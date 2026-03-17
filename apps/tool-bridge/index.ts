import { createLogger, env } from "@stanley2058/lilac-utils";
import {
  createCoreToolPluginManager,
  createProcessHandlers,
  createToolServer,
} from "@stanley2058/lilac-core";

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
  onUnhealthy: async (snapshot) => {
    logger.error("Tool bridge unhealthy; exiting", {
      checks: snapshot.checks.filter((check) => !check.ok),
    });
    handlers.handleUncaughtException(new Error("tool-bridge watchdog detected unhealthy state"));
  },
});

const handlers = createProcessHandlers({
  logger,
  stop: async () => {
    await server.stop();
  },
  recordUnhandledRejection: (reason) => {
    server.recordUnhandledRejection(reason);
  },
});

await server.init();
await server.start(Number(env.toolServer.port ?? 8080));

process.on("SIGINT", async () => {
  await handlers.handleSignal("SIGINT");
});

process.on("SIGTERM", async () => {
  await handlers.handleSignal("SIGTERM");
});

process.on("unhandledRejection", (reason, promise) => {
  handlers.handleUnhandledRejection(reason, promise);
});

process.on("uncaughtException", (error) => {
  handlers.handleUncaughtException(error);
});
