import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";

import { createCoreRuntime } from "./create-core-runtime";

const logger = new Logger({
  logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
  module: "core-main",
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  logger.error({ error }, "Uncaught exception");
  process.exitCode = 1;
});

let runtime: Awaited<ReturnType<typeof createCoreRuntime>> | null = null;

try {
  runtime = await createCoreRuntime();
  await runtime.start();
} catch (e) {
  logger.error({ error: e }, "Failed to start core runtime");
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
    logger.error({ error: e }, "Shutdown failed");
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(console.error);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(console.error);
});
