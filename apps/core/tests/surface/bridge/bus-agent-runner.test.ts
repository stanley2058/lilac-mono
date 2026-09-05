import { afterAll, beforeAll, describe, expect, it, jest } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  createLilacBus,
  decodeCorePrimaryLineageV2,
  EventPublishTransportFailed,
  lilacEventTypes,
  outReqTopic,
  type CmdRequestMessageData,
  type CoreLineageManifestV2,
  type CorePrimaryLineageV2,
  type EventDeliveryStopFailed,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  RESPONSE_COMMENTARY_INSTRUCTIONS,
  createLogger,
  ModelCapability,
  parseCoreConfigV2ToUniversal,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  AiSdkPiAgent,
  attachAutoCompaction,
  ToolExpansion,
  buildSyntheticToolCallId,
  createAgentRunIdleWatchdog,
  hashCanonicalMessagesV1,
  isRetryableTransientModelError,
  RetryBackoffAborted,
  type AiSdkPiAgentOptions,
} from "@stanley2058/lilac-agent";
import {
  ClaudeCodeRunExternalFailure,
  materializeClaudeCodeRun,
  type ClaudeNativeAttemptObservation,
  type ClaudeNativeSessionStart,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import type {
  ConversationThreadAutoInjectUsageAccumulator,
  ConversationThreadToolService,
} from "../../../src/conversation/thread-service";

import {
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH,
  applyCompleteLevel1Tools,
  appendAutoInjectedThreadSearchLineage,
  assertWorkflowDispatchPolicy,
  appendConfiguredAliasPromptBlock,
  appendAdditionalSessionMemoBlock,
  buildAutoInjectedThreadSearchOverlay,
  BusAgentRunnerIntakeFailed,
  BusAgentRunnerRequestHeadersInvalid,
  BusAgentRunnerQueueAttemptRouteInvalid,
  busAgentRunnerDeliveryDisposition,
  buildCustomCommandFailureFinalText,
  BusAgentRunnerOperationFailed,
  customCommandExecutionErrorText,
  consumeAssistantTextDelta,
  consumeReasoningChunkEvent,
  completeLevel1ToolMapping,
  createAssistantTextPartBoundaryState,
  captureBusAgentRunnerOperation,
  degradeCorePrimaryLineageForMutation,
  formatBusAgentRunnerDrainFailureForLog,
  formatClaudeLifecycleLogFields,
  formatAutoCompactionToolDisplay,
  formatUnknownErrorForDisplay,
  resolveCoreClaudeCompactionSummaryModel,
  buildHeartbeatOverlayForRequest,
  buildAutoInjectedThreadSearchMessages,
  buildDeferredSubagentResultMessages,
  hasDeferredSubagentResult,
  planDeferredSubagentBoundary,
  maybeBuildAutoInjectedThreadSearchMessages,
  buildPersistedHeartbeatMessages,
  buildSurfaceMetadataOverlay,
  corePrimaryLineageHasCompactionCheckpoint,
  isActiveRuntimeModelCompatible,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  mapCorePrimaryCompactionCurrentCanonicalStart,
  measureMeaningfulTextUnits,
  mergeToSingleUserMessage,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
  refreshSelectedLevel1Tools,
  removeSilentAssistantTurnMessages,
  resolveAgentRunModel,
  resolveAgentRunModelFallbacks,
  selectNextNativeModelFallback,
  shouldRunAutoInjectedThreadSearch,
  shouldQueueIncompatibleActiveRuntimeModel,
  shouldLogLevel1ToolCompletionAtInfo,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  shouldUsePersistentCoreClaudeRuntime,
  startBusAgentRunner as startBusAgentRunnerProduction,
  startBusAgentRunnerTerminalCleanup,
  shouldEnableAnthropicPromptCache,
  selectPersistedTranscriptMessages,
  selectedLevel1ToolNames,
  resolveCompactionCheckpointMeta,
  resolveCorePrimaryTranscriptProviderState,
  resolveCoreStableNamedContinuation,
  resolveStoredResourceProviderTarget,
  rethrowBusAgentRunnerPanic,
  signalBusAgentRunnerHostFailure,
  settleStoredMessageIdentityRemember,
  projectTranscriptMessagesForPersistence,
  toIdleRetryDecision,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
  WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS,
  validateCorePrimaryLineageAtRunnerIntake,
  type BusAgentRunnerRequestDelivery,
  type BusAgentRunnerTerminalCleanup,
} from "../../../src/surface/bridge/bus-agent-runner";
import {
  CustomCommandExecuteMissingError,
  CustomCommandExecuteRejectedError,
  CustomCommandExecuteThrownError,
  CustomCommandImportError,
  CustomCommandResultInvalidError,
  CustomCommandManager,
  type CustomCommandExecutionError,
} from "../../../src/custom-commands/manager";
import { createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult } from "../../../src/surface/bridge/bus-agent-runner/core-primary-continuation";
import { resolveCorePrimaryLoadedCatalogIds } from "../../../src/surface/bridge/bus-agent-runner/lineage-tool-authority";

function createCorePrimaryClaudeRuntime(
  input: Parameters<typeof createCorePrimaryClaudeRuntimeResult>[0],
) {
  const created = createCorePrimaryClaudeRuntimeResult(input);
  if (created.status === "error") throw created.error;
  return created.value;
}
import {
  createCoreToolPluginManager,
  type BuiltLevel1Toolset,
  type CoreToolPluginManager,
} from "../../../src/plugins";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  computeCorePrimaryClaudeTerminalHead as computeCorePrimaryClaudeTerminalHeadResult,
  type CoreClaudeAttemptMutationError,
  type CoreClaudeBindingReadError,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";
import {
  createStoredMessageIdentityProjectionV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
} from "../../../src/transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../../src/transcript/transcript-persistence-codec";
import { createAgentOutputActivityPublisher } from "../../../src/shared/agent-output-activity";
import { createRequestMessageCache } from "../../../src/tool-server/request-message-cache";
import {
  adaptDiscordRequestRouterStartOutcomeToHost,
  startDiscordRequestRouter,
} from "../../../src/surface/discord/discord-request-router";
import { DiscordRequestDeliveryFailed } from "../../../src/surface/discord/discord-request-router/publish";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import {
  AgentRunJournalConflict,
  AgentRunJournalSqliteFailure,
  type AgentRunCheckpointV1,
  type AgentRunRecoveryHead,
} from "../../../src/surface/bridge/agent-run-journal";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  type AcceptedRequestDelivery,
  type CoreAcceptedRequestWork,
} from "../../../src/surface/bridge/request-delivery";
import { createDiscordRelayPolicy } from "../../../src/surface/discord/discord-runtime-descriptor";
import { normalizeDiscordRaw } from "../../../src/surface/discord/discord-raw-normalizer";
import { getTestBlobStore } from "../../helpers/blob-store";
import { createTestResourceRegistry } from "../../helpers/resource-registry";
import { getBuiltinSurfaceProtocol } from "../../../src/surface/builtin-surface-protocols";
import type {
  ResolvedSurfaceProtocol,
  SurfaceProtocolResolver,
} from "../../../src/surface/runtime-descriptor";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceOperationResult,
  SurfaceOutputPart,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type {
  ContentOpts,
  AuthenticatedSurfaceOrigin,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import {
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
} from "../../../src/surface/bridge/bus-agent-runner/raw";
import {
  buildExperimentalDownloadForAnthropicFallback,
  shouldForceUrlDownloadForAnthropicFallback,
  withStableAnthropicUpstreamOrder,
} from "../../../src/surface/bridge/bus-agent-runner/anthropic-fallback-media";
import {
  subscribeForTest,
  testDeliveriesRemainOpenOnPolicyStop,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "../../helpers/result-raw-bus";

const TEST_SURFACE_PROTOCOL_RESOLVER: SurfaceProtocolResolver = {
  resolve: (platform) => {
    const protocol = getBuiltinSurfaceProtocol(platform);
    return protocol ? ({ platform: protocol.platform, protocol } as ResolvedSurfaceProtocol) : null;
  },
};

let TEST_BLOB_STORE: BlobStore;

beforeAll(async () => {
  const created = await createMemoryBlobStore();
  if (created.status === "error") throw created.error;
  TEST_BLOB_STORE = created.value;
});

afterAll(async () => {
  await TEST_BLOB_STORE.close({ deadlineAtMs: Date.now() + 1_000 });
});

function startBusAgentRunner(
  params: Omit<Parameters<typeof startBusAgentRunnerProduction>[0], "blobStore"> & {
    blobStore?: BlobStore;
  },
) {
  return startBusAgentRunnerProduction({
    ...params,
    blobStore: params.blobStore ?? TEST_BLOB_STORE,
    surfaceProtocolResolver: params.surfaceProtocolResolver ?? TEST_SURFACE_PROTOCOL_RESOLVER,
  });
}

function transcriptResultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function computeCorePrimaryClaudeTerminalHead(
  input: Parameters<typeof computeCorePrimaryClaudeTerminalHeadResult>[0],
) {
  return transcriptResultValue(computeCorePrimaryClaudeTerminalHeadResult(input));
}

function attemptMutationValue<T>(result: ResultType<T, CoreClaudeAttemptMutationError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptTransactionConflict":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function bindingValue<T>(result: ResultType<T, CoreClaudeBindingReadError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function getPrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCorePrimaryClaudeSessionBinding(input));
}

function promotePrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["promoteCorePrimaryClaudeSessionBinding"]>[0],
) {
  return attemptMutationValue(store.promoteCorePrimaryClaudeSessionBinding(input));
}

function buildCoreLineageManifestV2(...args: Parameters<typeof buildCoreLineageManifestResultV2>) {
  return transcriptResultValue(buildCoreLineageManifestResultV2(...args));
}

function getRequestTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getRequestTranscript"]>[0],
) {
  return transcriptResultValue(store.getRequestTranscript(input));
}

function getCorePrimaryLineageManifest(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryLineageManifest"]>[0],
) {
  return transcriptResultValue(store.getCorePrimaryLineageManifest(input));
}

function getCoreRequestAtomMetadata(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreRequestAtomMetadata"]>[0],
) {
  return transcriptResultValue(store.getCoreRequestAtomMetadata(input));
}

function getTranscriptBySurfaceMessage(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getTranscriptBySurfaceMessage"]>[0],
) {
  return transcriptResultValue(store.getTranscriptBySurfaceMessage(input));
}

function level1TestTool(execute: () => unknown) {
  return tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute,
  });
}

function level1TestToolset(params?: {
  builtinExecute?: () => unknown;
  catalogExecute?: () => unknown;
  searchExecute?: () => unknown;
  onCatalogCreate?: () => void;
  onBatchUpdate?: (activeToolNames: ReadonlySet<string>) => void;
}): BuiltLevel1Toolset {
  params?.onCatalogCreate?.();
  const catalogTool = level1TestTool(params?.catalogExecute ?? (() => "catalog"));
  const tools = {
    builtin: level1TestTool(params?.builtinExecute ?? (() => "builtin")),
    find_tools: level1TestTool(params?.searchExecute ?? (() => "search")),
    deferred_tool: catalogTool,
  } satisfies ToolSet;
  return {
    tools,
    specs: new Map(),
    contributionInfo: new Map(),
    directToolNames: new Set(["builtin", "find_tools"]),
    catalog: [
      {
        source: "mcp",
        sourceId: "server",
        rawName: "raw_tool",
        modelName: "deferred_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
        identity: {
          source: "mcp",
          sourceId: "server",
          rawToolName: "raw_tool",
        },
        stableId: "catalog-id",
        tool: catalogTool,
      },
    ],
    catalogMetadata: {
      deferred_tool: {
        sourceId: "server",
        rawName: "raw_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
      },
    },
    updateActiveBatchTools: (activeToolNames) => params?.onBatchUpdate?.(activeToolNames),
    genericOutputNormalizerBypassTools: new Set(["builtin"]),
    aggregateOutputBudgetExemptTools: new Set(),
    release: async () => Result.ok(undefined),
  };
}

function level1ZeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function level1TextStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1PhasedTextStep(finalText = "Final answer.") {
  const commentaryMetadata = {
    openai: { itemId: "msg_commentary", phase: "commentary" },
  } as const;
  const finalMetadata = {
    openai: { itemId: "msg_final", phase: "final_answer" },
  } as const;
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "text-start" as const,
          id: "commentary",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-delta" as const,
          id: "commentary",
          delta: "Commentary.",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-end" as const,
          id: "commentary",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-start" as const,
          id: "final",
          providerMetadata: finalMetadata,
        },
        {
          type: "text-delta" as const,
          id: "final",
          delta: finalText,
          providerMetadata: finalMetadata,
        },
        {
          type: "text-end" as const,
          id: "final",
          providerMetadata: finalMetadata,
        },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1ToolCallStep(calls: readonly { toolCallId: string; toolName: string }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({
          type: "tool-call" as const,
          ...call,
          input: "{}",
        })),
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1TextAndToolCallStep(text: string, call: { toolCallId: string; toolName: string }) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        { type: "tool-call" as const, ...call, input: "{}" },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

function level1OfferedToolNames(options: { tools?: ReadonlyArray<{ name: string }> }): string[] {
  return (options.tools ?? []).map((entry) => entry.name);
}

describe("Claude lifecycle logging", () => {
  it("redacts lifecycle detail and formats TaggedErrors without exposing causes", () => {
    class LifecycleFailure extends TaggedError("LifecycleFailure")<{
      readonly cause: unknown;
      readonly message: string;
    }> {}

    const projected = formatClaudeLifecycleLogFields(
      "candidate-finalization-failed",
      {
        requestId: "request-1",
        detail: "token=sk-detail-secret",
      },
      new LifecycleFailure({
        cause: { authorization: "Bearer cause-secret" },
        message: "finalization failed token=sk-message-secret",
      }),
    );

    expect(projected).toMatchObject({
      lifecycle: "candidate-finalization-failed",
      requestId: "request-1",
      detail: "token=<redacted>",
      errorTag: "LifecycleFailure",
      errorMessage: "finalization failed token=<redacted>",
    });
    expect(projected).not.toHaveProperty("cause");
    expect(JSON.stringify(projected)).not.toContain("cause-secret");
    expect(JSON.stringify(projected)).not.toContain("sk-detail-secret");
    expect(JSON.stringify(projected)).not.toContain("sk-message-secret");
  });

  it("serializes drain publication failures to JSONL without raw causes or stacks", () => {
    const secret = "sk-drain-cause-secret";
    const cause = new Error(`transport cause ${secret}`);
    const failure = new EventPublishTransportFailed({
      cause,
      eventType: "evt.request.lifecycle.changed",
      topic: "evt.request",
      message: `publish failed token=${secret}`,
    });
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const logger = createLogger({
      module: "bus-agent-runner-drain-test",
      outputFormat: "jsonl",
      stdout: output,
      stderr: output,
    });

    logger.error(
      "drainSessionQueue failed",
      formatBusAgentRunnerDrainFailureForLog(failure, {
        sessionId: "session-1",
        requestId: "request-1",
      }),
    );

    const serialized = chunks.join("");
    expect(serialized).toContain('"errorTag":"EventPublishTransportFailed"');
    expect(serialized).toContain('"errorMessage":"publish failed token=<redacted>"');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("transport cause");
    expect(serialized).not.toContain('"cause"');
    expect(serialized).not.toContain('"stack"');
  });
});

describe("runner Level 1 catalog selection", () => {
  it("audits portable search and MCP completions at info without duplicating built-in logs", () => {
    const toolset = level1TestToolset();
    const mcpEntry = toolset.catalog[0];
    if (!mcpEntry) throw new Error("missing MCP catalog fixture");

    expect(shouldLogLevel1ToolCompletionAtInfo("find_tools", toolset.catalog)).toBe(true);
    expect(shouldLogLevel1ToolCompletionAtInfo("deferred_tool", toolset.catalog)).toBe(true);
    expect(shouldLogLevel1ToolCompletionAtInfo("builtin", toolset.catalog)).toBe(false);
  });

  it("applies persisted initial selection by stable ID and omits unavailable selected rows", () => {
    const toolset = level1TestToolset();
    const persistedRows = ["catalog-id", "missing-catalog-id"];

    expect([...selectedLevel1ToolNames(toolset, persistedRows)]).toEqual([
      "builtin",
      "find_tools",
      "deferred_tool",
    ]);
    expect(persistedRows).toEqual(["catalog-id", "missing-catalog-id"]);
    expect([...selectedLevel1ToolNames({ ...toolset, catalog: [] }, persistedRows)]).toEqual([
      "builtin",
      "find_tools",
    ]);
    expect(persistedRows).toEqual(["catalog-id", "missing-catalog-id"]);
  });

  it("activates find_tools results on the next step and denies hidden same-step calls", async () => {
    const offered: string[][] = [];
    const selectedIds: string[] = [];
    let catalogCreates = 0;
    let catalogExecutions = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(level1OfferedToolNames(options));
        if (offered.length === 1) {
          return level1ToolCallStep([
            { toolCallId: "search", toolName: "find_tools" },
            { toolCallId: "hidden", toolName: "deferred_tool" },
          ]);
        }
        return offered.length === 2
          ? level1ToolCallStep([{ toolCallId: "selected", toolName: "deferred_tool" }])
          : level1TextStep("done");
      },
    });
    const toolset = level1TestToolset({
      onCatalogCreate: () => {
        catalogCreates += 1;
      },
      searchExecute: () => {
        selectedIds.push("catalog-id");
        return "selected";
      },
      catalogExecute: () => {
        catalogExecutions += 1;
        return "catalog";
      },
    });
    let agent: AiSdkPiAgent<ToolSet> | null = null;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: toolset.tools,
      beforeStep: async () => {
        if (!agent) throw new Error("agent not ready");
        await refreshSelectedLevel1Tools({
          target: agent,
          toolset,
          listSelectedCatalogIds: () => selectedIds,
        });
      },
    });

    await agent.prompt("find it");

    expect(catalogCreates).toBe(1);
    expect(catalogExecutions).toBe(1);
    expect(offered).toEqual([
      ["builtin", "find_tools"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
    ]);
    expect(agent.getLastStepToolSnapshot()?.names).toEqual([
      "builtin",
      "find_tools",
      "deferred_tool",
    ]);
  });

  it("executes selected expansion children and denies hidden children under the same step authority", async () => {
    let selectedExecutions = 0;
    let hiddenExecutions = 0;
    const selectedTool = level1TestTool(() => {
      selectedExecutions += 1;
      return "selected";
    });
    const hiddenTool = level1TestTool(() => {
      hiddenExecutions += 1;
      return "hidden";
    });
    const tools = {
      batch: level1TestTool(
        () =>
          new ToolExpansion("expanded", [
            {
              toolCallId: "selected-child",
              toolName: "selected_tool",
              input: {},
            },
            { toolCallId: "hidden-child", toolName: "hidden_tool", input: {} },
          ]),
      ),
      selected_tool: selectedTool,
      hidden_tool: hiddenTool,
    } satisfies ToolSet;
    const toolset: BuiltLevel1Toolset = {
      tools,
      specs: new Map(),
      contributionInfo: new Map(),
      directToolNames: new Set(["batch"]),
      catalog: [
        {
          source: "plugin",
          sourceId: "selected-plugin",
          rawName: "selected",
          modelName: "selected_tool",
          identity: {
            source: "plugin",
            sourceId: "selected-plugin",
            rawToolName: "selected",
          },
          stableId: "selected-id",
          tool: selectedTool,
        },
        {
          source: "plugin",
          sourceId: "hidden-plugin",
          rawName: "hidden",
          modelName: "hidden_tool",
          identity: {
            source: "plugin",
            sourceId: "hidden-plugin",
            rawToolName: "hidden",
          },
          stableId: "hidden-id",
          tool: hiddenTool,
        },
      ],
      catalogMetadata: {},
      updateActiveBatchTools: () => {},
      genericOutputNormalizerBypassTools: new Set(),
      aggregateOutputBudgetExemptTools: new Set(),
      release: async () => Result.ok(undefined),
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return calls === 1
          ? level1ToolCallStep([{ toolCallId: "batch", toolName: "batch" }])
          : level1TextStep("done");
      },
    });
    let agent: AiSdkPiAgent<ToolSet> | null = null;
    agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools,
      beforeStep: async () => {
        if (!agent) throw new Error("agent not ready");
        await refreshSelectedLevel1Tools({
          target: agent,
          toolset,
          listSelectedCatalogIds: () => ["selected-id"],
        });
      },
    });

    await agent.prompt("batch it");

    expect(selectedExecutions).toBe(1);
    expect(hiddenExecutions).toBe(0);
  });

  it("passes Claude the exact complete tools and deferred metadata with complete authority", () => {
    const toolset = level1TestToolset();
    const mapping = completeLevel1ToolMapping(toolset);
    const applied: { tools?: ToolSet; names?: ReadonlySet<string> } = {};

    applyCompleteLevel1Tools(
      {
        setTools: (tools) => {
          applied.tools = tools;
        },
        setActiveTools: (names) => {
          applied.names = new Set(names);
        },
      },
      toolset,
    );

    expect(mapping.tools).toBe(toolset.tools);
    expect(mapping.catalogMetadata).toBe(toolset.catalogMetadata);
    expect(Object.keys(mapping.catalogMetadata)).toEqual(["deferred_tool"]);
    expect(applied.tools).toBe(toolset.tools);
    expect([...(applied.names ?? [])]).toEqual(["builtin", "find_tools", "deferred_tool"]);
  });

  it("refreshes selection and batch authority without rebuilding the catalog", async () => {
    let catalogCreates = 0;
    let batchUpdates = 0;
    let appliedNames: ReadonlySet<string> = new Set();
    const toolset = level1TestToolset({
      onCatalogCreate: () => {
        catalogCreates += 1;
      },
      onBatchUpdate: () => {
        batchUpdates += 1;
      },
    });

    await refreshSelectedLevel1Tools({
      target: {
        setActiveTools: (names) => {
          appliedNames = names;
        },
      },
      toolset,
      listSelectedCatalogIds: () => [],
    });

    expect(catalogCreates).toBe(1);
    expect(batchUpdates).toBe(1);
    expect([...appliedNames]).toEqual(["builtin", "find_tools"]);
  });
});

describe("reasoning chunk streaming", () => {
  it("publishes accumulated snapshots before thinking_end without duplicating on end", () => {
    const state = { chunks: new Map<string, string>(), seq: 0 };

    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "",
      }),
    ).toEqual({ publishStart: true, snapshot: null });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "**Inspecting**",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**", seq: 1 },
    });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "delta",
        chunkId: "reasoning-1",
        delta: "\n\nChecking the stream.",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: { delta: "**Inspecting**\n\nChecking the stream.", seq: 2 },
    });
    expect(
      consumeReasoningChunkEvent(state, {
        type: "end",
        chunkId: "reasoning-1",
      }),
    ).toEqual({
      publishStart: false,
      snapshot: null,
    });
    expect(state.chunks.has("reasoning-1")).toBe(false);
  });
});

describe("deferred subagent result", () => {
  it("exposes the durable workflow run ID without exposing the child request ID", () => {
    const messages = buildDeferredSubagentResultMessages({
      runId: "wfrun:subagent:opaque-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:synthetic-child-request",
      profile: "explore",
      sessionName: "audit",
      status: "resolved",
      ok: true,
      finalText: "complete",
    });

    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "subagent_result",
            input: { workflowRunId: "wfrun:subagent:opaque-run" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "subagent_result",
            output: {
              type: "json",
              value: { workflowRunId: "wfrun:subagent:opaque-run" },
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("synthetic-child-request");
  });

  it("deduplicates a recovered legacy child-request result while emitting only the run ID form", () => {
    const completion = {
      runId: "wfrun:subagent:recovered-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:legacy-child-request",
      profile: "explore" as const,
      sessionName: "recovered-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "recovered",
    };
    const legacyToolCallId = buildSyntheticToolCallId({
      prefix: "subagent_result",
      seed: completion.childRequestId,
    });
    const checkpointMessages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: legacyToolCallId,
            toolName: "subagent_result",
            output: { type: "json", value: { status: "resolved" } },
          },
        ],
      },
    ];

    expect(hasDeferredSubagentResult(checkpointMessages, completion)).toBe(true);

    const emitted = buildDeferredSubagentResultMessages(completion);
    const emittedAssistant = emitted[0];
    if (
      emittedAssistant?.role !== "assistant" ||
      !Array.isArray(emittedAssistant.content) ||
      emittedAssistant.content[0]?.type !== "tool-call"
    ) {
      throw new Error("expected a synthetic subagent result tool call");
    }
    const emittedToolCallId = emittedAssistant.content[0].toolCallId;
    expect(emittedToolCallId).toBe(
      buildSyntheticToolCallId({
        prefix: "subagent_result",
        seed: completion.runId,
      }),
    );
    expect(emittedToolCallId).not.toBe(legacyToolCallId);
    expect(hasDeferredSubagentResult(emitted, completion)).toBe(true);

    const upgrade = planDeferredSubagentBoundary({
      canonicalMessages: checkpointMessages,
      modelInputMessages: [],
      completions: [completion],
    });
    expect(upgrade.append).toEqual(emitted);
    expect(upgrade.forceNextTurn).toBe(true);
  });

  it("keeps appended results pending until they appear in a model input", () => {
    const completion = {
      runId: "wfrun:subagent:boundary-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:boundary-child",
      profile: "explore" as const,
      sessionName: "boundary-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "boundary result",
    };

    const admitted = planDeferredSubagentBoundary({
      canonicalMessages: [],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(admitted.append).toEqual(buildDeferredSubagentResultMessages(completion));
    expect(admitted.consumedRunIds).toEqual([]);
    expect(admitted.forceNextTurn).toBe(true);

    const appendedButUnconsumed = planDeferredSubagentBoundary({
      canonicalMessages: admitted.append,
      modelInputMessages: [],
      completions: [completion],
    });
    expect(appendedButUnconsumed.append).toEqual([]);
    expect(appendedButUnconsumed.consumedRunIds).toEqual([]);
    expect(appendedButUnconsumed.forceNextTurn).toBe(true);

    const consumed = planDeferredSubagentBoundary({
      canonicalMessages: admitted.append,
      modelInputMessages: admitted.append,
      completions: [completion],
    });
    expect(consumed.append).toEqual([]);
    expect(consumed.consumedRunIds).toEqual([completion.runId]);
    expect(consumed.forceNextTurn).toBe(false);
  });

  it("recognizes consumption after provider tool-call ID normalization", () => {
    const completion = {
      runId: "wfrun:subagent:normalized-run",
      parentToolCallId: "delegate-call",
      childRequestId: "sub:normalized-child",
      profile: "explore" as const,
      sessionName: "normalized-audit",
      status: "resolved" as const,
      ok: true,
      finalText: "normalized result",
    };
    const normalizedModelInput: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagentr",
            toolName: "subagent_result",
            input: { workflowRunId: completion.runId, status: "resolved" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "subagentr",
            toolName: "subagent_result",
            output: {
              type: "json",
              value: {
                workflowRunId: completion.runId,
                finalText: "normalized result",
              },
            },
          },
        ],
      },
    ];

    const consumed = planDeferredSubagentBoundary({
      canonicalMessages: buildDeferredSubagentResultMessages(completion),
      modelInputMessages: normalizedModelInput,
      completions: [completion],
    });

    expect(consumed.consumedRunIds).toEqual([completion.runId]);
    expect(consumed.forceNextTurn).toBe(false);

    const assistantOnly = planDeferredSubagentBoundary({
      canonicalMessages: buildDeferredSubagentResultMessages(completion),
      modelInputMessages: [normalizedModelInput[0]!],
      completions: [completion],
    });
    expect(assistantOnly.consumedRunIds).toEqual([]);
    expect(assistantOnly.forceNextTurn).toBe(true);

    const missingResult = planDeferredSubagentBoundary({
      canonicalMessages: [buildDeferredSubagentResultMessages(completion)[0]!],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(missingResult.append).toEqual([buildDeferredSubagentResultMessages(completion)[1]!]);
  });
});

