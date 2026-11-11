import { formatJobWakeText } from "../jobs/job-events";
import { JobService } from "../jobs/job-service";
import { SqliteJobStore } from "../jobs/job-store";
import { nativeThreadId } from "../surface/native/native-protocol";
import { ConversationThreadSearchPool } from "../conversation/thread-search-pool";
import { nativeFailure } from "../surface/native/errors";
import { openNativeInstallation, type NativeInstallation } from "../surface/native/installation";
import {
  createNativeRuntime,
  nativeRuntimeResultToHost,
  type NativeRuntime,
} from "../surface/native/runtime";
import { maintainWorkflowArtifactPublications } from "../workflow/workflow-artifact-store";
import { captureError } from "../shared/error-capture.js";
import type { LogLevel } from "@stanley2058/simple-module-logger";
import {
  createLogger,
  env,
  errorMessage,
  formatTaggedErrorForLog,
  getCoreConfig,
  getOpenObserveDiagnostics,
  isPanic,
  readCoreConfigVersionResult,
  resolveDiscordDbPath,
  resolveCoreConfigPath,
  resolveCustomCommandsDir,
  resolveDiscoveryDbPath,
  resolveDiscordSearchDbPath,
  resolveTranscriptDbPath,
  toDurableResolvedModelRequest,
  toDurableResolvedModelPlan,
  type CustomCommandDiscoveryError,
} from "@stanley2058/lilac-utils";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";

import { DiscordAdapter } from "../surface/discord/discord-adapter";
import { createDiscordResourceOriginAdapter } from "../surface/discord/discord-resource-origin";
import { GithubAdapter } from "../surface/github/github-adapter";
import { createDiscordRuntimeHealthPort } from "../surface/discord/discord-runtime-health";
import { createDescriptorBoundSurfaceEventSource } from "../surface/produced-ref-guard";
import {
  adaptDiscordRequestRouterStartOutcomeToHost,
  startDiscordRequestRouter,
  type DiscordRequestRouter,
  type ResidualDiscordRequestRouter,
} from "../surface/discord/discord-request-router";
import {
  resolveAgentRunModel,
  resolveAgentRunModelFallbacks,
  startBusAgentRunner,
} from "../surface/bridge/bus-agent-runner";
import { startDiscordSearchIndexer } from "../surface/bridge/discord-search-indexer";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { DiscordSearchService, DiscordSearchStore } from "../surface/store/discord-search-store";
import { DiscordSurfaceStore } from "../surface/store/discord-surface-store";
import { createDiscordEntityMapper } from "../entity/entity-mapper";
import { DiscoveryService } from "../discovery/discovery-service";
import {
  createConversationThreadToolService,
  type ConversationThreadAttachmentHydrator,
  ConversationThreadOperationFailed,
  ConversationThreadService,
  type ConversationThreadRunSummarizationInput,
  type ConversationThreadToolService,
} from "../conversation/thread-service";
import { toReplyChainMessage } from "../surface/bridge/request-composition/reply-chain";
import {
  createCoreRequestDelivery,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  createRequestDeliveryPostCommitObserver,
  type CoreRequestOutputMetadata,
} from "../surface/bridge/request-delivery";
import {
  DiscordRequestDeliveryFailed,
  type DiscordRequestDeliveryPort,
} from "../surface/discord/discord-request-router/publish";
import { ConversationThreadStore } from "../conversation/thread-store";
import { createConversationThreadEmbeddingAdapterResolver } from "../conversation/thread-embedding";
import {
  startConversationThreadMaterializer,
  type ConversationThreadMaterializer,
} from "../conversation/thread-materializer-worker";
import {
  startConversationThreadSummarizationWorker,
  startConversationThreadWorker,
  ConversationThreadSummarizationRuntimeError,
  ConversationThreadSummarizationTransportError,
  type ConversationThreadSummarizationRuntimeOperation,
  type ConversationThreadSummarizationRunner,
} from "../conversation/thread-worker";

import { readGithubAppSecretResult } from "../github/github-app";

import { SqliteTranscriptStore } from "../transcript/transcript-store";
import { CoreResourceService, ResourceOriginAdapterRegistry } from "../resource";
import { startHeartbeatServiceResult, type HeartbeatService } from "../heartbeat/heartbeat-service";

import { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../workflow/workflow-action-resolver";
import { WorkflowProgressProjector } from "../workflow/workflow-progress-projector";
import { WorkflowEngine } from "../workflow/workflow-engine";
import { WorkflowWaitResolver } from "../workflow/workflow-wait-resolver";
import { WorkflowTriggerScheduler } from "../workflow/workflow-trigger-scheduler";
import { shouldSuppressRouterForWorkflowReply } from "../workflow/workflow-router-suppression";
import { WorkflowLiveParentBridge } from "../workflow/workflow-live-parent-bridge";
import { WorkflowSubagentDispatcher } from "../workflow/workflow-subagent-dispatcher";

import { createToolServer } from "../tool-server/create-tool-server";
import { resolveConversationThreadSummarizationToolOperation } from "../tool-server/tools/conversation-thread";
import {
  HEARTBEAT_LEVEL2_CALLABLES,
  RequestControlAuthority,
} from "../tool-server/request-control-authority";
import type {
  ToolServerHealthCheck,
  ToolServerHealthProviderResult,
  ToolServerHealthSnapshot,
} from "../tool-server/create-tool-server";
import {
  createRequestMessageCache,
  type RequestMessageCache,
} from "../tool-server/request-message-cache";
import {
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../surface/authenticated-request";
import type { AuthenticatedSurfaceOrigin } from "../surface/types";
import {
  AgentRunJournalMigrationFailure,
  SqliteAgentRunJournal,
  type AgentRunJournalSqliteFailure,
  type AgentRunRecoveryHead,
} from "../surface/bridge/agent-run-journal";
import { createCoreToolPluginManager, type CoreToolPluginManager } from "../plugins";
import {
  createDiscordContextReportProvider,
  DiscordContextReportFailed,
  type DiscordContextReportProvider,
} from "../surface/discord/discord-context-report";
import { CustomCommandManager } from "../custom-commands/manager";
import { handleCoreConfigWatchEvent } from "./core-config-watch";
import { publishConfigSchemas } from "./config-schemas";
import {
  captureRuntimeError,
  projectCapturedRuntimeError,
  projectRuntimeError,
  safeRuntimeErrorText,
} from "./error-format";
import {
  connectAndValidateSurfaceAdapters,
  createSurfaceWorkflowProgressPortMap,
  disconnectSurfaceAdapters,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopIngressAndDrainSurfaces,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  stopSurfaceRequestIngress,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "./surface-runtime-lifecycle";

import type { SurfaceRuntimeRegistry } from "../surface/runtime-descriptor";
import { resolveAuthenticatedRequestSafetyMode } from "../surface/builtin-surface-protocols";
import { resolveSessionSafetyMode } from "../surface/session-policy";
import type { SurfacePrincipal } from "../surface/types";
import { composeBuiltinSurfaceRuntimes } from "./compose-builtin-surface-runtimes";
import { createCoreBlobStore, type CoreBlobStoreCreateError } from "./create-core-blob-store";
import { prewarmFffFinders } from "@stanley2058/lilac-fs";
import { SqliteQuestionStore } from "../question/question-store";
import { QuestionService } from "../question/question-service";
import {
  adaptToolResultArtifactStoreInitToHost,
  createToolResultArtifactStore,
} from "../artifacts/tool-result-artifact-store";
import {
  AttachmentOutputLifecycleError,
  type AttachmentOutputLifecycle,
} from "../tools/attachment-output-lifecycle";
import {
  createEmptyMcpConfig,
  createMcpRegistryResult,
  McpOAuthCallbackService,
  McpOAuthProviderService,
  readMcpConfigFile,
  rethrowPanic,
  resolveMcpConfigPath,
  type McpOAuthCallbackListenerStatus,
  type McpRegistry,
  type McpRegistryOptionsInvalid,
  type UniversalMcpConfig,
} from "../mcp";
import {
  type AgentRunCheckpointBlobRecoveryDecision,
  emptyAgentRunRecoveryJoin,
  joinAgentRunRecoveryHeads,
  recoverAgentRunCheckpointBlobReferences,
  removeFullyReconciledAgentRunTerminalHeads,
  selectAgentRunAcceptedRecovery,
} from "./agent-run-recovery";
import {
  type CoreEventBusResources,
  type CoreEventBusSetupError,
  CoreEventBusSetupFailed,
  type CoreEventBusSetupOutcome,
  adaptCoreEventBusCleanupResultToHost,
  captureCoreEventBusCleanup,
  setupCoreEventBusResources,
} from "./core-event-bus";
import {
  type CoreResidualDiscordRequestRouterDoneOutcome,
  retainCoreResidualDiscordRequestRouter,
  settleCoreResidualDiscordRequestRouterDone,
  stopCoreResidualDiscordRequestRouter,
  superviseCoreRouterDone,
} from "./residual-discord-router";
import { createCoreRuntimeCleanupSupervisor } from "./core-runtime-cleanup";
export {
  type CoreRuntimeCleanupFailure,
  type CoreRuntimeCleanupSupervisor,
  createCoreRuntimeCleanupSupervisor,
} from "./core-runtime-cleanup";
export {
  type CoreResidualDiscordRequestRouterDoneOutcome,
  CoreResidualDiscordRequestRouterDoneRejected,
  CoreResidualDiscordRequestRouterDoneTimedOut,
  CoreResidualDiscordRequestRouterStopRejected,
  retainCoreResidualDiscordRequestRouter,
  settleCoreResidualDiscordRequestRouterDone,
  stopCoreResidualDiscordRequestRouter,
  superviseCoreResidualDiscordRequestRouterDone,
  superviseCoreRouterDone,
} from "./residual-discord-router";
export {
  CoreEventBusCleanupFailed,
  CoreEventBusSetupAndCleanupFailed,
  CoreEventBusSetupFailed,
  type CoreEventBusSetupOutcome,
  adaptCoreEventBusCleanupResultToHost,
  captureCoreEventBusCleanup,
  createCoreEventBusDeliveryOptions,
  createCoreEventBusFatalReporter,
  createCoreEventBusLogger,
  setupCoreEventBusResources,
} from "./core-event-bus";
export {
  type AgentRunAcceptedRecoveryDecision,
  type AgentRunCheckpointBlobRecoveryDecision,
  joinAgentRunRecoveryHeads,
  recoverAgentRunCheckpointBlobReferences,
  removeFullyReconciledAgentRunTerminalHeads,
  selectAgentRunAcceptedRecovery,
} from "./agent-run-recovery";

export function resolveRequestCapabilityIdentity(input: {
  readonly requestClient: string;
  readonly sessionId: string;
  readonly safetyMode: "trusted" | "restricted";
  readonly authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  readonly cachedRequest?: AuthenticatedRequestProjection;
}): {
  readonly principal: SurfacePrincipal | null;
  readonly authenticatedOrigin: AuthenticatedSurfaceOrigin | null;
  readonly safetyMode: "trusted" | "restricted";
} {
  const proposedOrigin = input.authenticatedOrigin ?? null;
  const cachedOrigin = input.cachedRequest?.authenticatedOrigin ?? null;
  const cacheMatches =
    input.cachedRequest !== undefined &&
    input.cachedRequest.requestClient === input.requestClient &&
    input.cachedRequest.sessionId === input.sessionId &&
    ((cachedOrigin === null && proposedOrigin === null) ||
      (cachedOrigin !== null &&
        proposedOrigin !== null &&
        cachedOrigin.platform === proposedOrigin.platform &&
        cachedOrigin.userId === proposedOrigin.userId &&
        cachedOrigin.sessionRef.channelId === proposedOrigin.sessionRef.channelId));
  const authenticatedOrigin = cacheMatches ? proposedOrigin : null;
  const principal = authenticatedOrigin
    ? {
        platform: authenticatedOrigin.platform,
        userId: authenticatedOrigin.userId,
      }
    : null;
  const safetyMode = input.cachedRequest
    ? resolveAuthenticatedRequestSafetyMode({
        projection: input.cachedRequest,
        assertedSafetyMode: input.safetyMode,
        correlatedAuthority: cacheMatches,
      })
    : "restricted";
  return { principal, authenticatedOrigin, safetyMode };
}

export type CoreRuntime = {
  start(): Promise<CoreRuntimeStartOutcome>;
  stop(priorPanic?: Panic | null, hardDeadlineAtMs?: number): Promise<void>;
  getBlobStore(): BlobStore | null;
  recordUnhandledRejection(reason: Error): void;
};

class CoreRuntimeExternalFailure extends TaggedError("CoreRuntimeExternalFailure")<{
  readonly operation: "reload-config" | "start-config-watcher";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreRuntimeCreateFailed extends TaggedError("CoreRuntimeCreateFailed")<{
  readonly operation:
    | "config"
    | "blob-storage"
    | "request-delivery"
    | "durable-stores"
    | "event-bus"
    | "custom-commands"
    | "mcp-registry";
  readonly cause:
    | Error
    | CoreBlobStoreCreateError
    | CoreEventBusSetupError
    | CustomCommandDiscoveryError
    | McpRegistryOptionsInvalid;
  readonly message: string;
}> {}

export type CoreRuntimeCreateOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<CoreRuntime, CoreRuntimeCreateFailed>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export class CoreRuntimeStartFailed extends TaggedError("CoreRuntimeStartFailed")<{
  readonly operation: "startup" | "blob-storage" | "heartbeat";
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CoreRuntimeStartOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<void, CoreRuntimeStartFailed>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export type CoreRuntimeOptions = {
  /** Where core tools operate (fs/bash tool root). Default: $LILAC_WORKSPACE_DIR or $DATA_DIR/workspace. */
  cwd?: string;
  toolServerPort?: number;
  /** Prefix for Redis consumer group ids / subscription ids. Default: "core". */
  subscriptionPrefix?: string;
  /** Override log level. Default: LOG_LEVEL env or "info". */
  logLevel?: LogLevel;
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  reportFatalError: (error: Error) => void;
};

/** Rebuilds every Discord channel once after the conversation index was reset. */
function rebuildDiscordConversationThreads(
  materializer: ConversationThreadMaterializer,
  getStore: () => ConversationThreadStore | null,
): void {
  const store = getStore();
  if (!store?.isDiscordRebuildPending()) return;
  materializer.markAllDirty();
  void Promise.allSettled([materializer.flush()]).then(([settled]) => {
    // A failed or interrupted rebuild stays pending, so the next start repeats it.
    if (settled?.status === "fulfilled" && getStore() === store) store.completeDiscordRebuild();
  });
}

export function createCoreRuntimeFatalReporter(
  reportFatalError: (error: Error) => void,
): (error: Error) => void {
  const reported = new WeakSet<Error>();
  return (error) => {
    if (reported.has(error)) return;
    reported.add(error);
    reportFatalError(error);
  };
}

export async function superviseDetachedCoreConfigValidation(params: {
  readonly validate: () => Promise<void>;
  readonly reportFatalError: (error: Error) => void;
}): Promise<void> {
  const [settled] = await Promise.allSettled([params.validate()]);
  if (settled.status === "fulfilled") return;
  if (isPanic(settled.reason)) {
    params.reportFatalError(settled.reason);
    return;
  }
  if (settled.reason instanceof Error) {
    params.reportFatalError(settled.reason);
    return;
  }
  params.reportFatalError(
    new Panic({
      message: "Core config validation rejected",
      cause: settled.reason,
    }),
  );
}

export type CoreRuntimeStopPass = "none" | "full" | "residual-router";

export const CORE_BLOB_STORE_CLEANUP_SLICE_MS = 1_000;
const CORE_REQUEST_DELIVERY_MAINTENANCE_INTERVAL_MS = 60_000;

export function scheduleCoreBlobStoreClose(params: {
  readonly hardDeadlineAtMs: number;
  readonly close: () => Promise<void>;
  readonly now?: () => number;
  readonly scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}): { readonly closeNow: () => Promise<void> } {
  const now = params.now ?? Date.now;
  const scheduleDeadline =
    params.scheduleDeadline ??
    ((callback: () => void, delayMs: number) => {
      const timeout = setTimeout(callback, delayMs);
      return () => clearTimeout(timeout);
    });
  let closeOperation: Promise<void> | null = null;
  let cancelDeadline = (): void => undefined;

  const closeNow = (): Promise<void> => {
    if (closeOperation) return closeOperation;
    cancelDeadline();
    closeOperation = Promise.resolve().then(params.close);
    return closeOperation;
  };

  cancelDeadline = scheduleDeadline(
    () => {
      void closeNow();
    },
    Math.max(0, params.hardDeadlineAtMs - CORE_BLOB_STORE_CLEANUP_SLICE_MS - now()),
  );
  return { closeNow };
}

export function resolveCoreGracefulDrainDeadlineMs(input: {
  readonly nowMs: number;
  readonly hardDeadlineAtMs: number;
  readonly configuredDrainDeadlineMs: number;
}): number {
  return Math.max(
    0,
    Math.min(
      input.configuredDrainDeadlineMs,
      input.hardDeadlineAtMs - CORE_BLOB_STORE_CLEANUP_SLICE_MS - input.nowMs,
    ),
  );
}

export function selectCoreRuntimeStopPass(params: {
  readonly fullCleanupPending: boolean;
  readonly hasResidualRouter: boolean;
}): CoreRuntimeStopPass {
  if (params.fullCleanupPending) return "full";
  if (params.hasResidualRouter) return "residual-router";
  return "none";
}

type CoreMcpStartupLogger = {
  info(message: string, details: Readonly<Record<string, unknown>>): void;
  warn(message: string, details: Readonly<Record<string, unknown>>): void;
  error(message: string, details: Readonly<Record<string, unknown>>): void;
};

export type CoreMcpStartupOptions = {
  readonly configPath: string;
  readonly providers: { reconcile(config: UniversalMcpConfig): void };
  readonly registry: { init(): Promise<void> };
  readonly callback: { start(): McpOAuthCallbackListenerStatus };
  readonly logger: CoreMcpStartupLogger;
  readonly readConfig?: typeof readMcpConfigFile;
};

export async function startCoreMcpServices(
  options: CoreMcpStartupOptions,
): Promise<{ readonly registryInit: Promise<void> }> {
  let config = createEmptyMcpConfig();
  const configResult = await (options.readConfig ?? readMcpConfigFile)(options.configPath);
  configResult.match({
    ok: (value) => {
      config = value.config;
    },
    err: (error) => {
      options.logger.warn("MCP OAuth providers reconciled to empty configuration", {
        path: options.configPath,
        error: formatTaggedErrorForLog(error).errorMessage,
      });
    },
  });
  options.providers.reconcile(config);

  const callbackStatus = options.callback.start();
  if (callbackStatus.status === "unavailable") {
    options.logger.warn("MCP OAuth callback listener unavailable", callbackStatus);
  } else {
    options.logger.info("MCP OAuth callback listener started", callbackStatus);
  }

  const registryInit = (async () => {
    const initialized = await Result.tryPromise({
      try: () => options.registry.init(),
      catch: (error) => ({ restoreError: () => error }),
    });
    const outcome = initialized.match<
      | { readonly kind: "success" }
      | { readonly kind: "failure"; readonly restoreError: () => unknown }
    >({
      ok: () => ({ kind: "success" }),
      err: ({ restoreError }) => ({ kind: "failure", restoreError }),
    });
    if (outcome.kind === "failure") {
      const error = outcome.restoreError();
      options.logger.error("MCP registry background initialization failed", {
        path: options.configPath,
        error: errorMessage(error),
      });
      rethrowPanic(error);
    }
  })();

  return { registryInit };
}

function subId(prefix: string, name: string): string {
  return `${prefix}:${name}`;
}

function runtimeFsDenyPaths(): readonly string[] {
  const home = process.env.HOME;
  return [
    path.resolve(env.dataDir, "secret"),
    path.resolve(env.dataDir, "tool-results"),
    ...(home ? [path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg")] : []),
  ];
}

function fffCacheDir(): string {
  return path.join(env.dataDir, ".cache", "fff");
}

export function openCoreDurableStoresInStartupOrder(input: {
  readonly openTranscript: () => void;
  readonly openDiscordSearch: () => void;
  readonly openDiscordSurface: () => void;
  readonly openConversationThread: () => void;
  readonly openDiscovery: () => void;
  readonly openWorkflow: () => void;
}): void {
  input.openTranscript();
  input.openDiscordSearch();
  input.openDiscordSurface();
  input.openConversationThread();
  input.openDiscovery();
  input.openWorkflow();
}

export async function createCoreRuntime(
  opts: CoreRuntimeOptions,
): Promise<CoreRuntimeCreateOutcome> {
  const logger = createLogger({
    logLevel: opts.logLevel,
    module: "core-runtime",
  });
  const blobStorageLogger = createLogger({
    logLevel: opts.logLevel,
    module: "blob-storage",
  });
  const requestDeliveryLogger = createLogger({
    logLevel: opts.logLevel,
    module: "request-delivery",
  });

  const subscriptionPrefix = opts.subscriptionPrefix ?? "core";
  const cwd =
    opts.cwd ??
    process.env.LILAC_WORKSPACE_DIR ??
    path.resolve(process.cwd(), env.dataDir, "workspace");
  const toolServerPort = opts.toolServerPort ?? Number(env.toolServer.port ?? 8080);
  const reportFatalError = createCoreRuntimeFatalReporter(opts.reportFatalError);

  logger.info("Core runtime init", {
    cwd,
    toolServerPort,
    subscriptionPrefix,
  });

  const loadedCoreConfig = (
    await Result.tryPromise({
      try: async () => {
        await publishConfigSchemas(env.dataDir);
        return getCoreConfig();
      },
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Core config startup preparation failed"),
  );
  const coreConfigSelection = loadedCoreConfig.match<
    | {
        readonly ok: true;
        readonly config: Awaited<ReturnType<typeof getCoreConfig>>;
      }
    | { readonly ok: false; readonly error: Error | Panic }
  >({
    ok: (config) => ({ ok: true, config }),
    err: (error) => ({ ok: false, error }),
  });
  if (!coreConfigSelection.ok) {
    if (isPanic(coreConfigSelection.error)) {
      return { kind: "panic", panic: coreConfigSelection.error };
    }
    return {
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "config",
          cause: coreConfigSelection.error,
          message: coreConfigSelection.error.message,
        }),
      ),
    };
  }
  const initialCoreConfig = coreConfigSelection.config;
  let currentCoreConfig = initialCoreConfig;
  const operatorTokenSha256 = process.env.LILAC_OPERATOR_TOKEN_SHA256;
  const nativeEnabled = initialCoreConfig.surface.native.enabled || Boolean(operatorTokenSha256);
  const discordEnabled =
    !nativeEnabled || Boolean(process.env[initialCoreConfig.surface.discord.tokenEnv]);
  let nativeInstallation: NativeInstallation | null = null;
  let nativeRuntime: NativeRuntime | null = null;
  let nativeConversationPlanner: ConversationThreadToolService | undefined;
  let activeTranscriptRetention = initialCoreConfig.agent.transcriptRetention;
  const createdBlobStore = await createCoreBlobStore({
    config: initialCoreConfig.blobStorage,
    dataDir: env.dataDir,
    logger: blobStorageLogger,
  });
  const blobStoreCreation = createdBlobStore.match<
    | { readonly ok: true; readonly store: BlobStore }
    | { readonly ok: false; readonly error: CoreBlobStoreCreateError }
  >({
    ok: (store) => ({ ok: true, store }),
    err: (error) => ({ ok: false, error }),
  });
  if (!blobStoreCreation.ok) {
    return {
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "blob-storage",
          cause: blobStoreCreation.error,
          message: blobStoreCreation.error.message,
        }),
      ),
    };
  }
  let blobStore: BlobStore | null = blobStoreCreation.store;
  let requestDeliveryStore: ReturnType<typeof createCoreRequestDelivery>["store"] | null = null;
  let agentRunJournal: SqliteAgentRunJournal | null = null;
  let questionStore: SqliteQuestionStore | null = null;
  let jobStore: SqliteJobStore | null = null;
  let jobService: JobService | null = null;
  let durableWorkflowStore: DurableWorkflowStore | null = null;
  let transcriptStore: SqliteTranscriptStore | null = null;
  let resourceService: CoreResourceService | null = null;
  let discordSearchStore: DiscordSearchStore | null = null;
  let discordSurfaceStore: DiscordSurfaceStore | null = null;
  let conversationThreadSearchPool: ConversationThreadSearchPool | null = null;
  let conversationThreadStore: ConversationThreadStore | null = null;
  let discoveryService: DiscoveryService | null = null;

  async function finishCoreRuntimeCreateFailure(
    outcome: CoreRuntimeCreateOutcome,
    eventBusResources: CoreEventBusResources | null = null,
  ): Promise<CoreRuntimeCreateOutcome> {
    const priorPanic = outcome.kind === "panic" ? outcome.panic : null;
    const cleanup = createCoreRuntimeCleanupSupervisor(priorPanic);
    if (eventBusResources) {
      await cleanup.run("eventBus.setup.close", async () => {
        adaptCoreEventBusCleanupResultToHost(
          await captureCoreEventBusCleanup({
            redis: eventBusResources.redis,
            raw: eventBusResources.raw,
            bus: eventBusResources.bus,
          }),
        );
      });
    }
    await cleanup.run(
      "agentRunJournal.createFailure.close",
      agentRunJournal
        ? async () => {
            agentRunJournal?.close();
            agentRunJournal = null;
          }
        : undefined,
    );
    await cleanup.run(
      "jobStore.createFailure.close",
      jobStore
        ? async () => {
            jobStore?.close();
            jobStore = null;
          }
        : undefined,
    );
    await cleanup.run(
      "questionStore.createFailure.close",
      questionStore
        ? async () => {
            questionStore?.close();
            questionStore = null;
          }
        : undefined,
    );
    await cleanup.run(
      "requestDeliveryStore.createFailure.close",
      requestDeliveryStore
        ? async () => {
            requestDeliveryStore?.close();
            requestDeliveryStore = null;
          }
        : undefined,
    );
    await cleanup.run("discoveryService.createFailure.close", async () => {
      discoveryService?.close();
      discoveryService = null;
    });
    await cleanup.run("nativeInstallation.createFailure.close", async () => {
      nativeInstallation?.database.close();
      nativeInstallation = null;
    });
    await cleanup.run("conversationThreadStore.createFailure.close", async () => {
      conversationThreadSearchPool?.close();
      conversationThreadSearchPool = null;
      conversationThreadStore?.close();
      conversationThreadStore = null;
    });
    await cleanup.run("discordSurfaceStore.createFailure.close", async () => {
      discordSurfaceStore?.close();
      discordSurfaceStore = null;
    });
    await cleanup.run("discordSearchStore.createFailure.close", async () => {
      discordSearchStore?.close();
      discordSearchStore = null;
    });
    await cleanup.run("transcriptStore.createFailure.close", async () => {
      transcriptStore?.close();
      transcriptStore = null;
    });
    await cleanup.run("durableWorkflowStore.createFailure.close", async () => {
      durableWorkflowStore?.close();
      durableWorkflowStore = null;
    });
    const ownedBlobStore = blobStore;
    blobStore = null;
    if (ownedBlobStore) {
      await cleanup.run("blobStore.createFailure.close.panic", async () => {
        const closed = await ownedBlobStore.close({
          deadlineAtMs: Date.now() + 1_000,
        });
        closed.match({
          ok: () => undefined,
          err: (error) => cleanup.record("blobStore.createFailure.close", error),
        });
      });
    }
    for (const failure of cleanup.failures) {
      logger.error("Core runtime create cleanup failed", {
        label: failure.label,
        error: failure.error,
        panic: failure.panic,
      });
    }
    if (priorPanic) return outcome;
    const cleanupPanic = cleanup.panics[0];
    return cleanupPanic ? { kind: "panic", panic: cleanupPanic } : outcome;
  }

  const requestDeliveryCreation = (
    await Result.tryPromise({
      try: async () => {
        await fs.mkdir(env.dataDir, { recursive: true });
        return createCoreRequestDelivery({
          dbPath: path.join(env.dataDir, "request-delivery.db"),
          blobStore: blobStoreCreation.store,
          logger: requestDeliveryLogger,
          inputBlobRetained: (objectId) =>
            transcriptStore
              ? transcriptStore.readCoreOwnedBlob(objectId).map((blob) => blob !== null)
              : Result.err(new Error("Transcript ownership is unavailable during input cleanup")),
          activity: {
            requestStarted: (id) => adapter.presence.requestStarted(id),
            requestSettled: (id) => adapter.presence.requestSettled(id),
          },
        });
      },
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Core request delivery store creation failed"),
  );
  const requestDeliverySelection = requestDeliveryCreation.match<
    | {
        readonly ok: true;
        readonly delivery: ReturnType<typeof createCoreRequestDelivery>;
      }
    | { readonly ok: false; readonly error: Error | Panic }
  >({
    ok: (delivery) => ({ ok: true, delivery }),
    err: (error) => ({ ok: false, error }),
  });
  if (!requestDeliverySelection.ok) {
    if (isPanic(requestDeliverySelection.error)) {
      return finishCoreRuntimeCreateFailure({
        kind: "panic",
        panic: requestDeliverySelection.error,
      });
    }
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "request-delivery",
          cause: requestDeliverySelection.error,
          message: requestDeliverySelection.error.message,
        }),
      ),
    });
  }
  const requestDeliveryCoordinator = requestDeliverySelection.delivery.coordinator;
  requestDeliveryStore = requestDeliverySelection.delivery.store;
  const journalCreation = Result.try({
    try: () =>
      new SqliteAgentRunJournal({
        dbPath: path.join(env.dataDir, "request-delivery.db"),
      }),
    catch: captureRuntimeError,
  });
  const journalMigrationFailure = journalCreation.match({
    ok: (journal) => {
      agentRunJournal = journal;
      return null;
    },
    err: (captured) => {
      if (captured.kind === "error" && captured.error instanceof AgentRunJournalMigrationFailure) {
        return captured.error;
      }
      logger.warn("Agent run journal disabled for this boot", {
        error: safeRuntimeErrorText(captured, "Agent run journal creation failed"),
      });
      return null;
    },
  });
  // Running without the journal would restart and prune the runs its unmigrated checkpoints hold.
  if (journalMigrationFailure) {
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "request-delivery",
          cause: journalMigrationFailure,
          message: journalMigrationFailure.message,
        }),
      ),
    });
  }
  const jobServiceCreation = Result.try({
    try: () => {
      const store = new SqliteJobStore({ dbPath: path.join(env.dataDir, "background-jobs.db") });
      jobStore = store;
      return new JobService({ store, logDir: path.join(env.dataDir, "background-jobs") });
    },
    catch: captureRuntimeError,
  }).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Background job store creation failed"),
  );
  const jobServiceError = jobServiceCreation.match({
    ok: (service) => {
      jobService = service;
      // Runs before the agent runner so recovered requests see their jobs as lost.
      service.reconcileAfterRestart();
      return null;
    },
    err: (error) => error,
  });
  if (jobServiceError) {
    if (isPanic(jobServiceError)) {
      return finishCoreRuntimeCreateFailure({ kind: "panic", panic: jobServiceError });
    }
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "request-delivery",
          cause: jobServiceError,
          message: "Background job store creation failed",
        }),
      ),
    });
  }
  const questionStoreCreation = Result.try({
    try: () =>
      new SqliteQuestionStore({
        dbPath: path.join(env.dataDir, "request-delivery.db"),
      }),
    catch: captureRuntimeError,
  }).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Question store creation failed"),
  );
  const questionStoreError = questionStoreCreation.match({
    ok: (store) => {
      questionStore = store;
      return null;
    },
    err: (error) => error,
  });
  if (questionStoreError) {
    if (isPanic(questionStoreError)) {
      return finishCoreRuntimeCreateFailure({ kind: "panic", panic: questionStoreError });
    }
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "request-delivery",
          cause: questionStoreError,
          message: "Question store creation failed",
        }),
      ),
    });
  }
  const durableStoresCreated = Result.try({
    try: () => {
      const discordSearchDbPath = resolveDiscordSearchDbPath();
      const discordSurfaceDbPath = resolveDiscordDbPath(initialCoreConfig);
      openCoreDurableStoresInStartupOrder({
        openTranscript: () => {
          transcriptStore = new SqliteTranscriptStore(
            resolveTranscriptDbPath(),
            undefined,
            undefined,
            {
              deferStartupRecovery: true,
              getRetention: () => activeTranscriptRetention,
            },
          );
        },
        openDiscordSearch: () => {
          discordSearchStore = new DiscordSearchStore(discordSearchDbPath);
        },
        openDiscordSurface: () => {
          discordSurfaceStore = new DiscordSurfaceStore(discordSurfaceDbPath);
        },
        openConversationThread: () => {
          conversationThreadStore = new ConversationThreadStore(discordSearchDbPath, {
            surfaceDbPath: discordSurfaceDbPath,
            mainAgentUserNames: [initialCoreConfig.surface.discord.botName],
          });
        },
        openDiscovery: () => {
          discoveryService = new DiscoveryService({
            dbPath: resolveDiscoveryDbPath(),
            dataDir: env.dataDir,
            discordSearchStore: discordSearchStore ?? undefined,
            transcriptStore: transcriptStore ?? undefined,
            getConfig: () => getCoreConfig(),
          });
        },
        openWorkflow: () => {
          durableWorkflowStore = new DurableWorkflowStore(undefined, {
            deferStartupRecovery: true,
          });
        },
      });
      transcriptStore?.initializeStartupRecovery();
      durableWorkflowStore?.initializeStartupRecovery();
    },
    catch: captureRuntimeError,
  }).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Core durable store preflight failed"),
  );
  const durableStoreCreationFailure = durableStoresCreated.match<Error | Panic | null>({
    ok: () => null,
    err: (error) => error,
  });
  if (durableStoreCreationFailure) {
    if (isPanic(durableStoreCreationFailure)) {
      return finishCoreRuntimeCreateFailure({
        kind: "panic",
        panic: durableStoreCreationFailure,
      });
    }
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "durable-stores",
          cause: durableStoreCreationFailure,
          message: durableStoreCreationFailure.message,
        }),
      ),
    });
  }
  const requestDeliveryPostCommitObserver = createRequestDeliveryPostCommitObserver({
    observeTransportCommit: (requestDeliveryId, streamId) =>
      requestDeliveryCoordinator.observeTransportCommit(requestDeliveryId, streamId),
  });

  const redisUrl = env.redisUrl;
  let eventBusSetup: CoreEventBusSetupOutcome;
  if (!redisUrl) {
    logger.error("Missing REDIS_URL env var (required)");
    eventBusSetup = {
      kind: "result",
      result: Result.err(
        new CoreEventBusSetupFailed({
          operation: "read-config",
          cause: undefined,
          message: "REDIS_URL must be set",
        }),
      ),
    };
  } else {
    eventBusSetup = await setupCoreEventBusResources({
      redisUrl,
      cwd,
      dataDir: env.dataDir,
      evidenceBlobStore: blobStoreCreation.store,
      logger,
      reportFatalError,
      postCommitObserver: requestDeliveryPostCommitObserver,
    });
  }
  if (eventBusSetup.kind === "panic") {
    return finishCoreRuntimeCreateFailure(eventBusSetup);
  }
  const eventBusSetupError = eventBusSetup.result.match({
    err: (error) => error,
    ok: () => null,
  });
  if (eventBusSetupError) {
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "event-bus",
          cause: eventBusSetupError,
          message: eventBusSetupError.message,
        }),
      ),
    });
  }
  const eventBusResources = eventBusSetup.result.match({
    ok: (value) => value,
    err: () => null,
  });
  if (!eventBusResources) {
    const missingResources = new CoreEventBusSetupFailed({
      operation: "create-lilac-bus",
      cause: undefined,
      message: "Core event bus setup returned no resources",
    });
    return finishCoreRuntimeCreateFailure({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "event-bus",
          cause: missingResources,
          message: "Core event bus setup returned no resources",
        }),
      ),
    });
  }
  const { redis, raw, bus, canonicalWorkspaceRoot } = eventBusResources;

  const customCommandManager = new CustomCommandManager(env.dataDir);
  const customCommandsInitialized = await customCommandManager.init();
  const customCommandFailure = customCommandsInitialized.match<
    () => CoreRuntimeCreateOutcome | null
  >({
    ok: () => () => null,
    err: (error) => () => ({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "custom-commands",
          cause: error,
          message: error.message,
        }),
      ),
    }),
  })();
  if (customCommandFailure) {
    return finishCoreRuntimeCreateFailure(customCommandFailure, eventBusResources);
  }
  const customCommands = customCommandManager;
  const loadedCustomCommands = customCommands.list();
  const customCommandWarnings = customCommands.listWarnings();
  logger.debug("custom commands initialized", {
    dataDir: env.dataDir,
    commandsDir: resolveCustomCommandsDir(env.dataDir),
    discoveredCount: loadedCustomCommands.length + customCommandWarnings.length,
    loadedCount: loadedCustomCommands.length,
    warningCount: customCommandWarnings.length,
    loadedNames: loadedCustomCommands.map((command) => command.def.name),
  });
  for (const warning of customCommandWarnings) {
    logger.warn("custom command skipped", { warning });
  }

  let pluginManager: CoreToolPluginManager | null = null;
  let contextReportProvider: DiscordContextReportProvider | null = null;
  const buildContextReport: DiscordContextReportProvider = (request) => {
    const provider = contextReportProvider;
    return provider
      ? provider(request)
      : Promise.resolve(
          Result.err(
            new DiscordContextReportFailed({
              stage: "tools",
              message: "Context reporting is not ready yet",
            }),
          ),
        );
  };
  const adapter = new DiscordAdapter({
    customCommands,
    contextReport: buildContextReport,
    reportFatalPanic: reportFatalError,
  });
  const githubAdapter = new GithubAdapter();
  const discordEventSource = createDescriptorBoundSurfaceEventSource("discord", adapter);
  let discordSearchService: DiscordSearchService | null = null;
  let conversationThreadService: ConversationThreadService | null = null;
  let conversationThreadMaterializer: ConversationThreadMaterializer | null = null;

  let started = false;
  let fullCleanupPending = true;

  const connectedSurfaceAdapters: ConnectedSurfaceAdapters = new Map();
  const surfaceAdapterIngressHandles: SurfaceAdapterIngressHandles = new Map();
  const surfaceRequestIngressHandles: SurfaceRequestIngressHandles = new Map();
  const surfaceRelayHandles: SurfaceRelayHandles = new Map();
  let stopDiscordSearchIndexer: { stop(): Promise<void> } | null = null;
  let stopRouter: DiscordRequestRouter | null = null;
  let routerSupervision: Promise<void> | null = null;
  let residualRouter: ResidualDiscordRequestRouter | null = null;
  const residualRouterDoneSupervisions: Array<
    Promise<CoreResidualDiscordRequestRouterDoneOutcome>
  > = [];
  let stopWorkflowActionResolver: { stop(): Promise<void> } | null = null;
  let workflowProgressProjector: WorkflowProgressProjector | null = null;
  let workflowEngine: WorkflowEngine | null = null;
  let workflowWaitResolver: WorkflowWaitResolver | null = null;
  let workflowTriggerScheduler: WorkflowTriggerScheduler | null = null;
  let workflowLiveParentBridge: WorkflowLiveParentBridge | null = null;
  let workflowSubagentDispatcher: WorkflowSubagentDispatcher | null = null;
  let questionService: QuestionService | null = null;
  let stopAgentRunner: Awaited<ReturnType<typeof startBusAgentRunner>> | null = null;
  let stopHeartbeat: HeartbeatService | null = null;
  let stopConversationThreadWorker: Awaited<
    ReturnType<typeof startConversationThreadWorker>
  > | null = null;
  let stopConversationThreadSummarizationWorker: Awaited<
    ReturnType<typeof startConversationThreadSummarizationWorker>
  > | null = null;
  let conversationThreadSummarizationRunner: ConversationThreadSummarizationRunner | null = null;
  let conversationThreadSummarizationStopping = false;

  let requestMessageCache: RequestMessageCache | null = null;
  const requestControlAuthority = new RequestControlAuthority();
  const mcpConfigPath = resolveMcpConfigPath({ dataDir: env.dataDir });
  const mcpOAuthProviders = new McpOAuthProviderService({
    dataDir: env.dataDir,
    configBaseDir: path.dirname(mcpConfigPath),
  });
  const mcpOAuthCallback = new McpOAuthCallbackService({
    providers: mcpOAuthProviders,
  });
  const mcpRegistryCreated = createMcpRegistryResult({
    configPath: mcpConfigPath,
    onRecoveryEvent: (event) => {
      if (event.event === "exhausted") {
        logger.error("MCP recovery exhausted", event);
        return;
      }
      logger.info("MCP recovery", event);
    },
    reportFatalError,
    dependencies: {
      createAuthProvider: ({ server }) => mcpOAuthProviders.getProvider(server.id),
    },
  });
  let mcpRegistry: McpRegistry;
  const mcpRegistryFailure = mcpRegistryCreated.match<() => CoreRuntimeCreateOutcome | null>({
    ok: (value) => () => {
      mcpRegistry = value;
      return null;
    },
    err: (error) => () => ({
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "mcp-registry",
          cause: error,
          message: error.message,
        }),
      ),
    }),
  })();
  if (mcpRegistryFailure) {
    return finishCoreRuntimeCreateFailure(mcpRegistryFailure, eventBusResources);
  }
  let surfaceRuntimeRegistry: SurfaceRuntimeRegistry | null = null;
  let runtimeFullyStarted = false;
  let routerSubscriptionHealthy = true;
  let mcpRegistryInitPromise: Promise<void> | null = null;
  let coreConfigWatcher: FSWatcher | null = null;
  let coreConfigValidationTimer: ReturnType<typeof setTimeout> | null = null;
  let coreConfigValidationHadError = false;
  let lastCoreConfigValidationError: string | null = null;
  let requestDeliveryMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let requestDeliveryMaintenanceOperation: Promise<void> | null = null;

  function runDetachedRequestDeliveryMaintenance(): void {
    if (requestDeliveryMaintenanceOperation) return;
    const cycle = Promise.resolve().then(async () => {
      const activeBlobStore = blobStore;
      const nativeMaintenance = await nativeRuntime?.maintain();
      nativeMaintenance?.match({
        ok: () => undefined,
        err: (error) =>
          logger.warn("Native surface maintenance deferred", { error: error.message }),
      });
      const [
        maintained,
        maintainedBlobs,
        maintainedResources,
        maintainedTranscriptBlobs,
        maintainedWorkflowArtifacts,
      ] = await Promise.all([
        requestDeliveryCoordinator.maintain(),
        activeBlobStore ? activeBlobStore.maintain() : Promise.resolve(null),
        resourceService?.maintain({ limit: 64 }) ?? Promise.resolve(null),
        activeBlobStore && transcriptStore
          ? transcriptStore.maintainCoreOwnedBlobs({
              blobStore: activeBlobStore,
              limit: 64,
            })
          : Promise.resolve(null),
        activeBlobStore && durableWorkflowStore
          ? maintainWorkflowArtifactPublications({
              blobStore: activeBlobStore,
              workflowStore: durableWorkflowStore,
              limit: 64,
            })
          : Promise.resolve(null),
      ]);
      maintained.match({
        err: (error) =>
          logger.error("Core request delivery maintenance failed", {
            ...formatTaggedErrorForLog(error),
          }),
        ok: (summary) => {
          if (summary.failures.length === 0) return;
          logger.warn(
            "Core request delivery maintenance completed with deletion failures",
            formatTaggedErrorForLog(summary.failures[0]!),
          );
        },
      });
      maintainedWorkflowArtifacts?.match({
        ok: () => undefined,
        err: (error) =>
          logger.warn(
            "Workflow artifact publication recovery deferred",
            formatTaggedErrorForLog(error),
          ),
      });
      maintainedBlobs?.match({
        err: (error) =>
          logger.error("Core blob storage maintenance failed", {
            ...formatTaggedErrorForLog(error),
          }),
        ok: () => undefined,
      });
      maintainedResources?.match({
        err: (error) =>
          logger.error("Core resource maintenance failed", {
            ...formatTaggedErrorForLog(error),
          }),
        ok: (summary) => {
          if (summary.failed === 0) return;
          logger.warn("Core resource maintenance completed with blob deletion failures", {
            failed: summary.failed,
            inspected: summary.inspected,
          });
        },
      });
      maintainedTranscriptBlobs?.match({
        err: (error) =>
          logger.error("Core transcript blob maintenance failed", {
            errorTag: error.name,
            errorMessage: error.message,
          }),
        ok: (summary) => {
          if (summary.failed === 0) return;
          logger.warn("Core transcript blob maintenance completed with deletion failures", {
            failed: summary.failed,
            inspected: summary.inspected,
          });
        },
      });
    });
    const supervision = Promise.allSettled([cycle]).then(([settled]) => {
      if (settled.status !== "rejected") return;
      const failure = projectRuntimeError(
        settled.reason,
        "Detached Core request delivery maintenance failed",
      );
      if (isPanic(failure)) {
        reportFatalError(failure);
        return;
      }
      logger.error("Detached Core request delivery maintenance failed");
    });
    requestDeliveryMaintenanceOperation = supervision;
    void supervision.then(() => {
      if (requestDeliveryMaintenanceOperation === supervision) {
        requestDeliveryMaintenanceOperation = null;
      }
    });
  }

  function startRequestDeliveryMaintenance(): void {
    if (requestDeliveryMaintenanceTimer) return;
    requestDeliveryMaintenanceTimer = setInterval(
      runDetachedRequestDeliveryMaintenance,
      CORE_REQUEST_DELIVERY_MAINTENANCE_INTERVAL_MS,
    );
    requestDeliveryMaintenanceTimer.unref?.();
  }

  async function readCoreConfigParserVersion(configPath: string): Promise<number | "unknown"> {
    const loaded = (
      await Result.tryPromise({
        try: async (): Promise<number | "unknown"> => {
          const version = readCoreConfigVersionResult(
            Bun.YAML.parse(await fs.readFile(configPath, "utf8")),
          );
          return version.match<number | "unknown">({
            ok: (value) => value,
            err: () => "unknown",
          });
        },
        catch: captureRuntimeError,
      })
    ).mapError((captured) =>
      projectCapturedRuntimeError(captured, "Core config version read failed"),
    );
    return loaded.match<() => number | "unknown">({
      ok: (value) => () => value,
      err: (error) => () => {
        if (isPanic(error)) throw error;
        return "unknown";
      },
    })();
  }

  let toolServer: {
    init(): Promise<void>;
    start(port: number): Promise<void>;
    stop(): Promise<void>;
    reload(): Promise<void>;
    recordUnhandledRejection(reason: Error): void;
  } | null = null;

  // How long shutdown waits for active runs and relays before interrupting them.
  const GRACEFUL_DRAIN_DEADLINE_MS = 3_000;
  const DEFAULT_HARD_SHUTDOWN_DEADLINE_MS = 5_000;
  const REDIS_HEALTH_TIMEOUT_MS = 1_000;

  async function probeRedisHealth(): Promise<{
    ok: boolean;
    durationMs: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pinged = (
      await Result.tryPromise({
        try: async () => {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`redis ping timed out after ${REDIS_HEALTH_TIMEOUT_MS}ms`));
            }, REDIS_HEALTH_TIMEOUT_MS);
            timer.unref?.();
          });
          await Promise.race([redis.ping(), timeout]);
        },
        catch: captureRuntimeError,
      })
    ).mapError((captured) => projectCapturedRuntimeError(captured, "Redis health probe failed"));
    if (timer) clearTimeout(timer);
    return pinged.match({
      ok: () => () => ({ ok: true, durationMs: Date.now() - startedAt }),
      err: (error) => () => {
        if (isPanic(error)) throw error;
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: errorMessage(error),
        };
      },
    })();
  }

  async function getRuntimeHealthReport(
    options: { includeMemoryDiagnostics?: boolean } = {},
  ): Promise<ToolServerHealthProviderResult> {
    const now = Date.now();
    const checks: ToolServerHealthCheck[] = [
      {
        name: "runtime.started",
        ok: runtimeFullyStarted,
        impact: "ready",
        reason: runtimeFullyStarted ? undefined : "core runtime has not completed startup",
      },
      {
        name: "runtime.router-subscriptions",
        ok: !started || routerSubscriptionHealthy,
        impact: "live",
        reason:
          !started || routerSubscriptionHealthy
            ? undefined
            : "Discord request router subscriptions terminated unexpectedly",
      },
    ];

    const surfaceInfo: Record<string, object> = {};
    const surfaceMemoryDiagnostics: Record<string, object> = {};
    for (const descriptor of surfaceRuntimeRegistry?.entries() ?? []) {
      if (!descriptor.health) continue;
      const contribution = await descriptor.health.getContribution({
        now,
        runtimeFullyStarted,
        includeMemoryDiagnostics: options.includeMemoryDiagnostics === true,
      });
      checks.push(...contribution.checks);
      surfaceInfo[descriptor.platform] = contribution.info;
      if (contribution.memoryDiagnostics) {
        surfaceMemoryDiagnostics[descriptor.platform] = contribution.memoryDiagnostics;
      }
    }

    const redisHealth = await probeRedisHealth();
    checks.push({
      name: "redis.ping",
      ok: redisHealth.ok,
      impact: "live",
      reason: redisHealth.ok ? undefined : redisHealth.error,
      details: redisHealth,
    });

    return {
      checks,
      ...(options.includeMemoryDiagnostics
        ? {
            memoryDiagnostics: {
              ...surfaceMemoryDiagnostics,
              openObserve: getOpenObserveDiagnostics(),
            },
          }
        : {}),
      info: {
        runtime: {
          started,
          runtimeFullyStarted,
          mcpRegistryInitPending: mcpRegistryInitPromise !== null,
          mcpOAuthCallback: mcpOAuthCallback.getStatus(),
        },
        ...surfaceInfo,
        redis: redisHealth,
      },
    };
  }

  async function validateCoreConfigOnChange(reason: "watch"): Promise<void> {
    const configPath = resolveCoreConfigPath();

    const loaded = (
      await Result.tryPromise({
        try: () => getCoreConfig({ forceReload: true }),
        catch: captureRuntimeError,
      })
    ).mapError((captured) => projectCapturedRuntimeError(captured, "Core config reload failed"));
    await loaded.match({
      ok: (config) => async () => {
        activeTranscriptRetention = config.agent.transcriptRetention;
        currentCoreConfig = config;
        await nativeRuntime?.updateCatalog();
        if (coreConfigValidationHadError) {
          logger.info("core-config hot-reload validation recovered", {
            reason,
            path: configPath,
            parserVersion: config.configVersion,
          });
        } else {
          logger.info("core-config hot-reload validation succeeded", {
            reason,
            path: configPath,
            parserVersion: config.configVersion,
          });
        }

        coreConfigValidationHadError = false;
        lastCoreConfigValidationError = null;
        if (discordEnabled) await adapter.refreshCoreConfig();
        await toolServer?.reload();
        conversationThreadMaterializer?.invalidate();
      },
      err: (error) => async () => {
        if (isPanic(error)) throw error;
        const failure = new CoreRuntimeExternalFailure({
          operation: "reload-config",
          cause: error,
          message: "Core config reload failed",
        });
        const logError = formatTaggedErrorForLog(failure);
        const msg = logError.errorMessage;
        if (!coreConfigValidationHadError || lastCoreConfigValidationError !== msg) {
          const parserVersion = await readCoreConfigParserVersion(configPath);
          logger.warn("core-config hot-reload validation failed", {
            reason,
            path: configPath,
            parserVersion,
            error: msg,
          });
        }

        coreConfigValidationHadError = true;
        lastCoreConfigValidationError = msg;
      },
    })();
  }

  function scheduleCoreConfigValidation(reason: "watch"): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
    }

    coreConfigValidationTimer = setTimeout(() => {
      coreConfigValidationTimer = null;
      void superviseDetachedCoreConfigValidation({
        validate: () => validateCoreConfigOnChange(reason),
        reportFatalError,
      });
    }, 200);
  }

  async function startCoreConfigWatcher(): Promise<void> {
    const configPath = resolveCoreConfigPath();
    const configDir = path.dirname(configPath);
    const configFileName = path.basename(configPath);

    const startedWatcher = (
      await Result.tryPromise({
        try: async () => {
          const watchState = {
            lastContent: await fs.readFile(configPath, "utf8"),
          };
          coreConfigWatcher = watch(configDir, (eventType, filename) => {
            void handleCoreConfigWatchEvent({
              configPath,
              configFileName,
              eventType,
              filename,
              state: watchState,
              logger,
              scheduleValidation: scheduleCoreConfigValidation,
            });
          });

          coreConfigWatcher.on("error", (error: Error) => {
            logger.warn("core-config watcher error", {
              path: configPath,
              error: safeRuntimeErrorText(error, "Opaque core-config watcher failure"),
            });
          });

          logger.debug("Core config hot-reload validator started", {
            path: configPath,
            parserVersion: await readCoreConfigParserVersion(configPath),
          });
        },
        catch: captureRuntimeError,
      })
    ).mapError((captured) =>
      projectCapturedRuntimeError(captured, "Core config watcher startup failed"),
    );
    startedWatcher.match({
      ok: () => () => undefined,
      err: (error) => () => {
        if (isPanic(error)) throw error;
        const failure = new CoreRuntimeExternalFailure({
          operation: "start-config-watcher",
          cause: error,
          message: "Core config watcher startup failed",
        });
        logger.warn("Core config hot-reload validator disabled", {
          path: configPath,
          ...formatTaggedErrorForLog(failure),
        });
        coreConfigWatcher = null;
      },
    })();
  }

  function stopCoreConfigWatcher(): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
      coreConfigValidationTimer = null;
    }
    coreConfigWatcher?.close();
    coreConfigWatcher = null;
  }

  async function start(): Promise<CoreRuntimeStartOutcome> {
    if (started) return { kind: "result", result: Result.ok(undefined) };
    started = true;
    fullCleanupPending = true;
    routerSubscriptionHealthy = true;
    conversationThreadSummarizationStopping = false;

    const startup = (
      await Result.tryPromise({
        try: async (): Promise<CoreRuntimeStartOutcome> => {
          const activeBlobStore = blobStore;
          if (!activeBlobStore) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "blob-storage",
                  cause: undefined,
                  message: "Core runtime cannot restart after its blob store has closed",
                }),
              ),
            };
          }
          const startupConfig = initialCoreConfig;
          const activeDurableWorkflowStore = durableWorkflowStore;
          const activeTranscriptStore = transcriptStore;
          const activeDiscordSearchStore = discordSearchStore;
          const activeDiscordSurfaceStore = discordSurfaceStore;
          const activeConversationThreadStore = conversationThreadStore;
          if (
            !activeDurableWorkflowStore ||
            !activeTranscriptStore ||
            !activeDiscordSearchStore ||
            !activeDiscordSurfaceStore ||
            !activeConversationThreadStore ||
            !discoveryService
          ) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: undefined,
                  message: "Core runtime cannot restart after its durable stores have closed",
                }),
              ),
            };
          }
          const recoveredArtifactPublications = await maintainWorkflowArtifactPublications({
            blobStore: activeBlobStore,
            workflowStore: activeDurableWorkflowStore,
          });
          recoveredArtifactPublications.match({
            ok: () => undefined,
            err: (error) =>
              logger.warn(
                "Workflow artifact startup publication recovery deferred",
                formatTaggedErrorForLog(error),
              ),
          });
          const requestDeliveryPublisher = createLilacBusRequestDeliveryPublisher(bus);
          const durableBus = createDurableCoreRequestBus({
            transportBus: bus,
            coordinator: requestDeliveryCoordinator,
            publisher: requestDeliveryPublisher,
          });
          const preparedRecovery =
            await requestDeliveryCoordinator.recoverPreparedPublications(requestDeliveryPublisher);
          const preparedRecoveryFailure = preparedRecovery.match<Error | null>({
            err: (error) => error,
            ok: (summary) => summary.failures[0] ?? null,
          });
          if (preparedRecoveryFailure) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: preparedRecoveryFailure,
                  message: "Core request publication recovery failed",
                }),
              ),
            };
          }
          const initialRequestDeliveryMaintenance = await requestDeliveryCoordinator.maintain();
          const initialRequestDeliveryMaintenanceFailure =
            initialRequestDeliveryMaintenance.match<Error | null>({
              err: (error) => error,
              ok: () => null,
            });
          if (initialRequestDeliveryMaintenanceFailure) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: initialRequestDeliveryMaintenanceFailure,
                  message: "Core request delivery startup maintenance failed",
                }),
              ),
            };
          }
          initialRequestDeliveryMaintenance.match({
            err: () => undefined,
            ok: (summary) => {
              if (summary.failures.length === 0) return;
              logger.warn(
                "Core request delivery startup maintenance completed with deletion failures",
                formatTaggedErrorForLog(summary.failures[0]!),
              );
            },
          });
          const initialTranscriptBlobMaintenance =
            await activeTranscriptStore.maintainCoreOwnedBlobs({
              blobStore: activeBlobStore,
              limit: 64,
            });
          initialTranscriptBlobMaintenance.match({
            err: (error) =>
              logger.warn("Core transcript blob startup maintenance failed", {
                errorTag: error.name,
                errorMessage: error.message,
              }),
            ok: (summary) => {
              if (summary.failed === 0) return;
              logger.warn(
                "Core transcript blob startup maintenance completed with deletion failures",
                { failed: summary.failed, inspected: summary.inspected },
              );
            },
          });
          startRequestDeliveryMaintenance();
          const discordRequestDelivery: DiscordRequestDeliveryPort = {
            async prepareAndPublish(input) {
              return (
                await requestDeliveryCoordinator.prepareAndPublish(input, requestDeliveryPublisher)
              )
                .map(() => undefined)
                .mapError(
                  (error) =>
                    new DiscordRequestDeliveryFailed({
                      cause: error,
                      message: error.message,
                    }),
                );
            },
          };
          const attachmentOutputLifecycle: AttachmentOutputLifecycle = {
            registerOutputHandle(input) {
              if (!input.requestDeliveryId) {
                return Result.err(
                  new AttachmentOutputLifecycleError({
                    message: "Attachment output registration requires requestDeliveryId",
                  }),
                );
              }
              return requestDeliveryCoordinator
                .registerOutputHandle({
                  requestDeliveryId: input.requestDeliveryId,
                  handle: input.handle,
                  metadata: {
                    mimeType: input.mimeType,
                    ...(input.filename ? { filename: input.filename } : {}),
                  } satisfies CoreRequestOutputMetadata,
                })
                .map(() => undefined)
                .mapError(
                  (error) =>
                    new AttachmentOutputLifecycleError({
                      message: error.message,
                    }),
                );
            },
          };

          const toolResultArtifacts = createToolResultArtifactStore(
            path.join(env.dataDir, "tool-results"),
            activeBlobStore,
          );
          const artifactStoreInit = await toolResultArtifacts.init();
          adaptToolResultArtifactStoreInitToHost(artifactStoreInit);

          const mcpStartup = await startCoreMcpServices({
            configPath: mcpConfigPath,
            providers: mcpOAuthProviders,
            registry: mcpRegistry,
            callback: mcpOAuthCallback,
            logger,
          });
          const registryInitPromise = mcpStartup.registryInit.finally(() => {
            if (mcpRegistryInitPromise === registryInitPromise) mcpRegistryInitPromise = null;
          });
          mcpRegistryInitPromise = registryInitPromise;

          const githubAppSecret = await readGithubAppSecretResult(env.dataDir);
          let githubAppCredentialsAvailable = false;
          const githubAppSecretError = githubAppSecret.match({
            err: (error) => error,
            ok: (value) => {
              githubAppCredentialsAvailable = value !== null;
              return null;
            },
          });
          if (githubAppSecretError) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: githubAppSecretError,
                  message: githubAppSecretError.message,
                }),
              ),
            };
          }
          resourceService = new CoreResourceService({
            store: activeTranscriptStore,
            blobStore: activeBlobStore,
            originAdapters: new ResourceOriginAdapterRegistry(
              discordEnabled ? [createDiscordResourceOriginAdapter(adapter)] : [],
            ),
            logger: createLogger({ module: "core-resource" }),
          });
          if (nativeEnabled) {
            nativeInstallation = nativeRuntimeResultToHost(
              await openNativeInstallation({
                config: startupConfig.surface.native,
                secrets: { ...env.native, operatorTokenSha256 },
                dataDir: env.dataDir,
              }),
            );
            nativeRuntime = nativeRuntimeResultToHost(
              await createNativeRuntime({
                ...(jobService ? { jobs: jobService } : {}),
                installation: nativeInstallation,
                bus: durableBus,
                blobs: activeBlobStore,
                transcript: activeTranscriptStore,
                resourceAccess: resourceService,
                getConfig: () => currentCoreConfig,
                dataDir: env.dataDir,
                workspaceRoot: canonicalWorkspaceRoot,
                denyPaths: runtimeFsDenyPaths(),
                subscriptionPrefix,
                customCommands,
                mcpRegistry,
                adapters: {
                  registeredPlatforms: () =>
                    surfaceRuntimeRegistry?.adapterResolver().registeredPlatforms() ?? [],
                  resolve: (platform) =>
                    surfaceRuntimeRegistry?.adapterResolver().resolve(platform) ?? null,
                },
                conversationThreads: () => nativeConversationPlanner,
                runner: () => stopAgentRunner ?? undefined,
                workflows: activeDurableWorkflowStore,
                externalHistory: conversationThreadStore ?? undefined,
                externalOutputs: (requestId) =>
                  requestDeliveryStore!
                    .listOutputsForRequest(requestId)
                    .mapError(() => nativeFailure("sqlite", "Attachment history is unavailable")),
                deliveryState: (id) =>
                  requestDeliveryStore!
                    .load(id)
                    .map((record) => {
                      if (record.state !== "terminal") return "owned" as const;
                      const kind = record.outcome.kind;
                      if (kind === "completed" || kind === "cancelled" || kind === "abandoned")
                        return kind;
                      return "failed" as const;
                    })
                    .tryRecover((error) =>
                      error._tag === "RequestDeliveryNotFound"
                        ? Result.ok("missing" as const)
                        : Result.err(error),
                    ),
                reportFatalError,
                warn: (message, error) => logger.warn(message, { error: error.message }),
                publishableKey: env.native.clerkPublishableKey,
                operatorTokenSha256,
              }),
            );
            nativeRuntimeResultToHost(await nativeRuntime.startOutput());
          }
          const registryCreated = composeBuiltinSurfaceRuntimes({
            discordAdapter: adapter,
            discordEnabled,
            ...(nativeRuntime ? { nativeDescriptor: nativeRuntime.descriptor } : {}),
            discordQuestionAnswers: adapter,
            githubAdapter,
            descriptorBoundDiscordEventSource: discordEventSource,
            discordHealth: createDiscordRuntimeHealthPort(adapter),
            bus: durableBus,
            blobStore: activeBlobStore,
            subscriptionPrefix,
            webhookSecret: env.github.webhookSecret,
            githubAppCredentialsAvailable,
            getTranscriptStore: () => activeTranscriptStore,
            logger,
            reportFatalError,
          });
          const registryError = registryCreated.match({
            err: (error) => error,
            ok: () => null,
          });
          if (registryError) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: registryError,
                  message: registryError.message,
                }),
              ),
            };
          }
          const registry = registryCreated.match({
            ok: (value) => value,
            err: () => null,
          });
          if (!registry) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: undefined,
                  message: "Surface runtime composition returned no registry",
                }),
              ),
            };
          }
          surfaceRuntimeRegistry = registry;
          const surfaceAdapter =
            registry.entries().find((descriptor) => descriptor.platform === "discord")?.adapter ??
            adapter;
          const initialResourceMaintenance = await resourceService.maintain({
            limit: 64,
          });
          initialResourceMaintenance.match({
            err: (error) =>
              logger.warn(
                "Core resource startup maintenance failed",
                formatTaggedErrorForLog(error),
              ),
            ok: () => undefined,
          });
          const workflowProgressPorts = createSurfaceWorkflowProgressPortMap(registry);
          if (startupConfig.tools.fsBackend === "fff") {
            void prewarmFffFinders({
              basePaths: ["/data", "/data/workspace", "/app", cwd],
              denyPaths: runtimeFsDenyPaths(),
              cacheDir: fffCacheDir(),
            }).then((results) => {
              logger.debug("fff finder prewarm completed", {
                results,
              });
            });
          }

          await startCoreConfigWatcher();

          const discordSearchDbPath = resolveDiscordSearchDbPath();
          const discordSurfaceDbPath = resolveDiscordDbPath(startupConfig);
          const conversationThreadEntityMapper = createDiscordEntityMapper({
            cfg: startupConfig,
            store: activeDiscordSurfaceStore,
          });
          const getConversationThreadEmbeddingAdapter =
            createConversationThreadEmbeddingAdapterResolver(() => getCoreConfig());
          conversationThreadMaterializer = startConversationThreadMaterializer({
            searchDbPath: discordSearchDbPath,
            surfaceDbPath: discordSurfaceDbPath,
          });
          rebuildDiscordConversationThreads(
            conversationThreadMaterializer,
            () => conversationThreadStore,
          );
          discordSearchService = new DiscordSearchService({
            adapter: surfaceAdapter,
            store: activeDiscordSearchStore,
            onMessagesIndexed(channelId) {
              conversationThreadMaterializer?.markDirty({
                channelId,
                kind: "topology",
              });
            },
          });
          const hydrateThreadAttachments: ConversationThreadAttachmentHydrator = async (input) => {
            const hydrated: Awaited<
              ReturnType<ConversationThreadAttachmentHydrator>
            > extends ResultType<infer Value, ConversationThreadOperationFailed>
              ? Value
              : never = [];
            const hydrateNativeAt = async (
              index: number,
              ref: Parameters<ConversationThreadAttachmentHydrator>[0]["refs"][number],
            ): Promise<ResultType<typeof hydrated, ConversationThreadOperationFailed>> => {
              if (!nativeRuntime)
                return Result.err(
                  new ConversationThreadOperationFailed({
                    operation: "summarize-thread",
                    message: "Native conversation storage is unavailable",
                  }),
                );
              const remainingBytes =
                50 * 1024 * 1024 -
                hydrated.reduce(
                  (total, item) =>
                    total +
                    item.attachments.reduce(
                      (sum, attachment) => sum + (attachment.data?.byteLength ?? 0),
                      0,
                    ),
                  0,
                );
              const result = await nativeRuntime.hydrateConversationAttachments(
                ref,
                remainingBytes,
              );
              const decision = result.match<
                | { kind: "value"; value: (typeof hydrated)[number] }
                | { kind: "error"; error: ConversationThreadOperationFailed }
              >({
                ok: (value) => ({ kind: "value" as const, value }),
                err: (error) => ({ kind: "error" as const, error }),
              });
              if (decision.kind === "error") return Result.err(decision.error);
              hydrated.push(decision.value);
              return hydrateAt(index + 1);
            };
            const hydrateAt = async (
              index: number,
            ): Promise<ResultType<typeof hydrated, ConversationThreadOperationFailed>> => {
              const ref = input.refs[index];
              if (!ref) return Result.ok(hydrated);
              if (ref.surface === "native") return hydrateNativeAt(index, ref);
              const read = await surfaceAdapter.readMsg({
                platform: "discord",
                ...ref,
              });
              const continueRead = read.match<
                () => Promise<ResultType<typeof hydrated, ConversationThreadOperationFailed>>
              >({
                err: (error) => async () =>
                  Result.err(
                    new ConversationThreadOperationFailed({
                      operation: "summarize-thread",
                      message: error.message,
                    }),
                  ),
                ok: (message) => async () => {
                  if (!message) {
                    return Result.err(
                      new ConversationThreadOperationFailed({
                        operation: "summarize-thread",
                        message: `Surface message not found: ${ref.messageId}`,
                      }),
                    );
                  }
                  hydrated.push({
                    ref,
                    attachments: toReplyChainMessage(message).attachments,
                  });
                  return await hydrateAt(index + 1);
                },
              });
              return await continueRead();
            };
            return await hydrateAt(0);
          };
          const nativeConversationDbPath = nativeInstallation
            ? path.join(env.dataDir, "native-surface.db")
            : undefined;
          if (nativeConversationDbPath)
            activeConversationThreadStore.attachNativeSource(nativeConversationDbPath);
          conversationThreadSearchPool = new ConversationThreadSearchPool({
            searchDbPath: discordSearchDbPath,
            surfaceDbPath: discordSurfaceDbPath,
            nativeDbPath: nativeConversationDbPath,
            botName: initialCoreConfig.surface.discord.botName,
          });
          const threadService = new ConversationThreadService({
            searchPool: conversationThreadSearchPool,
            store: activeConversationThreadStore,
            getConfig: () => getCoreConfig(),
            getEmbeddingAdapter: getConversationThreadEmbeddingAdapter,
            entityMapper: conversationThreadEntityMapper,
            attachmentHydrator: hydrateThreadAttachments,
          });
          conversationThreadService = threadService;
          const captureSummarizationRuntimeOperation = async <T>(
            operation: ConversationThreadSummarizationRuntimeOperation,
            effect: () => Promise<T>,
          ): Promise<ResultType<T, ConversationThreadSummarizationRuntimeError>> => {
            {
              const captured = await Result.tryPromise({
                try: async () => {
                  return Result.ok(await effect());
                },
                catch: captureError,
              });

              if (captured.isErr()) {
                const cause = captured.error.cause;
                rethrowPanic(cause);
                return Result.err(
                  new ConversationThreadSummarizationRuntimeError({
                    operation,
                    cause,
                    message: errorMessage(cause),
                  }),
                );
              }
              return captured.value;
            }
          };
          const runInProcessSummarization = (input: ConversationThreadRunSummarizationInput = {}) =>
            captureSummarizationRuntimeOperation("in-process", () =>
              threadService.runSummarization(input),
            );
          stopConversationThreadSummarizationWorker = startConversationThreadSummarizationWorker({
            nativeDbPath: nativeConversationDbPath,
            attachmentHydrator: hydrateThreadAttachments,
            searchDbPath: discordSearchDbPath,
            surfaceDbPath: discordSurfaceDbPath,
            adapter: surfaceAdapter,
          });
          conversationThreadSummarizationRunner = {
            async runSummarization(input) {
              if (conversationThreadSummarizationStopping) {
                return Result.err(
                  new ConversationThreadSummarizationTransportError({
                    operation: "stopped",
                    message: "conversation thread summarization is stopping",
                  }),
                );
              }
              const trigger = input?.trigger ?? "manual";
              const flushed = await captureSummarizationRuntimeOperation(
                "materializer-flush",
                async () => {
                  await conversationThreadMaterializer?.flush();
                },
              );
              const continueRun = () =>
                input?.dryRun === true || !stopConversationThreadSummarizationWorker
                  ? runInProcessSummarization(input)
                  : stopConversationThreadSummarizationWorker.runSummarization(input);
              const continueFlushed = flushed.match({
                err: (error) => async () => Result.err(error),
                ok: () => async () => {
                  if (conversationThreadSummarizationStopping) {
                    return Result.err(
                      new ConversationThreadSummarizationTransportError({
                        operation: "stopped",
                        message: "conversation thread summarization is stopping",
                      }),
                    );
                  }
                  if (trigger !== "periodic") return continueRun();
                  const config = await captureSummarizationRuntimeOperation("configuration", () =>
                    getCoreConfig(),
                  );
                  const continueConfig = config.match({
                    err: (error) => async () => Result.err(error),
                    ok: (value) => async () => {
                      if (value.conversation.thread.summarization.enabled === true) {
                        return continueRun();
                      }
                      return Result.ok({
                        dryRun: false,
                        refreshed: { channels: 0, threads: 0, messages: 0 },
                        eligible: 0,
                        eligibleTotal: 0,
                        eligibility: {
                          summary: 0,
                          embeddingOnly: 0,
                          reasons: {},
                        },
                        cleared: 0,
                        summarized: 0,
                        failed: 0,
                        failures: [],
                        threadIds: [],
                      });
                    },
                  });
                  return await continueConfig();
                },
              });
              return await continueFlushed();
            },
          };
          stopDiscordSearchIndexer = await startDiscordSearchIndexer({
            eventSource: discordEventSource,
            search: discordSearchService,
            getConfig: () => getCoreConfig(),
            materializer: conversationThreadMaterializer,
          });

          logger.debug("Discord search indexer started", {
            dbPath: discordSearchDbPath,
          });

          // Subscribe to adapter events before connecting, so we don't miss early messages.
          await startSurfaceAdapterIngress({
            registry,
            handles: surfaceAdapterIngressHandles,
          });

          requestMessageCache = createRequestMessageCache();

          logger.debug("Request message cache initialized");

          stopWorkflowActionResolver = await startWorkflowActionResolver({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            subscriptionId: subId(subscriptionPrefix, "workflow-actions"),
            surfaceProtocolResolver: registry.protocolResolver(),
          });

          // Subscribe durably before adapter.connect() so replies around startup replay.
          workflowWaitResolver = new WorkflowWaitResolver({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            subscriptionId: subId(subscriptionPrefix, "workflow-waits"),
            confirmLegacyGroupSingleVersionRollout:
              process.env.LILAC_CONFIRM_SINGLE_VERSION_WORKFLOW_WAIT_RESOLVER === "1",
          });
          await workflowWaitResolver.start();

          const activeQuestionStore = questionStore;
          if (!activeQuestionStore) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: undefined,
                  message: "Question store is unavailable",
                }),
              ),
            };
          }
          questionService = new QuestionService({
            store: activeQuestionStore,
            surfaces: registry.questionResolver(),
            logger,
          });
          const questionsStarted = await questionService.start();
          const questionStartError = questionsStarted.match({
            ok: () => null,
            err: (error) => error,
          });
          if (questionStartError) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: questionStartError,
                  message: questionStartError.message,
                }),
              ),
            };
          }

          await connectAndValidateSurfaceAdapters({
            registry,
            connected: connectedSurfaceAdapters,
          });

          logger.debug("Surface adapters connected");

          await questionService.finishStartupRecovery();

          workflowProgressProjector = new WorkflowProgressProjector({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            ports: workflowProgressPorts,
            subscriptionId: subId(subscriptionPrefix, "workflow-progress"),
            reportFatalPanic: reportFatalError,
          });
          await workflowProgressProjector.start();

          workflowTriggerScheduler = new WorkflowTriggerScheduler({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            progressCards: workflowProgressProjector,
            getMaxActiveRuns: async () => (await getCoreConfig()).workflows.maxActiveRuns,
            reportFatalPanic: reportFatalError,
          });
          await workflowTriggerScheduler.start();

          workflowLiveParentBridge = new WorkflowLiveParentBridge({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            subscriptionId: subId(subscriptionPrefix, "workflow-live-parents"),
            blobStore: activeBlobStore,
            toolResultArtifacts,
          });
          await workflowLiveParentBridge.start();

          workflowSubagentDispatcher = await WorkflowSubagentDispatcher.create({
            store: activeDurableWorkflowStore,
            dataDir: env.dataDir,
            blobStore: activeBlobStore,
            toolResultArtifacts,
            getMaxActiveRuns: async () => (await getCoreConfig()).workflows.maxActiveRuns,
            onRunCreated: async (run) => {
              adaptEventPublishResultToHost(
                await durableBus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
                  runId: run.runId,
                  revisionId: run.revisionId,
                  state: run.state,
                  ts: Date.now(),
                }),
              );
            },
            onRunCancelled: async (run, previousState) => {
              adaptEventPublishResultToHost(
                await durableBus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
                  runId: run.runId,
                  revisionId: run.revisionId,
                  state: "cancelled",
                  previousState,
                  detail: run.terminalDetail ?? undefined,
                  ts: Date.now(),
                }),
              );
              adaptEventPublishResultToHost(
                await durableBus.publish(lilacEventTypes.EvtWorkflowResultReady, {
                  runId: run.runId,
                  revisionId: run.revisionId,
                  state: "cancelled",
                  summary: run.terminalDetail ?? undefined,
                  ts: Date.now(),
                }),
              );
            },
          });

          if (discordEnabled) {
            stopRouter = adaptDiscordRequestRouterStartOutcomeToHost(
              await startDiscordRequestRouter({
                adapter: surfaceAdapter,
                bus: durableBus,
                blobStore: activeBlobStore,
                resourceRegistry: resourceService,
                attachmentCache: discordSearchStore?.attachmentCacheAccess(),
                messageCache: discordSearchStore ?? undefined,
                requestDelivery: discordRequestDelivery,
                subscriptionId: subId(subscriptionPrefix, "router"),
                customCommands,
                contextReport: buildContextReport,
                shouldSuppressAdapterEvent: async ({ evt }) =>
                  shouldSuppressRouterForWorkflowReply({
                    store: activeDurableWorkflowStore,
                    event: evt,
                  }),
                transcriptStore: transcriptStore ?? undefined,
              }),
              (retainedRouter) => {
                retainCoreResidualDiscordRequestRouter({
                  router: retainedRouter,
                  retainRouter: (router) => {
                    residualRouter = router;
                  },
                  retainDoneSupervision: (supervision) => {
                    residualRouterDoneSupervisions.push(supervision);
                  },
                });
              },
              (diagnostics) => {
                if (diagnostics.startupFailure) {
                  logger.error(
                    "Discord request router startup failed before cleanup Panic",
                    formatTaggedErrorForLog(diagnostics.startupFailure),
                  );
                }
                if (diagnostics.ordinaryCleanupFailure) {
                  logger.error(
                    "Discord request router startup rollback had ordinary cleanup failures",
                    formatTaggedErrorForLog(diagnostics.ordinaryCleanupFailure),
                  );
                }
                if (diagnostics.additionalPanicCount > 0) {
                  logger.error("Discord request router startup rollback had additional Panics");
                }
              },
            );
            routerSupervision = superviseCoreRouterDone({
              done: stopRouter.done,
              isStopping: () => !started,
              markUnhealthy: () => {
                routerSubscriptionHealthy = false;
                runtimeFullyStarted = false;
              },
              reportFatalError,
            });

            logger.debug("Discord request router started", {
              subscriptionId: subId(subscriptionPrefix, "router"),
            });
          }

          const conversationThreadToolService: ConversationThreadToolService | undefined =
            conversationThreadService
              ? (() => {
                  const service = conversationThreadService;
                  const summarizationRunner = conversationThreadSummarizationRunner;
                  const toolService = createConversationThreadToolService(service);
                  return {
                    ...toolService,
                    async runSummarization(input) {
                      const result = await resolveConversationThreadSummarizationToolOperation(
                        summarizationRunner
                          ? summarizationRunner.runSummarization(input)
                          : captureSummarizationRuntimeOperation("in-process", () =>
                              service.runSummarization(input),
                            ),
                      );
                      return result.match({
                        ok: (value) => () => value,
                        err: (error) => () => {
                          throw new Error(error.message);
                        },
                      })();
                    },
                  };
                })()
              : undefined;

          nativeConversationPlanner = conversationThreadToolService;

          pluginManager = createCoreToolPluginManager({
            discordSearch: discordSearchService ?? undefined,
            runtime: {
              bus: durableBus,
              blobStore: activeBlobStore,
              attachmentOutputLifecycle,
              surfaceAdapterResolver: registry.adapterResolver(),
              getConfig: () => getCoreConfig(),
              discovery: discoveryService ?? undefined,
              nativeSearch: nativeRuntime?.search,
              nativeAdapterForContext: nativeRuntime?.nativeAdapterForContext,
              resourceAccessForContext: nativeRuntime?.resourceAccessForContext,
              nativeAttachmentOutput: nativeRuntime?.attachmentOutput,
              conversationThreads: conversationThreadToolService,
              transcriptStore: transcriptStore ?? undefined,
              resourceAccess: resourceService,
              toolResultArtifacts,
              durableWorkflowStore: activeDurableWorkflowStore,
              workflowProgressCards: workflowProgressProjector,
              questions: questionService,
              ...(jobService ? { jobs: jobService } : {}),
              mcpRegistry,
              mcpOAuthProviders,
              mcpOAuthCallback,
              mcpConfigPath,
            },
            dataDir: env.dataDir,
          });
          contextReportProvider = createDiscordContextReportProvider({
            pluginManager,
            transcriptStore: transcriptStore ?? undefined,
            cwd: canonicalWorkspaceRoot,
          });

          toolServer = createToolServer({
            pluginManager,
            reportFatalToolCallDefect: reportFatalError,
            logger: createLogger({
              module: "tool-server",
            }),
            healthProvider: getRuntimeHealthReport,
            activeLevel1WorkProvider: () => stopAgentRunner?.getActiveLevel1Work() ?? [],
            onUnhealthy: opts.onUnhealthy,
            getConfig: () => getCoreConfig(),
            requestMessageCache: {
              get: requestMessageCache.get,
              getOrigin: requestMessageCache.getOrigin,
            },
            canonicalWorkspaceRoot,
            operatorTokenSha256: process.env.LILAC_OPERATOR_TOKEN_SHA256,
            authorizeControlRequest: (input) => requestControlAuthority.authorize(input),
            resolveServerSafetyMode: async (context) => {
              if (context.requestClient === "native" && context.sessionId && nativeInstallation) {
                return nativeInstallation.store
                  .getThreadRecord(context.sessionId.replace(/^native:/u, ""))
                  .andThen((thread) => nativeInstallation!.store.getUser(thread.starterId))
                  .match({
                    ok: (user) =>
                      user.toolMode === "full" ? ("trusted" as const) : ("restricted" as const),
                    err: () => "restricted" as const,
                  });
              }
              if (context.requestClient !== "discord" || !context.sessionId) return "restricted";
              const config = await getCoreConfig();
              const session = discordSurfaceStore?.getSession(context.sessionId);
              if (!session) return "restricted";
              return resolveSessionSafetyMode(
                config,
                context.sessionId,
                session.parent_channel_id ?? undefined,
                session.guild_id ?? undefined,
              );
            },
          });

          await toolServer.init();
          await toolServer.start(toolServerPort);

          await startSurfaceOutputs({
            registry,
            requestIngress: surfaceRequestIngressHandles,
            relays: surfaceRelayHandles,
          });

          let loadedJournalHeads: readonly AgentRunRecoveryHead[] = [];
          if (agentRunJournal) {
            const loadedJournal = agentRunJournal.loadRecoveryHeads();
            const loadDecision = loadedJournal.match<
              | {
                  readonly kind: "loaded";
                  readonly heads: readonly AgentRunRecoveryHead[];
                }
              | {
                  readonly kind: "reset";
                  readonly error: AgentRunJournalSqliteFailure;
                }
            >({
              ok: ({ heads, resets }) => {
                for (const reset of resets) {
                  logger.warn("Agent run journal progress reset", {
                    scope: reset.scope,
                    ...(reset.runId ? { requestDeliveryId: reset.runId } : {}),
                    reason: reset.reason,
                    errorTag: reset.errorName,
                  });
                }
                return { kind: "loaded", heads };
              },
              err: (error) => ({ kind: "reset", error }),
            });
            if (loadDecision.kind === "loaded") {
              loadedJournalHeads = loadDecision.heads;
            } else {
              logger.warn("Agent run journal recovery reset for this boot", {
                ...formatTaggedErrorForLog(loadDecision.error),
              });
              const resetFailure = agentRunJournal.resetAll().match({
                ok: () => null,
                err: (error) => error,
              });
              if (resetFailure) {
                logger.warn("Agent run journal disabled after reset failure", {
                  ...formatTaggedErrorForLog(resetFailure),
                });
                const disabledJournal = agentRunJournal;
                Result.try({
                  try: () => disabledJournal.close(),
                  catch: captureRuntimeError,
                });
                agentRunJournal = null;
              }
            }
          }

          let journalRecoveryJoin = emptyAgentRunRecoveryJoin();
          if (agentRunJournal && requestDeliveryStore) {
            const joined = joinAgentRunRecoveryHeads({
              heads: loadedJournalHeads,
              requestDeliveryStore,
              journal: agentRunJournal,
              workflowAuthority: activeDurableWorkflowStore,
              logger,
            });
            if (joined.journalResetFailure) {
              logger.warn("Agent run journal disabled after startup run reset failure", {
                ...formatTaggedErrorForLog(joined.journalResetFailure),
              });
              const disabledJournal = agentRunJournal;
              Result.try({
                try: () => disabledJournal.close(),
                catch: captureRuntimeError,
              });
              agentRunJournal = null;
            } else {
              journalRecoveryJoin = joined;
            }
          }
          let journalRecoveryHeads = journalRecoveryJoin.heads;
          const reconcileCheckpointBlobs = transcriptStore?.reconcileAgentRunCheckpointBlobs;
          if (agentRunJournal && transcriptStore && reconcileCheckpointBlobs) {
            const recoveryJournal = agentRunJournal;
            const recoveryDecision = recoverAgentRunCheckpointBlobReferences({
              heads: journalRecoveryHeads,
              reconcile: (checkpoints) =>
                reconcileCheckpointBlobs.call(transcriptStore, checkpoints),
              resetAll: () => recoveryJournal.resetAll(),
            });
            const applyBlobReferenceRecoveryFailure = (
              decision: Exclude<
                AgentRunCheckpointBlobRecoveryDecision,
                { readonly kind: "retained" }
              >,
            ): void => {
              if (TaggedError.is(decision.reconciliationError)) {
                logger.warn(
                  "Agent run journal recovery reset after blob reference failure",
                  formatTaggedErrorForLog(decision.reconciliationError),
                );
              } else {
                logger.warn("Agent run journal recovery reset after blob reference failure", {
                  errorTag: "CoreOwnedBlobIntegrityError",
                  errorMessage: "Agent run checkpoint blob reference reconciliation failed",
                });
              }
              journalRecoveryJoin = emptyAgentRunRecoveryJoin();
              journalRecoveryHeads = new Map();
              if (decision.kind === "reset") {
                if (decision.cleanupError) {
                  if (TaggedError.is(decision.cleanupError)) {
                    logger.warn(
                      "Agent run checkpoint blob reference cleanup deferred",
                      formatTaggedErrorForLog(decision.cleanupError),
                    );
                  } else {
                    logger.warn("Agent run checkpoint blob reference cleanup deferred", {
                      errorTag: "CoreOwnedBlobIntegrityError",
                      errorMessage: "Agent run checkpoint blob reference cleanup failed",
                    });
                  }
                }
                return;
              }
              if (TaggedError.is(decision.resetError)) {
                logger.warn(
                  "Agent run journal disabled after blob reference reset failure",
                  formatTaggedErrorForLog(decision.resetError),
                );
              } else {
                logger.warn("Agent run journal disabled after blob reference reset failure", {
                  errorTag: "AgentRunJournalSqliteFailure",
                  errorMessage: "Agent run journal reset failed",
                });
              }
              const disabledJournal = recoveryJournal;
              Result.try({
                try: () => disabledJournal.close(),
                catch: captureRuntimeError,
              });
              agentRunJournal = null;
            };
            switch (recoveryDecision.kind) {
              case "retained":
                break;
              case "reset":
              case "disabled": {
                applyBlobReferenceRecoveryFailure(recoveryDecision);
                break;
              }
            }
          }

          // Start agent runner last so it can't publish replies before relay is online.
          const startedAgentRunner = await startBusAgentRunner({
            questions: questionService,
            ...(jobService ? { jobs: jobService } : {}),
            bus: durableBus,
            blobStore: activeBlobStore,
            requestDelivery: requestDeliveryCoordinator,
            ...(nativeRuntime
              ? {
                  nativeExecution: nativeRuntime.execution.runnerLifecycle,
                  createNativeOutput: nativeRuntime.createOutput,
                  nativeResourceAccess: nativeRuntime.scopedResources,
                  nativeConversationThreads: nativeRuntime.scopedThreads,
                }
              : {}),
            onRequestSettled: (id) => {
              adapter.presence.requestSettled(id);
              nativeRuntime?.flushSurfaceSends().match({
                ok: () => undefined,
                err: (error) =>
                  logger.warn("Native deferred sends delayed", formatTaggedErrorForLog(error)),
              });
            },
            ...(agentRunJournal ? { agentRunJournal } : {}),
            subscriptionId: subId(subscriptionPrefix, "agent-runner"),
            reportFatalPanic: reportFatalError,
            pluginManager,
            customCommands,
            cwd: canonicalWorkspaceRoot,
            transcriptStore: transcriptStore ?? undefined,
            resourceAccess: resourceService,
            conversationThreads: conversationThreadToolService,
            toolResultArtifacts,
            workflowLiveParentBridge,
            workflowSubagentDispatcher,
            durableWorkflowStore: activeDurableWorkflowStore,
            projectAuthenticatedRequest,
            requestMessageCache: requestMessageCache ?? undefined,
            surfaceProtocolResolver: registry.protocolResolver(),
            startPaused: true,
            issueControlCapability: async (input) => {
              const cachedRequest = requestMessageCache?.getOrigin(input.requestId);
              const identity = resolveRequestCapabilityIdentity({
                requestClient: input.requestClient,
                sessionId: input.sessionId,
                safetyMode: input.safetyMode,
                ...(input.authenticatedOrigin
                  ? { authenticatedOrigin: input.authenticatedOrigin }
                  : {}),
                ...(cachedRequest ? { cachedRequest } : {}),
              });
              const policy = {
                kind: "primary",
                requestId: input.requestId,
                sessionId: input.sessionId,
                platform: input.requestClient,
                principal: identity.principal,
                authenticatedOrigin: identity.authenticatedOrigin,
                allowedCallables: null,
                profile: input.profile,
                canonicalCwd: input.canonicalCwd,
                safetyMode: identity.safetyMode,
                expiresAt: input.expiresAt,
              } as const;
              return {
                capability: requestControlAuthority.issue(policy),
                principal: policy.principal,
                authenticatedOrigin: policy.authenticatedOrigin,
                safetyMode: policy.safetyMode,
              };
            },
            issueHeartbeatCapability: (input) =>
              requestControlAuthority.issue({
                kind: "heartbeat",
                requestId: input.requestId,
                sessionId: input.sessionId,
                platform: input.requestClient,
                principal: null,
                authenticatedOrigin: null,
                allowedCallables: HEARTBEAT_LEVEL2_CALLABLES,
                profile: input.profile,
                canonicalCwd: input.canonicalCwd,
                safetyMode: "trusted",
                expiresAt: input.expiresAt,
              }),
            expireControlCapability: (requestId) => requestControlAuthority.expire(requestId),
            resolveDiscordSessionContext: (sessionId) => {
              const session = discordSurfaceStore?.getSession(sessionId);
              if (!session) return undefined;
              return {
                parentChannelId: session.parent_channel_id,
                guildId: session.guild_id,
              };
            },
          });
          stopAgentRunner = startedAgentRunner;
          if (nativeRuntime) {
            nativeRuntimeResultToHost(await nativeRuntime.recoverOperator());
            nativeRuntimeResultToHost(await nativeRuntime.execution.recoverMutations());
          }
          jobService?.startWakes({
            isSessionBusy: (sessionId) => stopAgentRunner?.isSessionBusy(sessionId) ?? true,
            port: {
              deliver: async ({ wakeId, sessionId, jobs }) => {
                const owner = jobs[0];
                if (owner?.platform === "native" && nativeRuntime) {
                  return nativeRuntime.deliverJobWake({
                    wakeId,
                    threadId: nativeThreadId(sessionId),
                    userId: owner.userId,
                    text: formatJobWakeText(jobs),
                  });
                }
                if (owner?.platform === "discord" && stopRouter) {
                  return stopRouter.publishJobWake({
                    wakeId,
                    sessionId,
                    originMessageId: owner.originMessageId,
                    promptText: formatJobWakeText(jobs),
                  });
                }
                return Result.ok("unavailable");
              },
            },
          });

          logger.debug("Bus agent runner started");

          const acceptedRecovery = await requestDeliveryCoordinator.recoverAccepted(
            (record) => {
              const decision = selectAgentRunAcceptedRecovery(
                journalRecoveryJoin,
                record.requestDeliveryId,
              );
              return decision.kind === "retained-active"
                ? Promise.resolve(Result.ok(undefined))
                : startedAgentRunner.resumeAcceptedDelivery(
                    record,
                    decision.kind === "resume" ? decision.head : undefined,
                  );
            },
            {
              terminalRecovery: (record) => {
                const decision = selectAgentRunAcceptedRecovery(
                  journalRecoveryJoin,
                  record.requestDeliveryId,
                );
                if (decision.kind !== "terminal") return undefined;
                return {
                  outcome: decision.outcome,
                  ...(decision.finalReplayDeadline === undefined
                    ? {}
                    : { finalReplayDeadline: decision.finalReplayDeadline }),
                };
              },
              prepareTerminalRecovery: (record) =>
                Promise.resolve(
                  startedAgentRunner.discardPausedRecoveredDelivery(record.requestDeliveryId),
                ),
            },
          );
          const acceptedRecoveryFailure = acceptedRecovery.match<Error | null>({
            err: (error) => error,
            ok: (summary) => {
              // One bad record must not keep Core down; it stays accepted for the next start.
              for (const failure of summary.failures) {
                logger.error("Accepted request recovery skipped a record", {
                  requestDeliveryId: failure.requestDeliveryId,
                  error: safeRuntimeErrorText(failure.error, "Opaque recovery failure"),
                });
              }
              return null;
            },
          });
          if (acceptedRecoveryFailure) {
            return {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: acceptedRecoveryFailure,
                  message: "Core accepted request recovery failed",
                }),
              ),
            };
          }
          if (agentRunJournal && requestDeliveryStore) {
            const removedRunIds = removeFullyReconciledAgentRunTerminalHeads({
              heads: journalRecoveryHeads,
              requestDeliveryStore,
              journal: agentRunJournal,
            });
            for (const requestDeliveryId of removedRunIds) {
              const releaseError = transcriptStore
                ?.releaseAgentRunCheckpointBlobs?.({ requestDeliveryId })
                .match({ ok: () => null, err: (error) => error });
              if (releaseError) {
                logger.warn(
                  "Agent run checkpoint blob reference cleanup deferred",
                  formatTaggedErrorForLog(releaseError),
                );
              }
            }
          }

          const recoverableRootParentRequestIds =
            journalRecoveryJoin.recoverableRootParentRequestIds;
          await workflowLiveParentBridge.enableOrphanHandling({
            protectedParentRequestIds: recoverableRootParentRequestIds,
            protectionMs: GRACEFUL_DRAIN_DEADLINE_MS,
          });
          const initialHeartbeatExternalState = {
            activeRequestIds: recoverableRootParentRequestIds,
          };

          workflowEngine = new WorkflowEngine({
            bus: durableBus,
            store: activeDurableWorkflowStore,
            dataDir: env.dataDir,
            blobStore: activeBlobStore,
            subscriptionId: subId(subscriptionPrefix, "workflow-engine"),
            reportFatalPanic: reportFatalError,
            validateAgentSelection: async ({ profile, model, reasoning }) => {
              const cfg = await getCoreConfig();
              const resolved = resolveAgentRunModel({
                cfg,
                runProfile: profile,
                ...(model ? { requestModelOverride: model } : {}),
                ...(reasoning ? { reasoningOverride: reasoning } : {}),
              });
              return {
                model: resolved.head.spec,
                reasoning: resolved.head.reasoning ?? null,
                request: toDurableResolvedModelPlan(resolved, cfg.agent.reasoningDisplay),
              };
            },
            resolveAgentFallbacks: async ({ profile, model, reasoning }) => {
              const cfg = await getCoreConfig();
              return resolveAgentRunModelFallbacks({
                cfg,
                runProfile: profile,
                ...(model ? { requestModelOverride: model } : {}),
                ...(reasoning ? { reasoningOverride: reasoning } : {}),
              }).map((fallback) =>
                toDurableResolvedModelRequest(fallback, cfg.agent.reasoningDisplay),
              );
            },
          });
          await workflowEngine.start();

          logger.debug("Unified workflow engine started", {
            subscriptionId: subId(subscriptionPrefix, "workflow-engine"),
          });

          const heartbeatStarted = await startHeartbeatServiceResult({
            bus: durableBus,
            subscriptionId: subId(subscriptionPrefix, "heartbeat"),
            initialExternalState: initialHeartbeatExternalState,
          });
          const heartbeatFailure = heartbeatStarted.match<() => CoreRuntimeStartOutcome | null>({
            ok: () => () => null,
            err: (error) => () => ({
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "heartbeat",
                  cause: error,
                  message: "Core runtime heartbeat startup failed",
                }),
              ),
            }),
          })();
          if (heartbeatFailure) return heartbeatFailure;
          stopHeartbeat = heartbeatStarted.match({
            ok: (heartbeat) => heartbeat,
            err: () => null,
          });

          logger.debug("Heartbeat service started", {
            subscriptionId: subId(subscriptionPrefix, "heartbeat"),
          });

          if (conversationThreadSummarizationRunner) {
            stopConversationThreadWorker = startConversationThreadWorker({
              runner: conversationThreadSummarizationRunner,
              getConfig: () => getCoreConfig(),
            });
            logger.debug("Conversation thread worker started");
          }

          if (nativeRuntime) nativeRuntimeResultToHost(await nativeRuntime.execution.kick());
          startedAgentRunner.activate();
          if (nativeRuntime) {
            nativeRuntimeResultToHost(nativeRuntime.startIngress());
            logger.info("Native surface started");
          }

          runtimeFullyStarted = routerSubscriptionHealthy;

          logger.info(
            `Core runtime started (tool-server port=${toolServerPort}, subscriptionPrefix=${subscriptionPrefix})`,
          );
          return { kind: "result", result: Result.ok(undefined) };
        },
        catch: captureRuntimeError,
      })
    ).mapError((captured) => projectCapturedRuntimeError(captured, "Core runtime startup failed"));
    const outcome: CoreRuntimeStartOutcome = startup.match({
      ok: (value) => value,
      err: (error) =>
        isPanic(error)
          ? { kind: "panic", panic: error }
          : {
              kind: "result",
              result: Result.err(
                new CoreRuntimeStartFailed({
                  operation: "startup",
                  cause: error,
                  message: error.message,
                }),
              ),
            },
    });
    if (outcome.kind === "panic") {
      logger.error("Core runtime start failed with Panic");
      await stop(outcome.panic);
      return outcome;
    }
    return outcome.result.match({
      ok: () => async () => outcome,
      err: (error) => async () => {
        logger.error("Core runtime start failed", {
          ...formatTaggedErrorForLog(error),
        });
        await stop();
        return outcome;
      },
    })();
  }

  async function stop(
    priorPanic: Panic | null = null,
    hardDeadlineAtMs = Date.now() + DEFAULT_HARD_SHUTDOWN_DEADLINE_MS,
  ): Promise<void> {
    const stopPass = selectCoreRuntimeStopPass({
      fullCleanupPending,
      hasResidualRouter: residualRouter !== null,
    });
    if (stopPass === "none") return;
    started = false;
    conversationThreadSummarizationStopping = true;
    const cleanup = createCoreRuntimeCleanupSupervisor(priorPanic);
    const safe = cleanup.run;
    await safe("native.ingress.stop", async () => nativeRuntime?.stopIngress());
    const ownedBlobStore = stopPass === "full" ? blobStore : null;
    if (stopPass === "full") blobStore = null;
    const gracefulAgentRunner = stopAgentRunner;
    const gracefulSurfaceRegistry = surfaceRuntimeRegistry;
    const gracefulDrainRequired =
      stopPass === "full" &&
      runtimeFullyStarted &&
      gracefulAgentRunner !== null &&
      gracefulSurfaceRegistry !== null;
    const blobStoreClose = ownedBlobStore
      ? scheduleCoreBlobStoreClose({
          hardDeadlineAtMs,
          close: () =>
            safe("blobStore.close.panic", async () => {
              const closed = await ownedBlobStore.close({
                deadlineAtMs: hardDeadlineAtMs,
              });
              closed.match({
                ok: () => undefined,
                err: (error) => cleanup.record("blobStore.close", error),
              });
            }),
        })
      : null;

    if (gracefulDrainRequired && gracefulAgentRunner && gracefulSurfaceRegistry) {
      const agentRunner = gracefulAgentRunner;
      const registry = gracefulSurfaceRegistry;

      await stopIngressAndDrainSurfaces({
        registry,
        stopAdapterIngress: async () => {
          await stopSurfaceAdapterIngress({
            registry,
            handles: surfaceAdapterIngressHandles,
            runCleanup: safe,
            graceful: true,
          });
        },
        stopRouterIngress: async () => {
          await safe("graceful.ingress.router.stop", () => stopRouter?.stop() ?? Promise.resolve());
          stopRouter = null;
          await safe("graceful.ingress.router.done", () => routerSupervision ?? Promise.resolve());
          routerSupervision = null;
        },
        stopWorkflowRequestProducers: async () => {
          await safe(
            "graceful.ingress.workflowWaitResolver.stop",
            () => workflowWaitResolver?.stop() ?? Promise.resolve(),
          );
          workflowWaitResolver = null;

          await safe(
            "graceful.ingress.workflowTriggerScheduler.stop",
            () => workflowTriggerScheduler?.stop() ?? Promise.resolve(),
          );
          workflowTriggerScheduler = null;

          await safe(
            "graceful.ingress.workflowActions.stop",
            () => stopWorkflowActionResolver?.stop() ?? Promise.resolve(),
          );
          stopWorkflowActionResolver = null;

          await safe(
            "graceful.ingress.workflowEngine.stop",
            () => workflowEngine?.stop() ?? Promise.resolve(),
          );
          workflowEngine = null;
        },
        stopRequestIngress: async () => {
          await stopSurfaceRequestIngress({
            registry,
            handles: surfaceRequestIngressHandles,
            runCleanup: safe,
            graceful: true,
          });
        },
        stopRemainingRequestProducers: async () => {
          await safe("graceful.toolServer.stop", () => toolServer?.stop() ?? Promise.resolve());
          await safe(
            "graceful.workflowLiveParentBridge.stop",
            () => workflowLiveParentBridge?.stop() ?? Promise.resolve(),
          );
          workflowLiveParentBridge = null;
          workflowSubagentDispatcher = null;

          if (requestDeliveryMaintenanceTimer) {
            clearInterval(requestDeliveryMaintenanceTimer);
            requestDeliveryMaintenanceTimer = null;
          }
          const gracefulMaintenanceOperation = requestDeliveryMaintenanceOperation;
          await safe(
            "graceful.requestDeliveryMaintenance.stop",
            gracefulMaintenanceOperation ? () => gracefulMaintenanceOperation : undefined,
          );
          requestDeliveryMaintenanceOperation = null;

          const gracefulHeartbeat = stopHeartbeat;
          await cleanup.runOutcome(
            "graceful.heartbeat.stop",
            gracefulHeartbeat ? () => gracefulHeartbeat.stopOutcome() : undefined,
          );
          stopHeartbeat = null;

          await safe(
            "graceful.conversationThreadWorker.stop",
            () => stopConversationThreadWorker?.stop() ?? Promise.resolve(),
          );
          stopConversationThreadWorker = null;

          await safe(
            "graceful.conversationThreadSummarizationWorker.stop",
            () => stopConversationThreadSummarizationWorker?.stop() ?? Promise.resolve(),
          );
          stopConversationThreadSummarizationWorker = null;
          conversationThreadSummarizationRunner = null;
        },
        deadlineMs: resolveCoreGracefulDrainDeadlineMs({
          nowMs: Date.now(),
          hardDeadlineAtMs,
          configuredDrainDeadlineMs: GRACEFUL_DRAIN_DEADLINE_MS,
        }),
        runCleanup: safe,
        agentRunner,
        relays: surfaceRelayHandles,
      });
    }
    const registry = surfaceRuntimeRegistry;
    if (stopPass === "full") {
      // Stop in reverse order (best-effort).
      await safe(
        "agentRunner.stop",
        () =>
          stopAgentRunner?.stop({
            deadlineAtMs: hardDeadlineAtMs - CORE_BLOB_STORE_CLEANUP_SLICE_MS,
          }) ?? Promise.resolve(),
      );
      await safe("jobService.close", () => jobService?.close() ?? Promise.resolve());
      await safe("native.output.stop", () => nativeRuntime?.stopOutput() ?? Promise.resolve());
      await safe("questionService.stop", () => questionService?.stop() ?? Promise.resolve());
      questionService = null;
      await safe(
        "workflowLiveParentBridge.stop",
        () => workflowLiveParentBridge?.stop() ?? Promise.resolve(),
      );
      workflowLiveParentBridge = null;
      workflowSubagentDispatcher = null;
      await safe(
        "conversationThreadWorker.stop",
        () => stopConversationThreadWorker?.stop() ?? Promise.resolve(),
      );
      await safe(
        "conversationThreadSummarizationWorker.stop",
        () => stopConversationThreadSummarizationWorker?.stop() ?? Promise.resolve(),
      );
      conversationThreadSummarizationRunner = null;
      const heartbeat = stopHeartbeat;
      await cleanup.runOutcome(
        "heartbeat.stop",
        heartbeat ? () => heartbeat.stopOutcome() : undefined,
      );
      await safe(
        "workflowTriggerScheduler.stop",
        () => workflowTriggerScheduler?.stop() ?? Promise.resolve(),
      );
      workflowTriggerScheduler = null;
      await safe(
        "workflowWaitResolver.stop",
        () => workflowWaitResolver?.stop() ?? Promise.resolve(),
      );
      workflowWaitResolver = null;
      await safe("workflowEngine.stop", () => workflowEngine?.stop() ?? Promise.resolve());
      workflowEngine = null;
      await safe(
        "workflowProgressProjector.stop",
        () => workflowProgressProjector?.stop() ?? Promise.resolve(),
      );
      workflowProgressProjector = null;
      await safe(
        "discordSearchIndexer.stop",
        () => stopDiscordSearchIndexer?.stop() ?? Promise.resolve(),
      );
      stopDiscordSearchIndexer = null;
      if (registry) {
        await stopSurfaceOutputs({
          registry,
          runCleanup: safe,
          relays: surfaceRelayHandles,
          requestIngress: surfaceRequestIngressHandles,
        });
      }

      await safe("toolServer.stop", () => toolServer?.stop() ?? Promise.resolve());
      await safe(
        "conversationThreadMaterializer.stop",
        () => conversationThreadMaterializer?.stop() ?? Promise.resolve(),
      );
      conversationThreadMaterializer = null;
    }

    // Residual routers follow outputs and precede ingress/adapters because they own bus subscriptions.
    if (residualRouter) {
      const replacementRouter = await stopCoreResidualDiscordRequestRouter({
        router: residualRouter,
        cleanup,
      });
      residualRouter = null;
      if (replacementRouter) {
        retainCoreResidualDiscordRequestRouter({
          router: replacementRouter,
          retainRouter: (router) => {
            residualRouter = router;
          },
          retainDoneSupervision: (supervision) => {
            residualRouterDoneSupervisions.push(supervision);
          },
        });
      }
    }

    if (stopPass === "full") {
      await safe("router.stop", () => stopRouter?.stop() ?? Promise.resolve());
      stopRouter = null;
      await safe("router.done", () => routerSupervision ?? Promise.resolve());
      routerSupervision = null;
      await safe(
        "workflowActions.stop",
        () => stopWorkflowActionResolver?.stop() ?? Promise.resolve(),
      );
      stopWorkflowActionResolver = null;
      if (registry) {
        await stopSurfaceAdapterIngress({
          registry,
          handles: surfaceAdapterIngressHandles,
          runCleanup: safe,
          graceful: false,
        });

        await disconnectSurfaceAdapters({
          registry,
          runCleanup: safe,
          connected: connectedSurfaceAdapters,
        });
        surfaceRuntimeRegistry = null;
      }
      if (requestDeliveryMaintenanceTimer) {
        clearInterval(requestDeliveryMaintenanceTimer);
        requestDeliveryMaintenanceTimer = null;
      }
      const maintenanceOperation = requestDeliveryMaintenanceOperation;
      await safe(
        "requestDeliveryMaintenance.stop",
        maintenanceOperation ? () => maintenanceOperation : undefined,
      );
      requestDeliveryMaintenanceOperation = null;
      await safe("bus.close", async () => {
        adaptCoreEventBusCleanupResultToHost(await captureCoreEventBusCleanup({ redis, raw, bus }));
      });
      await safe("resourceService.close", async () => {
        await resourceService?.close();
        resourceService = null;
      });
      await blobStoreClose?.closeNow();
      await safe("mcpOAuthCallback.stop", () => mcpOAuthCallback.stop());
      await safe("mcpRegistry.shutdown", () => mcpRegistry.shutdown());
      await safe(
        "requestMessageCache.stop",
        () => requestMessageCache?.stop() ?? Promise.resolve(),
      );
      await safe("agentRunJournal.close", async () => {
        agentRunJournal?.close();
        agentRunJournal = null;
      });
      await safe("jobStore.close", async () => {
        jobStore?.close();
        jobStore = null;
        jobService = null;
      });
      await safe("questionStore.close", async () => {
        questionStore?.close();
        questionStore = null;
      });
      await safe("requestDeliveryStore.close", async () => {
        requestDeliveryStore?.close();
        requestDeliveryStore = null;
      });
      await safe("durableWorkflowStore.close", async () => {
        durableWorkflowStore?.close();
        durableWorkflowStore = null;
      });
      await safe("discoveryService.close", async () => {
        discoveryService?.close();
        discoveryService = null;
      });
      await safe("transcriptStore.close", async () => {
        transcriptStore?.close();
        transcriptStore = null;
      });
      await safe("discordSearchStore.close", async () => {
        discordSearchStore?.close();
        discordSearchStore = null;
        discordSearchService = null;
      });
      await safe("discordSurfaceStore.close", async () => {
        discordSurfaceStore?.close();
        discordSurfaceStore = null;
      });
      await safe("conversationThreadStore.close", async () => {
        conversationThreadSearchPool?.close();
        conversationThreadSearchPool = null;
        conversationThreadStore?.close();
        conversationThreadStore = null;
        conversationThreadService = null;
      });
      await safe("nativeInstallation.close", async () => {
        nativeInstallation?.database.close();
        nativeInstallation = null;
        nativeRuntime = null;
      });
      await safe("coreConfigWatcher.stop", async () => {
        stopCoreConfigWatcher();
      });
      fullCleanupPending = false;
    }
    for (const supervision of residualRouterDoneSupervisions) {
      await settleCoreResidualDiscordRequestRouterDone({
        supervision,
        cleanup,
        reportLatePanic: reportFatalError,
        deadlineMs: resolveCoreGracefulDrainDeadlineMs({
          nowMs: Date.now(),
          hardDeadlineAtMs,
          configuredDrainDeadlineMs: GRACEFUL_DRAIN_DEADLINE_MS,
        }),
      });
    }
    residualRouterDoneSupervisions.length = 0;

    runtimeFullyStarted = false;

    if (cleanup.failures.length > 0) {
      for (const failure of cleanup.failures) {
        logger.error(
          `Core runtime cleanup failed [${failure.label}]${failure.panic ? " (panic)" : ""}: ${failure.error}`,
        );
      }
    }

    cleanup.finish();
    logger.info("Core runtime stopped");
  }

  return {
    kind: "result",
    result: Result.ok({
      start,
      stop,
      getBlobStore: () => blobStore,
      recordUnhandledRejection(reason: Error) {
        toolServer?.recordUnhandledRejection(reason);
      },
    }),
  };
}
