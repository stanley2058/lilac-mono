import Redis from "ioredis";
import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import {
  env,
  getCoreConfig,
  resolveLogLevel,
  resolveTranscriptDbPath,
} from "@stanley2058/lilac-utils";
import path from "node:path";
import fs from "node:fs/promises";
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

import { SqliteTranscriptStore } from "../transcript/transcript-store";

import { SqliteWorkflowStore } from "../workflow/workflow-store";
import { startWorkflowService } from "../workflow/workflow-service";
import { createWorkflowStoreQueries } from "../workflow/workflow-store-queries";
import { shouldSuppressRouterForWorkflowReply } from "../workflow/should-suppress-router-message";

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
  /** Where core tools operate (fs/bash tool root). Default: $LILAC_WORKSPACE_DIR or $DATA_DIR/workspace. */
  cwd?: string;
  toolServerPort?: number;
  /** Prefix for Redis consumer group ids / subscription ids. Default: "core". */
  subscriptionPrefix?: string;
  /** Override log level. Default: LOG_LEVEL env or "info". */
  logLevel?: LogLevel;
};

function subId(prefix: string, name: string): string {
  return `${prefix}:${name}`;
}

export async function createCoreRuntime(
  opts: CoreRuntimeOptions = {},
): Promise<CoreRuntime> {
  const logger = new Logger({
    logLevel: resolveLogLevel(opts.logLevel),
    module: "core-runtime",
  });

  const subscriptionPrefix = opts.subscriptionPrefix ?? "core";
  const cwd =
    opts.cwd ??
    process.env.LILAC_WORKSPACE_DIR ??
    path.resolve(process.cwd(), env.dataDir, "workspace");
  const toolServerPort =
    opts.toolServerPort ?? Number(env.toolServer.port ?? 8080);

  logger.info("Core runtime init", {
    cwd,
    toolServerPort,
    subscriptionPrefix,
  });

  const redisUrl = env.redisUrl;
  if (!redisUrl) {
    logger.error("Missing REDIS_URL env var (required)");
    throw new Error("REDIS_URL must be set");
  }
  const redis = new Redis(redisUrl);

  await fs.mkdir(cwd, { recursive: true });

  try {
    await redis.ping();
  } catch (e) {
    logger.error("Failed to connect to Redis", e);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to connect to Redis: ${msg}`);
  }

  const raw = createRedisStreamsBus({
    redis,
    ownsRedis: true,
    subscriberPool: {
      // We keep subscriptions on dedicated connections because Redis Streams uses
      // blocking XREAD/XREADGROUP calls.
      // Cap connections to avoid FD blowups, and warm a few so first-turn latency
      // doesn't include connection establishment.
      max: 16,
      warm: 8,
    },
  });

  const bus: LilacBus = createLilacBus(raw);

  const adapter = new DiscordAdapter();
  const workflowStore = new SqliteWorkflowStore();
  const workflowQueries = createWorkflowStoreQueries(workflowStore);

  let transcriptStore: SqliteTranscriptStore | null = null;

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
      logger.info("Core runtime starting...");

      // Ensure data dir exists before creating sqlite-backed stores.
      await fs.mkdir(env.dataDir, { recursive: true });

      transcriptStore = new SqliteTranscriptStore(resolveTranscriptDbPath());

      // Subscribe to adapter events before connecting, so we don't miss early messages.
      stopAdapterToBus = await bridgeAdapterToBus({
        adapter,
        bus,
        subscriptionId: subId(subscriptionPrefix, "adapter-to-bus"),
      });

      logger.info("bridgeAdapterToBus started", {
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

      logger.info("Workflow service started", {
        subscriptionId: subId(subscriptionPrefix, "workflow"),
      });

      stopRouter = await startBusRequestRouter({
        adapter,
        bus,
        subscriptionId: subId(subscriptionPrefix, "router"),
        shouldSuppressAdapterEvent: async ({ evt }) =>
          shouldSuppressRouterForWorkflowReply({ queries: workflowQueries, evt }),
        transcriptStore: transcriptStore ?? undefined,
      });

      logger.info("Bus request router started", {
        subscriptionId: subId(subscriptionPrefix, "router"),
      });

      // Tool server (same process)
      requestMessageCache = await createRequestMessageCache({
        bus,
        subscriptionId: subId(subscriptionPrefix, "tool-request-cache"),
      });

      logger.info("Request message cache started", {
        subscriptionId: subId(subscriptionPrefix, "tool-request-cache"),
      });

      toolServer = createToolServer({
        tools: createDefaultToolServerTools({
          bus,
          adapter,
          getConfig: () => getCoreConfig(),
        }),
        logger: new Logger({
          logLevel: resolveLogLevel(),
          module: "tool-server",
        }),
        requestMessageCache: {
          get: requestMessageCache.get,
        },
      });

      await toolServer.init();
      await toolServer.start(toolServerPort);

      logger.info("Tool server started", {
        port: toolServerPort,
      });

      // Adapter must be connected before we start relaying streamed outputs.
      await adapter.connect();

      logger.info("Surface adapter connected", {
        platform: "discord",
      });

      stopBusToAdapter = await bridgeBusToAdapter({
        adapter,
        bus,
        platform: "discord",
        subscriptionId: subId(subscriptionPrefix, "bus-to-adapter"),
        transcriptStore: transcriptStore ?? undefined,
      });

      logger.info("bridgeBusToAdapter started", {
        subscriptionId: subId(subscriptionPrefix, "bus-to-adapter"),
      });

      // Start agent runner last so it can't publish replies before relay is online.
      stopAgentRunner = await startBusAgentRunner({
        bus,
        subscriptionId: subId(subscriptionPrefix, "agent-runner"),
        cwd,
        transcriptStore: transcriptStore ?? undefined,
      });

      logger.info("Bus agent runner started", {
        subscriptionId: subId(subscriptionPrefix, "agent-runner"),
        cwd,
      });

      logger.info(
        `Core runtime started (tool-server port=${toolServerPort}, subscriptionPrefix=${subscriptionPrefix})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Core runtime start failed: ${msg}`, e);
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
    await safe("transcriptStore.close", async () => {
      transcriptStore?.close();
      transcriptStore = null;
    });
    await safe("bus.close", () => bus.close());

    if (stopErrors.length > 0) {
      logger.error({ stopErrors });
    }

    logger.info("Core runtime stopped");
  }

  return { start, stop };
}