describe("subagent model selection", () => {
  it("maps model capabilities to resource image and PDF support", () => {
    const capability = {
      provider: "test",
      model: "vision",
      attachment: true,
      limit: { context: 100_000, output: 4_000 },
      modalities: { input: ["text" as const, "image" as const] },
    };

    expect(resolveStoredResourceProviderTarget({ provider: "openai", capability })).toEqual({
      family: "ai-sdk",
      supportsImage: true,
      supportsPdf: false,
    });
    expect(
      resolveStoredResourceProviderTarget({
        provider: "claude-code",
        capability: null,
      }),
    ).toEqual({
      family: "claude-code",
      supportsImage: true,
      supportsPdf: false,
    });
  });

  it("runtime-validates primary lineage, rejects stale proof, and omits it outside Discord", () => {
    const messages = [{ role: "user", content: "hello" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "message",
          },
        ],
        canonicalMessages: messages,
      },
    ]);
    const staleStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest() {},
      getCoreSurfaceProjection() {
        return Result.ok(null);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      validateCorePrimaryLineageReferences() {
        return Result.ok("stale-surface-lineage");
      },
      close() {},
    };
    const validStore = {
      ...staleStore,
      getCoreSurfaceProjection() {
        return Result.ok({
          requestClient: "discord" as const,
          surfaceId: "discord:channel",
          sessionId: "channel",
          messageId: "message",
          projectionFormatVersion: 1 as const,
          canonicalMessages: messages,
          sourceFacts: {
            segmentMessageIds: ["message"],
            segmentDigest: hashCanonicalMessagesV1(messages).hash,
          },
          ownedBlobs: [],
          createdAt: 1,
        });
      },
      validateCorePrimaryLineageReferences(input: { manifest: CoreLineageManifestV2 }) {
        return Result.ok(
          input.manifest.segments[0]?.canonicalMessages[0]?.content === "hello"
            ? null
            : "transformed-surface-lineage",
        );
      },
    };

    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: validStore,
      }),
    ).toEqual(manifest);

    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: staleStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "stale-surface-lineage",
    });
    const transformedMessages = [{ role: "user", content: "edited" }] satisfies ModelMessage[];
    const transformedManifest = buildCoreLineageManifestV2([
      {
        atoms: manifest.segments[0]!.atoms,
        canonicalMessages: transformedMessages,
      },
    ]);
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages: transformedMessages,
        corePrimaryLineage: transformedManifest,
        transcriptStore: validStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "transformed-surface-lineage",
    });
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "discord",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: { ...manifest, segments: [] },
        transcriptStore: staleStore,
      }),
    ).toEqual({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "malformed-or-unaligned-manifest",
    });
    expect(
      validateCorePrimaryLineageAtRunnerIntake({
        requestClient: "github",
        sessionId: "channel",
        runProfile: "primary",
        messages,
        corePrimaryLineage: manifest,
        transcriptStore: staleStore,
      }),
    ).toBeUndefined();
  });

  it("enables persistent Claude only for Discord primary or stable named ownership", () => {
    const manifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "test",
            messageDigest: "11".repeat(32),
          },
        ],
        canonicalMessages: [{ role: "user", content: "hello" }],
      },
    ]);
    expect(
      shouldUsePersistentCoreClaudeRuntime({
        runProfile: "primary",
        requestClient: "discord",
        stableNamedContinuation: null,
        corePrimaryLineage: manifest,
      }),
    ).toBe(true);
    expect(
      shouldUsePersistentCoreClaudeRuntime({
        runProfile: "primary",
        requestClient: "github",
        stableNamedContinuation: null,
        corePrimaryLineage: manifest,
      }),
    ).toBe(false);
  });

  it("treats missing provider metadata and unidentified assistant history as mixed", () => {
    const requestLineage = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "request",
            requestId: "request",
            transcriptDigest: "11".repeat(32),
            providerFamily: "claude-code",
            containsCrossFamilyTurns: false,
          },
        ],
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "output",
            },
          ],
        },
        canonicalMessages: [{ role: "assistant", content: "request output" }],
      },
    ]);
    expect(
      resolveCorePrimaryTranscriptProviderState({
        targetFamily: "claude-code",
        lineage: requestLineage,
      }).containsCrossFamilyTurns,
    ).toBe(true);

    const syntheticAssistantLineage = buildCoreLineageManifestV2([
      {
        atoms: [{ kind: "synthetic", source: "test", messageDigest: "22".repeat(32) }],
        canonicalMessages: [{ role: "assistant", content: "unknown provider" }],
      },
    ]);
    expect(
      resolveCorePrimaryTranscriptProviderState({
        targetFamily: "claude-code",
        lineage: syntheticAssistantLineage,
      }).containsCrossFamilyTurns,
    ).toBe(true);
  });

  it("marks queue, follow-up, steering, recovery, and synthetic transforms fresh-only", () => {
    for (const reason of [
      "queued-request-coalesced",
      "queued-buffer-absorbed-into-steering",
      "follow-up-transform",
      "steering-transform",
      "restart-recovery-checkpoint",
      "compaction-checkpoint-transform",
      "synthetic-thread-search-insertion",
      "deferred-result-insertion",
    ]) {
      expect(degradeCorePrimaryLineageForMutation(reason)).toEqual({
        state: "fresh-only",
        lineageVersion: 2,
        currentCanonicalStart: 0,
        reason,
      });
    }
  });

  it("parses the minimal workflow dispatch hint and requires its epoch", () => {
    expect(
      parseWorkflowRequestHintFromRaw({
        workflow: {
          runId: "run-1",
          operationId: "operation-1",
          dispatchEpoch: "dispatch-epoch-0001",
        },
      }),
    ).toEqual({
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
    });
    expect(
      parseWorkflowRequestHintFromRaw({
        workflow: { runId: "run-1", operationId: "operation-1" },
      }),
    ).toBeNull();
  });

  it("parses a subagent reasoning override from raw request metadata", () => {
    expect(
      parseSubagentMetaFromRaw({
        subagent: { profile: "explore", depth: 1, reasoning: "xhigh" },
      }),
    ).toEqual({ profile: "explore", depth: 1, reasoning: "xhigh" });
  });

  it("preserves subagent profile and depth when reasoning metadata is invalid", () => {
    expect(
      parseSubagentMetaFromRaw({
        subagent: { profile: "explore", depth: 2, reasoning: "future-effort" },
      }),
    ).toEqual({ profile: "explore", depth: 2 });
  });

  it("resolves an agent-selectable alias and applies per-call reasoning", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      scout: {
        model: "openai/gpt-4o-mini",
        reasoning: "low",
        agentCanSelect: true,
      },
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "explore",
      requestModelOverride: "scout",
      reasoningOverride: "high",
    });

    expect(resolved.head.alias).toBe("scout");
    expect(resolved.head.spec).toBe("openai/gpt-4o-mini");
    expect(resolved.head.reasoning).toBe("high");
  });

  it("rejects direct and opted-out subagent model overrides", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      manual: {
        model: "openai/gpt-4o",
        agentCanSelect: false,
      },
    };

    expect(() =>
      resolveAgentRunModel({
        cfg,
        runProfile: "general",
        requestModelOverride: "openai/gpt-4o",
      }),
    ).toThrow("must be a models.def alias");
    expect(() =>
      resolveAgentRunModel({
        cfg,
        runProfile: "general",
        requestModelOverride: "manual",
      }),
    ).toThrow("not available for agent selection");
  });

  it("allows an opted-out alias in an explicit static profile", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      manual: {
        model: "openai/gpt-4o",
        agentCanSelect: false,
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      modelSlot: "main",
      model: "manual",
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "general",
    });

    expect(resolved.head.alias).toBe("manual");
  });

  it("applies reasoning overrides to the configured profile fallback", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
      reasoning: "low",
    };

    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "explore",
      reasoningOverride: "medium",
    });

    expect(resolved.head.reasoning).toBe("medium");
  });

  it("rehydrates a durable workflow model request without current preset resolution", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      changed: {
        model: "openai/current-model",
        options: { openai: { route: "current" } },
      },
    };
    const resolved = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      resolvedModelRequest: {
        alias: "removed-preset",
        spec: "codex/durable-model",
        provider: "codex",
        modelId: "durable-model",
        providerOptions: { openai: { route: "durable", store: false } },
        reasoning: "high",
        responseCommentary: true,
        anthropicPromptCache: true,
        reasoningDisplay: "none",
      },
    });

    expect(resolved.head).toMatchObject({
      alias: "removed-preset",
      spec: "codex/durable-model",
      provider: "codex",
      modelId: "durable-model",
      providerOptions: { openai: { route: "durable", store: false } },
      reasoning: "high",
      responseCommentary: true,
      anthropicPromptCache: true,
    });
  });

  it("preserves request alias fallback order and applies the strongest reasoning chain-wide", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      requested: {
        model: "openai/head",
        reasoning: "low",
        agentCanSelect: true,
        fallback: [
          "openai/backup",
          { model: "openai/special", reasoning: "none" },
          "openai/backup",
        ],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      reasoning: "medium",
    };

    const defaultReasoningPlan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
    });
    expect(
      [defaultReasoningPlan.head, ...defaultReasoningPlan.fallbacks].map(
        (candidate) => candidate.reasoning,
      ),
    ).toEqual(["medium", "medium", "none", "medium"]);

    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
      reasoningOverride: "xhigh",
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/head",
      "openai/backup",
      "openai/special",
      "openai/backup",
    ]);
    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.reasoning)).toEqual([
      "xhigh",
      "xhigh",
      "xhigh",
      "xhigh",
    ]);
  });

  it("resolves current override fallbacks without resolving or validating the alias head", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      requested: {
        model: "invalid-changed-head",
        agentCanSelect: false,
        fallback: ["openai/current", { model: "openai/explicit", reasoning: "low" }],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      reasoning: "medium",
    };

    const fallbacks = resolveAgentRunModelFallbacks({
      cfg,
      runProfile: "general",
      requestModelOverride: "requested",
    });

    expect(fallbacks.map((candidate) => [candidate.spec, candidate.reasoning])).toEqual([
      ["openai/current", "medium"],
      ["openai/explicit", "low"],
    ]);
    delete cfg.models.def.requested;
    expect(
      resolveAgentRunModelFallbacks({
        cfg,
        runProfile: "general",
        requestModelOverride: "requested",
        reasoningOverride: "high",
      }),
    ).toEqual([]);
  });

  it("keeps explicit profile and slot fallbacks when their head aliases are missing", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.main = {
      model: "missing-slot-head",
      fallback: ["openai/slot-backup"],
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "missing-profile-head",
      fallback: ["openai/profile-backup"],
    };

    expect(
      resolveAgentRunModelFallbacks({ cfg, runProfile: "general" }).map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/profile-backup"]);
    expect(
      resolveAgentRunModelFallbacks({ cfg, runProfile: "explore" }).map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/slot-backup"]);
  });

  it("uses explicit profile fallback and profile reasoning unless an entry overrides it", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      profile: {
        model: "openai/profile",
        fallback: ["openai/alias-backup"],
      },
    };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "profile",
      reasoning: "medium",
      fallback: [
        "openai/common-reasoning",
        { model: "openai/own-reasoning", reasoning: "low" },
        "openai/common-reasoning",
      ],
    };

    const plan = resolveAgentRunModel({ cfg, runProfile: "general" });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/profile",
      "openai/common-reasoning",
      "openai/own-reasoning",
      "openai/common-reasoning",
    ]);
    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.reasoning)).toEqual([
      "medium",
      "medium",
      "low",
      "medium",
    ]);
  });

  it("lets profile fallback replace slot and alias fallback", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      slot: { model: "openai/slot", fallback: ["openai/alias-backup"] },
    };
    cfg.models.fast = { model: "slot", fallback: ["openai/slot-backup"] };
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
      fallback: ["openai/profile-backup", "openai/profile-backup"],
    };

    const plan = resolveAgentRunModel({ cfg, runProfile: "explore" });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/slot",
      "openai/profile-backup",
      "openai/profile-backup",
    ]);
  });

  it("inherits alias fallback for a direct profile and slot fallback for a slot profile", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      direct: {
        model: "openai/direct",
        fallback: ["openai/direct-alias-backup"],
      },
      slot: { model: "openai/slot", fallback: ["openai/slot-alias-backup"] },
    };
    cfg.models.fast = { model: "slot", fallback: ["openai/slot-backup"] };
    cfg.agent.subagents.profiles.general = {
      ...cfg.agent.subagents.profiles.general,
      model: "direct",
    };
    cfg.agent.subagents.profiles.explore = {
      ...cfg.agent.subagents.profiles.explore,
      modelSlot: "fast",
    };

    expect(
      resolveAgentRunModel({ cfg, runProfile: "general" }).fallbacks.map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/direct-alias-backup"]);
    expect(
      resolveAgentRunModel({ cfg, runProfile: "explore" }).fallbacks.map(
        (candidate) => candidate.spec,
      ),
    ).toEqual(["openai/slot-backup"]);
  });

  it("rehydrates the complete durable fallback plan", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "general",
      resolvedModelRequest: {
        spec: "openai/durable-head",
        provider: "openai",
        modelId: "durable-head",
        reasoning: "low",
        reasoningDisplay: "simple",
        fallbacks: [
          {
            spec: "openai/durable-backup",
            provider: "openai",
            modelId: "durable-backup",
            reasoning: "high",
            reasoningDisplay: "simple",
          },
        ],
      },
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/durable-head",
      "openai/durable-backup",
    ]);
    expect(plan.fallbacks[0]?.reasoning).toBe("high");
    expect(plan.fallbacks[0]?.reasoningDisplay).toBe("simple");
  });

  it("skips claude-code candidates, preserves duplicates, and never advances a claude head", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.main = {
      model: "openai/head",
      fallback: ["claude-code/sonnet", "openai/backup", "openai/backup"],
    };
    const plan = resolveAgentRunModel({ cfg, runProfile: "primary" });
    const skipped: string[] = [];

    const first = selectNextNativeModelFallback({
      plan,
      activeIndex: 0,
      onSkipClaudeCode: (candidate) => skipped.push(candidate.spec),
    });
    const second = selectNextNativeModelFallback({
      plan,
      activeIndex: first?.index ?? 0,
    });

    expect(skipped).toEqual(["claude-code/sonnet"]);
    expect(first).toMatchObject({
      index: 2,
      candidate: { spec: "openai/backup" },
    });
    expect(second).toMatchObject({
      index: 3,
      candidate: { spec: "openai/backup" },
    });

    cfg.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/backup"],
    };
    expect(
      selectNextNativeModelFallback({
        plan: resolveAgentRunModel({ cfg, runProfile: "primary" }),
        activeIndex: 0,
      }),
    ).toBeNull();
  });

  it("keeps active model and effort immutable for steering compatibility", () => {
    const requested = {
      spec: "claude-code/sonnet",
      provider: "claude-code",
      modelId: "sonnet",
      model: new MockLanguageModelV4({ modelId: "sonnet" }),
      reasoning: "high" as const,
    };
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: requested.spec,
        activeReasoning: "high",
        activeFamily: "claude-code",
        requested,
      }),
    ).toBe(true);
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: requested.spec,
        activeReasoning: "low",
        activeFamily: "claude-code",
        requested,
      }),
    ).toBe(false);
    expect(
      isActiveRuntimeModelCompatible({
        activeSpec: "openai/gpt-5",
        activeReasoning: "high",
        activeFamily: "ai-sdk",
        requested,
      }),
    ).toBe(false);
    expect(
      shouldQueueIncompatibleActiveRuntimeModel({
        activeSpec: "openai/gpt-5",
        activeReasoning: "high",
        activeFamily: "ai-sdk",
        requested,
      }),
    ).toBe(true);
  });

  it("validates workflow reasoning against the operation request, not resolved defaults", () => {
    const policy = {
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
      profile: "general" as const,
      model: null,
      reasoning: null,
      resolvedModelRequest: {
        spec: "provider/default-model",
        provider: "provider",
        modelId: "default-model",
        reasoning: "high" as const,
        reasoningDisplay: "simple" as const,
      },
      cwd: "/workspace",
      originSession: {
        requestId: null,
        sessionId: null,
        client: null,
        userId: null,
      },
    };

    expect(assertWorkflowDispatchPolicy(policy, { profile: "general", depth: 1 }).status).toBe(
      "ok",
    );
    const mismatch = assertWorkflowDispatchPolicy(
      { ...policy, reasoning: "medium" },
      { profile: "general", depth: 1, reasoning: "low" },
    );
    expect(mismatch.status).toBe("error");
    if (mismatch.status === "error") {
      expect(mismatch.error.message).toContain(
        "reasoning does not match the approved operation policy",
      );
    }
  });

  it("accepts only the exact durable stable-named identity", () => {
    const policy = {
      runId: "run-1",
      operationId: "operation-1",
      dispatchEpoch: "dispatch-epoch-0001",
      profile: "general" as const,
      model: null,
      reasoning: null,
      resolvedModelRequest: {
        spec: "claude-code/sonnet",
        provider: "claude-code",
        modelId: "sonnet",
        reasoningDisplay: "simple" as const,
      },
      cwd: "/workspace",
      originSession: {
        requestId: "parent",
        sessionId: "channel",
        client: "discord" as const,
        userId: "user",
      },
      stableNamedContinuation: {
        sessionId: "sub:channel:named:audit",
        requestClient: "discord" as const,
      },
    };

    const exact = resolveCoreStableNamedContinuation({
      runProfile: "general",
      sessionId: "sub:channel:named:audit",
      workflowPolicy: policy,
    });
    expect(exact.status).toBe("ok");
    if (exact.status === "ok") expect(exact.value).toEqual(policy.stableNamedContinuation);
    const absent = resolveCoreStableNamedContinuation({
      runProfile: "general",
      sessionId: "sub:channel:named:generated",
      workflowPolicy: { ...policy, stableNamedContinuation: undefined },
    });
    expect(absent.status).toBe("ok");
    if (absent.status === "ok") expect(absent.value).toBeNull();
    const mismatchedSession = resolveCoreStableNamedContinuation({
      runProfile: "general",
      sessionId: "sub:channel:named:other",
      workflowPolicy: policy,
    });
    expect(mismatchedSession.status).toBe("error");
    if (mismatchedSession.status === "error") {
      expect(mismatchedSession.error.message).toContain("does not match the child session");
    }
    const primary = resolveCoreStableNamedContinuation({
      runProfile: "primary",
      sessionId: "sub:channel:named:audit",
      workflowPolicy: policy,
    });
    expect(primary.status).toBe("error");
    if (primary.status === "error") {
      expect(primary.error.message).toContain("cannot authorize a primary run");
    }
  });
});

describe("agent run activity", () => {
  it("fails idle retry when the inner backoff Result is aborted", () => {
    expect(
      toIdleRetryDecision(
        Result.err(
          new RetryBackoffAborted({
            cause: new Error("aborted"),
            message: "Retry backoff was aborted",
          }),
        ),
      ),
    ).toEqual({ status: "fail", reason: "aborted" });
  });

  it("fails idle retry when the inner backoff Result exhausts its budget", () => {
    expect(toIdleRetryDecision(Result.ok(null))).toEqual({
      status: "fail",
      reason: "exhausted",
    });
  });

  it("extends the idle deadline when activity continues", async () => {
    let timeoutCount = 0;
    const watchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: 45,
      onTimeout: () => {
        timeoutCount += 1;
      },
    });

    jest.useFakeTimers({ now: 0 });
    try {
      watchdog.start();
      jest.advanceTimersByTime(30);
      watchdog.reset();

      // test-wait-justification: schedules the watched operation on Bun's fake clock
      const operation = new Promise<string>((resolve) => {
        setTimeout(() => resolve("resolved"), 30);
      });
      const watched = watchdog.waitFor(operation);
      jest.advanceTimersByTime(30);

      await expect(watched).resolves.toBe("resolved");
      watchdog.stop();
      jest.advanceTimersByTime(20);
      expect(timeoutCount).toBe(0);
    } finally {
      watchdog.stop();
      jest.useRealTimers();
    }
  });

  it("publishes throttled activity on the request output topic", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requestId = "activity-request";
    const sources: string[] = [];
    const subResult = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "begin" } },
      async (msg) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputActivity) {
          sources.push(msg.data.source);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (subResult.status === "error") throw subResult.error;
    const sub = subResult.value;
    const firstPublished = Promise.withResolvers<void>();
    const secondPublished = Promise.withResolvers<void>();
    let publishCount = 0;
    const publishActivity = createAgentOutputActivityPublisher({
      publish: async (source) => {
        await bus.publish(
          lilacEventTypes.EvtAgentOutputActivity,
          { source },
          { headers: { request_id: requestId } },
        );
        publishCount += 1;
        if (publishCount === 1) firstPublished.resolve();
        if (publishCount === 2) secondPublished.resolve();
      },
      intervalMs: 25,
    });

    jest.useFakeTimers({ now: 0 });
    try {
      publishActivity("model");
      publishActivity("tool");
      await firstPublished.promise;
      jest.advanceTimersByTime(25);
      publishActivity("subagent");
      await secondPublished.promise;

      expect(sources).toEqual(["model", "subagent"]);
      const stopped = await sub.stop();
      if (stopped.status === "error") throw stopped.error;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("workflow request claim pacing", () => {
  it("refreshes at one third of the engine's 30s stale-owner threshold", () => {
    expect(WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS).toBe(10_000);
  });
});

describe("selectPersistedTranscriptMessages", () => {
  const finalMessages = [
    { role: "user", content: "compacted summary" },
    { role: "assistant", content: "retained response" },
    { role: "tool", content: [] },
    { role: "assistant", content: "final response" },
  ] satisfies ModelMessage[];

  it("persists response-only messages for ordinary primary runs", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 3,
        isPrimary: true,
        didCompact: false,
      }),
    ).toEqual([finalMessages[3]!]);
  });

  it("persists the full final canonical transcript after compaction despite a stale index", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 99,
        isPrimary: true,
        didCompact: true,
      }),
    ).toEqual(finalMessages);
  });

  it("keeps non-primary full-transcript persistence unchanged", () => {
    expect(
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 3,
        isPrimary: false,
        didCompact: false,
      }),
    ).toEqual(finalMessages);
  });

  it("creates one checkpoint marker after one or many completed compactions", () => {
    for (const completedCompactionCount of [1, 3]) {
      expect(
        resolveCompactionCheckpointMeta({
          runSucceeded: true,
          isPrimary: true,
          isCancelled: false,
          shouldSkipSurfaceReply: false,
          completedCompactionCount,
        }),
      ).toEqual({ type: "compaction", formatVersion: 1 });
    }
  });

  it("does not mark failed, cancelled, skipped, uncompacted, or non-primary runs", () => {
    const base = {
      runSucceeded: true,
      isPrimary: true,
      isCancelled: false,
      shouldSkipSurfaceReply: false,
      completedCompactionCount: 1,
    };
    expect(resolveCompactionCheckpointMeta({ ...base, runSucceeded: false })).toBeUndefined();
    expect(resolveCompactionCheckpointMeta({ ...base, isCancelled: true })).toBeUndefined();
    expect(
      resolveCompactionCheckpointMeta({
        ...base,
        shouldSkipSurfaceReply: true,
      }),
    ).toBeUndefined();
    expect(
      resolveCompactionCheckpointMeta({ ...base, completedCompactionCount: 0 }),
    ).toBeUndefined();
    expect(resolveCompactionCheckpointMeta({ ...base, isPrimary: false })).toBeUndefined();
  });

  it("detects compaction checkpoint ancestry in complete primary lineage", () => {
    const messages = [{ role: "assistant", content: "compacted history" }] satisfies ModelMessage[];
    const lineage = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "checkpoint",
            requestId: "discord:channel:checkpoint",
            transcriptDigest: "0".repeat(64),
          },
        ],
        canonicalMessages: messages,
      },
    ]);

    expect(corePrimaryLineageHasCompactionCheckpoint(lineage)).toBe(true);
    expect(
      corePrimaryLineageHasCompactionCheckpoint(
        degradeCorePrimaryLineageForMutation("test", messages.length),
      ),
    ).toBe(false);
    expect(corePrimaryLineageHasCompactionCheckpoint(undefined)).toBe(false);
  });
});

function formatExpectedLocalThreadTimeRange(start: string, end: string): string {
  const format = (value: string) => {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  };
  return `${format(start)} - ${format(end)}`;
}

function autoInjectPlanForQuery(query: string, intentSummary: string) {
  return {
    searches: [
      {
        queries: [query],
        aboutness: {
          domains: [],
          situations: [],
          targets: [],
          entities: [],
          userWouldAskForThisAs: [query],
          intentSummary,
        },
      },
    ],
  };
}

describe("bus agent runner delivery policy", () => {
  it("dead-letters missing required request headers", () => {
    const error = new BusAgentRunnerRequestHeadersInvalid({
      missing: ["session_id"],
      message: "missing session id",
    });

    expect(busAgentRunnerDeliveryDisposition(error)).toBe("dead-letter");
  });

  it("dead-letters a redelivered queue attempt with a conflicting route", () => {
    const error = new BusAgentRunnerQueueAttemptRouteInvalid({
      eventId: "pel-route-mismatch",
      message: "route mismatch",
    });
    expect(busAgentRunnerDeliveryDisposition(error)).toBe("dead-letter");
  });

  it("parks expected intake failures", () => {
    const error = new BusAgentRunnerIntakeFailed({
      cause: new Error("lifecycle publish unavailable"),
      message: "request intake failed",
    });

    expect(busAgentRunnerDeliveryDisposition(error)).toBe("park-pending");
  });

  it("reports and rethrows Panic without creating a delivery error", () => {
    const panic = new Panic({ message: "runner invariant failed" });
    const reported: Panic[] = [];

    expect(() => rethrowBusAgentRunnerPanic(panic, (cause) => reported.push(cause))).toThrow(panic);
    expect(reported).toEqual([panic]);
  });

  it("captures ordinary dependency rejection as an owned operation failure", async () => {
    const cause = new Error("provider unavailable");

    const result = await captureBusAgentRunnerOperation("provider resolution", () =>
      Promise.reject(cause),
    );

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected operation failure");
    expect(result.error).toBeInstanceOf(BusAgentRunnerOperationFailed);
    expect(result.error.operation).toBe("provider resolution");
    expect(result.error.cause).toBe(cause);
    expect(result.error.message).toBe("provider unavailable");
  });

  it("preserves Panic identity through capture and the exact host adapter", async () => {
    const panic = new Panic({ message: "provider invariant failed" });
    const reported: Panic[] = [];

    await expect(
      captureBusAgentRunnerOperation(
        "provider resolution",
        () => Promise.reject(panic),
        (cause) => reported.push(cause),
      ),
    ).rejects.toBe(panic);
    expect(reported).toEqual([panic]);

    const ordinaryCause = new Error("model callback failed");
    const failure = new BusAgentRunnerOperationFailed({
      operation: "model callback",
      cause: ordinaryCause,
      failureKind: "other",
      displayMessage: ordinaryCause.message,
      message: ordinaryCause.message,
    });
    expect(() => signalBusAgentRunnerHostFailure(failure)).toThrow(ordinaryCause);
  });

  it("signals stored identity projection failure outside the protected Result callback", () => {
    const projectionError = new StoredMessageProjectionError({
      message: "parallel identity mismatch",
    });

    expect(() => settleStoredMessageIdentityRemember(Result.err(projectionError))).toThrow(
      projectionError,
    );
  });

  it("uploads and reserves provider file bytes before transcript persistence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-runner-provider-file-"));
    const transcriptStore = new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
    const blobStore = transcriptResultValue(await createMemoryBlobStore());
    const base64 = Buffer.from("local read output").toString("base64");
    const providerMessages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-local",
            toolName: "read",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: base64 },
                  mediaType: "text/plain",
                  filename: "local.txt",
                },
              ],
            },
          },
        ],
      },
    ] satisfies ModelMessage[];

    const stored = await projectTranscriptMessagesForPersistence({
      identityProjection: createStoredMessageIdentityProjectionV1(),
      providerMessages: structuredClone(providerMessages) as ModelMessage[],
      blobStore,
      transcriptStore,
    });
    expect(stored[0]?.content[0]).toMatchObject({
      type: "tool-result",
      output: {
        type: "content",
        value: [{ type: "blob", filename: "local.txt" }],
      },
    });
    const blobPart =
      typeof stored[0]?.content === "string"
        ? undefined
        : stored[0]?.content[0]?.type === "tool-result" &&
            stored[0].content[0].output.type === "content"
          ? stored[0].content[0].output.value[0]
          : undefined;
    if (blobPart?.type !== "blob") throw new Error("expected stored provider file blob");
    expect(transcriptStore.getCoreOwnedBlob({ ownerId: blobPart.blob.objectId }).status).toBe("ok");

    transcriptStore.close();
    transcriptResultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    await rm(directory, { recursive: true, force: true });
  });
});

type RunnerTestRawBus = RawBus &
  TestRawSubscriptionHost & {
    redeliverRequest(requestId: string): Promise<void>;
    redeliverRequestEvent(eventId: string): Promise<void>;
    redeliverRequestEventWithHeaders(
      eventId: string,
      headers: Message<unknown>["headers"],
    ): Promise<void>;
    requestEventIds(requestId: string): readonly string[];
    suppressNextWorkReplay(): void;
    failNextQueuedLifecycle(): void;
    failCancelledLifecycleAfter(successfulPublications: number): void;
  };

