import Redis from "ioredis";
import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import {
  env,
  getCoreConfig,
  resolveCoreConfigPath,
  resolveDiscordSearchDbPath,
  resolveLogLevel,
  resolveTranscriptDbPath,
} from "@stanley2058/lilac-utils";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { createLilacBus, createRedisStreamsBus, type LilacBus } from "@stanley2058/lilac-event-bus";

import { DiscordAdapter } from "../surface/discord/discord-adapter";
import { GithubAdapter } from "../surface/github/github-adapter";
import { bridgeAdapterToBus } from "../surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../surface/bridge/subscribe-from-bus";
import { startBusRequestRouter } from "../surface/bridge/bus-request-router";
import { startBusAgentRunner } from "../surface/bridge/bus-agent-runner";
import { startDiscordSearchIndexer } from "../surface/bridge/discord-search-indexer";
import { DiscordSearchService, DiscordSearchStore } from "../surface/store/discord-search-store";

import { readGithubAppSecret } from "../github/github-app";
import { startGithubWebhookServer } from "../github/webhook/github-webhook-server";

import { SqliteTranscriptStore } from "../transcript/transcript-store";

import { SqliteWorkflowStore } from "../workflow/workflow-store";
import { startWorkflowService } from "../workflow/workflow-service";
import { startWorkflowScheduler } from "../workflow/workflow-scheduler";
import { createWorkflowStoreQueries } from "../workflow/workflow-store-queries";
import { shouldSuppressRouterForWorkflowReply } from "../workflow/should-suppress-router-message";

import { createToolServer } from "../tool-server/create-tool-server";
import { createDefaultToolServerTools } from "../tool-server/default-tools";
import {
  createRequestMessageCache,
  type RequestMessageCache,
} from "../tool-server/request-message-cache";
import { SqliteGracefulRestartStore, type GracefulRestartSnapshot } from "./graceful-restart-store";

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

