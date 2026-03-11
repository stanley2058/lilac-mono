import { createLogger, env } from "@stanley2058/lilac-utils";
import { createCoreToolPluginManager, createToolServer } from "@stanley2058/lilac-core";

const logger = createLogger({
  module: "tool-bridge",
});

const pluginManager = createCoreToolPluginManager({
  runtime: {},
  dataDir: env.dataDir,
});

const server = createToolServer({
  pluginManager,
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