function createInMemoryRawBus(
  options: {
    readonly waitForActiveHandlersOnStop?: boolean;
    readonly onWorkDeliveryStarted?: () => void;
    readonly onPublish?: (eventType: string) => void;
  } = {},
): RunnerTestRawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: TestRawMessageHandler;
    activeHandlers: Set<Promise<void>>;
  }>();
  let rejectNextQueuedLifecycle = false;
  let cancelledLifecyclePublicationsBeforeFailure: number | null = null;
  let suppressNextWorkReplay = false;
  const raw: RunnerTestRawBus = {
    subscribe: subscribeForTest,
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      options.onPublish?.(opts.type);
      if (
        rejectNextQueuedLifecycle &&
        opts.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        typeof msg.data === "object" &&
        msg.data !== null &&
        Reflect.get(msg.data, "state") === "queued"
      ) {
        rejectNextQueuedLifecycle = false;
        throw new Error("queued lifecycle publication failed");
      }
      if (
        cancelledLifecyclePublicationsBeforeFailure !== null &&
        opts.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        typeof msg.data === "object" &&
        msg.data !== null &&
        Reflect.get(msg.data, "state") === "cancelled"
      ) {
        if (cancelledLifecyclePublicationsBeforeFailure === 0) {
          cancelledLifecyclePublicationsBeforeFailure = null;
          throw new Error("cancelled lifecycle publication failed");
        }
        cancelledLifecyclePublicationsBeforeFailure -= 1;
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        if (s.opts.mode === "work") options.onWorkDeliveryStarted?.();
        const handling = s.handler(stored, id);
        s.activeHandlers.add(handling);
        void handling.then(
          () => s.activeHandlers.delete(handling),
          () => s.activeHandlers.delete(handling),
        );
        await handling;
      }
      return { id, cursor: id };
    },

    openTestSubscription: async (
      topic: string,
      opts: SubscriptionOptions,
      handler: TestRawMessageHandler,
    ) => {
      const entry = {
        topic,
        opts,
        handler,
        activeHandlers: new Set<Promise<void>>(),
      };
      subs.add(entry);

      const offset = opts.mode === "tail" ? opts.offset : undefined;
      if (suppressNextWorkReplay && topic === "cmd.request" && opts.mode === "work") {
        suppressNextWorkReplay = false;
      } else if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await handler(m, m.id);
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
          if (options.waitForActiveHandlersOnStop) {
            await Promise.all(entry.activeHandlers);
          }
        },
      };
    },

    fetch: async (topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    redeliverRequest: async (requestId) => {
      for (const [topic, messages] of topics) {
        const message = messages.findLast(
          (candidate) => candidate.headers?.request_id === requestId,
        );
        if (!message) continue;
        for (const subscription of subs) {
          if (subscription.topic === topic && subscription.opts.mode === "work") {
            await subscription.handler(message, message.id);
          }
        }
        return;
      }
      throw new Error(`Missing request for redelivery: ${requestId}`);
    },

    redeliverRequestEvent: async (eventId) => {
      const messages = topics.get("cmd.request") ?? [];
      const message = messages.find((candidate) => candidate.id === eventId);
      if (!message) throw new Error(`Missing request event for redelivery: ${eventId}`);
      for (const subscription of subs) {
        if (subscription.topic === "cmd.request" && subscription.opts.mode === "work") {
          await subscription.handler(message, message.id);
        }
      }
    },

    redeliverRequestEventWithHeaders: async (eventId, headers) => {
      const messages = topics.get("cmd.request") ?? [];
      const message = messages.find((candidate) => candidate.id === eventId);
      if (!message) throw new Error(`Missing request event for redelivery: ${eventId}`);
      for (const subscription of subs) {
        if (subscription.topic === "cmd.request" && subscription.opts.mode === "work") {
          await subscription.handler({ ...message, headers }, message.id);
        }
      }
    },

    requestEventIds: (requestId) =>
      (topics.get("cmd.request") ?? [])
        .filter((message) => message.headers?.request_id === requestId)
        .map((message) => message.id),

    suppressNextWorkReplay: () => {
      suppressNextWorkReplay = true;
    },

    failNextQueuedLifecycle: () => {
      rejectNextQueuedLifecycle = true;
    },

    failCancelledLifecycleAfter: (successfulPublications) => {
      cancelledLifecyclePublicationsBeforeFailure = successfulPublications;
    },

    close: async () => {},
  };

  return raw;
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  let rejectPromise: (reason?: unknown) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

type ProductionPathOutput = {
  readonly messageId: string;
  readonly parts: SurfaceOutputPart[];
  readonly finished: Promise<void>;
};

class ProductionPathDiscordAdapter extends SurfaceAdapterTestBase {
  readonly messages = new Map<string, SurfaceMessage>();
  readonly outputs: ProductionPathOutput[] = [];
  readonly updatedOutputMessageIds: string[] = [];
  private readonly handlers = new Set<AdapterEventHandler>();
  private outputSequence = 0;
  private timestamp = 10_000;

  async emitCreated(message: SurfaceMessage): Promise<void> {
    this.messages.set(message.ref.messageId, message);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.created",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  private async emitOutputUpdated(message: SurfaceMessage): Promise<void> {
    this.updatedOutputMessageIds.push(message.ref.messageId);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.updated",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    throw new Error("not used");
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    this.outputSequence += 1;
    const messageId = `output-${this.outputSequence}`;
    const parts: SurfaceOutputPart[] = [];
    const finished = deferred<void>();
    let outputMessage: SurfaceMessage | null = null;
    let visibleText = "";
    const ensureOutputMessage = (): SurfaceMessage => {
      if (outputMessage) return outputMessage;
      outputMessage = {
        ref: {
          platform: "discord",
          channelId: sessionRef.channelId,
          messageId,
        },
        session: { platform: "discord", channelId: sessionRef.channelId },
        userId: "bot",
        userName: "lilac",
        text: "",
        ts: this.timestamp++,
        raw: {
          reference: opts?.replyTo
            ? {
                messageId: opts.replyTo.messageId,
                channelId: opts.replyTo.channelId,
              }
            : {},
          discord: { isChat: true },
        },
      };
      this.messages.set(messageId, outputMessage);
      opts?.onMessageCreated?.(outputMessage.ref);
      return outputMessage;
    };
    this.outputs.push({ messageId, parts, finished: finished.promise });

    return Result.ok({
      push: async (part) => {
        parts.push(part);
        const message = ensureOutputMessage();
        if (part.type === "text.delta") visibleText += part.delta;
        if (part.type === "text.set") visibleText = part.text;
        message.text = visibleText;
        await this.emitOutputUpdated(message);
        return Result.ok("visible");
      },
      finish: async () => {
        const message = ensureOutputMessage();
        finished.resolve(undefined);
        return Result.ok({ created: [message.ref], last: message.ref });
      },
      abort: async () => {
        finished.resolve(undefined);
        return Result.ok(undefined);
      },
      getFinalTextMode: () => "continuation",
    });
  }

  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    throw new Error("not used");
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    return Result.ok(this.messages.get(msgRef.messageId) ?? null);
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const before = opts?.beforeMessageId ? this.messages.get(opts.beforeMessageId)?.ts : undefined;
    return Result.ok(
      [...this.messages.values()]
        .filter((message) => message.session.channelId === sessionRef.channelId)
        .filter((message) => before === undefined || message.ts < before)
        .toSorted((left, right) => left.ts - right.ts)
        .slice(-(opts?.limit ?? 50)),
    );
  }

  async editMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async deleteMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async getReplyContext(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    return Result.ok([]);
  }
  override async planReplyChain(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refs: MsgRef[] = [];
    const seen = new Set<string>();
    let cursor = msgRef;

    while (!seen.has(cursor.messageId)) {
      seen.add(cursor.messageId);
      refs.push(cursor);
      const reply = normalizeDiscordRaw(this.messages.get(cursor.messageId)?.raw)?.replyReference;
      if (!reply?.messageId) break;
      const channelId = reply.channelId ?? cursor.channelId;
      if (channelId !== msgRef.channelId) break;
      cursor = { platform: "discord", channelId, messageId: reply.messageId };
    }

    return Result.ok(refs.reverse());
  }
  async addReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async removeReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async listReactions(): Promise<SurfaceOperationResult<string[]>> {
    return Result.ok([]);
  }

  async subscribe(handler: AdapterEventHandler): Promise<{ stop(): Promise<void> }> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    return Result.ok([]);
  }
  async markRead(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
}

async function observeRequestLifecycle(bus: ReturnType<typeof createLilacBus>, requestId: string) {
  const terminal = deferred<"resolved" | "cancelled" | "failed">();
  const states: string[] = [];
  const details: Array<string | undefined> = [];
  const subscriptionResult = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "begin" } },
    async (message) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId
      ) {
        states.push(message.data.state);
        details.push(message.data.detail);
        if (
          message.data.state === "resolved" ||
          message.data.state === "cancelled" ||
          message.data.state === "failed"
        ) {
          terminal.resolve(message.data.state);
        }
      }
      return Result.ok(undefined);
    },
    () => "dead-letter",
  );
  if (subscriptionResult.status === "error") throw subscriptionResult.error;
  const subscription = subscriptionResult.value;
  return {
    states,
    details,
    terminal: terminal.promise,
    stop: async () => {
      const stopped = await subscription.stop();
      if (stopped.status === "error") throw stopped.error;
    },
  };
}

async function observeResponseAfterOutputRelay(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
) {
  const relayed = deferred<void>();
  let outputSubscription: {
    stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
  } | null = null;
  const lifecycleSubscriptionResult = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "now" } },
    async (message) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId &&
        message.data.state === "resolved" &&
        outputSubscription === null
      ) {
        const outputSubscriptionResult = await bus.subscribeTopic(
          outReqTopic(requestId),
          { mode: "tail", offset: { type: "now" } },
          async (outputMessage) => {
            if (outputMessage.type === lilacEventTypes.EvtAgentOutputResponseText) {
              relayed.resolve(undefined);
            }
            return Result.ok(undefined);
          },
          () => "dead-letter",
        );
        if (outputSubscriptionResult.status === "error") throw outputSubscriptionResult.error;
        outputSubscription = outputSubscriptionResult.value;
      }
      return Result.ok(undefined);
    },
    () => "dead-letter",
  );
  if (lifecycleSubscriptionResult.status === "error") throw lifecycleSubscriptionResult.error;
  const lifecycleSubscription = lifecycleSubscriptionResult.value;
  return {
    relayed: relayed.promise,
    stop: async () => {
      const lifecycleStopped = await lifecycleSubscription.stop();
      if (lifecycleStopped.status === "error") throw lifecycleStopped.error;
      if (outputSubscription) {
        const outputStopped = await outputSubscription.stop();
        if (outputStopped.status === "error") throw outputStopped.error;
      }
    },
  };
}

async function publishRunnerRequest(input: {
  bus: ReturnType<typeof createLilacBus>;
  requestId: string;
  sessionId: string;
  queue?: "prompt" | "followUp" | "steer" | "interrupt";
  text: string;
  messages?: readonly unknown[];
  modelOverride?: string;
  requestClient?: "discord" | "github";
  corePrimaryLineage?: CorePrimaryLineageV2;
  raw?: unknown;
  requestDeliveryId?: string;
}) {
  const requestDeliveryId = input.requestDeliveryId ?? crypto.randomUUID();
  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      requestDeliveryId,
      queue: input.queue ?? "prompt",
      messages: transcriptResultValue(
        projectStoredMessagesV1(input.messages ?? [{ role: "user", content: input.text }]),
      ),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    },
    {
      headers: {
        request_id: input.requestId,
        session_id: input.sessionId,
        request_client: input.requestClient ?? "github",
      },
    },
  );
  return requestDeliveryId;
}

function acceptedRunnerDelivery(input: {
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient?: "discord" | "github";
  readonly queue: CoreAcceptedRequestWork["data"]["queue"];
  readonly messages: readonly StoredMessageV1[];
  readonly corePrimaryLineage?: CorePrimaryLineageV2;
  readonly inputReferences?: AcceptedRequestDelivery<CoreAcceptedRequestWork>["inputReferences"];
  readonly raw?: unknown;
}): AcceptedRequestDelivery<CoreAcceptedRequestWork> {
  const requestClient = input.requestClient ?? "github";
  const headers = {
    request_id: input.requestId,
    session_id: input.sessionId,
    request_client: requestClient,
  };
  return {
    state: "accepted",
    requestDeliveryId: input.requestDeliveryId,
    requestId: input.requestId,
    work: {
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      requestClient,
      headers,
      data: {
        requestDeliveryId: input.requestDeliveryId,
        queue: input.queue,
        messages: [...input.messages],
        ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
        ...(input.raw === undefined ? {} : { raw: input.raw }),
      },
    },
    inputReferences: input.inputReferences ?? [],
    createdAt: 1,
    acceptedAt: 2,
  };
}

