import { NativeComputer } from "./computer";
import { NativeReferences } from "./references";
import { nativeStoreTransaction, type NativeStoreError } from "./store";
import { serverToolFailure } from "@stanley2058/lilac-plugin-runtime";
import type { NativeAttachmentOutput } from "../../tool-server/tools/attachment";
import type { NativeOutputPublisher } from "./output";
import { createNativeTitleGeneration, type NativeTitleGenerator } from "./title-generation";
import { NativeSubagents, type SubagentReader } from "./subagents";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import path from "node:path";
import { Panic, Result, type Result as ResultType } from "better-result";
import { FileSystem } from "@stanley2058/lilac-fs";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  lilacEventTypes,
  type LilacBus,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type NativeOutputFrontier,
  type NativeOutputEvent,
} from "@stanley2058/lilac-event-bus";
import { discoverSkills, type DiscoveredSkill } from "@stanley2058/lilac-utils/skills";
import { toDurableResolvedModelPlan, type CoreConfig } from "@stanley2058/lilac-utils";
import type { CustomCommandManager } from "../../custom-commands/manager";
import type { ConversationThreadToolService } from "../../conversation/thread-service";
import type { McpRegistryApi } from "../../mcp/registry-types";
import type { CoreResourceService } from "../../resource";
import type { SqliteTranscriptStore } from "../../transcript/transcript-store";
import type { CoreToolPluginRuntime } from "../../plugins/types";
import type { SurfaceAdapterResolver } from "../runtime-descriptor";
import { resolveAgentRunModelResult, type NativeRunnerRequest } from "../bridge/bus-agent-runner";
import { parseNativeRequestEnvelope } from "../authenticated-request";
import { NativeSurfaceAdapter, nativeSurfaceError } from "./adapter";
import { agentIdentity } from "./identity";
import { NativeCatalogService } from "./catalogs";
import { NativeConfigService } from "./config-service";
import { createNativeExecution, type NativeRunnerControl } from "./execution";
import { nativeFailure } from "./errors";
import { createNativeGateway } from "./gateway";
import { captureError } from "../../shared/error-capture";
import { createNativeOperator, NATIVE_OPERATOR_PORT } from "./operator";
import type { NativeAuthenticator } from "./auth";
import { createNativeMetrics } from "./metrics";
import type { NativeInstallation } from "./installation";
import { nativeThreadId } from "./native-protocol";
import { createNativeOutputPublisher, createNativeBusOutputSink } from "./output";
import { projectNativeOutput } from "./output-projection";
import { HtmlPreviewReply, NativeHtmlPreviews } from "./html-preview";
import { NativeResourceService } from "./resources";
import { NativeLiveFileService, rewriteNativePublishedFileLinks } from "./resources-live";
import { createNativeRpcServices, nativeViewer } from "./rpc-services";
import { createNativeSurfaceRuntimeDescriptor } from "./runtime-descriptor";
import { NativeSearchService } from "./search";
import {
  NativeExternalThreads,
  type ExternalHistory,
  type ExternalOutputs,
} from "./search-external";
import { hydrateNativeConversationAttachments } from "./conversation-attachments";
import { NativeSearchStore } from "./store-search";
import { NativeSurfaceStore } from "./store-surface";

export function nativeRuntimeFailureToHost(error: Error): never {
  throw error;
}

export function nativeRuntimeResultToHost<T>(result: ResultType<T, Error>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeRuntimeFailureToHost(error),
  });
  return settle();
}

