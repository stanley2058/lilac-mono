import { describe, expect, it, spyOn } from "bun:test";

import { createLogger } from "@stanley2058/lilac-utils/logging";

import {
  createTransientModelRetryController,
  isRetryableTransientModelError,
} from "../transient-model-retry";

const SAFE_MODEL_CALL_CONTEXT = {
  retrySafety: { canRetry: true } as const,
  phase: "model-call" as const,
};

function createTestLogger() {
  return createLogger({ module: "transient-model-retry-test", logLevel: "fatal" });
}

describe("transient model fallback", () => {
  it("classifies validated transient status, network, exhaustion, and retry phrases", () => {
    for (const error of [
      { statusCode: 524 },
      "failed to fetch",
      "getaddrinfo ENOTFOUND api.example.test",
      "EAI_AGAIN",
      "connect ECONNREFUSED",
      "request ETIMEDOUT",
      '{"code":"resource_exhausted"}',
      "Please retry your request",
      "Try your request again",
    ]) {
      expect(isRetryableTransientModelError(error)).toBe(true);
    }
  });

  it("classifies a Responses stream EOF before its terminal event as transient", () => {
    expect(
      isRetryableTransientModelError(
        new Error("Response stream ended before a terminal response event"),
      ),
    ).toBe(true);
  });

  it("gives every advanced candidate a fresh same-model retry budget", async () => {
    const logger = createTestLogger();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const advanceCalls: string[] = [];
    let candidate = "primary/one";
    const controller = createTransientModelRetryController({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      logger,
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: candidate,
      advanceModel: async () => {
        advanceCalls.push(candidate);
        if (candidate === "primary/one") {
          candidate = "fallback/two";
          return { ok: true, modelSpec: candidate };
        }
        return { ok: false, reason: "fallback-chain-exhausted" };
      },
    });
    const error = { statusCode: 503, message: "Service unavailable" };

    try {
      await expect(controller.handler(error, SAFE_MODEL_CALL_CONTEXT)).resolves.toBe("retry");
      await expect(controller.handler(error, SAFE_MODEL_CALL_CONTEXT)).resolves.toBe("retry");
      await expect(controller.handler(error, SAFE_MODEL_CALL_CONTEXT)).resolves.toBe("retry");
      await expect(controller.handler(error, SAFE_MODEL_CALL_CONTEXT)).resolves.toBe("fail");

      expect(advanceCalls).toEqual(["primary/one", "fallback/two"]);
      const logs = JSON.stringify(warn.mock.calls);
      expect(logs).toContain('"modelSpec":"fallback/two"');
      expect(logs).toContain("fallback-chain-exhausted");
      expect(logs).toContain("transient model retry exhausted");
    } finally {
      warn.mockRestore();
    }
  });

  it("advances immediately when same-model retry is disabled", async () => {
    let advances = 0;
    const controller = createTransientModelRetryController({
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 10, maxDelayMs: 10 },
      logger: createTestLogger(),
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "primary/one",
      advanceModel: async () => {
        advances += 1;
        return { ok: true, modelSpec: "fallback/two" };
      },
    });

    await expect(controller.handler({ statusCode: 503 }, SAFE_MODEL_CALL_CONTEXT)).resolves.toBe(
      "retry",
    );
    expect(advances).toBe(1);
  });

  it("advances exhausted AI SDK retries without another same-model retry", async () => {
    let advances = 0;
    const controller = createTransientModelRetryController({
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 },
      logger: createTestLogger(),
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "primary/one",
      advanceModel: async () => {
        advances += 1;
        return { ok: true, modelSpec: "fallback/two" };
      },
    });

    await expect(
      controller.handler(
        {
          name: "AI_RetryError",
          reason: "maxRetriesExceeded",
          lastError: { statusCode: 503, message: "Service unavailable" },
        },
        SAFE_MODEL_CALL_CONTEXT,
      ),
    ).resolves.toBe("retry");
    expect(advances).toBe(1);
  });

  it("never advances non-model-call, unsafe, aborted, overflow, or fatal failures", async () => {
    let advances = 0;
    const controller = createTransientModelRetryController({
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      logger: createTestLogger(),
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "primary/one",
      advanceModel: async () => {
        advances += 1;
        return { ok: true, modelSpec: "fallback/two" };
      },
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      controller.handler({ statusCode: 503 }, { ...SAFE_MODEL_CALL_CONTEXT, phase: "before-step" }),
    ).resolves.toBe("fail");
    await expect(
      controller.handler(
        { statusCode: 503 },
        { retrySafety: { canRetry: false, reason: "provider-executed-tool" }, phase: "model-call" },
      ),
    ).resolves.toBe("fail");
    await expect(
      controller.handler(
        { statusCode: 503 },
        { ...SAFE_MODEL_CALL_CONTEXT, abortSignal: abortController.signal },
      ),
    ).resolves.toBe("fail");
    await expect(
      controller.handler("maximum context length is 128000 tokens", SAFE_MODEL_CALL_CONTEXT),
    ).resolves.toBe("fail");
    await expect(
      controller.handler({ statusCode: 400, message: "Invalid request" }, SAFE_MODEL_CALL_CONTEXT),
    ).resolves.toBe("fail");

    expect(advances).toBe(0);
  });
});