describe("durable accepted runner recovery", () => {
  it.each([false, true])(
    "releases toolset ownership after run completion, cancelled during build=%s",
    async (cancelDuringBuild) => {
      const bus = createLilacBus(createInMemoryRawBus());
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/toolset-release" };
      const buildStarted = deferred<void>();
      const finishBuild = deferred<void>();
      const released = deferred<void>();
      let releases = 0;
      let modelCalls = 0;
      const toolset = {
        ...level1TestToolset(),
        release: async () => {
          releases += 1;
          released.resolve(undefined);
          return Result.ok(undefined);
        },
      };
      const pluginManager = corePrimaryTestPluginManager(undefined, toolset);
      pluginManager.buildLevel1ToolsetResult = async () => {
        buildStarted.resolve(undefined);
        if (cancelDuringBuild) await finishBuild.promise;
        return Result.ok(toolset);
      };
      const runner = await startBusAgentRunner({
        bus,
        config,
        pluginManager,
        subscriptionId: "toolset-release",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        issueControlCapability: () => ({ capability: "toolset-release", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "toolset-release",
              doStream: async () => {
                modelCalls += 1;
                expect(releases).toBe(0);
                return level1TextStep("finished");
              },
            }),
          }),
      });
      const request = {
        bus,
        requestId: "github:toolset-release:request",
        sessionId: "toolset-release",
        text: "hold toolset ownership",
      };
      try {
        await publishRunnerRequest(request);
        await buildStarted.promise;
        const drain = runner.getActiveDrainOperation();
        if (cancelDuringBuild) {
          await publishRunnerRequest({
            ...request,
            queue: "interrupt",
            messages: [],
            raw: { cancel: true },
          });
          await drain;
          expect(releases).toBe(0);
          finishBuild.resolve(undefined);
        }
        await released.promise;
        await drain;
        expect(releases).toBe(1);
        expect(modelCalls).toBe(cancelDuringBuild ? 0 : 1);
      } finally {
        finishBuild.resolve(undefined);
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );
  it.each(["register", "ready"] as const)(
    "settles preparation failure at parent %s and starts the next session request",
    async (failureStage) => {
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      let registrations = 0;
      let closes = 0;
      const terminalized: string[] = [];
      const workflowLiveParentBridge = {
        registerParent: () => {
          registrations += 1;
          if (failureStage === "register") throw new Error("parent registration unavailable");
          return {
            ready: Promise.reject(new Error("child subscription unavailable")),
            close: async () => {
              closes += 1;
            },
          };
        },
      } as unknown as NonNullable<
        Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
      >;
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `parent-preparation-${failureStage}`,
        config: parseCoreConfigV2ToUniversal({}),
        pluginManager,
        workflowLiveParentBridge,
        requestDelivery: {
          terminalize: async ({ requestDeliveryId }: { requestDeliveryId: string }) => {
            terminalized.push(requestDeliveryId);
            return Result.ok(undefined);
          },
        } as unknown as BusAgentRunnerRequestDelivery,
        reportFatalPanic: (panic) => {
          throw panic;
        },
      });
      try {
        for (const suffix of ["first", "second"]) {
          const requestDeliveryId = crypto.randomUUID();
          transcriptResultValue(
            await runner.resumeAcceptedDelivery(
              acceptedRunnerDelivery({
                requestDeliveryId,
                requestId: `github:parent-preparation:${suffix}`,
                sessionId: "parent-preparation",
                queue: "prompt",
                messages: [{ role: "user", content: "exercise preparation cleanup" }],
              }),
            ),
          );
          await runner.getActiveDrainOperation();
          expect(terminalized).toContain(requestDeliveryId);
        }
        expect(registrations).toBe(2);
        expect(closes).toBe(failureStage === "ready" ? 2 : 0);
        expect(runner.getActiveLevel1Work()).toEqual([]);
      } finally {
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );
  it.each(["handler-throw", "result-error", "already-accepted"] as const)(
    "does not start provider work for durable admission outcome %s",
    async (failureKind) => {
      const rawBus = createInMemoryRawBus();
      testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
      const bus = createLilacBus(rawBus);
      const pluginManager = corePrimaryTestPluginManager();
      let modelCalls = 0;
      const requestDelivery = {
        handleDelivery: async () => {
          if (failureKind === "handler-throw") {
            throw new Error("injected delivery handler rejection");
          }
          if (failureKind === "result-error") {
            return Result.err(new Error("injected delivery handler failure"));
          }
          return Result.ok({
            disposition: "commit" as const,
            reason: "already-accepted" as const,
          });
        },
        replaceAcceptedWork: () => {
          throw new Error("unowned work must not be replaced");
        },
        terminalize: async () => {
          throw new Error("unowned work must not be terminalized");
        },
      } as unknown as BusAgentRunnerRequestDelivery;
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `durable-admission-${failureKind}`,
        reportFatalPanic: () => undefined,
        config: parseCoreConfigV2ToUniversal({}),
        pluginManager,
        requestDelivery,
        issueControlCapability: () => ({
          capability: "durable-admission",
          principal: null,
        }),
        createAgent: (options) => {
          modelCalls += 1;
          return new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "must-not-run",
              doStream: async () => level1TextStep("must not run"),
            }),
          });
        },
      });
      try {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: crypto.randomUUID(),
          requestId: `github:durable-admission:${failureKind}`,
          sessionId: `durable-admission-${failureKind}`,
          text: "must remain parked",
        });
        expect(runner.getActiveDrainOperation()).toBeNull();
        expect(modelCalls).toBe(0);
      } finally {
        testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );

  it("reconciles accepted work immediately after a post-accept intake failure", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:accepted-reconcile:request";
    const sessionId = "accepted-reconcile";
    const messages: StoredMessageV1[] = [{ role: "user", content: "retry from accepted work" }];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages,
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let intakeAttempts = 0;
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "accepted-reconcile",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      beforeRequestIntake: () => {
        intakeAttempts += 1;
        throw new Error("fail after accepted commit");
      },
      issueControlCapability: () => ({
        capability: "reconcile",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "accepted-reconcile",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("reconciled");
            },
          }),
        }),
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "retry from accepted work",
      });
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect({ intakeAttempts, modelCalls }).toEqual({
        intakeAttempts: 1,
        modelCalls: 1,
      });
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("terminal");
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("retains an applied attached control until the active run terminalizes", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const activeDeliveryId = crypto.randomUUID();
    const controlDeliveryId = crypto.randomUUID();
    const requestId = "github:retained-control:active";
    const sessionId = "retained-control";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: activeDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: activeDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "stay active" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const uploaded = transcriptResultValue(
      await TEST_BLOB_STORE.startUpload({
        source: new TextEncoder().encode("active steering attachment"),
        retention: { kind: "durable" },
      }),
    );
    const reference = transcriptResultValue(await uploaded.completion);
    const controlMessages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "apply attached steer" },
          {
            type: "blob" as const,
            blob: uploaded.handle,
            mediaType: "text/plain",
            filename: "steer.txt",
          },
        ],
      },
    ];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: controlDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
        },
        inputHandles: [uploaded.handle],
        createdAt: 2,
      }),
    );
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const steerApplied = deferred<void>();
    const reconciledControlStates: string[] = [];
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => {
        reconciledControlStates.push(transcriptResultValue(store.load(controlDeliveryId)).state);
        return Result.ok(undefined);
      },
    };
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "retained-attached-control",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "retained-control",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "retained-control",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              }
              return level1TextStep("done");
            },
          }),
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          const id = steer(message);
          steerApplied.resolve(undefined);
          return id;
        };
        return agent;
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: activeDeliveryId,
        requestId,
        sessionId,
        text: "stay active",
      });
      await firstStarted.promise;
      transcriptResultValue(
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );
      await steerApplied.promise;
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("accepted");
      expect((await TEST_BLOB_STORE.open(reference)).status).toBe("ok");

      releaseFirst.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("terminal");
      expect(reconciledControlStates).toEqual(["terminal"]);
      expect((await TEST_BLOB_STORE.open(reference)).status).toBe("error");
    } finally {
      releaseFirst.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("checkpoints a queued control and its retained delivery in the same transition", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const activeDeliveryId = crypto.randomUUID();
    const controlDeliveryId = crypto.randomUUID();
    const requestId = "github:checkpointed-control:active";
    const sessionId = "checkpointed-control";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: activeDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: activeDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "stay active" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const controlMessages = [{ role: "user" as const, content: "apply queued steer" }];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: controlDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
        },
        inputHandles: [],
        createdAt: 2,
      }),
    );
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const steerApplied = deferred<void>();
    const checkpoints: AgentRunCheckpointV1[] = [];
    let crashBoundaryCheckpoint: AgentRunCheckpointV1 | undefined;
    let controlQueued = false;
    let failedControlCheckpoint = false;
    let journalSequence = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalSequence += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: journalSequence,
        });
      },
      writeCheckpoint: (
        handle: {
          readonly runId: string;
          readonly requestId: string;
          readonly sessionId: string;
          readonly sequence: number;
        },
        checkpoint: AgentRunCheckpointV1,
      ) => {
        const includesControl = JSON.stringify(checkpoint.messages).includes("apply queued steer");
        if (includesControl && !failedControlCheckpoint) {
          failedControlCheckpoint = true;
          throw new Error("injected unexpected checkpoint writer failure");
        }
        checkpoints.push(checkpoint);
        if (controlQueued && !includesControl && !crashBoundaryCheckpoint) {
          crashBoundaryCheckpoint = checkpoint;
        }
        journalSequence = handle.sequence + 1;
        return Result.ok({ ...handle, sequence: journalSequence });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "checkpointed-control",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "checkpointed-control",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "checkpointed-control",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              }
              if (modelCalls === 2) {
                return level1ToolCallStep([
                  { toolCallId: "retry-checkpoint", toolName: "retry_checkpoint" },
                ]);
              }
              return level1TextStep("done");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          normalizeSettledToolResultOutputs: undefined,
          tools: {
            retry_checkpoint: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => "checkpoint retry boundary",
            }),
          },
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          const id = steer(message);
          controlQueued = true;
          steerApplied.resolve(undefined);
          return id;
        };
        return agent;
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: activeDeliveryId,
        requestId,
        sessionId,
        text: "stay active",
      });
      await firstStarted.promise;
      transcriptResultValue(
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );
      await steerApplied.promise;
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("accepted");

      releaseFirst.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(crashBoundaryCheckpoint).toBeDefined();
      expect(crashBoundaryCheckpoint?.retainedRequestDeliveries).toEqual([]);
      expect(
        checkpoints.some(
          (checkpoint) =>
            JSON.stringify(checkpoint.messages).includes("apply queued steer") &&
            checkpoint.retainedRequestDeliveries.filter(
              (retained) => retained.requestDeliveryId === controlDeliveryId,
            ).length === 1,
        ),
      ).toBe(true);
      expect(failedControlCheckpoint).toBe(true);
      expect(modelCalls).toBe(3);
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("terminal");
    } finally {
      releaseFirst.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("continues provider work while a checkpoint blob upload is pending", async () => {
    const order: string[] = [];
    const uploadStarted = deferred<void>();
    const secondModelStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    let uploadReleased = false;
    let modelAdvancedBeforeUpload = false;
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-runner-journal-background-"));
    const transcriptStore = new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
    const baseBlobStore = transcriptResultValue(await createMemoryBlobStore());
    let uploadCount = 0;
    const blobStore: BlobStore = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        uploadCount += 1;
        if (uploadCount !== 1) return started;
        return started.map((upload) => ({
          ...upload,
          completion: (async () => {
            uploadStarted.resolve(undefined);
            await releaseUpload.promise;
            return await upload.completion;
          })(),
        }));
      },
      resolve: (handle, options) => baseBlobStore.resolve(handle, options),
      open: (ref) => baseBlobStore.open(ref),
      delete: (target) => baseBlobStore.delete(target),
      maintain: (input) => baseBlobStore.maintain(input),
      close: (input) => baseBlobStore.close(input),
    };
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType === lilacEventTypes.EvtAgentOutputResponseText) order.push("surface-write");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore,
      admission: createCoreRequestDeliveryAdmission(blobStore),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-order:request";
    const sessionId = "journal-order";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "persist before work" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let sequence = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        order.push("open");
        sequence += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("checkpoint");
        sequence = handle.sequence + 1;
        return Result.ok({ ...handle, sequence });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("terminal");
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-order",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      blobStore,
      transcriptStore,
      issueControlCapability: () => ({
        capability: "journal-order",
        principal: null,
      }),
      createAgent: (options) => {
        let modelCalls = 0;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-order",
            doStream: async () => {
              modelCalls += 1;
              order.push(`model-${modelCalls}`);
              if (modelCalls === 1) {
                return level1ToolCallStep([{ toolCallId: "read-image", toolName: "read" }]);
              }
              modelAdvancedBeforeUpload = !uploadReleased;
              secondModelStarted.resolve(undefined);
              return level1TextStep("journalled");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          normalizeSettledToolResultOutputs: undefined,
          tools: {
            read: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => ({ filename: "image.png" }),
              toModelOutput: () => ({
                type: "content",
                value: [
                  { type: "text", text: "Attached image.png" },
                  {
                    type: "file",
                    data: { type: "data", data: "iVBORwE=" },
                    mediaType: "image/png",
                    filename: "image.png",
                  },
                ],
              }),
            }),
          },
        });
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "persist before work",
      });
      await uploadStarted.promise;
      await secondModelStarted.promise;
      expect(modelAdvancedBeforeUpload).toBe(true);
      uploadReleased = true;
      releaseUpload.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(order.indexOf("surface-write")).toBeLessThan(order.indexOf("terminal"));
    } finally {
      uploadReleased = true;
      releaseUpload.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      transcriptStore.close();
      await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 });
      store.close();
      await bus.close();
      await rm(directory, { recursive: true });
    }
  });

  it("keeps recovery ownership when both terminal surface publications fail", async () => {
    let terminalSurfaceAttempts = 0;
    const terminalSurfaceFailed = deferred<void>();
    const uploadStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    const liveParentClosed = deferred<void>();
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-runner-journal-failed-output-"));
    const transcriptStore = new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
    const baseBlobStore = transcriptResultValue(await createMemoryBlobStore());
    let uploadCount = 0;
    const blobStore: BlobStore = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        uploadCount += 1;
        if (uploadCount !== 1) return started;
        return started.map((upload) => ({
          ...upload,
          completion: (async () => {
            uploadStarted.resolve(undefined);
            await releaseUpload.promise;
            return await upload.completion;
          })(),
        }));
      },
      resolve: (handle, options) => baseBlobStore.resolve(handle, options),
      open: (ref) => baseBlobStore.open(ref),
      delete: (target) => baseBlobStore.delete(target),
      maintain: (input) => baseBlobStore.maintain(input),
      close: (input) => baseBlobStore.close(input),
    };
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType !== lilacEventTypes.EvtAgentOutputResponseText) return;
        terminalSurfaceAttempts += 1;
        if (terminalSurfaceAttempts === 2) terminalSurfaceFailed.resolve(undefined);
        throw new Error("injected terminal surface publication failure");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore,
      admission: createCoreRequestDeliveryAdmission(blobStore),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-terminal-publication-failure:request";
    const sessionId = "journal-terminal-publication-failure";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "retain recovery ownership" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let terminalMarks = 0;
    let reconciliations = 0;
    const workflowLiveParentBridge = {
      registerParent: () => ({
        ready: Promise.resolve(),
        snapshot: () => ({
          signalVersion: 0,
          hasPendingCompletions: false,
          hasOutstandingRuns: false,
        }),
        waitForSignalSince: async () => undefined,
        listPendingIdentities: () => [],
        listPendingSettledAsync: async () => [],
        acknowledge: async () => undefined,
        isPending: () => false,
        clearMaterializationFailure: () => undefined,
        recordMaterializationFailure: () => 0,
        cancelAll: async () => undefined,
        close: async () => {
          liveParentClosed.resolve(undefined);
        },
      }),
    } as unknown as NonNullable<
      Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
    >;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        terminalMarks += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => {
        reconciliations += 1;
        return Result.ok(undefined);
      },
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-terminal-publication-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      blobStore,
      transcriptStore,
      workflowLiveParentBridge,
      issueControlCapability: () => ({
        capability: "terminal-publication",
        principal: null,
      }),
      createAgent: (options) => {
        let modelCalls = 0;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-terminal-publication-failure",
            doStream: async () => {
              modelCalls += 1;
              return modelCalls === 1
                ? level1ToolCallStep([{ toolCallId: "failed-output-read", toolName: "read" }])
                : level1TextStep("surface must accept this");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          normalizeSettledToolResultOutputs: undefined,
          tools: {
            read: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => ({ filename: "failed-output.png" }),
              toModelOutput: () => ({
                type: "content",
                value: [
                  { type: "text", text: "Attached failed-output.png" },
                  {
                    type: "file",
                    data: { type: "data", data: "iVBORwE=" },
                    mediaType: "image/png",
                    filename: "failed-output.png",
                  },
                ],
              }),
            }),
          },
        });
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "retain recovery ownership",
      });
      await uploadStarted.promise;
      await terminalSurfaceFailed.promise;
      await liveParentClosed.promise;
      await Promise.resolve();
      expect(runner.getActiveLevel1Work()).toHaveLength(1);
      releaseUpload.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();

      expect(terminalSurfaceAttempts).toBe(2);
      expect(terminalMarks).toBe(0);
      expect(reconciliations).toBe(0);
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("accepted");
    } finally {
      releaseUpload.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      transcriptStore.close();
      await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 });
      store.close();
      await bus.close();
      await rm(directory, { recursive: true });
    }
  });

  it("marks the terminal journal head before a blocked live-parent cleanup", async () => {
    const order: string[] = [];
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const terminalMarked = deferred<void>();
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType === lilacEventTypes.EvtAgentOutputResponseText) order.push("surface-write");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-cleanup-order:request";
    const sessionId = "journal-cleanup-order";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "mark before cleanup" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("terminal");
        terminalMarked.resolve(undefined);
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const workflowLiveParentBridge = {
      registerParent: () => ({
        ready: Promise.resolve(),
        snapshot: () => ({
          signalVersion: 0,
          hasPendingCompletions: false,
          hasOutstandingRuns: false,
        }),
        waitForSignalSince: async () => undefined,
        listPendingIdentities: () => [],
        listPendingSettledAsync: async () => [],
        acknowledge: async () => undefined,
        isPending: () => false,
        clearMaterializationFailure: () => undefined,
        recordMaterializationFailure: () => 0,
        cancelAll: async () => undefined,
        close: async () => {
          order.push("cleanup");
          cleanupStarted.resolve(undefined);
          await releaseCleanup.promise;
        },
      }),
    } as unknown as NonNullable<
      Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
    >;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-cleanup-order",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      workflowLiveParentBridge,
      issueControlCapability: () => ({
        capability: "journal-cleanup-order",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-cleanup-order",
            doStream: async () => level1TextStep("marked"),
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "mark before cleanup",
      });
      await terminalMarked.promise;
      await cleanupStarted.promise;
      expect(order).toEqual(["surface-write", "terminal", "cleanup"]);
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("accepted");
      releaseCleanup.resolve(undefined);
      await runner.getActiveDrainOperation();
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("terminal");
    } finally {
      releaseCleanup.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("keeps the previous checkpoint after one conflict and admits a later request", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    let failCheckpoint = true;
    let resets = 0;
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        if (failCheckpoint) {
          failCheckpoint = false;
          return Result.err(
            new AgentRunJournalConflict({
              runId: handle.runId,
              message: "injected checkpoint failure",
            }),
          );
        }
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "journal-failure",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-failure",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued");
            },
          }),
        }),
    });
    const firstId = "github:journal-failure:first";
    const secondId = "github:journal-failure:second";
    const firstDeliveryId = crypto.randomUUID();
    const secondDeliveryId = crypto.randomUUID();
    for (const [requestDeliveryId, requestId, sessionId, content] of [
      [firstDeliveryId, firstId, "journal-failure-first", "first"],
      [secondDeliveryId, secondId, "journal-failure-second", "second"],
    ] as const) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId,
          requestId,
          envelope: {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content }],
            },
          },
          inputHandles: [],
          createdAt: 1,
        }),
      );
    }
    const firstLifecycle = await observeRequestLifecycle(bus, firstId);
    const secondLifecycle = await observeRequestLifecycle(bus, secondId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: firstDeliveryId,
        requestId: firstId,
        sessionId: "journal-failure-first",
        text: "first",
      });
      await expect(firstLifecycle.terminal).resolves.toBe("resolved");
      await publishRunnerRequest({
        bus,
        requestDeliveryId: secondDeliveryId,
        requestId: secondId,
        sessionId: "journal-failure-second",
        text: "second",
      });
      await expect(secondLifecycle.terminal).resolves.toBe("resolved");
      expect(resets).toBe(0);
      expect(modelCalls).toBe(2);
    } finally {
      await firstLifecycle.stop();
      await secondLifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("stops checkpoint writes for each run after a conflict and still marks it terminal", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const journalCalls = {
      open: 0,
      checkpoint: 0,
      reset: 0,
      terminal: 0,
      remove: 0,
    };
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalCalls.open += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.checkpoint += 1;
        return Result.err(
          new AgentRunJournalConflict({
            runId: handle.runId,
            message: "injected checkpoint failure",
          }),
        );
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.terminal += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: (runId: string) => {
        journalCalls.reset += 1;
        return Result.err(
          new AgentRunJournalSqliteFailure({
            operation: `reset ${runId}`,
            code: "SQLITE_IOERR",
            message: "injected reset failure",
          }),
        );
      },
      removeReconciled: () => {
        journalCalls.remove += 1;
        return Result.ok(undefined);
      },
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-reset-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "journal-reset-failure",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-reset-failure",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued without journal");
            },
          }),
        }),
    });
    const requests = [
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "github:journal-reset-failure:first",
        sessionId: "journal-reset-failure-first",
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "github:journal-reset-failure:second",
        sessionId: "journal-reset-failure-second",
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          envelope: {
            headers: {
              request_id: request.requestId,
              session_id: request.sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId: request.requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: `request ${index + 1}` }],
            },
          },
          inputHandles: [],
          createdAt: index + 1,
        }),
      );
    }
    const lifecycles = await Promise.all(
      requests.map((request) => observeRequestLifecycle(bus, request.requestId)),
    );
    try {
      for (const [index, request] of requests.entries()) {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: `request ${index + 1}`,
        });
        await expect(lifecycles[index]!.terminal).resolves.toBe("resolved");
      }
      expect(modelCalls).toBe(2);
      expect(journalCalls.open).toBe(4);
      expect(journalCalls.checkpoint).toBe(2);
      expect(journalCalls.reset).toBe(0);
      expect(journalCalls.terminal).toBe(2);
      expect(journalCalls.remove).toBe(2);
    } finally {
      await Promise.all(lifecycles.map((lifecycle) => lifecycle.stop()));
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("resets a conflicted run only when its current handle cannot be reopened", async () => {
    const failureStage = "reopen" as const;
    const bus = createLilacBus(createInMemoryRawBus());
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const journalCalls = { open: 0, checkpoint: 0, reset: 0, terminal: 0 };
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalCalls.open += 1;
        if (journalCalls.open === 2) {
          return Result.err(
            new AgentRunJournalConflict({
              runId: owner.requestDeliveryId,
              message: "injected journal reopen failure",
            }),
          );
        }
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.checkpoint += 1;
        return Result.err(
          new AgentRunJournalConflict({
            runId: handle.runId,
            message: "injected journal checkpoint failure",
          }),
        );
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.terminal += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => {
        journalCalls.reset += 1;
        return Result.ok(undefined);
      },
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: `journal-bounded-${failureStage}`,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: `journal-bounded-${failureStage}`,
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: `journal-bounded-${failureStage}`,
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued without journal");
            },
          }),
        }),
    });
    const requests = [
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: `github:journal-bounded-${failureStage}:first`,
        sessionId: `journal-bounded-${failureStage}-first`,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: `github:journal-bounded-${failureStage}:second`,
        sessionId: `journal-bounded-${failureStage}-second`,
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          envelope: {
            headers: {
              request_id: request.requestId,
              session_id: request.sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId: request.requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: `request ${index + 1}` }],
            },
          },
          inputHandles: [],
          createdAt: index + 1,
        }),
      );
    }
    const lifecycles = await Promise.all(
      requests.map((request) => observeRequestLifecycle(bus, request.requestId)),
    );
    try {
      for (const [index, request] of requests.entries()) {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: `request ${index + 1}`,
        });
        await expect(lifecycles[index]!.terminal).resolves.toBe("resolved");
      }
      expect(modelCalls).toBe(2);
      expect(journalCalls.open).toBe(5);
      expect(journalCalls.checkpoint).toBe(2);
      expect(journalCalls.reset).toBe(1);
      expect(journalCalls.terminal).toBe(2);
    } finally {
      await Promise.all(lifecycles.map((lifecycle) => lifecycle.stop()));
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("reconstructs original and checkpointed work across sessions and skips terminal heads", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const pluginManager = corePrimaryTestPluginManager();
    const observedModelPrompts: string[] = [];
    const bothCalled = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-reconstruction",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({
        capability: "journal-reconstruction",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-reconstruction",
            doStream: async (call) => {
              observedModelPrompts.push(JSON.stringify(call.prompt));
              if (observedModelPrompts.length === 2) bothCalled.resolve(undefined);
              return level1TextStep("recovered");
            },
          }),
        });
        return agent;
      },
    });
    const original = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:original",
      sessionId: "journal-reconstruction-original",
      queue: "prompt",
      messages: [{ role: "user", content: "original floor" }],
    });
    const checkpointed = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:checkpoint",
      sessionId: "journal-reconstruction-checkpoint",
      queue: "prompt",
      messages: [{ role: "user", content: "stale accepted input" }],
    });
    const terminal = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:terminal",
      sessionId: "journal-reconstruction-terminal",
      queue: "prompt",
      messages: [{ role: "user", content: "must not rerun" }],
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: {
        runId: checkpointed.requestDeliveryId,
        requestId: checkpointed.requestId,
        sessionId: checkpointed.work.sessionId,
        sequence: 2,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable checkpoint" }],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const terminalHead: AgentRunRecoveryHead = {
      handle: {
        runId: terminal.requestDeliveryId,
        requestId: terminal.requestId,
        sessionId: terminal.work.sessionId,
        sequence: 3,
      },
      state: "terminal",
      terminalOutcome: { kind: "completed" },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(original));
      transcriptResultValue(await runner.resumeAcceptedDelivery(checkpointed, activeHead));
      transcriptResultValue(await runner.resumeAcceptedDelivery(terminal, terminalHead));
      runner.activate();
      await bothCalled.promise;
      expect(observedModelPrompts).toHaveLength(2);
      expect(observedModelPrompts.some((messages) => messages.includes("original floor"))).toBe(
        true,
      );
      expect(observedModelPrompts.some((messages) => messages.includes("durable checkpoint"))).toBe(
        true,
      );
      expect(
        observedModelPrompts.some((messages) => messages.includes("stale accepted input")),
      ).toBe(false);
      expect(observedModelPrompts.some((messages) => messages.includes("must not rerun"))).toBe(
        false,
      );
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores loaded tools from a WAL checkpoint and persists them for the next descendant", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-recovery-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async () => Result.ok(level1TestToolset());
    const offered: string[][] = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "tool-authority-wal-recovery",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      transcriptStore: store,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({ capability: "tool-authority-recovery", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "tool-authority-wal-recovery",
            doStream: async (modelOptions) => {
              offered.push(level1OfferedToolNames(modelOptions));
              return level1TextStep("recovered");
            },
          }),
        }),
    });

    const sessionId = "tool-authority-recovery";
    const inputMessageId = "recovered-input";
    const recoveredRequestId = `discord:${sessionId}:${inputMessageId}`;
    const recoveredMessages = [
      { role: "user", content: "resume after crash" },
    ] satisfies ModelMessage[];
    const recoveredLineage = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, inputMessageId, recoveredMessages),
    ]);
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: recoveredRequestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: transcriptResultValue(projectStoredMessagesV1(recoveredMessages)),
      corePrimaryLineage: recoveredLineage,
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "recovery-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: inputMessageId,
          },
        },
      },
    });
    const recoveryHead: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId: accepted.work.sessionId,
        sequence: 2,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: transcriptResultValue(projectStoredMessagesV1(recoveredMessages)),
        corePrimaryLineage: recoveredLineage,
        loadedCatalogIds: ["catalog-id"],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const recoveredLifecycle = await observeRequestLifecycle(bus, recoveredRequestId);

    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, recoveryHead));
      runner.activate();
      await expect(recoveredLifecycle.terminal).resolves.toBe("resolved");
      await recoveredLifecycle.stop();

      expect(
        getRequestTranscript(store, { requestId: recoveredRequestId })?.loadedCatalogIds,
      ).toEqual(["catalog-id"]);

      const descendantRequestId = "discord:tool-authority-recovery:descendant";
      const descendantMessages = [
        { role: "user", content: "continue after recovery" },
      ] satisfies ModelMessage[];
      const descendantLineage = extendPrimaryManifest({
        store,
        sessionId,
        previous: recoveredLineage,
        completedRequestId: recoveredRequestId,
        outputMessageId: "recovered-output",
        currentMessageId: "descendant-input",
        currentMessages: descendantMessages,
      });
      const descendantLifecycle = await observeRequestLifecycle(bus, descendantRequestId);
      await publishRunnerRequest({
        bus,
        requestId: descendantRequestId,
        sessionId,
        requestClient: "discord",
        text: "continue after recovery",
        messages: descendantLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: descendantLineage,
      });
      await expect(descendantLifecycle.terminal).resolves.toBe("resolved");
      await descendantLifecycle.stop();

      expect(offered).toEqual([
        ["builtin", "find_tools", "deferred_tool"],
        ["builtin", "find_tools", "deferred_tool"],
      ]);
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reseeds recovery from the previous checkpoint when the latest blob is unavailable", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    });
    const modelCalled = deferred<void>();
    let observedPrompt = "";
    let observedTools: string[] = [];
    let resets = 0;
    let promotions = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      promotePreviousCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        promotions += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      loadRecoveryHeads: () => Result.ok({ heads: [], resets: [] }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      resetAll: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-previous-checkpoint",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      agentRunJournal: journal,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({
        capability: "journal-previous-checkpoint",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-previous-checkpoint",
            doStream: async (call) => {
              observedPrompt = JSON.stringify(call.prompt);
              observedTools = level1OfferedToolNames(call);
              modelCalled.resolve(undefined);
              return level1TextStep("recovered previous checkpoint");
            },
          }),
        }),
    });
    const sessionId = "journal-previous-checkpoint";
    const originalMessageId = "accepted-message";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: `discord:${sessionId}:${originalMessageId}`,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "accepted floor" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "accepted-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: originalMessageId,
          },
        },
      },
    });
    const head: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId: accepted.work.sessionId,
        sequence: 3,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "blob",
                blob: {
                  version: 1,
                  objectId: `b1_${"11".repeat(16)}`,
                  sha256: "22".repeat(32),
                  byteLength: 1,
                },
                mediaType: "image/png",
                filename: "missing.png",
              },
            ],
          },
        ],
        loadedCatalogIds: [],
        retainedRequestDeliveries: [],
      },
      previousCheckpoint: {
        version: 1,
        messages: [{ role: "user", content: "previous safe checkpoint" }],
        loadedCatalogIds: ["catalog-id"],
        currentTurnUserId: "checkpoint-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, head));
      runner.activate();
      await modelCalled.promise;
      expect(promotions).toBe(1);
      expect(resets).toBe(0);
      expect(observedPrompt).toContain("previous safe checkpoint");
      expect(observedPrompt).not.toContain("accepted floor");
      expect(observedPrompt).not.toContain("missing.png");
      expect(observedTools).toEqual(["builtin", "find_tools", "deferred_tool"]);
      expect(level1RequestContext).toMatchObject({
        currentTurnUserId: "checkpoint-user",
      });
      expect(level1RequestContext?.currentTurnMessageRef).toBeUndefined();
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores the accepted message relation when no recovery checkpoint can be loaded", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    });
    const modelCalled = deferred<void>();
    let observedPrompt = "";
    let resets = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      loadRecoveryHeads: () => Result.ok({ heads: [], resets: [] }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      resetAll: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-accepted-fallback",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      agentRunJournal: journal,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({
        capability: "journal-accepted-fallback",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-accepted-fallback",
            doStream: async (call) => {
              observedPrompt = JSON.stringify(call.prompt);
              modelCalled.resolve(undefined);
              return level1TextStep("recovered accepted work");
            },
          }),
        }),
    });
    const sessionId = "journal-accepted-fallback";
    const originalMessageId = "accepted-message";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: `discord:${sessionId}:${originalMessageId}`,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "accepted floor" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "accepted-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: originalMessageId,
          },
        },
      },
    });
    const missingMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "blob" as const,
          blob: {
            version: 1 as const,
            objectId: `b1_${"11".repeat(16)}`,
            sha256: "22".repeat(32),
            byteLength: 1,
          },
          mediaType: "image/png",
          filename: "missing.png",
        },
      ],
    };
    const head: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId,
        sequence: 3,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [missingMessage],
        currentTurnUserId: "latest-checkpoint-user",
        retainedRequestDeliveries: [],
      },
      previousCheckpoint: {
        version: 1,
        messages: [missingMessage],
        currentTurnUserId: "previous-checkpoint-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, head));
      runner.activate();
      await modelCalled.promise;
      expect(resets).toBe(1);
      expect(observedPrompt).toContain("accepted floor");
      expect(observedPrompt).not.toContain("missing.png");
      expect(level1RequestContext).toMatchObject({
        currentTurnUserId: "accepted-user",
        currentTurnMessageRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: originalMessageId,
        },
      });
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores trusted Discord authority and its live cache owner from durable accepted work", async () => {
    const sessionId = "recovered-authority-session";
    const messageId = "recovered-authority-message";
    const requestId = `discord:${sessionId}:${messageId}`;
    const requestDeliveryId = crypto.randomUUID();
    const requestMessageCache = createRequestMessageCache();
    const bus = createLilacBus(createInMemoryRawBus());
    let issuedSafetyMode: string | undefined;
    let issuedOrigin: AuthenticatedSurfaceOrigin | undefined;
    let cachedOriginAtIssue: ReturnType<typeof requestMessageCache.getOrigin>;
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "recovered-authority",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: (input) => {
        issuedSafetyMode = input.safetyMode;
        issuedOrigin = input.authenticatedOrigin;
        cachedOriginAtIssue = requestMessageCache.getOrigin(requestId);
        return {
          capability: "recovered-authority",
          principal: input.authenticatedOrigin
            ? {
                platform: input.authenticatedOrigin.platform,
                userId: input.authenticatedOrigin.userId,
              }
            : null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "recovered-authority",
            doStream: async () => level1TextStep("trusted recovery"),
          }),
        }),
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "recover trusted authority" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "recovered-authority-user",
          messageRef: { platform: "discord", channelId: sessionId, messageId },
        },
      },
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable trusted checkpoint" }],
        currentTurnUserId: "recovered-authority-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(issuedSafetyMode).toBe("trusted");
      expect(issuedOrigin).toEqual({
        platform: "discord",
        userId: "recovered-authority-user",
        sessionRef: { platform: "discord", channelId: sessionId },
        messageRef: { platform: "discord", channelId: sessionId, messageId },
      });
      expect(cachedOriginAtIssue).toEqual(expect.objectContaining({ requestId, sessionId }));
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("keeps recovered Discord work restricted when its durable message proof is invalid", async () => {
    const sessionId = "invalid-recovered-authority-session";
    const requestId = `discord:${sessionId}:expected-message`;
    const requestDeliveryId = crypto.randomUUID();
    const requestMessageCache = createRequestMessageCache();
    const bus = createLilacBus(createInMemoryRawBus());
    let issuedSafetyMode: string | undefined;
    let issuedOrigin: AuthenticatedSurfaceOrigin | undefined;
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "invalid-recovered-authority",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: (input) => {
        issuedSafetyMode = input.safetyMode;
        issuedOrigin = input.authenticatedOrigin;
        return {
          capability: "invalid-recovered-authority",
          principal: null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "invalid-recovered-authority",
            doStream: async () => level1TextStep("restricted recovery"),
          }),
        }),
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "reject invalid durable authority" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "invalid-recovered-authority-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: "different-message",
          },
        },
      },
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable restricted checkpoint" }],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(issuedSafetyMode).toBe("restricted");
      expect(issuedOrigin).toBeUndefined();
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("recovers a Core-primary Claude WAL checkpoint without resuming the crash-left native attempt", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-wal-recovery-"));
    const dbPath = path.join(dataDir, "transcripts.db");
    const sessionId = "primary-wal-recovery";
    const requestId = "discord:primary-wal-recovery:input";
    const requestDeliveryId = crypto.randomUUID();
    const crashedCandidateSessionId = crypto.randomUUID();
    const portableMessages = [
      { role: "user", content: "portable WAL checkpoint" },
    ] satisfies ModelMessage[];
    const firstStore = new SqliteTranscriptStore(dbPath);
    const lineage = buildCoreLineageManifestV2([
      admitPrimarySurface(firstStore, sessionId, "portable-input", portableMessages),
    ]);
    attemptMutationValue(
      firstStore.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "crash-left-scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId: crashedCandidateSessionId,
        sourceSessionId: null,
        expectedBindingRevision: null,
      }),
    );
    firstStore.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");

    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const pluginManager = corePrimaryTestPluginManager();
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][] = [];
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "claude-code/sonnet", fallback: [] };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "primary-wal-recovery",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "primary-wal-recovery",
        principal: null,
      }),
      materializeClaudeCodeRun: async (options) => {
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral") {
          throw new Error("expected persistent Claude start");
        }
        starts.push(start);
        const observation: ClaudeNativeAttemptObservation = {
          requestedSessionId: start.sessionId,
          sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        };
        const model = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async (call) => {
            modelPrompts.push([...call.prompt]);
            return level1TextStep("recovered from portable checkpoint");
          },
        });
        return {
          agentModel: model,
          continuationModel: model,
          createUtilityModelResult: () => Result.ok(model),
          createUtilityModel: () => model,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation,
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1,
              },
              sourcePreflight: null,
              sourceFinal: null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {},
          disposeResult: async () => Result.ok(),
        };
      },
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "stale accepted input" }],
      corePrimaryLineage: lineage,
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: transcriptResultValue(projectStoredMessagesV1(portableMessages)),
        corePrimaryLineage: lineage,
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ mode: "fresh" });
      if (!starts[0] || starts[0].mode === "ephemeral") {
        throw new Error("recovered Claude start is missing");
      }
      expect(starts[0].sessionId).not.toBe(crashedCandidateSessionId);
      expect(JSON.stringify(modelPrompts)).toContain("portable WAL checkpoint");
      expect(JSON.stringify(modelPrompts)).not.toContain("stale accepted input");
      expect(
        store.getCorePrimaryClaudeSessionAttempt({
          providerId: "claude-code",
          requestClient: "discord",
          lilacSessionId: sessionId,
          requestId,
          attemptIndex: 0,
        })?.state,
      ).toBe("uncertain");
      expect(
        store.getCorePrimaryClaudeSessionAttempt({
          providerId: "claude-code",
          requestClient: "discord",
          lilacSessionId: sessionId,
          requestId,
          attemptIndex: 2,
        }),
      ).toMatchObject({
        attemptIndex: 2,
        candidateSessionId: starts[0].sessionId,
      });
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("bus agent runner terminal cleanup", () => {
  const synchronousLabels = [
    "workflow-claim-timer-clear",
    "control-capability-expire",
    "workflow-request-expire",
    "run-idle-watchdog-stop",
    "agent-unsubscribe",
    "compaction-unsubscribe",
    "output-publisher-drain",
  ] as const satisfies readonly BusAgentRunnerTerminalCleanup["label"][];

  for (const failingLabel of synchronousLabels) {
    it.each([
      ["an ordinary Error", () => new Error(`${failingLabel} failed`)],
      ["a Panic", () => new Panic({ message: `${failingLabel} invariant failed` })],
    ] as const)(
      `captures ${failingLabel} throwing %s without preventing cleanup`,
      async (_, cause) => {
        const failure = cause();
        const originalPanic = new Panic({
          message: "custom command invariant failed",
        });
        const started: BusAgentRunnerTerminalCleanup["label"][] = [];
        let nextQueueStarts = 0;
        let operations: ReturnType<typeof startBusAgentRunnerTerminalCleanup>["operations"] = [];
        const terminalOperation = (async () => {
          try {
            throw originalPanic;
          } finally {
            operations = startBusAgentRunnerTerminalCleanup(
              synchronousLabels.map((label) => ({
                label,
                run: () => {
                  started.push(label);
                  if (label === failingLabel) throw failure;
                },
              })),
            ).operations;
          }
        })();
        const drainOperation = terminalOperation.then(() => {
          nextQueueStarts += 1;
        });
        const drainRejection = drainOperation.then(
          () => null,
          (error: unknown) => error,
        );
        const observed = operations.map(({ operation }) =>
          operation.then(
            () => null,
            (error: unknown) => error,
          ),
        );

        expect(started).toEqual([...synchronousLabels]);
        expect(await drainRejection).toBe(originalPanic);
        expect(await Promise.all(observed)).toEqual(
          synchronousLabels.map((label) => (label === failingLabel ? failure : null)),
        );
        expect(nextQueueStarts).toBe(0);
      },
    );
  }

  it.each([
    ["ordinary errors", () => new Error("cleanup failed")],
    ["Panics", () => new Panic({ message: "cleanup invariant failed" })],
  ] as const)("supervises retire, dispose, and live-close %s independently", async (_, cause) => {
    const labels = [
      "core-named-retire",
      "core-primary-retire",
      "claude-dispose",
      "live-close",
    ] as const;
    const started: BusAgentRunnerTerminalCleanup["label"][] = [];
    const failures = labels.map(cause);
    const cleanupGates = labels.map(() => deferred<void>());
    const cleanupBatch = startBusAgentRunnerTerminalCleanup(
      labels.map((label, index) => ({
        label,
        run: () => {
          started.push(label);
          return cleanupGates[index]?.promise;
        },
      })),
    );
    const operations = cleanupBatch.operations;
    const observed = operations.map(({ operation }) =>
      operation.then(
        () => null,
        (error: unknown) => error,
      ),
    );

    expect(operations.map(({ label }) => label)).toEqual([...labels]);
    expect(started).toEqual([...labels]);
    for (const [index, gate] of cleanupGates.entries()) gate.reject(failures[index]);
    expect(await Promise.all(observed)).toEqual(failures);
    await expect(cleanupBatch.completion).resolves.toBeUndefined();
  });
});

