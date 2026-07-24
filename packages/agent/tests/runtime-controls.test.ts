import { describe, expect, it } from "bun:test";

import { createLogger } from "@stanley2058/lilac-utils";

import {
  computeTransientRetryDelayMs,
  createAgentRunIdleWatchdog,
  createIdleTimer,
  createTransientModelRetryController,
  isRetryableTransientModelError,
} from "../index";

describe("agent run idle watchdog", () => {
  it("rejects an active wait after the idle interval", async () => {
    const timedOut: Error[] = [];
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 20,
      onTimeout: (error) => timedOut.push(error),
    });

    watchdog.start();
    await expect(watchdog.waitFor(new Promise<void>(() => {}))).rejects.toThrow(
      "agent idle timed out after 20ms",
    );
    expect(timedOut).toHaveLength(1);
    watchdog.stop();
  });

  it("pauses monitoring between separately raced operations", async () => {
    let timeoutCount = 0;
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 10,
      onTimeout: () => {
        timeoutCount += 1;
      },
    });

    watchdog.start();
    watchdog.pause();
    await Bun.sleep(20);

    expect(timeoutCount).toBe(0);
    watchdog.stop();
  });

  it("does not clamp large idle deadlines to an immediate timer", async () => {
    let timeoutCount = 0;
    const timer = createIdleTimer(30 * 24 * 60 * 60 * 1000, () => {
      timeoutCount += 1;
    });

    timer.reset();
    await Bun.sleep(10);

    expect(timeoutCount).toBe(0);
    timer.stop();
  });
});

describe("transient model retry", () => {
  it("classifies transient failures but excludes context overflow and exhausted retries", () => {
    expect(isRetryableTransientModelError({ statusCode: 503 })).toBe(true);
    expect(isRetryableTransientModelError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableTransientModelError("maximum context length is 128000 tokens")).toBe(false);
    expect(
      isRetryableTransientModelError({
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 503 },
      }),
    ).toBe(false);
  });

  it("computes capped exponential backoff", () => {
    expect(
      computeTransientRetryDelayMs({ attempt: 1, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(2_000);
    expect(
      computeTransientRetryDelayMs({ attempt: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(30_000);
  });

  it("enforces the retry limit and can reset it", async () => {
    const controller = createTransientModelRetryController({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      logger: createLogger({ module: "agent-runtime-controls-test" }),
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/test",
    });
    const error = { statusCode: 503, message: "Service unavailable" };
    const context = { retrySafety: { canRetry: true } as const };

    await expect(controller.handler(error, context)).resolves.toBe("retry");
    await expect(controller.handler(error, context)).resolves.toBe("retry");
    await expect(controller.handler(error, context)).resolves.toBe("fail");
    controller.reset();
    await expect(controller.handler(error, context)).resolves.toBe("retry");
  });

  it("does not retry an unsafe transcript boundary", async () => {
    const controller = createTransientModelRetryController({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      logger: createLogger({ module: "agent-runtime-controls-test" }),
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/test",
    });

    await expect(
      controller.handler(new Error("WebSocket closed before a terminal response event"), {
        retrySafety: { canRetry: false, reason: "provider-executed-tool" },
      }),
    ).resolves.toBe("fail");
  });
});
