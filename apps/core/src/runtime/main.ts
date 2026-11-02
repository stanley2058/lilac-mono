import { createLogger, modelCatalogCache } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import { createCoreRuntime, type CoreRuntime } from "./create-core-runtime";
import { projectRuntimeError } from "./error-format";
import { createProcessHandlers } from "./process-handlers";

const logger = createLogger({
  module: "core-main",
});

let runtime: CoreRuntime | null = null;
const handlers = createProcessHandlers({
  logger,
  stop: async (fatalError, hardDeadlineAtMs) => {
    await runtime?.stop(fatalError && Panic.is(fatalError) ? fatalError : null, hardDeadlineAtMs);
  },
  recordUnhandledRejection: (reason) => {
    runtime?.recordUnhandledRejection(reason);
  },
});

modelCatalogCache.supervise((error) => handlers.reportFatalError(error));

function projectProcessFailure(reason: unknown, fallback: string): Error {
  return projectRuntimeError(reason, fallback);
}

function handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
  handlers.handleUnhandledRejection(
    projectProcessFailure(reason, "Opaque unhandled rejection"),
    promise,
  );
}

process.on("unhandledRejection", handleUnhandledRejection);

process.on("uncaughtException", (error) => {
  handlers.handleUncaughtException(projectProcessFailure(error, "Opaque uncaught exception"));
});

const started = await Result.tryPromise({
  try: async (): Promise<boolean> => {
    const created = await createCoreRuntime({
      reportFatalError: (error) => handlers.reportFatalError(error),
      onUnhealthy: async (snapshot) => {
        logger.error("Core runtime unhealthy; exiting", {
          checks: snapshot.checks.filter((check) => !check.ok),
        });
        handlers.handleUncaughtException(new Error("runtime watchdog detected unhealthy state"));
      },
    });
    if (created.kind === "panic") return false;
    return created.result.match({
      err: () => async () => false,
      ok: (createdRuntime) => async () => {
        runtime = createdRuntime;
        const startup = await runtime.start();
        if (startup.kind !== "result") return false;
        return startup.result.match({ ok: () => true, err: () => false });
      },
    })();
  },
  catch: () => "Opaque core startup failure",
});
const runtimeStarted = started.match({
  ok: (value) => value,
  err: () => false,
});
if (!runtimeStarted) {
  logger.error("Failed to start core runtime");
  process.exit(1);
}

async function handleProcessSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const handled = await Result.tryPromise({
    try: () => handlers.handleSignal(signal),
    catch: () => "Opaque shutdown handler failure",
  });
  handled.match({
    ok: () => undefined,
    err: () => logger.error(`Shutdown handler failed for ${signal}`),
  });
}

process.on("SIGINT", () => {
  void handleProcessSignal("SIGINT");
});

process.on("SIGTERM", () => {
  void handleProcessSignal("SIGTERM");
});