describe("startBusAgentRunner production path", () => {
  it("carries one projected origin through capability issuance and Level 1 context", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/identity-propagation" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    });
    let issuedOrigin: Parameters<
      NonNullable<Parameters<typeof startBusAgentRunner>[0]["issueControlCapability"]>
    >[0]["authenticatedOrigin"];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "identity-propagation",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({
        parentChannelId: null,
        guildId: null,
      }),
      issueControlCapability: (input) => {
        issuedOrigin = input.authenticatedOrigin;
        return {
          capability: "identity-capability",
          principal: input.authenticatedOrigin
            ? {
                platform: input.authenticatedOrigin.platform,
                userId: input.authenticatedOrigin.userId,
              }
            : null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "identity-propagation",
            doStream: async () => level1TextStep("identity propagated"),
          }),
        }),
    });
    const requestId = "discord:identity-session:identity-message";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "identity-session",
        requestClient: "discord",
        text: "propagate identity",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "identity-user",
            messageRef: {
              platform: "discord",
              channelId: "identity-session",
              messageId: "identity-message",
            },
          },
        },
      });
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      expect(issuedOrigin).toEqual({
        platform: "discord",
        userId: "identity-user",
        sessionRef: { platform: "discord", channelId: "identity-session" },
        messageRef: {
          platform: "discord",
          channelId: "identity-session",
          messageId: "identity-message",
        },
      });
      expect(level1RequestContext).toMatchObject({
        requestId,
        sessionId: "identity-session",
        requestClient: "discord",
        requestInitiator: { platform: "discord", userId: "identity-user" },
        requestInitiatorSessionId: "identity-session",
        currentTurnUserId: "identity-user",
      });
      await runner.getActiveDrainOperation();
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("keeps the initiator and updates tool context for a different-user follow-up", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/current-turn-user" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const firstCallStarted = deferred<void>();
    const releaseFirstCall = deferred<void>();
    const followUpApplied = deferred<void>();
    const toolContexts: unknown[] = [];
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const toolset = level1TestToolset();
    toolset.tools.builtin = tool({
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: (_input, options) => {
        toolContexts.push(options.context);
        const metadata = (
          options.context as {
            readonly metadata?: {
              readonly onActivity?: (source: "tool" | "subagent") => void;
            };
          }
        ).metadata;
        metadata?.onActivity?.("tool");
        return "ok";
      },
    });
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    }, toolset);
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "current-turn-user",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({
        parentChannelId: null,
        guildId: null,
      }),
      issueControlCapability: (input) => ({
        capability: "current-turn-capability",
        principal: input.authenticatedOrigin
          ? {
              platform: input.authenticatedOrigin.platform,
              userId: input.authenticatedOrigin.userId,
            }
          : null,
        authenticatedOrigin: input.authenticatedOrigin ?? null,
        safetyMode: input.safetyMode,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "current-turn-user",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstCallStarted.resolve(undefined);
                await releaseFirstCall.promise;
                return level1TextStep("first response");
              }
              return modelCalls === 2
                ? level1ToolCallStep([{ toolCallId: "current-turn", toolName: "builtin" }])
                : level1TextStep("done");
            },
          }),
        });
        const followUp = agent.followUp.bind(agent);
        agent.followUp = (message) => {
          const id = followUp(message);
          followUpApplied.resolve(undefined);
          return id;
        };
        return agent;
      },
    });
    const requestId = "discord:turn-session:first-message";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "turn-session",
        requestClient: "discord",
        text: "first",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-a",
            messageRef: {
              platform: "discord",
              channelId: "turn-session",
              messageId: "first-message",
            },
          },
        },
      });
      await firstCallStarted.promise;
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "turn-session",
        requestClient: "discord",
        queue: "followUp",
        text: "second",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-b",
            messageRef: {
              platform: "discord",
              channelId: "turn-session",
              messageId: "second-message",
            },
          },
        },
      });
      expect(requestMessageCache.getOrigin(requestId)?.authenticatedOrigin?.userId).toBe("user-a");
      await followUpApplied.promise;
      releaseFirstCall.resolve(undefined);

      await expect(lifecycle.terminal).resolves.toBe("resolved");
      expect(level1RequestContext).toMatchObject({
        requestInitiator: { platform: "discord", userId: "user-a" },
        requestInitiatorSessionId: "turn-session",
        currentTurnUserId: "user-b",
        currentTurnMessageRef: {
          platform: "discord",
          channelId: "turn-session",
          messageId: "second-message",
        },
      });
      expect(toolContexts).toEqual([
        expect.objectContaining({
          requestInitiator: { platform: "discord", userId: "user-a" },
          requestInitiatorSessionId: "turn-session",
          currentTurnUserId: "user-b",
          currentTurnMessageRef: {
            platform: "discord",
            channelId: "turn-session",
            messageId: "second-message",
          },
          metadata: expect.objectContaining({
            onActivity: expect.any(Function),
          }),
        }),
      ]);
    } finally {
      releaseFirstCall.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("admits the work subscription while paused and releases retained delivery synchronously", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/paused-admission" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "paused-admission",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      startPaused: true,
      issueControlCapability: () => ({
        capability: "paused-admission",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "paused-admission",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("released");
            },
          }),
        }),
    });
    const requestId = "github:paused-admission:request";
    try {
      const publication = publishRunnerRequest({
        bus,
        requestId,
        sessionId: "paused-admission",
        text: "retained",
      });
      await Promise.resolve();
      expect(modelCalls).toBe(0);
      expect(requestMessageCache.get(requestId)).toBeUndefined();

      expect(runner.activate()).toBeUndefined();
      await publication;
      await runner.getActiveDrainOperation();
      expect(modelCalls).toBe(1);
    } finally {
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("releases paused delivery before stopping a host that waits for active callbacks", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/paused-stop" };
    const deliveryStarted = deferred<void>();
    const rawBus = createInMemoryRawBus({
      waitForActiveHandlersOnStop: true,
      onWorkDeliveryStarted: () => deliveryStarted.resolve(undefined),
    });
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "paused-stop",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      startPaused: true,
      issueControlCapability: () => ({
        capability: "paused-stop",
        principal: null,
      }),
      createAgent: (agentOptions) =>
        new AiSdkPiAgent({
          ...agentOptions,
          model: new MockLanguageModelV4({
            modelId: "paused-stop",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("must not run");
            },
          }),
        }),
    });
    const requestId = "github:paused-stop:request";
    try {
      const publication = publishRunnerRequest({
        bus,
        requestId,
        sessionId: "paused-stop",
        text: "retained until shutdown",
      });
      await deliveryStarted.promise;

      await runner.stop();
      await publication;

      expect(modelCalls).toBe(0);
      expect(requestMessageCache.get(requestId)).toBeUndefined();
    } finally {
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("retains identity and cache state across park-pending intake redelivery", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/park-redelivery" };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    let intakeAttempts = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "park-redelivery",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: () => ({
        capability: "park-capability",
        principal: null,
      }),
      beforeRequestIntake: () => {
        intakeAttempts += 1;
        if (intakeAttempts === 1) throw new Error("transient intake failure");
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "park-redelivery",
            doStream: async () => level1TextStep("recovered"),
          }),
        }),
    });
    const requestId = "discord:park-session:park-message";
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "park-session",
        requestClient: "discord",
        text: "first attempt",
      });
      expect(requestMessageCache.snapshot(requestId)?.parkedEventIds).toHaveLength(1);
      expect(requestMessageCache.get(requestId)).toHaveLength(1);

      const lifecycle = await observeRequestLifecycle(bus, requestId);
      try {
        await rawBus.redeliverRequest(requestId);
        await expect(lifecycle.terminal).resolves.toBe("resolved");
        expect(intakeAttempts).toBe(2);
        expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
      } finally {
        await lifecycle.stop();
      }
    } finally {
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it("rolls back an ordinary queued owner when lifecycle publication fails", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/queue-rollback" };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "ordinary-queue-rollback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: (sessionId) => ({
        parentChannelId: sessionId,
        guildId: null,
      }),
      issueControlCapability: () => ({
        capability: "rollback-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "queue-rollback",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              } else {
                secondStarted.resolve(undefined);
              }
              return level1TextStep("rollback complete");
            },
          }),
        }),
    });
    const firstRequestId = "discord:rollback-session:first";
    const queuedRequestId = "discord:rollback-session:queued";
    try {
      await publishRunnerRequest({
        bus,
        requestId: firstRequestId,
        sessionId: "rollback-session",
        requestClient: "discord",
        text: "first",
      });
      await firstStarted.promise;
      rawBus.failNextQueuedLifecycle();
      await publishRunnerRequest({
        bus,
        requestId: queuedRequestId,
        sessionId: "rollback-session",
        requestClient: "discord",
        text: "queued",
      });
      expect(requestMessageCache.snapshot(queuedRequestId)).toMatchObject({
        ownerCount: 0,
        parkedEventIds: [expect.any(String)],
      });

      await rawBus.redeliverRequest(queuedRequestId);
      expect(requestMessageCache.snapshot(queuedRequestId)?.ownerCount).toBe(1);
      releaseFirst.resolve(undefined);
      await secondStarted.promise;
      await runner.getActiveDrainOperation();
      expect(modelCalls).toBe(2);
    } finally {
      releaseFirst.resolve(undefined);
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it("releases every coalesced buffered-prompt owner", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/coalesced-owner" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "coalesced-owner-cleanup",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: (sessionId) => ({
        parentChannelId: sessionId,
        guildId: null,
      }),
      issueControlCapability: () => ({
        capability: "coalesced-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "coalesced-owner",
            doStream: async () => {
              firstStarted.resolve(undefined);
              await releaseFirst.promise;
              return level1TextStep("coalesced complete");
            },
          }),
        }),
    });
    const activeRequestId = "discord:coalesce-session:active";
    const bufferedRequestIds = [
      "discord:coalesce-session:buffered-1",
      "discord:coalesce-session:buffered-2",
    ];
    try {
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId: "coalesce-session",
        requestClient: "discord",
        text: "active",
      });
      await firstStarted.promise;
      for (const requestId of bufferedRequestIds) {
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId: "coalesce-session",
          requestClient: "discord",
          text: requestId,
          raw: { bufferedForActiveRequestId: activeRequestId },
        });
        expect(requestMessageCache.snapshot(requestId)?.ownerCount).toBe(1);
      }
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId: "coalesce-session",
        requestClient: "discord",
        queue: "steer",
        text: "absorb buffered",
      });
      for (const requestId of bufferedRequestIds) {
        expect(requestMessageCache.get(requestId)).toBeUndefined();
      }
    } finally {
      releaseFirst.resolve(undefined);
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("keeps the tool call paired with its result when steering during tool execution", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/steer-during-tool" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const toolEntered = deferred<void>();
    const releaseTool = deferred<void>();
    const pluginManager = corePrimaryTestPluginManager(
      undefined,
      level1TestToolset({
        builtinExecute: async () => {
          toolEntered.resolve(undefined);
          await releaseTool.promise;
          return "tool complete";
        },
      }),
    );
    const modelPrompts: ModelMessage[][] = [];
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "steer-during-tool",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: () => ({
        capability: "steer-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "steer-during-tool",
            doStream: async (call) => {
              modelPrompts.push([...call.prompt]);
              modelCalls += 1;
              return modelCalls === 1
                ? level1ToolCallStep([{ toolCallId: "active-tool", toolName: "builtin" }])
                : level1TextStep("steered response");
            },
          }),
        }),
    });
    const sessionId = "steer-during-tool";
    const requestId = `discord:${sessionId}:input`;
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        requestClient: "discord",
        text: "run the tool",
      });
      await toolEntered.promise;

      await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        requestClient: "discord",
        queue: "steer",
        text: "use the result carefully",
      });
      releaseTool.resolve(undefined);

      await expect(lifecycle.terminal).resolves.toBe("resolved");
      expect(modelPrompts).toHaveLength(2);
      const secondPrompt = modelPrompts[1] ?? [];
      const toolCallIndex = secondPrompt.findIndex(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) => part.type === "tool-call" && part.toolCallId === "active-tool",
          ),
      );
      const toolResultIndex = secondPrompt.findIndex(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === "active-tool",
          ),
      );
      const steeringIndex = secondPrompt.findIndex(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("use the result carefully"),
      );
      expect(toolCallIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
      expect(steeringIndex).toBeGreaterThan(toolResultIndex);
    } finally {
      releaseTool.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("releases queue-drain coalescing owners after terminal completion", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/drain-coalescing" };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const contexts: Array<
      Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
    > = [];
    const pluginManager = corePrimaryTestPluginManager((context) => contexts.push(context));
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const coalescedStarted = deferred<void>();
    const releaseCoalesced = deferred<void>();
    const prompts: string[] = [];
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "queue-drain-coalescing-owner-cleanup",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: (input) => ({
        capability: "coalescing-capability",
        principal: input.authenticatedOrigin
          ? {
              platform: input.authenticatedOrigin.platform,
              userId: input.authenticatedOrigin.userId,
            }
          : null,
        authenticatedOrigin: input.authenticatedOrigin ?? null,
        safetyMode: input.safetyMode,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "drain-coalescing",
            doStream: async (modelInput) => {
              modelCalls += 1;
              prompts.push(JSON.stringify(modelInput.prompt));
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              } else {
                coalescedStarted.resolve(undefined);
                await releaseCoalesced.promise;
              }
              return level1TextStep("complete");
            },
          }),
        }),
    });
    const activeRequestId = "github:drain-coalescing:active";
    const coalescedRequestId = "discord:drain-coalescing:first-message";
    const lifecycle = await observeRequestLifecycle(bus, coalescedRequestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId: "drain-coalescing",
        text: "active",
      });
      await firstStarted.promise;
      await publishRunnerRequest({
        bus,
        requestId: coalescedRequestId,
        sessionId: "drain-coalescing",
        requestClient: "discord",
        text: "coalesced first",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-a",
            messageRef: {
              platform: "discord",
              channelId: "drain-coalescing",
              messageId: "first-message",
            },
          },
        },
      });
      await publishRunnerRequest({
        bus,
        requestId: coalescedRequestId,
        sessionId: "drain-coalescing",
        requestClient: "discord",
        text: "coalesced second",
        raw: {
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-b",
            messageRef: {
              platform: "discord",
              channelId: "drain-coalescing",
              messageId: "second-message",
            },
          },
        },
      });
      expect(requestMessageCache.snapshot(coalescedRequestId)?.ownerCount).toBe(2);

      releaseFirst.resolve(undefined);
      await coalescedStarted.promise;
      expect(requestMessageCache.snapshot(coalescedRequestId)?.ownerCount).toBe(1);
      expect(prompts[1]).toContain("coalesced first");
      expect(prompts[1]).toContain("coalesced second");
      expect(contexts[1]).toMatchObject({
        requestInitiator: { platform: "discord", userId: "user-a" },
        currentTurnUserId: "user-b",
        currentTurnMessageRef: {
          platform: "discord",
          channelId: "drain-coalescing",
          messageId: "second-message",
        },
      });
      releaseCoalesced.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(requestMessageCache.get(coalescedRequestId)).toBeUndefined();
    } finally {
      releaseFirst.resolve(undefined);
      releaseCoalesced.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it.each([
    ["before the first publication", 0],
    ["after a partial publication", 1],
  ] as const)(
    "resumes queued cancellation %s without duplicate lifecycle effects",
    async (_, failAfter) => {
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/queued-cancellation-retry" };
      const rawBus = createInMemoryRawBus();
      testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
      const bus = createLilacBus(rawBus);
      const requestMessageCache = createRequestMessageCache();
      const pluginManager = corePrimaryTestPluginManager();
      const activeStarted = deferred<void>();
      const releaseActive = deferred<void>();
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `queued-cancellation-retry-${failAfter}`,
        reportFatalPanic: () => undefined,
        config,
        pluginManager,
        requestMessageCache,
        issueControlCapability: () => ({
          capability: "cancel-capability",
          principal: null,
        }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "queued-cancellation-retry",
              doStream: async () => {
                activeStarted.resolve(undefined);
                await releaseActive.promise;
                return level1TextStep("active complete");
              },
            }),
          }),
      });
      const sessionId = `queued-cancellation-${failAfter}`;
      const targetRequestIds = [`github:${sessionId}:target-a`, `github:${sessionId}:target-b`];
      const cancellationRequestId = `github:${sessionId}:cancel`;
      const lifecycles = await Promise.all(
        targetRequestIds.map((requestId) => observeRequestLifecycle(bus, requestId)),
      );
      try {
        await publishRunnerRequest({
          bus,
          requestId: `github:${sessionId}:active`,
          sessionId,
          text: "active",
        });
        await activeStarted.promise;
        for (const requestId of targetRequestIds) {
          await publishRunnerRequest({
            bus,
            requestId,
            sessionId,
            text: requestId,
            raw: { chainMessageIds: ["cancel-target"] },
          });
        }
        rawBus.failCancelledLifecycleAfter(failAfter);
        await publishRunnerRequest({
          bus,
          requestId: cancellationRequestId,
          sessionId,
          queue: "interrupt",
          text: "cancel queued",
          raw: { cancel: true, cancelQueued: true, messageId: "cancel-target" },
        });

        expect(requestMessageCache.snapshot(cancellationRequestId)?.parkedEventIds).toHaveLength(1);
        expect(
          targetRequestIds.map(
            (requestId) => requestMessageCache.snapshot(requestId)?.ownerCount ?? 0,
          ),
        ).toEqual(failAfter === 0 ? [1, 1] : [0, 1]);
        await rawBus.redeliverRequest(cancellationRequestId);
        for (const requestId of targetRequestIds) {
          expect(requestMessageCache.get(requestId)).toBeUndefined();
        }
        expect(requestMessageCache.get(cancellationRequestId)).toBeUndefined();
        expect(
          lifecycles.map((lifecycle) => lifecycle.states.filter((state) => state === "cancelled")),
        ).toEqual([["cancelled"], ["cancelled"]]);
      } finally {
        releaseActive.resolve(undefined);
        for (const lifecycle of lifecycles) await lifecycle.stop();
        await runner.stop();
        await requestMessageCache.stop();
        await pluginManager.destroy();
        await bus.close();
        testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
      }
    },
  );

  it.each([
    ["before the first cancellation publication", 0],
    ["after a partial cancellation publication", 1],
  ] as const)("resumes buffered absorption %s without reapplying control", async (_, failAfter) => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/buffered-absorption-retry" };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    let steerCalls = 0;
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: `buffered-absorption-retry-${failAfter}`,
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: () => ({
        capability: "absorb-capability",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "buffered-absorption-retry",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                activeStarted.resolve(undefined);
                await releaseActive.promise;
              }
              return level1TextStep("active complete");
            },
          }),
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          steerCalls += 1;
          return steer(message);
        };
        return agent;
      },
    });
    const sessionId = `buffered-absorption-${failAfter}`;
    const activeRequestId = `github:${sessionId}:active`;
    const bufferedRequestIds = [`github:${sessionId}:buffer-a`, `github:${sessionId}:buffer-b`];
    const activeLifecycle = await observeRequestLifecycle(bus, activeRequestId);
    const bufferedLifecycles = await Promise.all(
      bufferedRequestIds.map((requestId) => observeRequestLifecycle(bus, requestId)),
    );
    try {
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId,
        text: "active",
      });
      await activeStarted.promise;
      for (const requestId of bufferedRequestIds) {
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId,
          text: requestId,
          raw: { bufferedForActiveRequestId: activeRequestId },
        });
      }
      rawBus.failCancelledLifecycleAfter(failAfter);
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId,
        queue: "steer",
        text: "absorb",
      });

      expect(steerCalls).toBe(1);
      expect(requestMessageCache.snapshot(activeRequestId)?.parkedEventIds).toHaveLength(1);
      expect(
        bufferedRequestIds.map(
          (requestId) => requestMessageCache.snapshot(requestId)?.ownerCount ?? 0,
        ),
      ).toEqual(failAfter === 0 ? [1, 1] : [0, 1]);

      await rawBus.redeliverRequest(activeRequestId);
      expect(steerCalls).toBe(1);
      for (const requestId of bufferedRequestIds) {
        expect(requestMessageCache.get(requestId)).toBeUndefined();
      }
      expect(
        bufferedLifecycles.map((lifecycle) =>
          lifecycle.states.filter((state) => state === "cancelled"),
        ),
      ).toEqual([["cancelled"], ["cancelled"]]);

      releaseActive.resolve(undefined);
      await expect(activeLifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(requestMessageCache.get(activeRequestId)).toBeUndefined();
    } finally {
      releaseActive.resolve(undefined);
      await activeLifecycle.stop();
      for (const lifecycle of bufferedLifecycles) await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it("rolls back buffered reservations when control application fails before mutation", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/buffered-control-rollback" };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    let steerAttempts = 0;
    let appliedSteers = 0;
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "buffered-control-rollback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: () => ({
        capability: "rollback-capability",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "buffered-control-rollback",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                activeStarted.resolve(undefined);
                await releaseActive.promise;
              }
              return level1TextStep("complete");
            },
          }),
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          steerAttempts += 1;
          if (steerAttempts === 1) throw new Error("control rejected before mutation");
          const steeringId = steer(message);
          appliedSteers += 1;
          return steeringId;
        };
        return agent;
      },
    });
    const sessionId = "buffered-control-rollback";
    const activeRequestId = `github:${sessionId}:active`;
    const bufferedRequestId = `github:${sessionId}:buffered`;
    const activeLifecycle = await observeRequestLifecycle(bus, activeRequestId);
    const bufferedLifecycle = await observeRequestLifecycle(bus, bufferedRequestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId,
        text: "active",
      });
      await activeStarted.promise;
      await publishRunnerRequest({
        bus,
        requestId: bufferedRequestId,
        sessionId,
        text: "buffered",
        raw: { bufferedForActiveRequestId: activeRequestId },
      });
      await publishRunnerRequest({
        bus,
        requestId: activeRequestId,
        sessionId,
        queue: "steer",
        text: "absorb",
      });

      expect({ steerAttempts, appliedSteers }).toEqual({
        steerAttempts: 1,
        appliedSteers: 0,
      });
      expect(requestMessageCache.snapshot(bufferedRequestId)?.ownerCount).toBe(1);
      await rawBus.redeliverRequest(activeRequestId);
      expect({ steerAttempts, appliedSteers }).toEqual({
        steerAttempts: 2,
        appliedSteers: 1,
      });
      expect(requestMessageCache.get(bufferedRequestId)).toBeUndefined();
      expect(bufferedLifecycle.states.filter((state) => state === "cancelled")).toEqual([
        "cancelled",
      ]);

      releaseActive.resolve(undefined);
      await expect(activeLifecycle.terminal).resolves.toBe("resolved");
    } finally {
      releaseActive.resolve(undefined);
      await activeLifecycle.stop();
      await bufferedLifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it.each([
    ["first then second", [0, 1]],
    ["second then first", [1, 0]],
  ] as const)("retains two same-request PEL entries when recovering %s", async (_, order) => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/two-pel-recovery" };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const seenEventIds = new Set<string>();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: `two-pel-recovery-${order.join("-")}`,
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      beforeRequestIntake: (message) => {
        if (seenEventIds.has(message.id)) return;
        seenEventIds.add(message.id);
        throw new Error("park each initial delivery");
      },
      issueControlCapability: () => ({
        capability: "two-pel-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "two-pel-recovery",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                activeStarted.resolve(undefined);
                await releaseActive.promise;
              }
              return level1TextStep("recovered");
            },
          }),
        }),
    });
    const sessionId = `two-pel-${order.join("-")}`;
    const requestId = `github:${sessionId}:request`;
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        text: "first",
      });
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        text: "second",
      });
      const eventIds = rawBus.requestEventIds(requestId);
      expect(eventIds).toHaveLength(2);
      expect(requestMessageCache.snapshot(requestId)).toMatchObject({
        ownerCount: 0,
        eventIdCount: 2,
      });

      await rawBus.redeliverRequestEvent(eventIds[order[0]]!);
      await activeStarted.promise;
      expect(requestMessageCache.snapshot(requestId)).toMatchObject({
        ownerCount: 1,
        eventIdCount: 1,
        parkedEventIds: [eventIds[order[1]]],
      });
      await rawBus.redeliverRequestEvent(eventIds[order[1]]!);
      expect(requestMessageCache.snapshot(requestId)).toMatchObject({
        ownerCount: 1,
        eventIdCount: 0,
        parkedEventIds: [],
      });

      releaseActive.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.getActiveDrainOperation();
      expect(requestMessageCache.get(requestId)).toBeUndefined();
    } finally {
      releaseActive.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it.each([
    ["an ordinary Error", () => new Error("capability expiration failed")],
    ["a Panic", () => new Panic({ message: "capability expiration invariant failed" })],
  ] as const)(
    "propagates custom command Panic when terminal cleanup throws %s",
    async (_, cause) => {
      const config = parseCoreConfigV2ToUniversal({});
      const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-custom-panic-"));
      const commandDir = path.join(dataDir, "cmds", "panic");
      const commandStarted = deferred<void>();
      const releaseCommand = deferred<void>();
      await mkdir(commandDir, { recursive: true });
      await writeFile(
        path.join(commandDir, "def.json"),
        JSON.stringify({ name: "panic", description: "Raise a test Panic" }),
        "utf8",
      );
      await writeFile(
        path.join(commandDir, "index.ts"),
        "export async function execute() { return { type: 'json', value: null }; }\n",
        "utf8",
      );
      const customCommands = new CustomCommandManager(dataDir);
      const customCommandsInit = await customCommands.init();
      if (customCommandsInit.status === "error") throw customCommandsInit.error;
      customCommands.execute = async (input) => {
        commandStarted.resolve(undefined);
        await releaseCommand.promise;
        throw input.args[0];
      };
      const pluginManager = corePrimaryTestPluginManager();
      const bus = createLilacBus(createInMemoryRawBus());
      let nextWorkStarts = 0;
      const cleanupFailure = cause();
      const fatalPanicReported = deferred<Panic>();
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: "production-custom-command-panic",
        reportFatalPanic: fatalPanicReported.resolve,
        config,
        pluginManager,
        customCommands,
        issueControlCapability: () => ({
          capability: "test-capability",
          principal: null,
        }),
        expireControlCapability: () => {
          throw cleanupFailure;
        },
        createAgent: () => {
          nextWorkStarts += 1;
          throw new Error("custom command Panic must stop before agent creation");
        },
      });
      const requestId = "github:custom-panic:request";
      const queuedRequestId = "github:custom-panic:queued";
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const queuedLifecycle = await observeRequestLifecycle(bus, queuedRequestId);
      const panic = new Panic({ message: "custom command invariant failed" });

      try {
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId: "custom-panic",
          text: "/lilac:panic",
          raw: {
            customCommand: {
              name: "panic",
              args: [panic],
              text: "/lilac:panic",
              source: "text",
            },
          },
        });
        const startedDrainOperation = runner.getActiveDrainOperation();
        if (!startedDrainOperation) throw new Error("Expected the request to start a queue drain");
        expect(
          await Promise.race([
            commandStarted.promise.then(() => "command-started" as const),
            lifecycle.terminal,
          ]),
        ).toBe("command-started");
        await publishRunnerRequest({
          bus,
          requestId: queuedRequestId,
          sessionId: "custom-panic",
          text: "must not start",
        });
        expect(queuedLifecycle.states).toEqual(["queued"]);

        const activeDrainOperation = runner.getActiveDrainOperation();
        if (!activeDrainOperation) throw new Error("Expected an active detached drain operation");
        const rejectionObserved = activeDrainOperation.then(
          () => null,
          (error: unknown) => error,
        );
        releaseCommand.resolve(undefined);
        expect(await rejectionObserved).toBe(panic);
        expect(await fatalPanicReported.promise).toBe(panic);
        const cleanupOperations = runner.getTerminalCleanupOperations();
        const cleanupResults = await Promise.all(
          cleanupOperations.map(({ operation }) =>
            operation.then(
              () => null,
              (error: unknown) => error,
            ),
          ),
        );
        expect(cleanupOperations.map(({ label }) => label)).toEqual([
          "control-capability-expire",
          "run-idle-watchdog-stop",
          "agent-unsubscribe",
          "compaction-unsubscribe",
          "output-publisher-drain",
        ]);
        expect(cleanupResults).toEqual([cleanupFailure, null, null, null, null]);
        expect(lifecycle.states).toEqual(["running"]);
        expect(queuedLifecycle.states).toEqual(["queued"]);
        expect(nextWorkStarts).toBe(0);
        await expect(
          publishRunnerRequest({
            bus,
            requestId: "github:custom-panic:after-defect",
            sessionId: "custom-panic",
            text: "must be rejected",
          }),
        ).rejects.toBe(panic);
      } finally {
        releaseCommand.resolve(undefined);
        await lifecycle.stop();
        await queuedLifecycle.stop();
        await runner.stop().catch((cause: unknown) => {
          expect(cause).toBe(panic);
        });
        await pluginManager.destroy();
        await bus.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("latches the active model, applies an unqualified follow-up, and queues an explicit change", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/initial" };
    config.models.def = {
      active: { model: "openai/active", agentCanSelect: true },
      other: { model: "openai/other", agentCanSelect: true },
    };
    const bus = createLilacBus(createInMemoryRawBus());
    const requestMessageCache = createRequestMessageCache();
    const requestContexts: Array<
      Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
    > = [];
    const pluginManager = corePrimaryTestPluginManager((context) => requestContexts.push(context));
    const firstCallStarted = deferred<void>();
    const releaseFirstCall = deferred<void>();
    const createdSpecs: string[] = [];
    const capabilityInputs: Array<
      Parameters<
        NonNullable<Parameters<typeof startBusAgentRunner>[0]["issueControlCapability"]>
      >[0]
    > = [];
    let activeCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-model-latch",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: (sessionId) => ({
        parentChannelId: sessionId,
        guildId: null,
      }),
      issueControlCapability: (input) => {
        capabilityInputs.push(input);
        return {
          capability: "test-capability",
          principal: input.authenticatedOrigin
            ? {
                platform: input.authenticatedOrigin.platform,
                userId: input.authenticatedOrigin.userId,
              }
            : null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options: AiSdkPiAgentOptions<ToolSet>) => {
        const spec = options.modelSpecifier ?? "unknown";
        createdSpecs.push(spec);
        const model = new MockLanguageModelV4({
          modelId: spec,
          doStream: async () => {
            if (spec === "openai/active") {
              activeCalls += 1;
              if (activeCalls === 1) {
                firstCallStarted.resolve(undefined);
                await releaseFirstCall.promise;
              }
            }
            return level1TextStep(`${spec} response`);
          },
        });
        return new AiSdkPiAgent({ ...options, model });
      },
    });
    const requestId = "github:session:model-latch";
    const changedRequestId = "github:session:changed-message";
    const activeLifecycle = await observeRequestLifecycle(bus, requestId);
    const changedLifecycle = await observeRequestLifecycle(bus, changedRequestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      text: "first",
      modelOverride: "active",
      raw: {
        authenticatedOrigin: {
          platform: "github",
          userId: "user-1",
          messageRef: {
            platform: "github",
            channelId: "session",
            messageId: "changed-message",
          },
        },
      },
    });
    expect(
      await Promise.race([
        firstCallStarted.promise.then(() => "model-started" as const),
        activeLifecycle.terminal,
      ]),
    ).toBe("model-started");
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      queue: "followUp",
      text: "same model",
    });
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "session",
      queue: "followUp",
      text: "change model",
      modelOverride: "other",
      raw: {
        authenticatedOrigin: {
          platform: "github",
          userId: "user-1",
          messageRef: {
            platform: "github",
            channelId: "session",
            messageId: "changed-message",
          },
        },
      },
    });
    expect(changedLifecycle.states).toContain("queued");

    releaseFirstCall.resolve(undefined);
    await expect(activeLifecycle.terminal).resolves.toBe("resolved");
    await expect(changedLifecycle.terminal).resolves.toBe("resolved");
    expect(activeCalls).toBe(2);
    expect(createdSpecs).toEqual(["openai/active", "openai/other"]);
    expect(requestContexts).toHaveLength(2);
    expect(requestContexts[1]).toMatchObject({
      requestId: changedRequestId,
      safetyMode: "trusted",
      requestInitiator: { platform: "github", userId: "user-1" },
      requestInitiatorSessionId: "session",
    });
    expect(capabilityInputs).toHaveLength(2);
    expect(capabilityInputs[0]?.authenticatedOrigin?.messageRef).toMatchObject({
      messageId: "changed-message",
    });
    expect(capabilityInputs[1]).toMatchObject({
      requestId: changedRequestId,
      authenticatedOrigin: {
        platform: "github",
        userId: "user-1",
        sessionRef: { platform: "github", channelId: "session" },
      },
      verifiedIngress: false,
    });
    expect(capabilityInputs[1]?.authenticatedOrigin?.messageRef).toBeUndefined();

    await activeLifecycle.stop();
    await changedLifecycle.stop();
    await runner.stop();
    await requestMessageCache.stop();
    await pluginManager.destroy();
    await bus.close();
  });

  it("rolls back a distinct model alias when queued lifecycle publication fails", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/initial" };
    config.models.def = {
      active: { model: "openai/active", agentCanSelect: true },
      other: { model: "openai/other", agentCanSelect: true },
    };
    const rawBus = createInMemoryRawBus();
    testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
    const bus = createLilacBus(rawBus);
    const requestMessageCache = createRequestMessageCache();
    const pluginManager = corePrimaryTestPluginManager();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "model-alias-rollback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      requestMessageCache,
      issueControlCapability: () => ({
        capability: "alias-rollback",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: options.modelSpecifier ?? "unknown",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              } else {
                secondStarted.resolve(undefined);
              }
              return level1TextStep("alias rollback complete");
            },
          }),
        }),
    });
    const requestId = "github:rollback-session:source";
    const aliasRequestId = "github:rollback-session:changed-message";
    const raw = {
      authenticatedOrigin: {
        platform: "github" as const,
        userId: "user-1",
        messageRef: {
          platform: "github" as const,
          channelId: "rollback-session",
          messageId: "changed-message",
        },
      },
    };
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "rollback-session",
        text: "first",
        modelOverride: "active",
        raw,
      });
      await firstStarted.promise;
      rawBus.failNextQueuedLifecycle();
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId: "rollback-session",
        queue: "followUp",
        text: "change",
        modelOverride: "other",
        raw,
      });
      expect(requestMessageCache.get(aliasRequestId)).toBeUndefined();
      expect(requestMessageCache.snapshot(requestId)).toMatchObject({
        ownerCount: 1,
        parkedEventIds: [expect.any(String)],
      });

      await rawBus.redeliverRequest(requestId);
      expect(requestMessageCache.snapshot(aliasRequestId)?.ownerCount).toBe(1);
      releaseFirst.resolve(undefined);
      await secondStarted.promise;
      await runner.getActiveDrainOperation();
      expect(modelCalls).toBe(2);
    } finally {
      releaseFirst.resolve(undefined);
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
      testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
    }
  });

  it.each([
    {
      platform: "discord" as const,
      requestId: "discord:self-alias-channel:self-alias-message",
      sessionId: "self-alias-channel",
    },
    {
      platform: "github" as const,
      requestId: "github:owner/repo#1:42",
      sessionId: "owner/repo#1",
    },
  ])(
    "retains canonical $platform self-alias ownership through the queued run",
    async (testCase) => {
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/initial" };
      config.models.def = {
        active: { model: "openai/active", agentCanSelect: true },
        other: { model: "openai/other", agentCanSelect: true },
      };
      const bus = createLilacBus(createInMemoryRawBus());
      const requestMessageCache = createRequestMessageCache();
      const contexts: Array<
        Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      > = [];
      const pluginManager = corePrimaryTestPluginManager((context) => contexts.push(context));
      const firstStarted = deferred<void>();
      const releaseFirst = deferred<void>();
      const secondStarted = deferred<void>();
      const raw =
        testCase.platform === "discord"
          ? {
              authenticatedOrigin: {
                platform: "discord" as const,
                userId: "self-alias-user",
                messageRef: {
                  platform: "discord" as const,
                  channelId: testCase.sessionId,
                  messageId: "self-alias-message",
                },
              },
            }
          : {
              authenticatedActor: {
                platform: "github" as const,
                userId: "self-alias-user",
              },
              authenticatedOrigin: {
                platform: "github" as const,
                userId: "self-alias-user",
                messageRef: {
                  platform: "github" as const,
                  channelId: testCase.sessionId,
                  messageId: "42",
                },
              },
              github: {
                repoFullName: "owner/repo",
                issueNumber: 1,
                trigger: { kind: "comment" as const, commentId: 42 },
              },
            };
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `self-alias-${testCase.platform}`,
        reportFatalPanic: () => undefined,
        config,
        pluginManager,
        requestMessageCache,
        resolveDiscordSessionContext: (sessionId) => ({
          parentChannelId: sessionId,
          guildId: null,
        }),
        issueControlCapability: (input) => ({
          capability: `self-alias-${testCase.platform}`,
          principal: input.authenticatedOrigin
            ? {
                platform: input.authenticatedOrigin.platform,
                userId: input.authenticatedOrigin.userId,
              }
            : null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: options.modelSpecifier ?? "unknown",
              doStream: async () => {
                if (options.modelSpecifier === "openai/active") {
                  firstStarted.resolve(undefined);
                  await releaseFirst.promise;
                } else {
                  secondStarted.resolve(undefined);
                }
                return level1TextStep("self alias complete");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId: testCase.requestId,
          sessionId: testCase.sessionId,
          requestClient: testCase.platform,
          text: "first",
          modelOverride: "active",
          raw,
        });
        await firstStarted.promise;
        await publishRunnerRequest({
          bus,
          requestId: testCase.requestId,
          sessionId: testCase.sessionId,
          requestClient: testCase.platform,
          queue: "followUp",
          text: "change model",
          modelOverride: "other",
          raw,
        });
        expect(requestMessageCache.snapshot(testCase.requestId)?.ownerCount).toBe(2);
        releaseFirst.resolve(undefined);
        await secondStarted.promise;
        expect(requestMessageCache.getOrigin(testCase.requestId)).toBeDefined();
        expect(requestMessageCache.get(testCase.requestId)).toBeDefined();
        await runner.getActiveDrainOperation();
        expect(contexts).toHaveLength(2);
        expect(contexts[1]).toMatchObject({
          requestId: testCase.requestId,
          safetyMode: "trusted",
          requestInitiator: {
            platform: testCase.platform,
            userId: "self-alias-user",
          },
          requestInitiatorSessionId: testCase.sessionId,
        });
      } finally {
        releaseFirst.resolve(undefined);
        await runner.stop();
        await requestMessageCache.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );

  it("cancels an active model call after the running lifecycle transition", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/cancellable" };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-cancel-"));
    const pluginManager = createCoreToolPluginManager({
      runtime: { config },
      dataDir,
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const modelCallStarted = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-cancel",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "cancellable",
            doStream: async ({ abortSignal }) => {
              modelCallStarted.resolve(undefined);
              await new Promise<void>((resolve) => {
                abortSignal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
              throw Object.assign(new Error("cancelled"), {
                name: "AbortError",
              });
            },
          }),
        }),
    });
    const requestId = "github:cancel-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "cancel-session",
      text: "start",
    });
    expect(
      await Promise.race([
        modelCallStarted.promise.then(() => "model-started" as const),
        lifecycle.terminal,
      ]),
    ).toBe("model-started");
    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "cancel-session",
      queue: "interrupt",
      text: "cancel",
      raw: { cancel: true },
    });

    await expect(lifecycle.terminal).resolves.toBe("cancelled");
    expect(lifecycle.states[0]).toBe("running");
    expect(lifecycle.states.at(-1)).toBe("cancelled");

    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("advances the live agent to the configured fallback transport", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = {
      model: "openai/primary",
      fallback: ["openai/fallback"],
    };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-fallback-"));
    const pluginManager = createCoreToolPluginManager({
      runtime: { config },
      dataDir,
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const switchedSpecs: Array<string | undefined> = [];
    const successModel = new MockLanguageModelV4({
      modelId: "fallback",
      doStream: async () => level1TextStep("fallback response"),
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-fallback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "primary",
            doStream: async () => {
              throw Object.assign(new Error("connection reset"), {
                code: "ECONNRESET",
              });
            },
          }),
        });
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (_model, providerOptions, modelSpecifier, reasoning) => {
          switchedSpecs.push(modelSpecifier);
          setModel(successModel, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });
    const requestId = "github:fallback-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "fallback-session",
      text: "start",
    });

    expect({
      terminal: await lifecycle.terminal,
      details: lifecycle.details,
    }).toEqual({
      terminal: "resolved",
      details: [undefined, undefined],
    });
    expect(switchedSpecs).toEqual(["openai/fallback"]);

    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("publishes OpenAI phases and honors a final-answer NO_REPLY", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/phased" };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-phased-output-"));
    const pluginManager = createCoreToolPluginManager({
      runtime: { config },
      dataDir,
    });
    const bus = createLilacBus(createInMemoryRawBus());
    let createdAgents = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-phased-output",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      createAgent: (options) => {
        createdAgents += 1;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "phased",
            doStream: level1PhasedTextStep(createdAgents === 1 ? "Final answer." : "NO_REPLY"),
          }),
        });
      },
    });
    const requestId = "github:phased-output:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const responsePublished = deferred<void>();
    const textDeltas: Array<{
      delta: string;
      phase?: "commentary" | "final_answer";
      phaseBoundaryPrefixChars?: number;
    }> = [];
    const outputSubscriptionResult = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          textDeltas.push(message.data);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          responsePublished.resolve(undefined);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputSubscriptionResult.status === "error") throw outputSubscriptionResult.error;
    const outputSubscription = outputSubscriptionResult.value;

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "phased-output",
      text: "show both phases",
    });

    await expect(lifecycle.terminal).resolves.toBe("resolved");
    await responsePublished.promise;
    expect(textDeltas).toEqual([
      { delta: "Commentary.", phase: "commentary" },
      {
        delta: "\n\nFinal answer.",
        phase: "final_answer",
        phaseBoundaryPrefixChars: 2,
      },
    ]);

    const skippedRequestId = "github:phased-output:skip";
    const skippedLifecycle = await observeRequestLifecycle(bus, skippedRequestId);
    const skippedDeltas: typeof textDeltas = [];
    const skippedResets: string[] = [];
    const skippedResponse = deferred<{
      finalText: string;
      delivery?: "reply" | "skip";
    }>();
    const skippedOutputSubscriptionResult = await bus.subscribeTopic(
      outReqTopic(skippedRequestId),
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          skippedDeltas.push(message.data);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputTextReset) {
          skippedResets.push(message.data.text);
        }
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          skippedResponse.resolve(message.data);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (skippedOutputSubscriptionResult.status === "error") {
      throw skippedOutputSubscriptionResult.error;
    }
    const skippedOutputSubscription = skippedOutputSubscriptionResult.value;
    await publishRunnerRequest({
      bus,
      requestId: skippedRequestId,
      sessionId: "phased-output-skip",
      text: "skip the final response",
    });

    await expect(skippedLifecycle.terminal).resolves.toBe("resolved");
    await expect(skippedResponse.promise).resolves.toMatchObject({
      finalText: "",
      delivery: "skip",
    });
    expect(skippedDeltas).toEqual([{ delta: "Commentary.", phase: "commentary" }]);
    expect(skippedResets).toEqual([""]);

    const skippedOutputStopped = await skippedOutputSubscription.stop();
    if (skippedOutputStopped.status === "error") throw skippedOutputStopped.error;
    await skippedLifecycle.stop();
    const outputStopped = await outputSubscription.stop();
    if (outputStopped.status === "error") throw outputStopped.error;
    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("silences an intermediate NO_REPLY turn while preserving its tool exchange", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/silent-turn" };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-silent-turn-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const modelPrompts: ModelMessage[][] = [];
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-silent-turn",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "silent-turn",
            doStream: async (call) => {
              modelPrompts.push([...call.prompt]);
              modelCalls += 1;
              return modelCalls === 1
                ? level1TextAndToolCallStep("NO_REPLY", {
                    toolCallId: "call-silent",
                    toolName: "builtin",
                  })
                : level1TextStep("final answer");
            },
          }),
        }),
    });
    const requestId = "github:silent-turn-session:request";
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const responsePublished = deferred<void>();
    const outputEvents: Array<Message<unknown>> = [];
    const outputSubscriptionResult = await bus.subscribeTopic(
      outReqTopic(requestId),
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        outputEvents.push(message);
        if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
          responsePublished.resolve(undefined);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputSubscriptionResult.status === "error") throw outputSubscriptionResult.error;
    const outputSubscription = outputSubscriptionResult.value;

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId: "silent-turn-session",
      text: "wait for the work",
    });

    await expect(lifecycle.terminal).resolves.toBe("resolved");
    await responsePublished.promise;
    expect(modelCalls).toBe(2);
    expect(JSON.stringify(outputEvents)).not.toContain("NO_REPLY");
    expect(
      outputEvents.find((message) => message.type === lilacEventTypes.EvtAgentOutputResponseText)
        ?.data,
    ).toMatchObject({ finalText: "final answer", delivery: "reply" });
    const secondTurnAssistantMessages = modelPrompts[1]?.filter(
      (message) => message.role === "assistant",
    );
    expect(JSON.stringify(secondTurnAssistantMessages)).not.toContain("NO_REPLY");
    expect(JSON.stringify(secondTurnAssistantMessages)).toContain("call-silent");
    const transcript = getRequestTranscript(store, { requestId });
    expect(transcript?.finalText).toBe("final answer");
    expect(JSON.stringify(transcript?.messages)).not.toContain("NO_REPLY");
    expect(JSON.stringify(transcript?.messages)).toContain("call-silent");

    const outputStopped = await outputSubscription.stop();
    if (outputStopped.status === "error") throw outputStopped.error;
    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

