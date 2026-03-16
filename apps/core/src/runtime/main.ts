import { createLogger } from "@stanley2058/lilac-utils";

import { createCoreRuntime } from "./create-core-runtime";
import { createProcessHandlers } from "./process-handlers";

const logger = createLogger({
  module: "core-main",
});

let runtime: Awaited<ReturnType<typeof createCoreRuntime>> | null = null;
const handlers = createProcessHandlers({
  logger,
  stop: async () => {
    await runtime?.stop();
  },
  recordUnhandledRejection: (reason) => {
    runtime?.recordUnhandledRejection(reason);
  },
});

process.on("unhandledRejection", (reason, promise) => {
  handlers.handleUnhandledRejection(reason, promise);
});

process.on("uncaughtException", (error) => {
  handlers.handleUncaughtException(error);
});

try {
  runtime = await createCoreRuntime({
    onUnhealthy: async (snapshot) => {
      logger.error("Core runtime unhealthy; exiting", {
        checks: snapshot.checks.filter((check) => !check.ok),
      });
      handlers.handleUncaughtException(new Error("runtime watchdog detected unhealthy state"));
    },
  });
  await runtime.start();
} catch (e) {
  logger.error("Failed to start core runtime", e);
  process.exit(1);
}

process.on("SIGINT", () => {
  handlers.handleSignal("SIGINT").catch((e) => {
    logger.error("Shutdown handler failed", e);
  });
});

process.on("SIGTERM", () => {
  handlers.handleSignal("SIGTERM").catch((e) => {
    logger.error("Shutdown handler failed", e);
  });
});
