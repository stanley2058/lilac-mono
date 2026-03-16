import type { Logger } from "@stanley2058/simple-module-logger";

export type ProcessSignal = "SIGINT" | "SIGTERM";

type ProcessExitFn = (code: number) => never;

export type ProcessHandlerParams = {
  logger: Logger;
  stop: () => Promise<void>;
  recordUnhandledRejection?: (reason: unknown, promise: Promise<unknown>) => void;
  exit?: ProcessExitFn;
  exitTimeoutMs?: number;
};

export type ProcessHandlers = {
  handleSignal(signal: ProcessSignal): Promise<void>;
  handleUncaughtException(error: unknown): void;
  handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): void;
};

const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

export function createProcessHandlers(params: ProcessHandlerParams): ProcessHandlers {
  const exit = params.exit ?? ((code: number) => process.exit(code));
  const exitTimeoutMs = params.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;

  let shuttingDown = false;
  let fatalShutdownStarted = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearForceExitTimer() {
    if (!forceExitTimer) return;
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }

  function scheduleForceExit(trigger: string) {
    if (forceExitTimer) return;
    forceExitTimer = setTimeout(() => {
      params.logger.error("Process force exit after fatal error", {
        trigger,
        timeoutMs: exitTimeoutMs,
      });
      exit(1);
    }, exitTimeoutMs);
    forceExitTimer.unref?.();
  }

  async function handleSignal(signal: ProcessSignal): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    params.logger.info(`Received ${signal}, shutting down...`);
    try {
      await params.stop();
    } catch (e) {
      params.logger.error("Shutdown failed", e);
      process.exitCode = 1;
    } finally {
      clearForceExitTimer();
      const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
      exit(exitCode);
    }
  }

  async function handleFatal(trigger: string, error: unknown): Promise<void> {
    process.exitCode = 1;
    if (fatalShutdownStarted || shuttingDown) {
      params.logger.error("Fatal process error during shutdown; exiting immediately", { trigger }, error);
      clearForceExitTimer();
      exit(1);
    }

    fatalShutdownStarted = true;
    params.logger.error("Fatal process error", { trigger }, error);
    scheduleForceExit(trigger);

    try {
      await handleSignal("SIGTERM");
    } catch (e) {
      params.logger.error("Fatal shutdown handler failed", { trigger }, e);
      clearForceExitTimer();
      exit(1);
    }
  }

  return {
    async handleSignal(signal: ProcessSignal) {
      await handleSignal(signal);
    },
    handleUncaughtException(error: unknown) {
      void handleFatal("uncaughtException", error).catch((e) => {
        params.logger.error("Fatal shutdown promise rejected", { trigger: "uncaughtException" }, e);
        clearForceExitTimer();
        exit(1);
      });
    },
    handleUnhandledRejection(reason: unknown, promise: Promise<unknown>) {
      params.logger.error("Unhandled promise rejection", reason);
      params.recordUnhandledRejection?.(reason, promise);
    },
  };
}