function corePrimaryTestPluginManager(
  onBuild?: (
    requestContext: Parameters<
      CoreToolPluginManager["buildLevel1ToolsetResult"]
    >[0]["requestContext"],
  ) => void,
  toolset = level1TestToolset(),
): CoreToolPluginManager {
  return {
    init: async () => Result.ok(),
    destroy: async () => Result.ok(),
    reload: async () => Result.ok(),
    ensureFresh: async () => Result.ok(),
    getStatuses: () => [],
    getLevel2Tools: () => [],
    getLevel2ContributionInfo: () => new Map(),
    buildLevel1ToolsetResult: async (input) => {
      onBuild?.(input.requestContext);
      return Result.ok(toolset);
    },
  };
}

function admitPrimarySurface(
  store: SqliteTranscriptStore,
  sessionId: string,
  messageId: string,
  canonicalMessages: readonly ModelMessage[],
) {
  const storedMessages = transcriptResultValue(projectStoredMessagesV1(canonicalMessages));
  store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${sessionId}`,
    sessionId,
    messageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages: storedMessages,
    sourceFacts: {
      segmentMessageIds: [messageId],
      segmentDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(storedMessages)).hash,
    },
    ownedBlobs: [],
  });
  return {
    atoms: [
      {
        kind: "surface" as const,
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId,
      },
    ],
    canonicalMessages: storedMessages,
  };
}

function extendPrimaryManifest(input: {
  store: SqliteTranscriptStore;
  sessionId: string;
  previous: CoreLineageManifestV2;
  completedRequestId: string;
  outputMessageId: string;
  currentMessageId: string;
  currentMessages: readonly ModelMessage[];
}): CoreLineageManifestV2 {
  const transcript = getRequestTranscript(input.store, {
    requestId: input.completedRequestId,
  });
  const metadata = getCoreRequestAtomMetadata(input.store, {
    requestId: input.completedRequestId,
  });
  if (!transcript || !metadata) throw new Error("completed primary request metadata is missing");
  input.store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${input.sessionId}`,
    sessionId: input.sessionId,
    messageId: input.outputMessageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages: transcript.messages,
    sourceFacts: {},
    ownedBlobs: [],
  });
  input.store.linkSurfaceMessagesToRequest({
    requestId: input.completedRequestId,
    created: [
      {
        platform: "discord",
        channelId: input.sessionId,
        messageId: input.outputMessageId,
      },
    ],
    last: {
      platform: "discord",
      channelId: input.sessionId,
      messageId: input.outputMessageId,
    },
  });
  const currentSegment = admitPrimarySurface(
    input.store,
    input.sessionId,
    input.currentMessageId,
    input.currentMessages,
  );
  return buildCoreLineageManifestV2(
    [
      ...input.previous.segments.map((segment) => ({
        atoms: segment.atoms,
        canonicalMessages: segment.canonicalMessages,
        ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
      })),
      {
        atoms: [{ kind: "request" as const, ...metadata }],
        canonicalMessages: transcript.messages,
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: `discord:${input.sessionId}`,
              sessionId: input.sessionId,
              messageId: input.outputMessageId,
            },
          ],
        },
      },
      currentSegment,
    ],
    { currentSegmentIndex: input.previous.segments.length + 1 },
  );
}

