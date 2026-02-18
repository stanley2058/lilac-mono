import { Logger } from "@stanley2058/simple-module-logger";
import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import { createDefaultToolServerTools, createToolServer } from "@stanley2058/lilac-core";

const logger = new Logger({
  logLevel: resolveLogLevel(),
  module: "tool-bridge",
});

const server = createToolServer({
  // In dev mode, run without a bus by default.
  // Bus-backed tools (workflow/attachment) are enabled when the caller injects a bus.
  // Surface-backed tools require a live adapter + config, which tool-bridge does not create.
  tools: createDefaultToolServerTools(),
  logger,
});

await server.init();
await server.start(Number(env.toolServer.port ?? 8080));

process.on("SIGINT", async () => {
  logger.info("Gracefully shutting down...");
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Gracefully shutting down...");
  await server.stop();
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Caught unhandled rejection at:", reason, promise);
});
