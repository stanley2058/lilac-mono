import { createLogger } from "@stanley2058/lilac-utils";

import { createCoreRuntime } from "./create-core-runtime";

const logger = createLogger({
  module: "core-main",
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  process.exitCode = 1;
});

let runtime: Awaited<ReturnType<typeof createCoreRuntime>> | null = null;

try {
  runtime = await createCoreRuntime();
  await runtime.start();
} catch (e) {
  logger.error("Failed to start core runtime", e);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);
  try {
    await runtime?.stop();
  } catch (e) {
    logger.error("Shutdown failed", e);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((e) => {
    logger.error("Shutdown handler failed", e);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((e) => {
    logger.error("Shutdown handler failed", e);
  });
});