describe("startBusAgentRunner prefix-lineage tool authority", () => {
  it("keeps loaded tools on descendants and excludes them from earlier forks and new threads", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-lineage-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async (input) =>
      Result.ok(
        level1TestToolset({
          searchExecute: () => {
            input.onSelectCatalogIds?.(["catalog-id"]);
            return "selected";
          },
        }),
      );
    const offered: string[][] = [];
    let modelCall = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "prefix-lineage-tool-authority",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "prefix-lineage-tool-authority",
            doStream: async (modelOptions) => {
              offered.push(level1OfferedToolNames(modelOptions));
              modelCall += 1;
              return modelCall === 1
                ? level1ToolCallStep([{ toolCallId: "search", toolName: "find_tools" }])
                : level1TextStep(`done-${modelCall}`);
            },
          }),
        }),
    });

    const sessionId = "tool-lineage-channel";
    const firstRequestId = "discord:tool-lineage:first";
    const firstMessages = [{ role: "user", content: "load a tool" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-first", firstMessages),
    ]);
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    await publishRunnerRequest({
      bus,
      requestId: firstRequestId,
      sessionId,
      requestClient: "discord",
      text: "load a tool",
      corePrimaryLineage: firstManifest,
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    await firstLifecycle.stop();

    const secondRequestId = "discord:tool-lineage:second";
    const secondMessages = [{ role: "user", content: "continue" }] satisfies ModelMessage[];
    const secondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-first",
      currentMessageId: "input-second",
      currentMessages: secondMessages,
    });
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: secondRequestId,
      sessionId,
      requestClient: "discord",
      text: "continue",
      messages: secondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: secondManifest,
    });
    await expect(secondLifecycle.terminal).resolves.toBe("resolved");
    await secondLifecycle.stop();

    const forkAfterRequestId = "discord:tool-lineage:fork-after";
    const forkAfterMessages = [
      { role: "user", content: "fork after load" },
    ] satisfies ModelMessage[];
    const forkAfterManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-first-fork",
      currentMessageId: "input-fork-after",
      currentMessages: forkAfterMessages,
    });
    const forkAfterLifecycle = await observeRequestLifecycle(bus, forkAfterRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkAfterRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork after load",
      messages: forkAfterManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: forkAfterManifest,
    });
    await expect(forkAfterLifecycle.terminal).resolves.toBe("resolved");
    await forkAfterLifecycle.stop();

    const thirdRequestId = "discord:tool-lineage:third";
    const thirdMessages = [{ role: "user", content: "continue again" }] satisfies ModelMessage[];
    const thirdManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-second",
      currentMessageId: "input-third",
      currentMessages: thirdMessages,
    });
    const thirdLifecycle = await observeRequestLifecycle(bus, thirdRequestId);
    await publishRunnerRequest({
      bus,
      requestId: thirdRequestId,
      sessionId,
      requestClient: "discord",
      text: "continue again",
      messages: thirdManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: thirdManifest,
    });
    await expect(thirdLifecycle.terminal).resolves.toBe("resolved");
    await thirdLifecycle.stop();

    const forkFromSecondRequestId = "discord:tool-lineage:fork-from-second";
    const forkFromSecondMessages = [
      { role: "user", content: "fork from second response" },
    ] satisfies ModelMessage[];
    const forkFromSecondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-second-fork",
      currentMessageId: "input-fork-from-second",
      currentMessages: forkFromSecondMessages,
    });
    const forkFromSecondLifecycle = await observeRequestLifecycle(bus, forkFromSecondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkFromSecondRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork from second response",
      messages: forkFromSecondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: forkFromSecondManifest,
    });
    await expect(forkFromSecondLifecycle.terminal).resolves.toBe("resolved");
    await forkFromSecondLifecycle.stop();

    const forkRequestId = "discord:tool-lineage:fork-before";
    const forkMessages = [{ role: "user", content: "fork before load" }] satisfies ModelMessage[];
    const forkManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-fork", forkMessages),
    ]);
    const forkLifecycle = await observeRequestLifecycle(bus, forkRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork before load",
      corePrimaryLineage: forkManifest,
    });
    await expect(forkLifecycle.terminal).resolves.toBe("resolved");
    await forkLifecycle.stop();

    const freshSessionId = "tool-lineage-new-thread";
    const freshRequestId = "discord:tool-lineage:fresh";
    const freshMessages = [{ role: "user", content: "new thread" }] satisfies ModelMessage[];
    const freshManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, freshSessionId, "input-fresh", freshMessages),
    ]);
    const freshLifecycle = await observeRequestLifecycle(bus, freshRequestId);
    await publishRunnerRequest({
      bus,
      requestId: freshRequestId,
      sessionId: freshSessionId,
      requestClient: "discord",
      text: "new thread",
      corePrimaryLineage: freshManifest,
    });
    await expect(freshLifecycle.terminal).resolves.toBe("resolved");
    await freshLifecycle.stop();

    expect(offered).toEqual([
      ["builtin", "find_tools"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools"],
      ["builtin", "find_tools"],
    ]);
    expect(getRequestTranscript(store, { requestId: firstRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(getRequestTranscript(store, { requestId: secondRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(
      getRequestTranscript(store, { requestId: forkAfterRequestId })?.loadedCatalogIds,
    ).toEqual(["catalog-id"]);
    expect(getRequestTranscript(store, { requestId: thirdRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(
      getRequestTranscript(store, { requestId: forkFromSecondRequestId })?.loadedCatalogIds,
    ).toEqual(["catalog-id"]);
    expect(getRequestTranscript(store, { requestId: forkRequestId })?.loadedCatalogIds).toEqual([]);
    expect(getRequestTranscript(store, { requestId: freshRequestId })?.loadedCatalogIds).toEqual(
      [],
    );

    await runner.stop();
    await pluginManager.destroy();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("carries loaded tools through a real compaction checkpoint into its descendant", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-compaction-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async () => Result.ok(level1TestToolset());
    const config = parseCoreConfigV2ToUniversal({
      models: {
        main: { model: "openrouter/openai/gpt-4o" },
        fast: { model: "openrouter/openai/gpt-4o" },
        def: {},
        capability: {
          forceUnknownProviders: ["openrouter"],
          overrides: {
            "openrouter/openai/gpt-4o": {
              limit: { context: 10_000, output: 1_000 },
            },
          },
        },
      },
    });
    const modelCalls: Array<{ prompt: string; tools: string[] }> = [];
    const model = new MockLanguageModelV4({
      modelId: "tool-authority-compaction",
      doStream: async (modelOptions) => {
        const tools = level1OfferedToolNames(modelOptions);
        modelCalls.push({ prompt: JSON.stringify(modelOptions.prompt), tools });
        return tools.length === 0
          ? level1TextStep("## Objective\n- Preserve the loaded tool authority.")
          : level1TextStep("compacted response");
      },
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "prefix-lineage-tool-compaction",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "tool-compaction", principal: null }),
      createAgent: (options) => new AiSdkPiAgent({ ...options, model }),
    });

    const sessionId = "tool-compaction-channel";
    const seedRequestId = "discord:tool-compaction:seed";
    const historicalMessages = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? ({ role: "user", content: `historical question ${index} ${"x".repeat(10_000)}` } as const)
        : ({ role: "assistant", content: `historical answer ${index}` } as const),
    ) satisfies ModelMessage[];
    const seedLineage = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "seed-input", historicalMessages),
    ]);
    transcriptResultValue(
      store.saveRequestTranscript({
        requestId: seedRequestId,
        sessionId,
        requestClient: "discord",
        messages: [{ role: "assistant", content: "seed response" }],
        providerState: {
          lastFamily: "ai-sdk",
          containsCrossFamilyTurns: false,
        },
        loadedCatalogIds: ["catalog-id"],
        corePrimaryLineage: seedLineage,
      }),
    );

    const compactingRequestId = "discord:tool-compaction:compacting";
    const compactingMessages = [
      { role: "user", content: "compact this prefix" },
    ] satisfies ModelMessage[];
    const compactingLineage = extendPrimaryManifest({
      store,
      sessionId,
      previous: seedLineage,
      completedRequestId: seedRequestId,
      outputMessageId: "seed-output",
      currentMessageId: "compacting-input",
      currentMessages: compactingMessages,
    });
    const compactingLifecycle = await observeRequestLifecycle(bus, compactingRequestId);

    try {
      await publishRunnerRequest({
        bus,
        requestId: compactingRequestId,
        sessionId,
        requestClient: "discord",
        text: "compact this prefix",
        messages: compactingLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: compactingLineage,
      });
      const compactingTerminal = await compactingLifecycle.terminal;
      if (compactingTerminal !== "resolved") {
        throw new Error(
          `compaction request ${compactingTerminal}: ${compactingLifecycle.details.join(" | ")}`,
        );
      }
      await compactingLifecycle.stop();

      const checkpoint = getRequestTranscript(store, { requestId: compactingRequestId });
      expect(checkpoint?.contextMeta).toEqual({ type: "compaction", formatVersion: 1 });
      expect(checkpoint?.loadedCatalogIds).toEqual(["catalog-id"]);
      if (!checkpoint?.transcriptDigest) throw new Error("compaction checkpoint missing");
      store.linkSurfaceMessagesToRequest({
        requestId: compactingRequestId,
        created: [
          {
            platform: "discord",
            channelId: sessionId,
            messageId: "compacting-output",
          },
        ],
        last: {
          platform: "discord",
          channelId: sessionId,
          messageId: "compacting-output",
        },
      });

      const descendantMessages = [
        { role: "user", content: "continue after compaction" },
      ] satisfies ModelMessage[];
      const descendantLineage = buildCoreLineageManifestV2([
        {
          atoms: [
            {
              kind: "checkpoint",
              requestId: compactingRequestId,
              transcriptDigest: checkpoint.transcriptDigest,
            },
          ],
          canonicalMessages: checkpoint.messages,
        },
        admitPrimarySurface(store, sessionId, "post-compaction-input", descendantMessages),
      ]);
      const descendantRequestId = "discord:tool-compaction:descendant";
      expect(
        transcriptResultValue(
          store.validateCorePrimaryLineageReferences({
            manifest: descendantLineage,
            requestClient: "discord",
            sessionId,
            surfaceId: `discord:${sessionId}`,
          }),
        ),
      ).toBeNull();
      expect(
        resolveCorePrimaryLoadedCatalogIds({ lineage: descendantLineage, transcriptStore: store }),
      ).toEqual(["catalog-id"]);
      const descendantLifecycle = await observeRequestLifecycle(bus, descendantRequestId);
      await publishRunnerRequest({
        bus,
        requestId: descendantRequestId,
        sessionId,
        requestClient: "discord",
        text: "continue after compaction",
        messages: descendantLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: descendantLineage,
      });
      await expect(descendantLifecycle.terminal).resolves.toBe("resolved");
      await descendantLifecycle.stop();

      expect(modelCalls.filter((call) => call.tools.length > 0).map((call) => call.tools)).toEqual([
        ["builtin", "find_tools", "deferred_tool"],
        ["builtin", "find_tools", "deferred_tool"],
      ]);
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("startBusAgentRunner Core-primary Claude production path", () => {
  it("promotes an auto-injected first turn and forks the exact linked reply with suffix-only input", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "claude-code/sonnet" };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    config.conversation.thread.autoInject = {
      ...config.conversation.thread.autoInject,
      enabled: true,
      minTextUnits: 20,
      followUpMinTextUnits: 20,
      limit: 1,
      minScore: 0.1,
      expansionMinConfidence: 0.57,
      mode: "hybrid",
      filterCurrentParticipants: false,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-auto-inject-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new ProductionPathDiscordAdapter();
    const sessionId = "primary-auto-inject-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][] = [];
    let plannedSearches = 0;
    const routedRequests: Array<{
      readonly headers?: Readonly<Record<string, string>>;
      readonly data: CmdRequestMessageData;
    }> = [];
    const routedSubResult = await bus.subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          routedRequests.push(message);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (routedSubResult.status === "error") throw routedSubResult.error;
    const routedSub = routedSubResult.value;
    const outputCreated = deferred<MsgRef>();
    const outputCreatedSubResult = await bus.subscribeTopic(
      "evt.surface",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtSurfaceOutputMessageCreated &&
          message.headers?.request_id === `discord:${sessionId}:input-1`
        ) {
          const msgRef = message.data.msgRef;
          if (msgRef.platform === "discord") {
            outputCreated.resolve({
              platform: "discord",
              channelId: msgRef.channelId,
              messageId: msgRef.messageId,
            });
          }
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputCreatedSubResult.status === "error") throw outputCreatedSubResult.error;
    const outputCreatedSub = outputCreatedSubResult.value;
    const routedOutputUpdates: string[] = [];
    const outputUpdatedSubResult = await bus.subscribeTopic(
      "evt.adapter",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtAdapterMessageUpdated &&
          message.data.platform === "discord"
        ) {
          routedOutputUpdates.push(message.data.messageId);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputUpdatedSubResult.status === "error") throw outputUpdatedSubResult.error;
    const outputUpdatedSub = outputUpdatedSubResult.value;
    const adapterIngress = await bridgeAdapterToBus({
      eventSource: adapter,
      platform: "discord",
      bus,
      subscriptionId: "production-primary-auto-inject-ingress",
      transcriptStore: store,
    });
    const requestBlobStore = await getTestBlobStore();
    const router = adaptDiscordRequestRouterStartOutcomeToHost(
      await startDiscordRequestRouter({
        adapter,
        bus,
        blobStore: requestBlobStore,
        resourceRegistry: createTestResourceRegistry(),
        requestDelivery: {
          async prepareAndPublish({ envelope }) {
            return (
              await bus.publish(lilacEventTypes.CmdRequestMessage, envelope.data, {
                headers: envelope.headers,
              })
            )
              .map(() => undefined)
              .mapError(
                (cause) =>
                  new DiscordRequestDeliveryFailed({
                    cause,
                    message: "Test request publication failed",
                  }),
              );
          },
        },
        subscriptionId: "production-primary-auto-inject-router",
        config,
        transcriptStore: store,
        routerGate: async () => ({
          forward: true,
          reason: "deterministic integration route",
        }),
      }),
      () => {},
      () => {},
    );
    const outputRelay = await bridgeBusToAdapter({
      adapter,
      blobStore: requestBlobStore,
      bus,
      platform: "discord",
      policy: createDiscordRelayPolicy(adapter),
      subscriptionId: "production-primary-auto-inject-relay",
      transcriptStore: store,
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-auto-inject",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannedSearches += 1;
          return autoInjectPlanForQuery("native continuation", "Find continuation context.");
        },
        search: async () => ({
          meta: {
            query: "native continuation",
            limit: 1,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [
            {
              threadId: "related-thread",
              title: "Relevant native continuation context",
              brief: "A deterministic auto-injected result.",
              score: 0.9,
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      materializeClaudeCodeRun: async (options) => {
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const runIndex = starts.length;
        starts.push(start);
        const observation = (): ClaudeNativeAttemptObservation => ({
          requestedSessionId: start.sessionId,
          sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100 + runIndex,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        });
        const model = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async (call) => {
            modelPrompts.push([...call.prompt]);
            return level1TextStep(`auto-inject response ${runIndex + 1}`);
          },
        });
        return {
          agentModel: model,
          continuationModel: model,
          createUtilityModelResult: () => Result.ok(model),
          createUtilityModel: () => model,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: observation,
            waitForObservation: async () => observation(),
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {},
          disposeResult: async () => Result.ok(),
        };
      },
    });

    const firstRequestId = `discord:${sessionId}:input-1`;
    const firstText = Array.from({ length: 40 }, (_, index) => `detail-${index}`).join(" ");
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    const firstRelayedResponse = await observeResponseAfterOutputRelay(bus, firstRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: `<@bot> ${firstText}`,
      ts: 1_000,
      raw: {
        reference: {},
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          botUserId: "bot",
        },
      },
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    await firstRelayedResponse.relayed;
    expect(await outputCreated.promise).toEqual({
      platform: "discord",
      channelId: sessionId,
      messageId: "output-1",
    });

    const firstRouted = routedRequests.find(
      (request) => request.headers?.request_id === firstRequestId,
    );
    if (!firstRouted || firstRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("first request did not route with complete Stage 6 lineage");
    }
    const firstInputManifest = firstRouted.data.corePrimaryLineage;
    const persistedFirstManifest = getCorePrimaryLineageManifest(store, {
      requestId: firstRequestId,
    });
    if (!persistedFirstManifest) throw new Error("auto-injected manifest was not persisted");
    expect(persistedFirstManifest.currentCanonicalStart).toBe(
      firstInputManifest.currentCanonicalStart,
    );
    expect(firstInputManifest.segments).toEqual(persistedFirstManifest.segments.slice(0, -1));
    expect(persistedFirstManifest.segments.at(-1)?.atoms).toEqual([
      expect.objectContaining({
        kind: "synthetic",
        source: "conversation-thread-auto-inject",
      }),
    ]);
    expect(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages.map((message) => message.role),
    ).toEqual(["assistant", "tool"]);
    const firstOutput = adapter.outputs[0];
    if (!firstOutput) throw new Error("first output stream was not created");
    expect(
      firstOutput.parts
        .filter((part) => part.type === "tool.status")
        .map((part) => part.update.status),
    ).toEqual(["start", "end"]);
    expect(firstOutput.parts[0]).toMatchObject({
      type: "tool.status",
      update: {
        status: "start",
        display: "conversation_thread_search auto-injected metadata",
      },
    });
    expect(
      adapter.updatedOutputMessageIds.filter((id) => id === firstOutput.messageId).length,
    ).toBe(firstOutput.parts.length);
    expect(routedOutputUpdates.filter((id) => id === firstOutput.messageId).length).toBe(
      firstOutput.parts.length,
    );
    expect(adapter.messages.get(firstOutput.messageId)?.text).toBe("auto-inject response 1");
    expect(
      getTranscriptBySurfaceMessage(store, {
        platform: "discord",
        channelId: sessionId,
        messageId: firstOutput.messageId,
      })?.requestId,
    ).toBe(firstRequestId);
    const firstBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    const firstTranscript = getRequestTranscript(store, {
      requestId: firstRequestId,
    });
    if (!firstBinding || !firstTranscript?.transcriptDigest || !firstTranscript.providerState) {
      throw new Error("auto-injected first turn did not promote");
    }
    expect(firstBinding).toMatchObject(
      computeCorePrimaryClaudeTerminalHead({
        manifest: persistedFirstManifest,
        requestId: firstRequestId,
        transcriptDigest: firstTranscript.transcriptDigest,
        responseMessageCount: firstTranscript.messages.length,
        providerState: firstTranscript.providerState,
      }),
    );

    const secondRequestId = `discord:${sessionId}:input-2`;
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    const secondRelayedResponse = await observeResponseAfterOutputRelay(bus, secondRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: "next",
      ts: 20_000,
      raw: {
        reference: { messageId: firstOutput.messageId, channelId: sessionId },
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          botUserId: "bot",
        },
      },
    });
    await expect(secondLifecycle.terminal).resolves.toBe("resolved");
    await secondRelayedResponse.relayed;

    const secondRouted = routedRequests.find(
      (request) => request.headers?.request_id === secondRequestId,
    );
    if (!secondRouted || secondRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("second request did not route with complete Stage 6 lineage");
    }
    const secondManifest = secondRouted.data.corePrimaryLineage;
    expect(secondManifest.segments.map((segment) => segment.atoms[0]?.kind)).toEqual([
      "surface",
      "synthetic",
      "request",
      "surface",
    ]);
    expect(secondManifest.segments[2]?.requestSource?.aliases).toEqual([
      {
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId: firstOutput.messageId,
      },
    ]);
    expect(secondManifest.segments[1]?.canonicalMessages).toEqual(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages,
    );
    const secondCurrentSegment = secondManifest.segments.at(-1);
    if (!secondCurrentSegment) throw new Error("second current segment is missing");
    expect(secondManifest.currentCanonicalStart).toBe(secondCurrentSegment.canonicalStart);

    expect(plannedSearches).toBe(1);
    expect(starts[0]).toMatchObject({
      mode: "fresh",
      sessionId: firstBinding.claudeSessionId,
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
    });
    expect(modelPrompts).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[0])).toContain("related-thread");
    expect(JSON.stringify(modelPrompts[1])).toContain("next");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("detail-0");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("related-thread");
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.revision,
    ).toBe(2);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      firstRelayedResponse.stop(),
      secondRelayedResponse.stop(),
    ]);
    await runner.stop();
    await outputRelay.stop();
    await router.stop();
    await adapterIngress.stop();
    const routedStopped = await routedSub.stop();
    if (routedStopped.status === "error") throw routedStopped.error;
    const outputCreatedStopped = await outputCreatedSub.stop();
    if (outputCreatedStopped.status === "error") throw outputCreatedStopped.error;
    const outputUpdatedStopped = await outputUpdatedSub.stop();
    if (outputUpdatedStopped.status === "error") throw outputUpdatedStopped.error;
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("promotes fresh and exact-fork tool-loop turns, then fences cancellation and CAS loss", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-claude-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-claude-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][][] = [];
    const finalizationStarted = [deferred<void>(), deferred<void>()];
    const releaseFinalization = [deferred<void>(), deferred<void>()];
    const switchedModels: Array<string | undefined> = [];
    const materialize = async (
      options: Parameters<typeof materializeClaudeCodeRun>[0],
    ): Promise<MaterializedClaudeCodeRun> => {
      const start = options.nativeSession;
      if (!start || start.mode === "ephemeral") throw new Error("expected persistent Claude start");
      const runIndex = starts.length;
      starts.push(start);
      modelPrompts.push([]);
      let modelCalls = 0;
      let contextTokens = 100 + runIndex * 100;
      const observation = (): ClaudeNativeAttemptObservation => ({
        requestedSessionId: start.sessionId,
        sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
        initSessionId: start.sessionId,
        resultSessionId: start.sessionId,
        contextTokens,
        contextMaxTokens: 4_000,
        requestedModel: options.modelId,
        initializedModel: options.modelId,
        requestedReasoning: options.reasoning ?? null,
        providerWarnings: [],
        invoked: true,
        requiredObservabilityError: null,
        callbackError: null,
      });
      const model = new MockLanguageModelV4({
        modelId: options.modelId,
        doStream: async (call) => {
          modelPrompts[runIndex]!.push([...call.prompt]);
          modelCalls += 1;
          if (runIndex === 1 && modelCalls === 1) {
            return level1ToolCallStep([{ toolCallId: "native-tool", toolName: "builtin" }]);
          }
          return level1TextStep(`native response ${runIndex + 1}`);
        },
      });
      return {
        agentModel: model,
        continuationModel: model,
        createUtilityModelResult: () => Result.ok(model),
        createUtilityModel: () => model,
        control: {
          inject: () => false,
          interrupt: async () => false,
          async interruptResult() {
            return Result.ok(await this.interrupt());
          },
          clear: () => {},
          clearResult() {
            this.clear();
            return Result.ok();
          },
        },
        nativeSession: {
          getObservation: observation,
          waitForObservation: async () => {
            contextTokens += 25;
            return observation();
          },
          recordWarning: () => {},
          finalize: async () => {
            if (runIndex === 2 || runIndex === 3) {
              const gateIndex = runIndex - 2;
              finalizationStarted[gateIndex]!.resolve(undefined);
              await releaseFinalization[gateIndex]!.promise;
            }
            return {
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            };
          },
          async finalizeResult() {
            return Result.ok(await this.finalize());
          },
        },
        dispose: async () => {},
        disposeResult: async () => Result.ok(),
      };
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-claude",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      materializeClaudeCodeRun: materialize,
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });

    const firstRequestId = "discord:primary-claude-session:input-1";
    const firstMessages = [{ role: "user", content: "first current" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-1", firstMessages),
    ]);
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    await publishRunnerRequest({
      bus,
      requestId: firstRequestId,
      sessionId,
      requestClient: "discord",
      text: "first current",
      corePrimaryLineage: firstManifest,
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    const firstBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!firstBinding) throw new Error("first binding was not promoted");
    const firstTranscript = getRequestTranscript(store, {
      requestId: firstRequestId,
    });
    if (!firstTranscript?.transcriptDigest) throw new Error("first transcript digest is missing");
    const firstHead = computeCorePrimaryClaudeTerminalHead({
      manifest: firstManifest,
      requestId: firstRequestId,
      transcriptDigest: firstTranscript.transcriptDigest,
      responseMessageCount: firstTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    expect(starts[0]).toMatchObject({
      mode: "fresh",
      sessionId: firstBinding.claudeSessionId,
    });
    expect(firstBinding).toMatchObject(firstHead);

    const secondRequestId = "discord:primary-claude-session:input-2";
    const secondMessages = [{ role: "user", content: "second current" }] satisfies ModelMessage[];
    const secondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-1",
      currentMessageId: "input-2",
      currentMessages: secondMessages,
    });
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: secondRequestId,
      sessionId,
      requestClient: "discord",
      text: "second current",
      messages: secondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: secondManifest,
    });
    expect({
      terminal: await secondLifecycle.terminal,
      details: secondLifecycle.details,
    }).toEqual({
      terminal: "resolved",
      details: [undefined, undefined],
    });
    const secondBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!secondBinding) throw new Error("second binding was not promoted");
    const secondTranscript = getRequestTranscript(store, {
      requestId: secondRequestId,
    });
    if (!secondTranscript?.transcriptDigest) throw new Error("second transcript digest is missing");
    const secondHead = computeCorePrimaryClaudeTerminalHead({
      manifest: secondManifest,
      requestId: secondRequestId,
      transcriptDigest: secondTranscript.transcriptDigest,
      responseMessageCount: secondTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
      sessionId: secondBinding.claudeSessionId,
    });
    expect(modelPrompts[1]).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[1]?.[0])).not.toContain("first current");
    expect(JSON.stringify(modelPrompts[1]?.[0])).toContain("second current");
    expect(JSON.stringify(modelPrompts[1]?.[1])).toContain(
      "Continue after the completed tool call.",
    );
    expect(
      JSON.stringify(getRequestTranscript(store, { requestId: secondRequestId })?.messages),
    ).toContain("native-tool");
    expect(secondBinding.canonicalMessageCount).toBe(
      secondManifest.segments.at(-1)!.canonicalEnd +
        getRequestTranscript(store, { requestId: secondRequestId })!.messages.length,
    );
    expect(secondBinding).toMatchObject(secondHead);
    expect(secondBinding.nativeContextTokens).toBeGreaterThan(firstBinding.nativeContextTokens);

    const cancellationRequestId = "discord:primary-claude-session:input-cancel";
    const cancellationMessages = [
      { role: "user", content: "cancel during finalize" },
    ] satisfies ModelMessage[];
    const cancellationManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2",
      currentMessageId: "input-cancel",
      currentMessages: cancellationMessages,
    });
    const cancellationLifecycle = await observeRequestLifecycle(bus, cancellationRequestId);
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      text: "cancel during finalize",
      messages: cancellationManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: cancellationManifest,
    });
    await finalizationStarted[0]!.promise;
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      queue: "interrupt",
      text: "cancel",
      raw: { cancel: true },
    });
    releaseFinalization[0]!.resolve(undefined);
    await expect(cancellationLifecycle.terminal).resolves.toBe("cancelled");
    expect(starts[2]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: cancellationRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[2]?.mode === "fresh" || starts[2]?.mode === "fork" ? starts[2].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
      state: "cancelled",
    });
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(secondBinding);

    const raceRequestId = "discord:primary-claude-session:input-race";
    const raceMessages = [{ role: "user", content: "race finalize" }] satisfies ModelMessage[];
    const raceManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2-race",
      currentMessageId: "input-race",
      currentMessages: raceMessages,
    });
    const raceLifecycle = await observeRequestLifecycle(bus, raceRequestId);
    await publishRunnerRequest({
      bus,
      requestId: raceRequestId,
      sessionId,
      requestClient: "discord",
      text: "race finalize",
      messages: raceManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: raceManifest,
    });
    await finalizationStarted[1]!.promise;
    expect(starts[3]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });

    const competitorRequestId = "primary-competitor";
    const competitorSessionId = crypto.randomUUID();
    attemptMutationValue(
      store.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: secondBinding.executionScopeHash,
        requestId: competitorRequestId,
        attemptIndex: 0,
        candidateSessionId: competitorSessionId,
        sourceSessionId: secondBinding.claudeSessionId,
        expectedBindingRevision: secondBinding.revision,
      }),
    );
    store.saveRequestTranscript({
      requestId: competitorRequestId,
      sessionId,
      requestClient: "discord",
      messages: [{ role: "assistant", content: "competitor response" }],
      corePrimaryLineage: raceManifest,
    });
    const competitorTranscript = getRequestTranscript(store, {
      requestId: competitorRequestId,
    });
    if (!competitorTranscript?.transcriptDigest)
      throw new Error("competitor transcript is missing");
    const competitorHead = computeCorePrimaryClaudeTerminalHead({
      manifest: raceManifest,
      requestId: competitorRequestId,
      transcriptDigest: competitorTranscript.transcriptDigest,
      responseMessageCount: competitorTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    store.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: competitorRequestId,
      attemptIndex: 0,
      terminalRequestId: competitorRequestId,
      terminalLineageVersion: 2,
      terminalAtomCount: competitorHead.atomCount,
      terminalPrefixDigest: competitorHead.prefixDigest,
      terminalCanonicalMessageCount: competitorHead.canonicalMessageCount,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
      nativeCwd: dataDir,
      nativeLastModified: 9_999,
      nativeContextTokens: 999,
      nativeContextMaxTokens: 4_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "provider-default",
    });
    expect(
      promotePrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: competitorRequestId,
        attemptIndex: 0,
      }),
    ).toBe(true);
    releaseFinalization[1]!.resolve(undefined);
    await expect(raceLifecycle.terminal).resolves.toBe("resolved");
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toMatchObject({
      claudeSessionId: competitorSessionId,
      atomCount: competitorHead.atomCount,
      prefixDigest: competitorHead.prefixDigest,
      canonicalMessageCount: competitorHead.canonicalMessageCount,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[3]?.mode === "fresh" || starts[3]?.mode === "fork" ? starts[3].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
    });
    expect(switchedModels).toEqual([]);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      cancellationLifecycle.stop(),
      raceLifecycle.stop(),
    ]);
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("does not invoke a configured cross-family fallback after a Claude failure", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-fallback-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-no-fallback";
    let materializations = 0;
    const switchedModels: Array<string | undefined> = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-no-fallback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      materializeClaudeCodeRun: async (options) => {
        materializations += 1;
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const observation: ClaudeNativeAttemptObservation = {
          requestedSessionId: start.sessionId,
          sourceSessionId: null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        };
        const failingModel = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async () => {
            throw Object.assign(new Error("connection reset"), {
              code: "ECONNRESET",
            });
          },
        });
        return {
          agentModel: failingModel,
          continuationModel: failingModel,
          createUtilityModelResult: () => Result.ok(failingModel),
          createUtilityModel: () => failingModel,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation,
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1,
              },
              sourcePreflight: null,
              sourceFinal: null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {},
          disposeResult: async () => Result.ok(),
        };
      },
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });
    const requestId = "discord:primary-no-fallback:input";
    const messages = [{ role: "user", content: "fail without fallback" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input", messages),
    ]);
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId,
      requestClient: "discord",
      text: "fail without fallback",
      corePrimaryLineage: manifest,
    });

    await expect(lifecycle.terminal).resolves.toBe("failed");
    expect(materializations).toBe(1);
    expect(switchedModels).toEqual([]);
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    await lifecycle.stop();
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("Core-primary local compaction replacement", () => {
  it("falls back from an owned utility-model failure without calling the throwing adapter", () => {
    const fallbackModel = new MockLanguageModelV4({ modelId: "fallback" });
    let compatibilityCalls = 0;
    const reported: ClaudeCodeRunExternalFailure[] = [];
    const failure = new ClaudeCodeRunExternalFailure({
      operation: "Claude utility model construction",
      cause: new Error("construction failed"),
      message: "Claude utility model construction failed",
    });
    const run = {
      createUtilityModelResult: () => Result.err(failure),
      createUtilityModel: () => {
        compatibilityCalls += 1;
        throw failure;
      },
    };

    const model = resolveCoreClaudeCompactionSummaryModel({
      run,
      fallback: () => fallbackModel,
      onFailure: (error) => reported.push(error),
    });

    expect(model).toBe(fallbackModel);
    expect(reported).toEqual([failure]);
    expect(compatibilityCalls).toBe(0);
  });

  it("maps the current boundary and text-lowers retained mixed history in the fresh payload", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-primary-compaction-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const oldPrefix = [
      { role: "user", content: `old question ${"x".repeat(20_000)}` },
      { role: "assistant", content: "old answer" },
    ] satisfies ModelMessage[];
    const retainedHistorical = [
      { role: "user", content: "retained historical question" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "old-tool",
            toolName: "builtin",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old-tool",
            toolName: "builtin",
            output: { type: "text", value: "historical tool output" },
          },
        ],
      },
      { role: "assistant", content: "retained historical answer" },
    ] satisfies ModelMessage[];
    const current = [
      {
        role: "user",
        content: [
          { type: "text", text: "current question" },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
      },
    ] satisfies ModelMessage[];
    const oldPrefixStored = transcriptResultValue(projectStoredMessagesV1(oldPrefix));
    const retainedHistoricalStored = transcriptResultValue(
      projectStoredMessagesV1(retainedHistorical),
    );
    const currentStored = transcriptResultValue(
      projectStoredMessagesV1([
        {
          role: "user",
          content: [
            { type: "text", text: "current question" },
            {
              type: "blob",
              blob: {
                version: 1,
                objectId: `b1_${"11".repeat(16)}`,
                sha256: "22".repeat(32),
                byteLength: 3,
              },
              mediaType: "image/png",
            },
          ],
        },
      ]),
    );
    const originalMessages = [...oldPrefix, ...retainedHistorical, ...current];
    let lineage: CorePrimaryLineageV2 = buildCoreLineageManifestV2(
      [
        {
          atoms: [
            {
              kind: "synthetic",
              source: "old-prefix",
              messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(oldPrefixStored))
                .hash,
            },
          ],
          canonicalMessages: oldPrefixStored,
        },
        {
          atoms: [
            {
              kind: "synthetic",
              source: "retained-history",
              messageDigest: transcriptResultValue(
                hashCanonicalStoredMessagesV2(retainedHistoricalStored),
              ).hash,
            },
          ],
          canonicalMessages: retainedHistoricalStored,
        },
        {
          atoms: [
            {
              kind: "synthetic",
              source: "current-media",
              messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(currentStored))
                .hash,
            },
          ],
          canonicalMessages: currentStored,
        },
      ],
      { currentSegmentIndex: 2 },
    );
    const mainPayloads: ModelMessage[][] = [];
    const mainModel = new MockLanguageModelV4({
      modelId: "sonnet",
      doStream: async (call) => {
        mainPayloads.push([...call.prompt]);
        return level1TextStep("fresh response");
      },
    });
    const summaryModel = new MockLanguageModelV4({
      modelId: "summary",
      doStream: async () => level1TextStep("## Objective\n- Preserve current input."),
    });
    const materializedStarts: ClaudeNativeSessionStart[] = [];
    const disposedSessionIds: string[] = [];
    const observation: ClaudeNativeAttemptObservation = {
      requestedSessionId: null,
      sourceSessionId: null,
      initSessionId: null,
      resultSessionId: null,
      contextTokens: null,
      contextMaxTokens: null,
      requestedModel: "sonnet",
      initializedModel: null,
      requestedReasoning: null,
      providerWarnings: [],
      invoked: false,
      requiredObservabilityError: null,
      callbackError: null,
    };
    const runtime = createCorePrimaryClaudeRuntime({
      store,
      sessionId: "compaction-session",
      requestId: "compaction-request",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "provider-default",
      executionScopeHash: "scope",
      executionCwd: dataDir,
      getLineage: () => lineage,
      materialize: async (start) => {
        materializedStarts.push(start);
        return {
          agentModel: mainModel,
          continuationModel: mainModel,
          createUtilityModelResult: () => Result.ok(summaryModel),
          createUtilityModel: () => summaryModel,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: () => ({
              ...observation,
              requestedSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              initSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              resultSessionId: start.mode === "ephemeral" ? null : start.sessionId,
              invoked: true,
            }),
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "unpromotable" as const,
              issues: [
                {
                  code: "candidate-missing" as const,
                  message: "not finalized in this test",
                },
              ],
              observations: observation,
              candidate: null,
              sourcePreflight: null,
              sourceFinal: null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {
            if (start.mode !== "ephemeral") disposedSessionIds.push(start.sessionId);
          },
          async disposeResult() {
            if (start.mode !== "ephemeral") disposedSessionIds.push(start.sessionId);
            return Result.ok();
          },
        };
      },
    });
    await runtime.prepareModelCall({
      canonicalMessages: originalMessages,
      fullBudgetView: originalMessages,
      runtime: {
        model: mainModel,
        modelSpecifier: "claude-code/sonnet",
        executionMode: "provider-tools",
      },
      payload: { mode: "full" },
      transformContext: { system: "test", tools: level1TestToolset().tools },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "claude-code/sonnet",
      messages: originalMessages,
      tools: level1TestToolset().tools,
      sendToolsToModel: false,
      prepareModelCall: runtime.prepareModelCall,
    });
    let replacement:
      | {
          originalSuffixStart: number;
          replacementSuffixStart: number;
          replacementMessageCount: number;
        }
      | undefined;
    const detach = await attachAutoCompaction(agent, {
      model: "claude-code/sonnet",
      modelCapability: new ModelCapability({ fetch: globalThis.fetch }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 2_000, output: 200 }),
      resolveSummaryContextLimit: () => 2_000,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 2,
      keepRecentTokens: 1_000,
      prepareFullModelView: (messages) => runtime.prepareHistoryView(messages),
      prepareFullBudgetView: (messages, context) =>
        runtime.prepareFullBudgetView(messages, context.canonicalStartIndex),
      resolveCurrentInputCanonicalStart: () => lineage.currentCanonicalStart,
      onCompactionEnd: (event) => {
        if (event.status !== "completed" || !event.canonicalReplacement) return;
        replacement = event.canonicalReplacement;
        lineage = degradeCorePrimaryLineageForMutation(
          "compaction-checkpoint-transform",
          mapCorePrimaryCompactionCurrentCanonicalStart({
            previousCurrentCanonicalStart: lineage.currentCanonicalStart,
            replacement: event.canonicalReplacement,
          }),
        );
      },
    });

    try {
      await agent.continue();
    } finally {
      detach();
      await runtime.retireAtRunEnd();
    }

    expect(replacement).toMatchObject({
      originalSuffixStart: 3,
      replacementSuffixStart: 1,
      replacementMessageCount: 5,
    });
    expect(String(lineage.state)).toBe("fresh-only");
    expect(lineage.currentCanonicalStart).toBe(4);
    expect("reason" in lineage ? lineage.reason : null).toBe("compaction-checkpoint-transform");
    expect(materializedStarts).toHaveLength(2);
    expect(materializedStarts[0]).toMatchObject({ mode: "fresh" });
    expect(materializedStarts[1]).toMatchObject({ mode: "fresh" });
    const firstStart = materializedStarts[0];
    const replacementStart = materializedStarts[1];
    if (
      !firstStart ||
      !replacementStart ||
      firstStart.mode === "ephemeral" ||
      replacementStart.mode === "ephemeral"
    ) {
      throw new Error("expected persisted compaction candidates");
    }
    expect(replacementStart.sessionId).not.toBe(firstStart.sessionId);
    expect(disposedSessionIds).toContain(firstStart.sessionId);
    expect(agent.state.messages.slice(1, 5)).toEqual([...retainedHistorical.slice(1), ...current]);
    expect(mainPayloads).toHaveLength(1);
    const actualPayload = mainPayloads[0]!;
    const serializedPayload = JSON.stringify(actualPayload);
    expect(serializedPayload).not.toContain('"type":"tool-call"');
    expect(serializedPayload).not.toContain('"type":"tool-result"');
    expect(serializedPayload).toContain("historical tool output");
    const payloadCurrent = actualPayload.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file"),
    );
    if (!payloadCurrent || !Array.isArray(payloadCurrent.content)) {
      throw new Error("current media payload is missing");
    }
    expect(
      payloadCurrent.content.some(
        (part) => part.type === "text" && part.text === "current question",
      ),
    ).toBe(true);
    expect(
      payloadCurrent.content.some((part) => part.type === "file" && part.mediaType === "image/png"),
    ).toBe(true);

    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("formatAutoCompactionToolDisplay", () => {
  it("keeps start and successful end displays compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "start",
        messageCountBefore: 42,
      }),
    ).toBe("compact context (42 msgs)");

    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: true,
        messageCountBefore: 42,
        messageCountAfter: 9,
      }),
    ).toBe("compact context (42->9 msgs)");
  });

  it("keeps failed end display compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: false,
        messageCountBefore: 42,
      }),
    ).toBe("compact context failed");
  });
});

describe("buildAutoInjectedThreadSearchMessages", () => {
  it("builds slim auto-injected thread search metadata messages", () => {
    const messages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-1",
      entries: [
        {
          threadId: "thread-1",
          title: "Short thread title",
          brief: "Short thread brief",
          timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.role).toBe("tool");
    const assistantMessage = messages[0];
    if (assistantMessage?.role !== "assistant" || typeof assistantMessage.content === "string") {
      throw new Error("expected assistant tool-call message");
    }
    const toolCall = assistantMessage.content[0];
    expect(toolCall?.type).toBe("tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
    expect(toolCall.toolName).toBe("conversation_thread_search");
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    expect(result?.type).toBe("tool-result");
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.toolName).toBe("conversation_thread_search");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "Short thread title",
            brief: "Short thread brief",
            timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
          },
        ],
      },
    });
  });

  it("appends one deterministic unsliceable synthetic segment after the current boundary", () => {
    const sourceMessages = [
      { role: "user", content: "historical" },
      { role: "user", content: "current" },
    ] satisfies ModelMessage[];
    const source = buildCoreLineageManifestV2(
      [
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "historical",
            },
          ],
          canonicalMessages: sourceMessages.slice(0, 1),
        },
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "current",
            },
          ],
          canonicalMessages: sourceMessages.slice(1),
        },
      ],
      { currentSegmentIndex: 1 },
    );
    const injected = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-deterministic",
      entries: [{ threadId: "thread-1", title: "Relevant thread" }],
    });
    const storedInjected = transcriptResultValue(projectStoredMessagesV1(injected));

    const first = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });
    const second = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });

    expect(first).toEqual(second);
    if (first.state !== "complete") throw new Error("expected complete appended lineage");
    expect(first.currentCanonicalStart).toBe(source.currentCanonicalStart);
    expect(first.segments.slice(0, -1)).toEqual(source.segments);
    const synthetic = first.segments.at(-1)!;
    expect(synthetic).toMatchObject({
      atoms: [
        {
          kind: "synthetic",
          source: "conversation-thread-auto-inject",
          messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(storedInjected)).hash,
        },
      ],
      canonicalMessages: storedInjected,
      canonicalStart: sourceMessages.length,
      canonicalEnd: sourceMessages.length + injected.length,
      cumulativeAtomCount: source.segments.at(-1)!.cumulativeAtomCount + 1,
    });
    expect(synthetic.canonicalMessages).toHaveLength(2);
    expect(synthetic.atoms).toHaveLength(1);
    expect(synthetic.atoms[0]?.kind).toBe("synthetic");
    expect(decodeCorePrimaryLineageV2(first, [...sourceMessages, ...injected]).status).toBe("ok");
  });

  it("fails closed for missing, fresh-only, malformed, or unaligned source lineage", () => {
    const canonicalMessages = [{ role: "user", content: "current" }] satisfies ModelMessage[];
    const injectedMessages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-invalid",
      entries: [{ threadId: "thread-1", title: "Relevant thread" }],
    });
    const complete = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "current",
          },
        ],
        canonicalMessages,
      },
    ]);
    const cases: unknown[] = [
      undefined,
      degradeCorePrimaryLineageForMutation("already-fresh", 0),
      { ...complete, segments: [] },
      complete,
    ];

    expect(
      cases.map((lineage, index) =>
        appendAutoInjectedThreadSearchLineage({
          lineage,
          canonicalMessages:
            index === cases.length - 1
              ? [{ role: "user", content: "transformed" }]
              : canonicalMessages,
          injectedMessages,
        }),
      ),
    ).toEqual(
      cases.map(() => ({
        state: "fresh-only",
        lineageVersion: 2,
        currentCanonicalStart: 0,
        reason: "synthetic-thread-search-insertion",
      })),
    );
  });
});