type NativeOutputSubscription = {
  done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export type NativeRuntimeOptions = {
  generateTitle?: NativeTitleGenerator;
  installation: NativeInstallation;
  bus: LilacBus;
  blobs: BlobStore;
  transcript: SqliteTranscriptStore;
  resourceAccess: CoreResourceService;
  getConfig: () => CoreConfig;
  dataDir: string;
  workspaceRoot: string;
  denyPaths: readonly string[];
  subscriptionPrefix: string;
  customCommands: CustomCommandManager;
  mcpRegistry: Pick<McpRegistryApi, "reload" | "getCatalogServers" | "getTools">;
  adapters: SurfaceAdapterResolver;
  conversationThreads: () => ConversationThreadToolService | undefined;
  runner: () => (NativeRunnerControl & SubagentReader) | undefined;
  workflows: DurableWorkflowStore;
  externalOutputs?: ExternalOutputs;
  externalHistory?: ExternalHistory;
  deliveryState: (
    id: string,
  ) => ResultType<"missing" | "owned" | "completed" | "failed" | "cancelled", Error>;
  reportFatalError: (error: Error) => void;
  warn: (message: string, error: Error) => void;
  publishableKey?: string;
  operatorTokenSha256?: string;
};

export async function createNativeRuntime(options: NativeRuntimeOptions) {
  const { store, database, auth: publicAuth, clerk, login } = options.installation;
  const legacy = options.getConfig().surface.native;
  const deploymentInitialized = store.initializeDeployment({
    titleModel: legacy.titleModel,
    outputStreaming: legacy.outputStreaming,
    oldMessageSelectionMaxAgeMs: legacy.oldMessageSelectionMaxAgeMs,
    storageRetentionMaxAgeMs: legacy.storageRetentionMaxAgeMs,
    crossThreadSend: legacy.crossThreadSend,
  });
  const deploymentInitializationError = deploymentInitialized.match({
    ok: () => null,
    err: (error) => error,
  });
  if (deploymentInitializationError) return Result.err(deploymentInitializationError);
  const deployment = () => nativeRuntimeResultToHost(store.getDeployment()).settings;
  const metrics = createNativeMetrics();
  let skills: readonly DiscoveredSkill[] = (
    await discoverSkills({ workspaceRoot: options.workspaceRoot, dataDir: options.dataDir })
  ).skills;
  const catalogs = new NativeCatalogService({
    config: options.getConfig(),
    skills,
    commands: options.customCommands.list().map((entry) => entry.def),
  });
  const refreshAgentIdentity = () => {
    store
      .getUser("lilac")
      .map(agentIdentity)
      .match({ ok: (identity) => catalogs.setAgent(identity), err: options.reportFatalError });
  };
  refreshAgentIdentity();
  const stopAgentIdentity = store.subscribe((threadId) => {
    if (!threadId) refreshAgentIdentity();
  });
  const external = new NativeExternalThreads({
    getAgent: () => store.getUser("lilac"),
    profileProvider: clerk,
    getUser: (id) => store.getUser(id),
    adapters: options.adapters,
    transcripts: options.transcript,
    outputs: options.externalOutputs,
    history: options.externalHistory,
  });
  const resources = new NativeResourceService({
    native: store,
    profileProvider: clerk ?? undefined,
    resources: options.transcript,
    access: options.resourceAccess,
    blobs: options.blobs,
    externalFile: (actorId, id) => external.file(actorId, id),
  });
  const liveFiles = new NativeLiveFileService({
    native: store,
    filesystem: new FileSystem(options.workspaceRoot, { denyPaths: options.denyPaths }),
    toolRoot: options.workspaceRoot,
    remoteDenyPaths: options.denyPaths,
  });
  const htmlPreviews = new NativeHtmlPreviews({ store, files: liveFiles, resources });
  const execution = createNativeExecution({
    expandReferences: (userId, text) =>
      references.expand(userId, text, new URL(options.getConfig().surface.native.publicUrl).origin),
    metrics,
    store,
    bus: options.bus,
    transcriptStore: options.transcript,
    blobStore: options.blobs,
    runner: options.runner,
    customCommands: options.customCommands,
    validateSkill: (id) => skills.some((skill) => skill.name === id),
    deliveryState: options.deliveryState,
    getOldMessageSelectionMaxAgeMs: () => deployment().oldMessageSelectionMaxAgeMs ?? undefined,
  });
  const operator = options.operatorTokenSha256
    ? createNativeOperator({
        tokenSha256: options.operatorTokenSha256,
        ownerId: options.getConfig().surface.native.auth.ownerId,
        store,
        execution,
      })
    : undefined;
  const auth: NativeAuthenticator = {
    ...publicAuth,
    checkSession: (principal) =>
      principal.provider === "operator" && operator
        ? operator.auth.checkSession(principal)
        : publicAuth.checkSession(principal),
  };
  const surface = new NativeSurfaceStore(database, store, async (actorId, input) =>
    (
      await options.bus.publish(
        lilacEventTypes.EvtAdapterActionInvoked,
        {
          actionId: input.actionId,
          platform: "native",
          userId: actorId,
          messageRef: { platform: "native", channelId: input.threadId, messageId: input.messageId },
          ts: Date.now(),
        },
        {
          headers: {
            request_id: input.requestId,
            session_id: `native:${input.threadId}`,
            request_client: "native",
          },
        },
      )
    )
      .map(() => undefined)
      .mapError(() => nativeFailure("sqlite", "Native action publication failed")),
  );
  const references = new NativeReferences(store, surface, external);
  const initialized = surface
    .initialize()
    .andThen(() => resources.reconcileReferences())
    .map(() => undefined);
  const initializationError = initialized.match({ ok: () => null, err: (error) => error });
  if (initializationError) return Result.err(initializationError);
  const kick = (threadId: string) => {
    void execution.kick(threadId).then((result) =>
      result.match({
        ok: () => undefined,
        err: (error) => options.warn("Native input admission deferred", error),
      }),
    );
  };
  const resolveModel = (modelId?: string) => {
    const cfg = options.getConfig();
    return resolveAgentRunModelResult({
      cfg,
      runProfile: "primary",
      requestModelOverride: modelId,
    }).map((plan) => toDurableResolvedModelPlan(plan, cfg.agent.reasoningDisplay));
  };
  const adapter = new NativeSurfaceAdapter({
    store,
    surface,
    resources,
    resolveModel,
    shouldTriggerRun: () => deployment().crossThreadSend.triggerRun,
    streamingMode: () => deployment().outputStreaming,
    kick,
  });
  const descriptor = createNativeSurfaceRuntimeDescriptor({
    adapter,
    resolveWorkflowAdapter: (threadId) =>
      store
        .getThreadRecord(nativeThreadId(threadId))
        .map((thread) =>
          adapter.forRequest({ principalId: thread.starterId, sourceThreadId: thread.id }),
        )
        .mapError((error) => nativeSurfaceError("send-message", error)),
  });
  const titles = createNativeTitleGeneration({
    store,
    getConfig: options.getConfig,
    generate: options.generateTitle,
    warn: options.warn,
    reportFatalError: options.reportFatalError,
  });
  const searchStore = new NativeSearchStore({ db: database, store });
  const retiredSummaries = nativeStoreTransaction(database, () => {
    database.run("DROP TABLE IF EXISTS native_thread_summaries");
    return Result.ok(undefined);
  });
  const retirementError = retiredSummaries.match({ ok: () => null, err: (error) => error });
  if (retirementError) return Result.err(retirementError);
  const search = new NativeSearchService({
    store,
    searchStore,
    get conversationThreads() {
      return options.conversationThreads();
    },
  });
  const config = new NativeConfigService({
    dataDir: options.dataDir,
    ownerId: options.getConfig().surface.native.auth.ownerId,
    registry: options.mcpRegistry,
  });
  const nativeConfig = options.getConfig().surface.native;
  const services = createNativeRpcServices({
    computer: new NativeComputer(store, options.mcpRegistry),
    references,
    files: liveFiles,
    subagents: new NativeSubagents({
      native: store,
      workflows: options.workflows,
      transcripts: options.transcript,
      live: options.runner,
      streamingMode: () => deployment().outputStreaming,
    }),
    store,
    auth,
    installationId: nativeConfig.installationId ?? "operator",
    workingIndicators: () => options.getConfig().surface.workingIndicators,
    catalogs,
    config,
    execution,
    resolveModel,
    resources,
    search: searchStore,
    external,
    surface,
    ...(clerk ? { lookupUser: clerk.lookupUser, profileProvider: clerk } : {}),
  });
  const gateway = createNativeGateway({
    metrics,
    reportFatalError: options.reportFatalError,
    hostname: nativeConfig.host,
    port: nativeConfig.port,
    auth: publicAuth,
    publicAuth: {
      provider: nativeConfig.auth.provider,
      ...(nativeConfig.auth.provider === "clerk"
        ? {
            issuer: nativeConfig.auth.clerkIssuer,
            oauthClientId: nativeConfig.auth.clerkOAuthClientId,
          }
        : {}),
      ...(options.publishableKey ? { publishableKey: options.publishableKey } : {}),
    },
    ...(login ? { login } : {}),
    services,
    getViewer: (id) => store.getUser(id).map(nativeViewer),
    resources: {
      async handle(request, actorId) {
        return (
          (await resources.handle(request, actorId)) ??
          (await htmlPreviews.handle(request, actorId)) ??
          liveFiles.handle(request, actorId)
        );
      },
    },
    webRoot: path.resolve(import.meta.dir, "../../../../web/dist"),
  });
  const operatorGateway = operator
    ? createNativeGateway({
        metrics,
        reportFatalError: options.reportFatalError,
        hostname: "127.0.0.1",
        port: NATIVE_OPERATOR_PORT,
        auth: operator.auth,
        publicAuth: { provider: "local" },
        operatorSession: operator.handle,
        services,
        getViewer: (id) => store.getUser(id).map(nativeViewer),
        resources: { handle: (request, actorId) => resources.handle(request, actorId) },
      })
    : undefined;
  let operatorTimer: ReturnType<typeof setInterval> | undefined;
  let operatorMaintenance: Promise<void> | undefined;
  async function maintainOperator() {
    const captured = await Result.tryPromise({ try: () => operator!.reap(), catch: captureError });
    if (captured.isErr()) {
      options.reportFatalError(captured.error.cause);
      return;
    }
    captured.value.match({
      ok: () => undefined,
      err: (error) => options.warn("Temporary conversation cleanup deferred", error),
    });
  }
  function tickOperator() {
    if (operatorMaintenance) return;
    operatorMaintenance = maintainOperator().then(() => {
      operatorMaintenance = undefined;
    });
  }
  async function recoverOperator() {
    if (operator) return operator.reap(true);
    // Persisted temporary sessions still need cleanup when operator access is disabled on this boot.
    const threads = store.listEphemeralThreads();
    return Result.gen(async function* () {
      for (const thread of yield* threads) {
        if (!thread.ephemeral) continue;
        yield* Result.await(
          execution.deleteThread(thread.starterId, {
            threadId: thread.id,
            commandId: `operator-end:${thread.ephemeral.sessionId}`,
          }),
        );
      }
      return Result.ok();
    });
  }
  let output: NativeOutputSubscription | undefined;
  let outputStopping = false;
  let unsubscribe: (() => void) | undefined;
  const nativeAdapterForContext: NonNullable<CoreToolPluginRuntime["nativeAdapterForContext"]> = (
    context,
  ) => {
    const principal = context.requestInitiator;
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!context.serverOwnedRequest || principal?.platform !== "native" || !threadId)
      return Result.err(
        nativeSurfaceError(
          "list-sessions",
          nativeFailure("forbidden", "Native tools require starter authority"),
        ),
      );
    return Result.ok(
      adapter.forRequest({
        principalId: principal.userId,
        sourceThreadId: nativeThreadId(threadId),
        requestId: context.requestId,
      }),
    );
  };

  const resourceAccessForContext: NonNullable<CoreToolPluginRuntime["resourceAccessForContext"]> = (
    context,
  ) => {
    const principal = context?.requestInitiator;
    if (context?.requestClient !== "native" && principal?.platform !== "native")
      return options.resourceAccess;
    if (!context?.serverOwnedRequest || principal?.platform !== "native") return undefined;
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!threadId) return undefined;
    const allowed = store
      .getThreadRecord(nativeThreadId(threadId))
      .andThen((thread) =>
        store
          .authorizeThread(principal.userId, thread.id)
          .map(() => thread.starterId === principal.userId),
      )
      .match({ ok: (value) => value, err: () => false });
    return allowed ? resources.scopedAccess(principal.userId) : undefined;
  };

  function linkProjectedMessages(requestId?: string) {
    return Result.gen(function* () {
      const links = yield* store.listProjectedMessageLinks(requestId);
      for (const link of links) {
        const created = link.messageIds.map((messageId) => ({
          platform: "native" as const,
          channelId: link.threadId,
          messageId,
        }));
        const last = created.at(-1);
        const captured = Result.try({
          try: () => {
            if (last)
              options.transcript.linkSurfaceMessagesToRequest({
                requestId: link.requestId,
                created,
                last,
              });
            return options.transcript.listSurfaceMessagesForRequest({ requestId: link.requestId });
          },
          catch: captureError,
        });
        const refs = yield* captured.mapError(({ cause }) => {
          if (Panic.is(cause)) nativeRuntimeFailureToHost(cause);
          return nativeFailure("sqlite", "Unable to link native output to its transcript");
        });
        for (const ref of refs) {
          if (ref.platform !== "native" || ref.channelId !== link.threadId) continue;
          const thread = yield* store.getThreadRecord(ref.channelId);
          const message = yield* surface.readMessage(
            thread.starterId,
            ref.channelId,
            ref.messageId,
          );
          if (message) continue;
          yield* options.transcript
            .unlinkSurfaceMessage(ref)
            .mapError((error) => nativeFailure("sqlite", error.message));
        }
      }
      return Result.ok(undefined);
    });
  }

  async function startOutput(): Promise<
    ResultType<void, NativeStoreError | EventDeliveryStartFailed>
  > {
    outputStopping = false;
    return Result.gen(async function* () {
      yield* linkProjectedMessages();
      const started = await options.bus.subscribeTopic(
        "evt.native.output",
        {
          mode: "fanout",
          startFrom: "beginning",
          subscriptionId: `${options.subscriptionPrefix}:native-output`,
          consumerId: `${options.subscriptionPrefix}:native-output:${process.pid}`,
        },
        async (message) =>
          Result.gen(function* () {
            const projected = store.projectTurn(
              message.data.threadId,
              message.data.generation,
              message.data.eventId,
              message.data.turnId,
              (slot, projection) =>
                Result.gen(function* () {
                  const event = message.data;
                  if (event.payload.type === "resource") {
                    const thread = yield* store.getThreadRecord(event.threadId);
                    yield* store.publishUpload(thread.starterId, event.payload.resourceId);
                  }
                  if (event.payload.type !== "text")
                    return Result.ok(projectNativeOutput(slot, event, projection));
                  const thread = yield* store.getThreadRecord(event.threadId);
                  const text = yield* rewriteNativePublishedFileLinks({
                    text: event.payload.text,
                    threadId: thread.id,
                    actorId: thread.starterId,
                    cwd: options.workspaceRoot,
                    register: (actorId, threadId, target, cwd) =>
                      store.registerPublishedPath(actorId, threadId, target, cwd),
                  });
                  return Result.ok(
                    projectNativeOutput(
                      slot,
                      { ...event, payload: { ...event.payload, text } },
                      projection,
                    ),
                  );
                }),
            );
            const committedAt = performance.now();
            const committed = projected.match({ ok: () => true, err: () => false });
            if (!committed) {
              metrics.handoffFailure("projection", message.data.threadId, message.data.requestId);
              return projected;
            }
            yield* linkProjectedMessages(message.data.requestId);
            const thread = store
              .getThreadRecord(message.data.threadId)
              .match({ ok: (value) => value, err: () => undefined });
            if (thread)
              metrics.committed(
                thread.id,
                thread.revision,
                thread.historyGeneration,
                message.data.requestId,
                committedAt,
              );
            return projected;
          }),
        (error) =>
          error._tag === "NativeStoreFailure" && error.code === "stale" ? "commit" : "retry",
      );
      return started.map((handle) => {
        output = handle;
        void handle.done.then((done) =>
          done.match({
            ok: () => undefined,
            err: (error) => {
              if (!outputStopping) options.reportFatalError(error);
            },
          }),
        );
      });
    });
  }

  const publishOutput = createNativeBusOutputSink(options.bus);
  async function publishDurableOutput(event: NativeOutputEvent) {
    const published = await publishOutput(event);
    const failure = published.match({ ok: () => undefined, err: (error) => error });
    // Recovery owns the retained run once publication fences its checkpoint and terminal output.
    if (failure) options.reportFatalError(failure);
    return published;
  }

  const activeOutputs = new Map<string, { publisher: NativeOutputPublisher; threadId: string }>();
  const attachmentOutput: NativeAttachmentOutput = async (context, input) => {
    const failure = (message: string) =>
      serverToolFailure({
        kind: "unavailable",
        code: "native_attachment_output",
        message,
        retryable: false,
      });
    return Result.gen(async function* () {
      yield* nativeAdapterForContext(context).mapError((error) => failure(error.message));
      const sourceThreadId = nativeThreadId(
        context.requestInitiatorSessionId ?? context.sessionId ?? "",
      );
      const active = activeOutputs.get(context.requestId ?? "");
      if (!active || sourceThreadId !== active.threadId)
        return Result.err(
          failure("Native attachment requires an active response in the originating thread"),
        );
      const principalId = context.requestInitiator!.userId;
      const thread = yield* store
        .authorizeThread(principalId, active.threadId)
        .mapError((error) => failure(error.message));
      if (thread.starterId !== principalId)
        return Result.err(failure("Native attachment requires starter authority"));
      const stepId = active.publisher.currentStepId();
      const upload = yield* Result.await(
        resources
          .ingest(principalId, active.threadId, input)
          .then((result) => result.mapError((error) => failure(error.message))),
      );
      if (activeOutputs.get(context.requestId ?? "") !== active)
        return Result.err(failure("Native response changed while uploading the attachment"));
      yield* Result.await(
        active.publisher
          .resource({
            stepId,
            resourceId: upload.id,
            filename: upload.filename,
            mediaType: upload.mediaType,
            size: upload.size,
          })
          .then((result) => result.mapError((error) => failure(error.message))),
      );
      return Result.ok(undefined);
    });
  };

  function createOutput(input: {
    requestId: string;
    requestClient: string;
    recoveryOutputFrontier?: NativeOutputFrontier;
  }) {
    if (input.requestClient !== "native") return undefined;
    const attempt = nativeRuntimeResultToHost(store.beginOutputAttempt(input.requestId));
    const mode = deployment().outputStreaming;
    const publisher = createNativeOutputPublisher({
      ...attempt,
      requestId: input.requestId,
      mode,
      publish: publishDurableOutput,
      recoveryFrontier: input.recoveryOutputFrontier,
    });
    const active = { publisher, threadId: attempt.threadId };
    activeOutputs.set(input.requestId, active);
    const reply = new HtmlPreviewReply(attempt.attemptId);
    let snapshotted = false;
    async function snapshotPreviews(state: Parameters<NativeOutputPublisher["terminal"]>[0]) {
      if (snapshotted || state === "canceled") return;
      snapshotted = true;
      await htmlPreviews.snapshot({
        threadId: attempt.threadId,
        turnId: attempt.turnId,
        texts: reply.texts(),
      });
    }
    return {
      ...publisher,
      textStart: (part: Parameters<NativeOutputPublisher["textStart"]>[0]) => {
        publisher.textStart(part);
        reply.start(part.partId, part.stepId);
      },
      textDelta: (partId: string, delta: string) => {
        publisher.textDelta(partId, delta);
        reply.append(partId, delta);
      },
      textEnd: (partId: string) => {
        publisher.textEnd(partId);
        // Paragraph mode publishes a part at its end, so a reused part ID starts a new message.
        if (mode === "paragraph") reply.end(partId);
      },
      stepEnd: (reason: Parameters<NativeOutputPublisher["stepEnd"]>[0]) => {
        publisher.stepEnd(reason);
        reply.endStep();
      },
      reset: (nextAttemptId: string, stepId?: string) => {
        publisher.reset(nextAttemptId, stepId);
        reply.reset(nextAttemptId, stepId);
      },
      terminal: async (state: Parameters<NativeOutputPublisher["terminal"]>[0]) => {
        if (activeOutputs.get(input.requestId) === active) activeOutputs.delete(input.requestId);
        await snapshotPreviews(state);
        return publisher.terminal(state);
      },
    };
  }

  async function recover() {
    return Result.gen(async function* () {
      yield* Result.await(execution.recoverMutations());
      yield* Result.await(execution.kick());
      return Result.ok(undefined);
    });
  }

  function startIngress() {
    return Result.gen(function* () {
      const publicAddress = nativeConfig.enabled ? yield* gateway.start() : undefined;
      const operatorAddress = operatorGateway ? yield* operatorGateway.start() : undefined;
      const address = publicAddress ?? operatorAddress ?? { url: nativeConfig.publicUrl };
      unsubscribe = store.subscribeChanges(kick);
      if (operator) operatorTimer = setInterval(tickOperator, 1000);
      return Result.ok(address);
    });
  }

  async function stopIngress() {
    await titles.stop();
    stopAgentIdentity();
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(operatorTimer);
    await operatorMaintenance;
    await operatorGateway?.stop();
    await gateway.stop();
    const uploads = await resources.stop();
    const publications = await execution.drainPublications();
    nativeRuntimeResultToHost(Result.all([uploads, publications]));
  }
  async function stopOutput() {
    outputStopping = true;
    const active = output;
    output = undefined;
    if (active) nativeRuntimeResultToHost(await active.stop());
  }
  async function updateCatalog() {
    skills = (
      await discoverSkills({ workspaceRoot: options.workspaceRoot, dataDir: options.dataDir })
    ).skills;
    catalogs.update({
      config: options.getConfig(),
      skills,
      commands: options.customCommands.list().map((entry) => entry.def),
    });
  }
  async function maintain() {
    return Result.gen(async function* () {
      const config = options.getConfig();
      const maxAge = (yield* store.getDeployment()).settings.storageRetentionMaxAgeMs;
      if (maxAge !== null) {
        const expired = yield* store.listExpiredThreadIds(Date.now() - maxAge, 10);
        for (const threadId of expired)
          yield* Result.await(
            execution.deleteThread(config.surface.native.auth.ownerId, {
              threadId,
              commandId: `retention:${threadId}`,
            }),
          );
      }
      yield* resources.reconcileReferences();
      yield* surface.pruneDeleted();
      yield* store.pruneReplay();

      return Result.ok(undefined);
    });
  }
  function scopedResources(request: NativeRunnerRequest) {
    return resources.scopedAccess(parseNativeRequestEnvelope(request)?.starterUserId ?? "");
  }
  function scopedThreads(request: NativeRunnerRequest) {
    return search.forThread(parseNativeRequestEnvelope(request)?.threadId ?? "");
  }
  return Result.ok({
    descriptor,
    adapter,
    execution,
    resources,
    search,
    nativeAdapterForContext,
    resourceAccessForContext,
    attachmentOutput,
    createOutput,
    scopedResources,
    scopedThreads,
    hydrateConversationAttachments: (
      ref: Parameters<typeof hydrateNativeConversationAttachments>[1],
      remainingBytes: number,
    ) => hydrateNativeConversationAttachments({ store, surface, resources }, ref, remainingBytes),
    startOutput,
    startIngress,
    stopIngress,
    stopOutput,
    recover,
    recoverOperator,
    maintain,
    updateCatalog,
  });
}

export type NativeRuntime = NonNullable<
  ReturnType<typeof createNativeRuntime> extends Promise<ResultType<infer Value, Error>>
    ? Value
    : never
>;
