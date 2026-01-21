import Redis from "ioredis";
import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import { env, getCoreConfig } from "@stanley2058/lilac-utils";
import {
  createLilacBus,
  createRedisStreamsBus,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import { DiscordAdapter } from "../surface/discord/discord-adapter";
import { bridgeAdapterToBus } from "../surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../surface/bridge/subscribe-from-bus";
import { startBusRequestRouter } from "../surface/bridge/bus-request-router";
import { startBusAgentRunner } from "../surface/bridge/bus-agent-runner";

import { SqliteWorkflowStore } from "../workflow/workflow-store";
import { startWorkflowService } from "../workflow/workflow-service";

import { createToolServer } from "../tool-server/create-tool-server";
import { createDefaultToolServerTools } from "../tool-server/default-tools";
import {
  createRequestMessageCache,
  type RequestMessageCache,
} from "../tool-server/request-message-cache";

export type CoreRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type CoreRuntimeOptions = {
  /** Where core tools operate (fs tool root). Default: process.cwd(). */
  cwd?: string;
  toolServerPort?: number;
  /** Prefix for Redis consumer group ids / subscription ids. Default: "core". */
  subscriptionPrefix?: string;
  /** Override log level. Default: LOG_LEVEL env or "info". */
  logLevel?: LogLevel;
};

function mustRedisUrl(): string {
  const url = env.redisUrl;
  if (!url) {
    console.error("Fatal: REDIS_URL must be set");
    process.exit(1);
  }
  return url;
}

function subId(prefix: string, name: string): string {
  return `${prefix}:${name}`;
}

export async function createCoreRuntime(
  opts: CoreRuntimeOptions = {},
): Promise<CoreRuntime> {
  const logger = new Logger({
    logLevel: opts.logLevel ?? (process.env.LOG_LEVEL as LogLevel) ?? "info",
    module: "core-runtime",
  });

  const subscriptionPrefix = opts.subscriptionPrefix ?? "core";
  const cwd = opts.cwd ?? process.cwd();
  const toolServerPort =
    opts.toolServerPort ?? Number(env.toolServer.port ?? 8080);

  const redisUrl = mustRedisUrl();
  const redis = new Redis(redisUrl);

  try {
    await redis.ping();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Fatal: failed to connect to Redis: ${msg}`);
    process.exit(1);
  }

  const raw = createRedisStreamsBus({
    redis,
    ownsRedis: true,
  });

  const bus: LilacBus = createLilacBus(raw);

  const adapter = new DiscordAdapter();
  const workflowStore = new SqliteWorkflowStore();

  let started = false;

  let stopAdapterToBus: { stop(): Promise<void> } | null = null;
  let stopRouter: { stop(): Promise<void> } | null = null;
  let stopWorkflow: { stop(): Promise<void> } | null = null;
  let stopBusToAdapter: { stop(): Promise<void> } | null = null;
  let stopAgentRunner: { stop(): Promise<void> } | null = null;

  let requestMessageCache: RequestMessageCache | null = null;

  let toolServer: {
    init(): Promise<void>;
    start(port: number): Promise<void>;
    stop(): Promise<void>;
  } | null = null;

  async function start(): Promise<void> {
    if (started) return;
    started = true;

    try {
      // Subscribe to adapter events before connecting, so we don't miss early messages.
      stopAdapterToBus = await bridgeAdapterToBus({
        adapter,
        bus,
        subscriptionId: subId(subscriptionPrefix, "adapter-to-bus"),
      });

      // Services that subscribe to evt.adapter should start before adapter.connect().
      stopWorkflow = await startWorkflowService({
        bus,
        store: workflowStore,
        subscriptionId: subId(subscriptionPrefix, "workflow"),
        pollTimeouts: {
          enabled: true,
        },
      });

      stopRouter = await startBusRequestRouter({
        adapter,
        bus,
        subscriptionId: subId(subscriptionPrefix, "router"),
      });

      // Tool server (same process)
      requestMessageCache = await createRequestMessageCache({
        bus,
        subscriptionId: subId(subscriptionPrefix, "tool-request-cache"),
      });

      toolServer = createToolServer({
        tools: createDefaultToolServerTools({
          bus,
          adapter,
          getConfig: () => getCoreConfig(),
        }),
        logger: new Logger({
          logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
          module: "tool-server",
        }),
        requestMessageCache: {
          get: requestMessageCache.get,
        },
      });

      await toolServer.init();
      await toolServer.start(toolServerPort);

      // Adapter must be connected before we start relaying streamed outputs.
      await adapter.connect();

      stopBusToAdapter = await bridgeBusToAdapter({
        adapter,
        bus,
        platform: "discord",
        subscriptionId: subId(subscriptionPrefix, "bus-to-adapter"),
      });

      // Start agent runner last so it can't publish replies before relay is online.
      stopAgentRunner = await startBusAgentRunner({
        bus,
        subscriptionId: subId(subscriptionPrefix, "agent-runner"),
        cwd,
      });

      logger.info(
        `Core runtime started (tool-server port=${toolServerPort}, subscriptionPrefix=${subscriptionPrefix})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ error: e }, `Core runtime start failed: ${msg}`);
      await stop();
      throw e;
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;

    const stopErrors: unknown[] = [];

    async function safe(label: string, fn: (() => Promise<void>) | undefined) {
      if (!fn) return;
      try {
        await fn();
      } catch (e) {
        stopErrors.push({ label, error: e });
      }
    }

    // Stop in reverse order (best-effort).
    await safe(
      "agentRunner.stop",
      () => stopAgentRunner?.stop() ?? Promise.resolve(),
    );
    await safe(
      "bridgeBusToAdapter.stop",
      () => stopBusToAdapter?.stop() ?? Promise.resolve(),
    );

    await safe(
      "toolServer.stop",
      () => toolServer?.stop() ?? Promise.resolve(),
    );
    await safe(
      "requestMessageCache.stop",
      () => requestMessageCache?.stop() ?? Promise.resolve(),
    );

    await safe("router.stop", () => stopRouter?.stop() ?? Promise.resolve());
    await safe(
      "workflow.stop",
      () => stopWorkflow?.stop() ?? Promise.resolve(),
    );
    await safe(
      "bridgeAdapterToBus.stop",
      () => stopAdapterToBus?.stop() ?? Promise.resolve(),
    );

    await safe("adapter.disconnect", () => adapter.disconnect());
    await safe("bus.close", () => bus.close());

    if (stopErrors.length > 0) {
      logger.error({ stopErrors });
    }

    logger.info("Core runtime stopped");
  }

  return { start, stop };
}
