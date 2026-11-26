import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";

import { createProcessHandlers } from "../../src/runtime/process-handlers";
import { safeRuntimeErrorText } from "../../src/runtime/error-format";

function createLoggerStub() {
  return createLogger({
    module: "process-handlers-test",
  });
}

function createExitCodeHooks() {
  let exitCode: number | undefined;
  return {
    getExitCode: () => exitCode,
    setExitCode: (code: number) => {
      exitCode = code;
    },
  };
}

describe("createProcessHandlers", () => {
  it("passes one absolute hard deadline to runtime shutdown", async () => {
    const exitCodeHooks = createExitCodeHooks();
    const deadlines: number[] = [];
    const before = Date.now();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async (_fatalError, hardDeadlineAtMs) => {
        if (hardDeadlineAtMs !== undefined) deadlines.push(hardDeadlineAtMs);
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exitTimeoutMs: 2_000,
      exit: (() => undefined as never) as (code: number) => never,
    });

    await handlers.handleSignal("SIGTERM");

    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 2_000);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  it("redacts standalone provider and AWS credential formats", () => {
    const credentials = [
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      `FwoG${"A".repeat(96)}`,
    ] as const;

    for (const credential of credentials) {
      const redacted = safeRuntimeErrorText(new Error(credential), "fallback");
      expect(redacted).toBe("<redacted>");
      expect(redacted).not.toContain(credential);
    }
  });

  it("logs unhandled rejections without exiting", () => {
    const seen: unknown[] = [];
    const exitCalls: number[] = [];
    const exitCodeHooks = createExitCodeHooks();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {},
      recordUnhandledRejection: (reason) => {
        seen.push(reason);
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.handleUnhandledRejection(new Error("boom"), Promise.resolve(undefined));

    expect(seen).toHaveLength(1);
    expect(exitCalls).toEqual([]);
  });

  it("treats uncaught exceptions as fatal and exits after stop", async () => {
    const exitCalls: number[] = [];
    const exited = Promise.withResolvers<void>();
    let stopCalls = 0;
    const exitCodeHooks = createExitCodeHooks();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {
        stopCalls += 1;
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        exited.resolve();
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.handleUncaughtException(new Error("fatal"));
    await exited.promise;

    expect(stopCalls).toBe(1);
    expect(exitCalls).toEqual([1]);
  });

  it("exits immediately on a second fatal error during shutdown", async () => {
    const exitCalls: number[] = [];
    let resolveStop!: () => void;
    const exitCodeHooks = createExitCodeHooks();
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = () => resolve();
    });
    const stopEntered = Promise.withResolvers<void>();
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {
        stopEntered.resolve();
        await stopPromise;
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    const shutdown = handlers.handleSignal("SIGTERM");
    await stopEntered.promise;
    handlers.handleUncaughtException(new Error("fatal during shutdown"));

    expect(exitCalls).toEqual([1]);

    resolveStop();
    await shutdown;
  });
});