describe("maybeBuildAutoInjectedThreadSearchMessages", () => {
  it("plans from the latest attachment-only user message without falling back to older text", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const plannerInputs: Array<
      Parameters<ConversationThreadToolService["planAutoInjectSearch"]>[0]
    > = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "attachment-only",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: "This older message must not be used for planning.",
        },
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              filename: "diagram.png",
              mediaType: "image/png",
            },
          ],
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannerInputs.push(input);
          return autoInjectPlanForQuery("diagram contents", "Find prior diagram discussions.");
        },
        search: async () => ({
          meta: {
            query: "diagram contents",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 0,
            vectorAvailable: false,
          },
          results: [],
        }),
        metadata: async () => ({ threads: [], missing: [] }),
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    const plannerInput = plannerInputs[0];
    expect(plannerInput?.text).toBe("");
    expect(Array.isArray(plannerInput?.content)).toBe(true);
    expect(Array.isArray(plannerInput?.content) ? plannerInput.content[0]?.type : null).toBe(
      "file",
    );
  });

  it("treats an empty planner result as a successful retrieval abstention", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const statuses: Array<{ status: "start" | "end"; ok?: boolean }> = [];
    let searchCalls = 0;
    const errors: string[] = [];
    let plannerUsage: ConversationThreadAutoInjectUsageAccumulator | undefined;
    const finishedUsage: Parameters<ConversationThreadAutoInjectUsageAccumulator["finish"]>[0][] =
      [];
    const autoInjectUsage: ConversationThreadAutoInjectUsageAccumulator = {
      recordPlannerUsage: () => {},
      recordEmbeddingUsage: () => {},
      finish: (usage) => finishedUsage.push(usage),
    };

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "retrieval-abstention",
      raw: {},
      userMessages: [{ role: "user", content: "A long incidental article excerpt" }],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannerUsage = input.autoInjectUsage;
          return { searches: [] };
        },
        search: async () => {
          searchCalls += 1;
          throw new Error("not used");
        },
        metadata: async () => ({ threads: [], missing: [] }),
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async (status) => {
        statuses.push({
          status: status.status,
          ...(status.ok === undefined ? {} : { ok: status.ok }),
        });
      },
      onError: (message) => {
        errors.push(message);
      },
      autoInjectUsage,
    });

    expect(messages).toEqual([]);
    expect(searchCalls).toBe(0);
    expect(statuses).toEqual([{ status: "start" }, { status: "end", ok: true }]);
    expect(errors).toEqual([]);
    expect(plannerUsage).toBe(autoInjectUsage);
    expect(finishedUsage).toEqual([{ status: "abstained", searchCount: 0, queryCount: 0 }]);
  });

  it("includes dynamically capped brief metadata", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const fullThreshold = Math.floor(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1);
    const belowDisplayBrief = "a".repeat(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH - 1);
    const nearThresholdBrief = "b".repeat(fullThreshold);
    const overThresholdBrief = "c".repeat(fullThreshold + 1);

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-briefs",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            {
              queries: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                targets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
                intentSummary: "Find meaningful message threads.",
              },
            },
          ],
        }),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 3,
            vectorAvailable: false,
          },
          results: [
            {
              threadId: "thread-1",
              title: "Below display",
              brief: belowDisplayBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
            {
              threadId: "thread-2",
              title: "Near threshold",
              brief: nearThresholdBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
            {
              threadId: "thread-3",
              title: "Over threshold",
              brief: overThresholdBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "Below display",
            brief: belowDisplayBrief,
          },
          {
            threadId: "thread-2",
            title: "Near threshold",
            brief: nearThresholdBrief,
          },
          {
            threadId: "thread-3",
            title: "Over threshold",
            brief: `${overThresholdBrief.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH)} ...(${overThresholdBrief.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`,
          },
        ],
      },
    });
  });

  it("ignores surface metadata when deciding whether to auto-inject", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\nlol`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("lol", "Short message.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "lol",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("passes stripped user text to auto-inject query planning", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.42,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const body =
      "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.";
    const startTime = "2026-06-28T12:01:00.000Z";
    const endTime = "2026-06-28T13:23:00.000Z";
    let plannedText = "";
    let searchVerbose: boolean | undefined;
    let searchMinScore: number | undefined;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\n${body}`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannedText = input.text;
          return {
            searches: [
              {
                queries: ["OAuth callback mobile login loop"],
                aboutness: {
                  domains: ["OAuth debugging"],
                  situations: ["mobile login loop after callback"],
                  targets: ["cookie settings"],
                  entities: ["Safari", "SameSite", "secure"],
                  userWouldAskForThisAs: ["OAuth callback mobile login loop"],
                  intentSummary: "Find prior threads about OAuth callback login loops on mobile.",
                },
              },
            ],
          };
        },
        search: async (input) => {
          searchVerbose = input.verbose;
          searchMinScore = input.minScore;
          return {
            meta: {
              query: "OAuth callback mobile login loop",
              limit: 3,
              mode: "hybrid",
              minScore: 0.42,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: "thread-1",
                title: "OAuth callback login loop",
                brief: "",
                timeRange: {
                  start: startTime,
                  end: endTime,
                },
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannedText).toBe(body);
    expect(plannedText).not.toContain("LILAC_META");
    expect(searchVerbose).toBe(true);
    expect(searchMinScore).toBe(0.42);
    expect(messages).toHaveLength(2);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "OAuth callback login loop",
            timeRange: formatExpectedLocalThreadTimeRange(startTime, endTime),
          },
        ],
      },
    });
  });

  it("ranks planned searches globally without reserving a slot per category", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const searchQueries: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-grouped",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("auth cookies", "Find auth cookie threads.").searches[0]!,
            autoInjectPlanForQuery("workplace context", "Find workplace context threads.")
              .searches[0]!,
            autoInjectPlanForQuery("project architecture", "Find project architecture threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          searchQueries.push(query);
          const resultsByQuery: Record<
            string,
            Array<{
              threadId: string;
              title: string;
              brief: string;
              score: number;
            }>
          > = {
            "auth cookies": [
              {
                threadId: "shared",
                title: "Shared top",
                brief: "",
                score: 0.99,
              },
              {
                threadId: "auth-second",
                title: "Auth second",
                brief: "",
                score: 0.4,
              },
            ],
            "workplace context": [
              {
                threadId: "shared",
                title: "Shared top",
                brief: "",
                score: 0.98,
              },
              {
                threadId: "work-second",
                title: "Work second",
                brief: "",
                score: 0.3,
              },
            ],
            "project architecture": [
              {
                threadId: "project-top",
                title: "Project top",
                brief: "",
                score: 0.2,
              },
            ],
          };
          return {
            meta: {
              query,
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: resultsByQuery[query]?.length ?? 0,
              vectorAvailable: false,
            },
            results: resultsByQuery[query] ?? [],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(searchQueries).toEqual(["auth cookies", "workplace context", "project architecture"]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ threadId: "project-top", title: "Project top" }],
      },
    });
  });

  it("caps globally ranked auto-injected results by the configured limit", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-limit-two",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("first category", "Find first category threads.").searches[0]!,
            autoInjectPlanForQuery("second category", "Find second category threads.").searches[0]!,
            autoInjectPlanForQuery("third category", "Find third category threads.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = Array.isArray(input.query) ? input.query[0]! : input.query;
          const title = `${query} result`;
          return {
            meta: {
              query,
              limit: 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: query,
                title,
                brief: "",
                score: query === "third category" ? 1 : 0.1,
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "third category", title: "third category result" },
          { threadId: "first category", title: "first category result" },
        ],
      },
    });
  });

  it("overfetches one search so ranking can rescue a relevant fourth result", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const requestedLimits: number[] = [];
    const highestRejectedThreadIds: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-dedupe-recall",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("buried target", "Find the buried target thread.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          const requestedLimit = input.limit ?? 5;
          requestedLimits.push(requestedLimit);
          const results = [
            { threadId: "generic-1", title: "General project notes", brief: "", score: 1 },
            { threadId: "generic-2", title: "General status update", brief: "", score: 0.9 },
            { threadId: "generic-3", title: "General coordination", brief: "", score: 0.8 },
            {
              threadId: "buried-target",
              title: "Buried target incident",
              brief: "",
              score: 0.7,
              retrievalHints: ["buried target"],
              aboutness: {
                domains: [],
                situations: ["buried target"],
                complaintTargets: ["buried target"],
                entities: [],
                userWouldAskForThisAs: ["buried target"],
              },
            },
          ].slice(0, requestedLimit);
          return {
            meta: {
              query,
              limit: requestedLimit,
              mode: "hybrid",
              minScore: 0.1,
              count: results.length,
              vectorAvailable: false,
            },
            results,
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onInjected: (event) => {
        if (event.highestRejectedByConfidence) {
          highestRejectedThreadIds.push(event.highestRejectedByConfidence.threadId);
        }
      },
      onError: () => {},
    });

    expect(requestedLimits).toEqual([15]);
    expect(highestRejectedThreadIds).toEqual(["generic-1"]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ threadId: "buried-target", title: "Buried target incident" }],
      },
    });
  });

  it("keeps successful auto-inject search groups when another group fails", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-partial-search-failure",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("working category", "Find working category threads.")
              .searches[0]!,
            autoInjectPlanForQuery("failing category", "Find failing category threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          if (query === "failing category") throw new Error("vector search unavailable");
          return {
            meta: {
              query,
              limit: input.limit ?? 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: "working-thread",
                title: "Working thread",
                brief: "",
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: (message) => {
        errors.push(message);
      },
    });

    expect(errors).toEqual([
      "auto-injected thread search failed; continuing with partial metadata",
    ]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ threadId: "working-thread", title: "Working thread" }],
      },
    });
  });

  it("skips injection when all search results were already auto-injected", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const statuses: Array<"start" | "end"> = [];
    let injectedCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Previously injected", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async (update) => {
        statuses.push(update.status);
      },
      onError: () => {},
      onInjected: () => {
        injectedCalls += 1;
      },
    });

    expect(messages).toEqual([]);
    expect(statuses).toEqual(["start", "end"]);
    expect(injectedCalls).toBe(0);
  });

  it("uses the initial threshold before any previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "cookie callback subdomain",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [
            {
              threadId: "thread-1",
              title: "Cookie callback thread",
              brief: "",
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("uses the follow-up threshold after previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "cookie callback subdomain",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: "thread-2",
                title: "Cookie callback thread",
                brief: "",
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("still injects follow-up metadata when the follow-up threshold is met", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-3",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "different angle: this started right after the edge middleware deploy, and the redirect host header differs between Vercel preview and production",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "edge middleware redirect host header",
            "Find redirect host header threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "edge middleware redirect host header",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [
            {
              threadId: "thread-2",
              title: "Edge middleware host header",
              brief: "",
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("skips injection when participant filtering is enabled without visible participants", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: true,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("meaningful message", "Find meaningful message threads.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "meaningful message",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("continues injecting metadata when optional status publishing fails", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];
    const injectedEvents: Array<{
      toolCallId: string;
      mode: "hybrid" | "semantic" | "lexical";
      limit: number;
      searches: readonly (readonly string[])[];
      participantFilterUserCount: number;
      entries: readonly { threadId: string; title: string }[];
    }> = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Related title", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {
        throw new Error("status bus unavailable");
      },
      onError: (message) => {
        errors.push(message);
      },
      onInjected: (event) => {
        injectedEvents.push(event);
      },
    });

    expect(messages).toHaveLength(2);
    expect(injectedEvents).toHaveLength(1);
    const injectedEvent = injectedEvents[0];
    expect(injectedEvent?.toolCallId.startsWith("conversation_thread_")).toBe(true);
    expect(injectedEvent).toMatchObject({
      mode: "hybrid",
      limit: 3,
      searches: [["meaningful message"]],
      participantFilterUserCount: 0,
      entries: [{ threadId: "thread-1", title: "Related title" }],
    });
    expect(errors).toEqual([
      "auto-injected thread search status publish failed; continuing",
      "auto-injected thread search status publish failed; continuing",
    ]);
  });
});

describe("shouldRunAutoInjectedThreadSearch", () => {
  const shouldRun = (text: string) => shouldRunAutoInjectedThreadSearch({ text, minTextUnits: 80 });

  it("skips short and Discord-syntax-heavy messages", () => {
    expect(shouldRun("lol")).toBe(false);
    expect(shouldRun("wtf is this")).toBe(false);
    expect(shouldRun("https://x.com/foo lmao")).toBe(false);
    expect(shouldRun("<@123> thoughts? <#456> <:blob:789> <t:1710000000:R>")).toBe(false);
  });

  it("runs for enough authored Latin text", () => {
    expect(
      shouldRun(
        "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.",
      ),
    ).toBe(true);
  });

  it("weights CJK text enough to trigger on shorter authored messages", () => {
    expect(
      shouldRun(
        "我登入後一直被踢回登入頁，只有手機版會發生，改 cookie 設定之後才開始，想知道是不是 SameSite 或 secure 設定造成的",
      ),
    ).toBe(true);
  });

  it("does not let giant code blocks dominate the gate", () => {
    const code =
      "```ts\n" + "const value = computeBrokenOAuthCookieState();\n".repeat(50) + "```\nwhy";
    expect(measureMeaningfulTextUnits(code)).toBeLessThan(80);
    expect(shouldRun(code)).toBe(false);
  });

  it("counts prose around inline code while discounting code syntax", () => {
    expect(
      shouldRun(
        "The OAuth callback works on desktop, but mobile Safari loses the session after `setCookie` runs. I changed `sameSite`, `secure`, and the callback domain yesterday.",
      ),
    ).toBe(true);
  });
});

describe("transient model retry", () => {
  it("classifies Codex overload stream errors as retryable", () => {
    expect(
      isRetryableTransientModelError({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe(true);
  });

  it("formats Codex overload stream errors for display", () => {
    expect(
      formatUnknownErrorForDisplay({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe("server_is_overloaded: Our servers are currently overloaded. Please try again later.");
  });

  it("classifies transient errors inside arrays", () => {
    expect(
      isRetryableTransientModelError({
        errors: [{ code: "server_is_overloaded" }],
      }),
    ).toBe(true);
  });

  it("classifies SSE socket closures as retryable", () => {
    const message =
      "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()";

    expect(
      isRetryableTransientModelError(
        Object.assign(new Error(message), { code: "ConnectionClosed" }),
      ),
    ).toBe(true);
    expect(isRetryableTransientModelError(new Error(message))).toBe(true);
    expect(
      isRetryableTransientModelError({
        cause: Object.assign(new Error("connection reset"), {
          code: "ConnectionClosed",
        }),
      }),
    ).toBe(true);
  });
});

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(vercel?.openai?.include).toEqual(["reasoning.encrypted_content"]);
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("does not override explicit reasoningSummary and injects encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  it("preserves existing encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "codex",
      modelId: "gpt-5.5",
      providerOptions: {
        openai: {
          include: ["reasoning.encrypted_content"],
        },
      },
    });

    expect(next?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("withReasoningDisplayDefaultForAnthropicModels", () => {
  it("does not inject summarized thinking when display is none", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "none",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
        },
      },
    });
  });

  it("injects summarized display without changing thinking type", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
          display: "summarized",
        },
      },
    });
  });

  it("injects summarized display for vercel/openrouter anthropic models", () => {
    const vercel = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "anthropic/claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        gateway: {
          order: ["anthropic"],
        },
      },
    });

    const openrouter = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "anthropic/claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        openrouter: {
          route: "fallback",
        },
      },
    });

    expect(vercel).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      gateway: {
        order: ["anthropic"],
      },
    });
    expect(openrouter).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      openrouter: {
        route: "fallback",
      },
    });
  });

  it("does not override explicit anthropic thinking display", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "omitted",
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "omitted",
        },
      },
    });
  });
});

describe("shouldEnableAnthropicPromptCache", () => {
  it("keeps Anthropic prompt caching disabled by default", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
      }),
    ).toBe(false);
  });

  it("enables Anthropic prompt caching only when explicitly opted in", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        anthropicPromptCache: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/openai/gpt-4o",
        anthropicPromptCache: true,
      }),
    ).toBe(false);
  });
});

describe("withStableAnthropicUpstreamOrder", () => {
  it("injects the default order for vercel anthropic when none is configured", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: { type: "enabled" },
      },
      gateway: {
        order: ["anthropic", "vertex", "bedrock"],
      },
    });
  });

  it("preserves an explicit vercel gateway order", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });

    expect(next).toEqual({
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });
  });

  it("preserves an explicit openrouter provider order", () => {
    const next = withStableAnthropicUpstreamOrder("openrouter", {
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });

    expect(next).toEqual({
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });
  });
});

describe("anthropic fallback URL downloads", () => {
  it("detects fallback-capable anthropic gateway models", () => {
    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        providerOptions: {
          openrouter: {
            provider: {
              order: ["anthropic"],
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            only: ["anthropic"],
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(false);
  });

  it("forces downloads for http urls when fallback order includes vertex or bedrock", async () => {
    const downloadCalls: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      downloadUrl: async (url) => {
        downloadCalls.push(url.toString());
        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        };
      },
      cacheDir: dir,
    });

    try {
      expect(download).toBeDefined();

      const result = await download!([
        {
          url: new URL("https://example.com/image.png?test=force-download"),
          isUrlSupportedByModel: true,
        },
        {
          url: new URL("data:image/png;base64,AA=="),
          isUrlSupportedByModel: false,
        },
      ]);

      expect(downloadCalls.toSorted()).toEqual([
        "data:image/png;base64,AA==",
        "https://example.com/image.png?test=force-download",
      ]);
      expect(result).toEqual([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches fallback downloads across repeated requests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array([9, 8, 7, 6]),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/report.pdf?test=cache"),
          isUrlSupportedByModel: true,
        },
      ];

      await download!(request);
      await download!(request);

      expect(calls).toBe(1);
      const files = await readdir(dir);
      expect(files.some((file) => file.endsWith(".bin"))).toBe(false);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o077).toBe(0);

      for (const file of files) {
        const fileStat = await stat(path.join(dir, file));
        expect(fileStat.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads large cached attachments back from blob storage without re-downloading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array(9 * 1024 * 1024),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/large-report.pdf?test=disk-cache"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized images to fit anthropic fallback limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/huge-image.png?test=resize"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
      expect(first).toEqual([
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        },
      ]);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches oversize image failures to avoid repeated downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return null;
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/too-big-image.png?test=oversize"),
          isUrlSupportedByModel: true,
        },
      ];

      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not build a download hook when routing is pinned away from fallback providers", () => {
    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          only: ["anthropic"],
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
    });

    expect(download).toBeUndefined();
  });
});

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("appendConfiguredAliasPromptBlock", () => {
  it("appends sorted user and session aliases with ids and comments", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            Stanley: { discord: "u1", comment: "Primary operator" },
            alice: { discord: "u2" },
          },
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
              Deployments: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
    });

    expect(out).toContain("Configured Aliases (Discord):");
    expect(out).toContain("- @alice (discord, u2)");
    expect(out).toContain("- @Stanley (discord, u1): Primary operator");
    expect(out).toContain("- #Deployments (discord, c2)");
    expect(out).toContain("- #ops (discord, c1): Deploy coordination");
    expect(out).not.toContain("read /tmp/core-config.yaml");
  });

  it("points to core-config when alias sections are truncated", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
            bob: { discord: "u2" },
          },
          sessions: {
            discord: {
              dev: "c1",
              ops: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
      maxUserAliases: 1,
      maxSessionAliases: 1,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("- @bob (discord, u2)");
    expect(out).toContain("- #dev (discord, c1)");
    expect(out).not.toContain("- #ops (discord, c2)");
    expect(out).toContain("read /tmp/core-config.yaml");
  });

  it("handles configs with user aliases but no session aliases", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
          },
        },
      } as unknown as Pick<CoreConfig, "entity">,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("Sessions:");
  });
});

describe("heartbeat overlays", () => {
  it("adds ordinary-session request metadata when heartbeat is enabled", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "discord:1:2",
      sessionId: "chan",
      runProfile: "primary",
      nowMs: 0,
    });

    expect(overlay).toContain("Heartbeat Context");
    expect(overlay).toContain("sourceSessionId='chan'");
    expect(overlay).toContain("sourceRequestId='discord:1:2'");
  });

  it("adds heartbeat quiet-hours context for heartbeat session", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
          softQuietHours: {
            start: "23:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "heartbeat:1",
      sessionId: "__heartbeat__",
      runProfile: "primary",
      nowMs: Date.UTC(2026, 2, 11, 23, 30, 0),
    });

    expect(overlay).toContain("Heartbeat Quiet Hours");
    expect(overlay).toContain("Current local quiet-hours state: inside");
  });
});

describe("buildPersistedHeartbeatMessages", () => {
  it("stores heartbeat summary as a single assistant message", () => {
    expect(buildPersistedHeartbeatMessages("summary")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
  });
});

describe("shouldCancelIdleOnlyGlobalRequest", () => {
  it("cancels when another non-heartbeat session is running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "discord-session",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
      [
        "__heartbeat__",
        {
          running: false,
          agent: null,
          queue: [],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });

  it("cancels when the heartbeat session is already running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "__heartbeat__",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "heartbeat:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });
});

describe("shouldCancelRunPolicyRequest", () => {
  it("cancels idle_only_session when the session is already running", () => {
    type RunnerState =
      Parameters<typeof shouldCancelRunPolicyRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, RunnerState>([
      [
        "chan",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelRunPolicyRequest({
        runPolicy: "idle_only_session",
        sessionId: "chan",
        states,
      }),
    ).toBe(true);
  });
});

describe("maybeAppendResponseCommentaryPrompt", () => {
  it("describes commentary and final_answer as response phases", () => {
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("response phases");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("`commentary` phase");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("`final_answer` phase");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).not.toContain("Use two channels");
  });

  it("appends commentary guidance for openai provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("appends commentary guidance for codex provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "codex",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("does not append when disabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: false,
    });

    expect(out).toBe("Base prompt");
  });

  it("does not append for unsupported providers", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openrouter",
      responseCommentary: true,
    });

    expect(out).toBe("Base prompt");
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});

describe("silent assistant turn removal", () => {
  it("drops pure assistant output only inside the completed turn range", () => {
    const messages = [
      { role: "user", content: "request" },
      { role: "assistant", content: "NO_REPLY" },
      { role: "assistant", content: "later answer" },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 1,
        messageCount: 1,
      }),
    ).toEqual([messages[0]!, messages[2]!]);
  });

  it("removes sentinel text but preserves structural assistant parts", () => {
    const messages = [
      { role: "user", content: "request" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "builtin",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 1,
        messageCount: 1,
      }),
    ).toEqual([
      messages[0]!,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
      messages[2]!,
    ]);
  });

  it("drops reasoning when no structural assistant parts remain", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "NO_REPLY" },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 0,
        messageCount: 1,
      }),
    ).toEqual([]);
  });

  it("uses final-answer phase text when commentary precedes the sentinel", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Commentary update.",
            providerOptions: { openai: { phase: "commentary" } },
          },
          {
            type: "text",
            text: "NO_REPLY",
            providerOptions: { openai: { phase: "final_answer" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      removeSilentAssistantTurnMessages({
        messages,
        startIndex: 0,
        messageCount: 1,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "builtin",
            input: {},
          },
        ],
      },
    ]);
  });
});

describe("assistant text part boundary accumulation", () => {
  it("separates streamed output and final text when a resumed text block reuses the same part id", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const secondDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(secondDelta);
    finalText += secondDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const thirdDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Now let me update the discovery.search entry...",
    });
    streamed.push(thirdDelta);
    finalText += thirdDelta;

    expect(streamed).toEqual([
      "...update the notes.",
      "\n\nWorks without the old patch...",
      "\n\nNow let me update the discovery.search entry...",
    ]);
    expect(finalText).toBe(
      "...update the notes.\n\nWorks without the old patch...\n\nNow let me update the discovery.search entry...",
    );
  });

  it("separates resumed streamed output from recovered visible text before persistence", () => {
    const state = createAssistantTextPartBoundaryState("Done. Updated TOOLS.md...");
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const delta = consumeAssistantTextDelta({
      state,
      finalText,
      recoveryPartialText: "Done. Updated TOOLS.md...",
      partId: "text-0",
      delta: "Now let me also write a daily note...",
    });
    streamed.push(delta);
    finalText += delta;

    expect(streamed).toEqual(["\n\nNow let me also write a daily note..."]);
    expect(finalText).toBe("\n\nNow let me also write a daily note...");
  });

  it("keeps a new text-block boundary pending across whitespace-only deltas", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const whitespaceDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "\n",
    });
    streamed.push(whitespaceDelta);
    finalText += whitespaceDelta;

    const textDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(textDelta);
    finalText += textDelta;

    expect(streamed).toEqual(["...update the notes.", "\n", "\nWorks without the old patch..."]);
    expect(finalText).toBe("...update the notes.\n\nWorks without the old patch...");
  });
});

describe("buildAutoInjectedThreadSearchOverlay", () => {
  it("returns the notice only for primary runs when auto-inject is enabled", () => {
    const baseCfg = parseCoreConfigV2ToUniversal({});
    const cfg: CoreConfig = {
      ...baseCfg,
      conversation: {
        ...baseCfg.conversation,
        thread: {
          ...baseCfg.conversation.thread,
          autoInject: {
            ...baseCfg.conversation.thread.autoInject,
            enabled: true,
          },
        },
      },
    };

    const overlay = buildAutoInjectedThreadSearchOverlay({
      cfg,
      runProfile: "primary",
    });

    expect(overlay).toBe(
      "Notice on auto-injected possibly related threads:\nThese search results may appear before your reply, treat them as retrieval hints only, and use them when relevant to the current context.",
    );
    expect(
      buildAutoInjectedThreadSearchOverlay({
        cfg: baseCfg,
        runProfile: "primary",
      }),
    ).toBeNull();
    expect(buildAutoInjectedThreadSearchOverlay({ cfg, runProfile: "explore" })).toBeNull();
  });
});

describe("buildSurfaceMetadataOverlay", () => {
  it("returns null when no user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      { role: "user", content: "plain user text" },
      {
        role: "assistant",
        content: '<LILAC_META:v1>{"platform":"discord"}</LILAC_META:v1>',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toBeNull();
  });

  it("returns instructions when a user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content:
          '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1"}</LILAC_META:v1>\nhello',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
    expect(overlay).toContain("&lt;LILAC_META:v1>");
  });

  it("returns instructions for slash-command metadata without message id", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content: `${formatSurfaceMetadataLine({
          platform: "discord",
          user_id: "u1",
          user_name: "Alice",
          message_time: new Date(1_234).toISOString(),
        })}\n/lilac:tarot 3 focus`,
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
  });
});

describe("mergeToSingleUserMessage", () => {
  it("keeps all user text when merging plain-text messages", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "C two" },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("B one");
    expect(out.content).toContain("C two");
    expect(out.content).toContain("D steer");
  });

  it("preserves later metadata lines at merged block boundaries", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m1"}</LILAC_META:v1>\nfirst',
      },
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("m1");
    expect(out.content).toContain(
      '\n\n<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
    );
  });

  it("preserves buffered multipart content and steering text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "B with image" },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
      },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B with image")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D steer")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });

  it("preserves steering multipart content and buffered text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      {
        role: "user",
        content: [
          { type: "text", text: "D interrupt with image" },
          {
            type: "file",
            data: new Uint8Array([7, 8]),
            mediaType: "image/jpeg",
          },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B one")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D interrupt")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });
});

describe("custom command failures", () => {
  it.each([
    new CustomCommandImportError({
      commandName: "fixture",
      entrypointPath: "/fixture/index.ts",
      cause: new Error("import cause"),
      message: "safe import failure",
    }),
    new CustomCommandExecuteMissingError({
      commandName: "fixture",
      entrypointPath: "/fixture/index.ts",
      message: "safe missing execute failure",
    }),
    new CustomCommandExecuteThrownError({
      commandName: "fixture",
      entrypointPath: "/fixture/index.ts",
      cause: new Error("throw cause"),
      message: "safe synchronous failure",
    }),
    new CustomCommandExecuteRejectedError({
      commandName: "fixture",
      entrypointPath: "/fixture/index.ts",
      cause: new Error("rejection cause"),
      message: "safe rejection failure",
    }),
    new CustomCommandResultInvalidError({
      commandName: "fixture",
      entrypointPath: "/fixture/index.ts",
      message: "safe malformed result failure",
    }),
  ] satisfies readonly CustomCommandExecutionError[])(
    "maps $._tag to its compatibility error text",
    (error) => {
      expect(customCommandExecutionErrorText(error)).toBe(error.message);
    },
  );

  it("builds persisted finalText from the bounded normalized error", () => {
    const finalText = buildCustomCommandFailureFinalText({
      commandText: "/fixture",
      normalizedOutput: {
        type: "error-text",
        value: "bounded error [tool result truncated: 100 characters omitted]",
      },
    });

    expect(finalText).toBe(
      "Error running /fixture: bounded error [tool result truncated: 100 characters omitted]",
    );
  });
});
