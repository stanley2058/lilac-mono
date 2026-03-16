import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";

import { createProcessHandlers } from "../../src/runtime/process-handlers";

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
        return undefined as never;
      }) as (code: number) => never,
    });

    handlers.handleUncaughtException(new Error("fatal"));
    await Bun.sleep(0);

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
    const handlers = createProcessHandlers({
      logger: createLoggerStub(),
      stop: async () => {
        await stopPromise;
      },
      getExitCode: exitCodeHooks.getExitCode,
      setExitCode: exitCodeHooks.setExitCode,
      exit: ((code: number) => {
        exitCalls.push(code);
        return undefined as never;
      }) as (code: number) => never,
    });

    void handlers.handleSignal("SIGTERM");
    handlers.handleUncaughtException(new Error("fatal during shutdown"));
    await Bun.sleep(0);

    expect(exitCalls).toEqual([1]);

    resolveStop();
    await Bun.sleep(0);
  });
});