export async function createCoreRuntime(opts: CoreRuntimeOptions = {}): Promise<CoreRuntime> {
  const logger = new Logger({
    logLevel: resolveLogLevel(opts.logLevel),
    module: "core-runtime",
  });

  const subscriptionPrefix = opts.subscriptionPrefix ?? "core";
  const cwd =
    opts.cwd ??
    process.env.LILAC_WORKSPACE_DIR ??
    path.resolve(process.cwd(), env.dataDir, "workspace");
  const toolServerPort = opts.toolServerPort ?? Number(env.toolServer.port ?? 8080);

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
      autoscale: {
        enabled: true,
        min: 16,
        cap: 256,
        // Avoid resize thrash during bursts.
        cooldownMs: 30_000,
      },
    },
  });

  const bus: LilacBus = createLilacBus(raw);

  const adapter = new DiscordAdapter();
  const githubAdapter = new GithubAdapter();
  const workflowStore = new SqliteWorkflowStore();
  const workflowQueries = createWorkflowStoreQueries(workflowStore);

  let transcriptStore: SqliteTranscriptStore | null = null;
  let discordSearchStore: DiscordSearchStore | null = null;
  let discordSearchService: DiscordSearchService | null = null;

  let started = false;

  let stopAdapterToBus: { stop(): Promise<void> } | null = null;
  let stopDiscordSearchIndexer: { stop(): Promise<void> } | null = null;
  let stopRouter: { stop(): Promise<void> } | null = null;
  let stopWorkflow: { stop(): Promise<void> } | null = null;
  let stopWorkflowScheduler: { stop(): Promise<void> } | null = null;
  let stopBusToAdapter: Awaited<ReturnType<typeof bridgeBusToAdapter>> | null = null;
  let stopGithubBusToAdapter: Awaited<ReturnType<typeof bridgeBusToAdapter>> | null = null;
  let stopAgentRunner: Awaited<ReturnType<typeof startBusAgentRunner>> | null = null;

  let stopGithubWebhook: { stop(): Promise<void> } | null = null;

  let requestMessageCache: RequestMessageCache | null = null;
  let gracefulRestartStore: SqliteGracefulRestartStore | null = null;
  let runtimeFullyStarted = false;
  let coreConfigWatcher: FSWatcher | null = null;
  let coreConfigValidationTimer: ReturnType<typeof setTimeout> | null = null;
  let coreConfigValidationHadError = false;
  let lastCoreConfigValidationError: string | null = null;

  let toolServer: {
    init(): Promise<void>;
    start(port: number): Promise<void>;
    stop(): Promise<void>;
  } | null = null;

  const GRACEFUL_RESTART_DEADLINE_MS = 120_000;

  function watchFilenameToString(name: string | Buffer | null): string | null {
    if (typeof name === "string") return name;
    if (name instanceof Buffer) return name.toString("utf8");
    return null;
  }

  async function validateCoreConfigOnChange(reason: "watch"): Promise<void> {
    const configPath = resolveCoreConfigPath();

    try {
      await getCoreConfig({ forceReload: true });

      if (coreConfigValidationHadError) {
        logger.info("core-config hot-reload validation recovered", {
          reason,
          path: configPath,
        });
      }

      coreConfigValidationHadError = false;
      lastCoreConfigValidationError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!coreConfigValidationHadError || lastCoreConfigValidationError !== msg) {
        logger.warn("core-config hot-reload validation failed", {
          reason,
          path: configPath,
          error: msg,
        });
      }

      coreConfigValidationHadError = true;
      lastCoreConfigValidationError = msg;
    }
  }

  function scheduleCoreConfigValidation(reason: "watch"): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
    }

    coreConfigValidationTimer = setTimeout(() => {
      coreConfigValidationTimer = null;
      void validateCoreConfigOnChange(reason);
    }, 200);
  }

  async function startCoreConfigWatcher(): Promise<void> {
    const configPath = resolveCoreConfigPath();
    const configDir = path.dirname(configPath);
    const configFileName = path.basename(configPath);

    try {
      coreConfigWatcher = watch(configDir, (eventType, filename) => {
        const changed = watchFilenameToString(filename);
        if (changed && changed !== configFileName) return;

        logger.debug("core-config file change detected", {
          eventType,
          changed: changed ?? configFileName,
          path: configPath,
        });

        scheduleCoreConfigValidation("watch");
      });

      coreConfigWatcher.on("error", (e: unknown) => {
        logger.warn("core-config watcher error", { path: configPath }, e);
      });

      logger.info("Core config hot-reload validator started", {
        path: configPath,
      });
    } catch (e) {
      logger.warn("Core config hot-reload validator disabled", { path: configPath }, e);
      coreConfigWatcher = null;
    }
  }

  function stopCoreConfigWatcher(): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
      coreConfigValidationTimer = null;
    }
    coreConfigWatcher?.close();
    coreConfigWatcher = null;
  }

  async function restoreGracefulSnapshot(snapshot: GracefulRestartSnapshot) {
    logger.info("Restoring graceful restart snapshot", {
      createdAt: snapshot.createdAt,
      agentEntries: snapshot.agent.length,
      relayEntries: snapshot.relays.length,
    });

    if (stopBusToAdapter) {
      await stopBusToAdapter.restoreRelays(snapshot.relays.filter((r) => r.platform === "discord"));
    }

    if (stopGithubBusToAdapter) {
      await stopGithubBusToAdapter.restoreRelays(
        snapshot.relays.filter((r) => r.platform === "github"),
      );
    }

    stopAgentRunner?.restoreRecoverables(snapshot.agent);

    logger.info("Graceful restart snapshot restored", {
      agentEntries: snapshot.agent.length,
      relayEntries: snapshot.relays.length,
    });
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;

    try {
      logger.info("Core runtime starting...");

      // Ensure data dir exists before creating sqlite-backed stores.
      await fs.mkdir(env.dataDir, { recursive: true });

      await startCoreConfigWatcher();

      gracefulRestartStore = new SqliteGracefulRestartStore(
        path.join(env.dataDir, "graceful-restart.db"),
      );

      transcriptStore = new SqliteTranscriptStore(resolveTranscriptDbPath());
      discordSearchStore = new DiscordSearchStore(resolveDiscordSearchDbPath());
      discordSearchService = new DiscordSearchService({
        adapter,
        store: discordSearchStore,
      });

      stopDiscordSearchIndexer = await startDiscordSearchIndexer({
        adapter,
        search: discordSearchService,
      });

      logger.info("Discord search indexer started", {
        dbPath: resolveDiscordSearchDbPath(),
      });

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

      stopWorkflowScheduler = await startWorkflowScheduler({
        bus,
        store: workflowStore,
        queries: workflowQueries,
        subscriptionId: subId(subscriptionPrefix, "workflow-scheduler"),
      });

      logger.info("Workflow scheduler started", {
        subscriptionId: subId(subscriptionPrefix, "workflow-scheduler"),
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
          workflowStore,
          discordSearch: discordSearchService ?? undefined,
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

      // GitHub surface (webhook ingress + non-streamed comment egress)
      const ghSecret = await readGithubAppSecret(env.dataDir);
      if (ghSecret) {
        stopGithubWebhook = await startGithubWebhookServer({
          bus,
          subscriptionId: subId(subscriptionPrefix, "github-webhook"),
        });

        stopGithubBusToAdapter = await bridgeBusToAdapter({
          adapter: githubAdapter,
          bus,
          platform: "github",
          subscriptionId: subId(subscriptionPrefix, "bus-to-github"),
          transcriptStore: transcriptStore ?? undefined,
        });

        logger.info("GitHub surface started", {
          webhookPath: env.github.webhookPath,
          webhookPort: env.github.webhookPort,
          subscriptionId: subId(subscriptionPrefix, "bus-to-github"),
        });
      } else {
        logger.info("GitHub App secret missing; skipping GitHub surface");
      }

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

      const restartLoad = gracefulRestartStore?.loadAndConsumeCompletedSnapshotDetailed() ?? {
        snapshot: null,
        reason: "empty" as const,
      };

      if (restartLoad.snapshot) {
        await restoreGracefulSnapshot(restartLoad.snapshot).catch((e: unknown) => {
          logger.error("Failed to restore graceful restart snapshot", e);
        });
      } else if (restartLoad.reason === "stale") {
        logger.warn("Graceful restart snapshot discarded (stale)", {
          createdAt: restartLoad.createdAt,
          ageMs: restartLoad.ageMs,
          deadlineMs: restartLoad.deadlineMs,
        });
      } else if (restartLoad.reason !== "empty") {
        logger.warn("Graceful restart snapshot discarded", {
          reason: restartLoad.reason,
        });
      }

      runtimeFullyStarted = true;

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

    if (runtimeFullyStarted && stopAgentRunner && gracefulRestartStore) {
      const agentRunner = stopAgentRunner;

      await safe(
        "graceful.ingress.bridgeAdapterToBus.stop",
        () => stopAdapterToBus?.stop() ?? Promise.resolve(),
      );
      stopAdapterToBus = null;

      await safe("graceful.ingress.router.stop", () => stopRouter?.stop() ?? Promise.resolve());
      stopRouter = null;

      await safe("graceful.ingress.workflow.stop", () => stopWorkflow?.stop() ?? Promise.resolve());
      stopWorkflow = null;

      await safe(
        "graceful.ingress.workflowScheduler.stop",
        () => stopWorkflowScheduler?.stop() ?? Promise.resolve(),
      );
      stopWorkflowScheduler = null;

      await safe("graceful.ingress.githubWebhook.stop", () => {
        return stopGithubWebhook?.stop() ?? Promise.resolve();
      });
      stopGithubWebhook = null;

      await safe("graceful.agentRunner.beginDrain", () =>
        agentRunner.beginDrain({ deadlineMs: GRACEFUL_RESTART_DEADLINE_MS }),
      );

      await safe(
        "graceful.discordBridge.beginDrain",
        () =>
          stopBusToAdapter?.beginDrain({ deadlineMs: GRACEFUL_RESTART_DEADLINE_MS }) ??
          Promise.resolve(),
      );

      await safe(
        "graceful.githubBridge.beginDrain",
        () =>
          stopGithubBusToAdapter?.beginDrain({ deadlineMs: GRACEFUL_RESTART_DEADLINE_MS }) ??
          Promise.resolve(),
      );

      const agentRecoverables = agentRunner.snapshotRecoverables();
      const relayRecoverables = [
        ...(stopBusToAdapter?.snapshotRelays() ?? []),
        ...(stopGithubBusToAdapter?.snapshotRelays() ?? []),
      ];

      if (agentRecoverables.length > 0 || relayRecoverables.length > 0) {
        await safe("graceful.store.saveCompletedSnapshot", async () => {
          gracefulRestartStore?.saveCompletedSnapshot({
            version: 1,
            createdAt: Date.now(),
            deadlineMs: GRACEFUL_RESTART_DEADLINE_MS,
            agent: agentRecoverables,
            relays: relayRecoverables,
          });
        });

        logger.info("Saved graceful restart snapshot", {
          deadlineMs: GRACEFUL_RESTART_DEADLINE_MS,
          agentEntries: agentRecoverables.length,
          relayEntries: relayRecoverables.length,
        });
      } else {
        await safe("graceful.store.clear", async () => {
          gracefulRestartStore?.clear();
        });
      }
    }

    // Stop in reverse order (best-effort).
    await safe("agentRunner.stop", () => stopAgentRunner?.stop() ?? Promise.resolve());
    await safe(
      "discordSearchIndexer.stop",
      () => stopDiscordSearchIndexer?.stop() ?? Promise.resolve(),
    );
    await safe("bridgeBusToAdapter.stop", () => stopBusToAdapter?.stop() ?? Promise.resolve());
    await safe(
      "bridgeGithubBusToAdapter.stop",
      () => stopGithubBusToAdapter?.stop() ?? Promise.resolve(),
    );
    await safe("githubWebhook.stop", () => stopGithubWebhook?.stop() ?? Promise.resolve());

    await safe("toolServer.stop", () => toolServer?.stop() ?? Promise.resolve());
    await safe("requestMessageCache.stop", () => requestMessageCache?.stop() ?? Promise.resolve());

    await safe("router.stop", () => stopRouter?.stop() ?? Promise.resolve());
    await safe("workflow.stop", () => stopWorkflow?.stop() ?? Promise.resolve());
    await safe("workflowScheduler.stop", () => stopWorkflowScheduler?.stop() ?? Promise.resolve());
    await safe("bridgeAdapterToBus.stop", () => stopAdapterToBus?.stop() ?? Promise.resolve());

    await safe("adapter.disconnect", () => adapter.disconnect());
    await safe("githubAdapter.disconnect", () => githubAdapter.disconnect());
    await safe("transcriptStore.close", async () => {
      transcriptStore?.close();
      transcriptStore = null;
    });
    await safe("discordSearchStore.close", async () => {
      discordSearchStore?.close();
      discordSearchStore = null;
      discordSearchService = null;
    });
    await safe("gracefulRestartStore.close", async () => {
      gracefulRestartStore?.close();
      gracefulRestartStore = null;
    });
    await safe("coreConfigWatcher.stop", async () => {
      stopCoreConfigWatcher();
    });
    await safe("bus.close", () => bus.close());

    runtimeFullyStarted = false;

    if (stopErrors.length > 0) {
      logger.error({ stopErrors });
    }

    logger.info("Core runtime stopped");
  }

  return { start, stop };
}
