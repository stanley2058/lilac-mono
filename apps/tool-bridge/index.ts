import { createLogger, env } from "@stanley2058/lilac-utils";
import {
  createCoreToolPluginManager,
  createProcessHandlers,
  createToolServer,
} from "@stanley2058/lilac-core/tool-server/host";

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
  reportFatalToolCallDefect: (defect) => handlers.reportFatalError(defect),
  onUnhealthy: async (snapshot) => {
    logger.error("Tool bridge unhealthy; exiting", {
      checks: snapshot.checks.filter((check) => !check.ok),
    });
    handlers.handleUncaughtException(new Error("tool-bridge watchdog detected unhealthy state"));
  },
});

function recordUnhandledRejection(reason: unknown): void {
  server.recordUnhandledRejection(reason);
}

const handlers = createProcessHandlers({
  logger,
  stop: async () => {
    await server.stop();
  },
  recordUnhandledRejection,
});

await server.init();
await server.start(Number(env.toolServer.port ?? 8080));

process.on("SIGINT", async () => {
  await handlers.handleSignal("SIGINT");
});

process.on("SIGTERM", async () => {
  await handlers.handleSignal("SIGTERM");
});

process.on("unhandledRejection", handlers.handleUnhandledRejection);

process.on("uncaughtException", (error) => {
  handlers.handleUncaughtException(error);
});
