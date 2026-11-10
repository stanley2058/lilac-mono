import { createCorePrimaryLineageFreshOnlyV2 } from "@stanley2058/lilac-event-bus";
import type { QuestionService } from "../../../src/question/question-service";
import type { QuestionCall } from "../../../src/question/question-domain";
import { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import { WorkflowLiveParentBridge } from "../../../src/workflow/workflow-live-parent-bridge";
import { WorkflowSubagentDispatcher } from "../../../src/workflow/workflow-subagent-dispatcher";
import { WorkflowEngine } from "../../../src/workflow/workflow-engine";
import { subagentTools } from "../../../src/tools/subagent";
import { generatedMessageMetadata } from "@stanley2058/lilac-agent";
import { describe, expect, it, jest, spyOn } from "bun:test";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  EventPublishTransportFailed,
  lilacEventTypes,
  outReqTopic,
  type CoreLineageManifestV2,
  type Message,
} from "@stanley2058/lilac-event-bus";
import { createLogger, parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Panic, Result, TaggedError } from "better-result";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  AiSdkPiAgent,
  buildSyntheticToolCallId,
  createAgentRunIdleWatchdog,
  hashCanonicalMessagesV1,
  RetryBackoffAborted,
  type AiSdkPiAgentOptions,
} from "@stanley2058/lilac-agent";
import {
  applyCompleteLevel1Tools,
  assertWorkflowDispatchPolicy,
  BusAgentRunnerIntakeFailed,
  BusAgentRunnerRequestHeadersInvalid,
  BusAgentRunnerQueueAttemptRouteInvalid,
  busAgentRunnerDeliveryDisposition,
  buildCustomCommandFailureFinalText,
  BusAgentRunnerOperationFailed,
  customCommandExecutionErrorText,
  completeLevel1ToolMapping,
  captureBusAgentRunnerOperation,
  degradeCorePrimaryLineageForMutation,
  formatBusAgentRunnerDrainFailureForLog,
  formatClaudeLifecycleLogFields,
  formatAutoCompactionToolDisplay,
  buildDeferredSubagentResultMessages,
  hasDeferredSubagentResult,
  planDeferredSubagentBoundary,
  persistHeartbeatSurfaceHandoffs,
  corePrimaryLineageHasCompactionCheckpoint,
  isActiveRuntimeModelCompatible,
  refreshSelectedLevel1Tools,
  resolveAgentRunModel,
  resolveAgentRunModelFallbacks,
  selectNextNativeModelFallback,
  shouldQueueIncompatibleActiveRuntimeModel,
  shouldLogLevel1ToolCompletionAtInfo,
  shouldUsePersistentCoreClaudeRuntime,
  startBusAgentRunnerTerminalCleanup,
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
  WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS,
  validateCorePrimaryLineageAtRunnerIntake,
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
import { createCoreToolPluginManager, type CoreToolPluginManager } from "../../../src/plugins";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import {
  createStoredMessageIdentityProjectionV1,
  StoredMessageProjectionError,
} from "../../../src/transcript/stored-message-materialization";
import { createAgentOutputActivityPublisher } from "../../../src/shared/agent-output-activity";
import { createRequestMessageCache } from "../../../src/tool-server/request-message-cache";
import { JobService } from "../../../src/jobs/job-service";
import { SqliteJobStore } from "../../../src/jobs/job-store";
import {
  isJobWakeRequestRaw,
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
} from "../../../src/surface/bridge/bus-agent-runner/raw";
import { testDeliveriesRemainOpenOnPolicyStop } from "../../helpers/result-raw-bus";
import {
  TEST_BLOB_STORE,
  startBusAgentRunner,
  transcriptResultValue,
  buildCoreLineageManifestV2,
  getRequestTranscript,
  level1TestToolset,
  level1TextStep,
  level1PhasedTextStep,
  level1ToolCallStep,
  level1TextAndToolCallStep,
  level1OfferedToolNames,
  createInMemoryRawBus,
  deferred,
  observeRequestLifecycle,
  publishRunnerRequest,
  acceptedRunnerDelivery,
  corePrimaryTestPluginManager,
  readGeneratedPayload,
} from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

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

  it("refreshes selection without rebuilding the catalog", async () => {
    let catalogCreates = 0;
    let appliedNames: ReadonlySet<string> = new Set();
    const toolset = level1TestToolset({
      onCatalogCreate: () => {
        catalogCreates += 1;
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
    expect([...appliedNames]).toEqual(["builtin", "find_tools"]);
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

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(generatedMessageMetadata(messages[0]!)).toMatchObject({
      kind: "subagent_completion",
      id: "wfrun:subagent:opaque-run",
    });
    expect(readGeneratedPayload(messages)).toMatchObject({
      workflowRunId: "wfrun:subagent:opaque-run",
      finalText: "complete",
    });
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
    expect(generatedMessageMetadata(emitted[0]!)?.id).toBe(completion.runId);
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
      canonicalMessages: [normalizedModelInput[0]!],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(missingResult.append.map((message) => message.role)).toEqual(["tool", "user"]);
    expect(missingResult.append[0]).toMatchObject({
      content: [{ type: "tool-result", toolCallId: "subagentr" }],
    });
    expect(missingResult.append[1]).toEqual(buildDeferredSubagentResultMessages(completion)[0]);
    const restartedResult: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "subagent_result",
          toolCallId: "subagentr",
          output: { type: "error-text", value: "server restarted" },
        },
      ],
    };
    const restarted = planDeferredSubagentBoundary({
      canonicalMessages: [normalizedModelInput[0]!, restartedResult],
      modelInputMessages: [],
      completions: [completion],
    });
    expect(restarted.append).toEqual(buildDeferredSubagentResultMessages(completion));
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

  it("runs subagents on models.main and its fallbacks when no alias is delegated", () => {
    const cfg = parseCoreConfigV2ToUniversal({});
    cfg.models.def = {
      slot: { model: "openai/slot", fallback: ["openai/alias-backup"] },
    };
    cfg.models.main = { model: "slot", fallback: ["openai/main-backup"] };
    cfg.models.fast = { model: "openai/fast" };

    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "restricted",
      reasoningOverride: "medium",
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.spec)).toEqual([
      "openai/slot",
      "openai/main-backup",
    ]);
    expect(plan.head.reasoning).toBe("medium");
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
    const defaultReasoningPlan = resolveAgentRunModel({
      cfg,
      runProfile: "full",
      requestModelOverride: "requested",
    });
    expect(
      [defaultReasoningPlan.head, ...defaultReasoningPlan.fallbacks].map(
        (candidate) => candidate.reasoning,
      ),
    ).toEqual(["low", undefined, "none", undefined]);

    const plan = resolveAgentRunModel({
      cfg,
      runProfile: "full",
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
    const fallbacks = resolveAgentRunModelFallbacks({
      cfg,
      runProfile: "full",
      requestModelOverride: "requested",
    });

    expect(fallbacks.map((candidate) => [candidate.spec, candidate.reasoning])).toEqual([
      ["openai/current", undefined],
      ["openai/explicit", "low"],
    ]);
    delete cfg.models.def.requested;
    expect(
      resolveAgentRunModelFallbacks({
        cfg,
        runProfile: "full",
        requestModelOverride: "requested",
        reasoningOverride: "high",
      }),
    ).toEqual([]);
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

  it("persists a native primary run from its own input through the response", () => {
    const opening = {
      role: "user",
      content: [
        {
          type: "text",
          text: '<LILAC_META:v1>{"platform":"native","thread_id":"t1","message_id":"m2"}</LILAC_META:v1>\nsecond',
        },
      ],
    } satisfies ModelMessage;
    const history = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
    ] satisfies ModelMessage[];
    const own = [opening, { role: "assistant", content: "answer two" }] satisfies ModelMessage[];
    const select = (overrides: { didCompact?: boolean; requestId?: string }) =>
      selectPersistedTranscriptMessages({
        finalMessages: [...history, ...own],
        responseStartIndex: 3,
        isPrimary: true,
        didCompact: overrides.didCompact ?? false,
        native: {
          requestId: overrides.requestId ?? "native:t1:m2",
          requestMessages: [...history, opening],
        },
      });
    expect(select({})).toEqual(own);
    expect(select({ didCompact: true })).toEqual([...history, ...own]);
    expect(select({ requestId: "native:t1:other" })).toEqual([...history, ...own]);
  });

  it("persists full native context when a recovered checkpoint holds a new compaction summary", () => {
    const opening = {
      role: "user",
      content:
        '<LILAC_META:v1>{"platform":"native","thread_id":"t1","message_id":"m3"}</LILAC_META:v1>\nthird',
    } satisfies ModelMessage;
    const summary = (text: string) =>
      ({
        role: "user",
        content: `<context-compaction>\n${text}\n</context-compaction>`,
      }) satisfies ModelMessage;
    const answer = { role: "assistant", content: "answer three" } satisfies ModelMessage;
    const select = (finalMessages: ModelMessage[], requestMessages: ModelMessage[]) =>
      selectPersistedTranscriptMessages({
        finalMessages,
        responseStartIndex: 0,
        isPrimary: true,
        didCompact: false,
        native: { requestId: "native:t1:m3", requestMessages },
      });
    const earlier = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
    ] satisfies ModelMessage[];
    expect(select([summary("new"), opening, answer], [...earlier, opening])).toEqual([
      summary("new"),
      opening,
      answer,
    ]);
    expect(select([summary("old"), opening, answer], [summary("old"), opening])).toEqual([
      opening,
      answer,
    ]);
    expect(select([summary("newer"), opening, answer], [summary("old"), opening])).toEqual([
      summary("newer"),
      opening,
      answer,
    ]);
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
  it.each([
    ["restricted", "deferred"],
    ["full", "sync"],
  ] as const)(
    "delegates heartbeat work with inherited %s authority in %s mode",
    async (profile, mode) => {
      const root = await mkdtemp(path.join(tmpdir(), "heartbeat-delegation-"));
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/heartbeat-test" };
      const bus = createLilacBus(createInMemoryRawBus());
      const store = new DurableWorkflowStore(path.join(root, "workflow.db"));
      const bridge = new WorkflowLiveParentBridge({
        bus,
        blobStore: TEST_BLOB_STORE,
        store,
        subscriptionId: "heartbeat-parent",
      });
      await bridge.start();
      const dispatcher = WorkflowSubagentDispatcher.create({
        store,
        blobStore: TEST_BLOB_STORE,
        dataDir: root,
      });
      const issuedProfiles: string[] = [];
      let currentContext: Parameters<
        CoreToolPluginManager["buildLevel1ToolsetResult"]
      >[0]["requestContext"];
      const pluginManager = corePrimaryTestPluginManager((context) => {
        currentContext = context;
      });
      let delegated = false;
      let resumed = false;
      const runner = await startBusAgentRunner({
        bus,
        config,
        pluginManager,
        cwd: root,
        subscriptionId: "heartbeat-delegation",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        durableWorkflowStore: store,
        workflowLiveParentBridge: bridge,
        workflowSubagentDispatcher: dispatcher,
        issueHeartbeatCapability: ({ profile }) => {
          issuedProfiles.push(profile);
          return `heartbeat-${profile}`;
        },
        issueControlCapability: () => {
          throw new Error("Heartbeat child requested primary authority");
        },
        createAgent: (options) => {
          const context = currentContext!;
          return new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "heartbeat-test",
              doStream: async ({ prompt }) => {
                expect(context.requestInitiator).toBeUndefined();
                if (context.sessionId !== "__heartbeat__") {
                  expect(context.metadata?.controlCapability).toBe(`heartbeat-${profile}`);
                  return level1TextStep("child research complete");
                }
                if (delegated) {
                  expect(JSON.stringify(prompt)).toContain("child research complete");
                  resumed = true;
                  return level1TextStep("HEARTBEAT_OK");
                }
                delegated = true;
                const onDelegate = context.metadata?.onSubagentDelegate as NonNullable<
                  Parameters<typeof subagentTools>[0]["onDelegate"]
                >;
                expect(onDelegate).toBeFunction();
                const tool = subagentTools({
                  idleTimeoutMs: 10_000,
                  maxDepth: 2,
                  runProfile: "primary",
                  config,
                  onDelegate,
                }).subagent_delegate;
                const result = await tool.execute!(
                  { task: "Research the watch", permissions: profile, mode },
                  {
                    toolCallId: "heartbeat-delegate",
                    messages: [],
                    context,
                  },
                );
                if (mode === "sync") {
                  expect(result).toMatchObject({
                    status: "resolved",
                    finalText: "child research complete",
                  });
                  resumed = true;
                  return level1TextStep("HEARTBEAT_OK");
                }
                return level1TextStep("NO_REPLY");
              },
            }),
          });
        },
      });
      const engine = new WorkflowEngine({
        bus,
        blobStore: TEST_BLOB_STORE,
        store,
        dataDir: root,
        subscriptionId: "heartbeat-engine",
        pollMs: 5,
        validateAgentSelection: () => ({
          model: "openai/heartbeat-test",
          reasoning: null,
          request: {
            spec: "openai/heartbeat-test",
            provider: "openai",
            modelId: "heartbeat-test",
            reasoningDisplay: "simple",
          },
        }),
      });
      await engine.start();
      const lifecycle = await observeRequestLifecycle(bus, "heartbeat:delegation-test");
      try {
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: crypto.randomUUID(),
            queue: "prompt",
            runPolicy: "idle_only_global",
            origin: { kind: "heartbeat", reason: "interval" },
            messages: [{ role: "user", content: "Check the watch" }],
          },
          {
            headers: {
              request_id: "heartbeat:delegation-test",
              session_id: "__heartbeat__",
              request_client: "unknown",
            },
          },
        );
        expect(await lifecycle.terminal, JSON.stringify(lifecycle.details)).toBe("resolved");
        expect(resumed).toBe(true);
        expect(issuedProfiles).toEqual(["primary", profile]);
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await engine.stop();
        await bridge.stop();
        await pluginManager.destroy();
        await bus.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["discord", "github"] as const)(
    "normalizes native links in %s model input",
    async (requestClient) => {
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/reference-input" };
      config.surface.native.publicUrl = "https://chat.example/";
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      let modelInput = "";
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `references-${requestClient}`,
        reportFatalPanic: () => undefined,
        config,
        pluginManager,
        issueControlCapability: () => ({ capability: "reference-input", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "reference-input",
              doStream: async ({ prompt }) => {
                modelInput = JSON.stringify(prompt);
                return level1TextStep("reference received");
              },
            }),
          }),
      });
      const requestId = `${requestClient}:reference-session:reference-message`;
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId: "reference-session",
          requestClient,
          text: "Read https://chat.example/?ref=native%3Atarget&message=anchor",
        });
        expect(await lifecycle.terminal, JSON.stringify(lifecycle.details)).toBe("resolved");
        expect(modelInput).toContain("Conversation references (coordinates only");
        expect(modelInput).toContain("native:target");
        expect(modelInput).toContain('\\"client\\":\\"native\\"');
        expect(modelInput).toContain('\\"messageId\\":\\"anchor\\"');
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );

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
      await runner.waitForIdle();
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it.each(["followUp", "steer"] as const)(
    "keeps the initiator and updates tool context for different-user %s",
    async (queue) => {
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/current-turn-user" };
      const bus = createLilacBus(createInMemoryRawBus());
      const requestMessageCache = createRequestMessageCache();
      const firstCallStarted = deferred<void>();
      const releaseFirstCall = deferred<void>();
      const inputApplied = deferred<void>();
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
          const enqueue = agent[queue].bind(agent);
          spyOn(agent, queue).mockImplementation((message) => {
            const id = enqueue(message);
            inputApplied.resolve(undefined);
            return id;
          });
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
          queue,
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
        expect(requestMessageCache.getOrigin(requestId)?.authenticatedOrigin?.userId).toBe(
          "user-a",
        );
        await inputApplied.promise;
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
    },
  );

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
      await runner.waitForIdle();
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
      await runner.waitForIdle();
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
      await runner.waitForIdle();
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
      await runner.waitForIdle();
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
      await runner.waitForIdle();
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
        expect(runner.isSessionBusy("custom-panic")).toBe(true);
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

        const rejectionObserved = runner.waitForIdle().then(
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
      await runner.waitForIdle();
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
        await runner.waitForIdle();
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
    const bindingContexts: unknown[] = [];
    const toolContexts: unknown[] = [];
    const buildToolset = pluginManager.buildLevel1ToolsetResult.bind(pluginManager);
    spyOn(pluginManager, "buildLevel1ToolsetResult").mockImplementation(async (input) => {
      bindingContexts.push(input.requestContext);
      const built = await buildToolset(input);
      return built.map((toolset) => ({
        ...toolset,
        tools: {
          ...toolset.tools,
          bash: tool({
            inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
            execute: (_input, options) => {
              toolContexts.push(options.context);
              return "ok";
            },
          }),
        },
      }));
    });
    let fallbackCalls = 0;
    const successModel = new MockLanguageModelV4({
      modelId: "fallback",
      doStream: async () => {
        fallbackCalls += 1;
        return fallbackCalls === 1
          ? level1ToolCallStep([{ toolCallId: "fallback-context", toolName: "bash" }])
          : level1TextStep("fallback response");
      },
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
    expect(bindingContexts).toHaveLength(2);
    expect(toolContexts).toHaveLength(1);
    expect(toolContexts[0]).toBe(bindingContexts[1]);
    expect(toolContexts[0]).toMatchObject({
      requestId,
      sessionId: "fallback-session",
      safetyMode: "trusted",
      metadata: { controlCapability: "test-capability", onActivity: expect.any(Function) },
    });

    await lifecycle.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps a follow-up sender admitted while fallback attachments materialize", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/primary", fallback: ["openai/fallback"] };
    config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    const fallbackReadStarted = deferred<void>();
    const releaseFallbackRead = deferred<void>();
    const followUpApplied = deferred<void>();
    const bindingContexts: unknown[] = [];
    const toolContexts: unknown[] = [];
    const baseBlobStore = transcriptResultValue(await createMemoryBlobStore());
    const upload = transcriptResultValue(
      await baseBlobStore.startUpload({
        source: new TextEncoder().encode("fallback attachment"),
        retention: { kind: "durable" },
      }),
    );
    const attachment = transcriptResultValue(await upload.completion);
    let fallbackReadPaused = false;
    const blobStore: BlobStore = {
      startUpload: (input) => baseBlobStore.startUpload(input),
      startStagedUpload: (input) => baseBlobStore.startStagedUpload(input),
      adopt: (handle) => baseBlobStore.adopt(handle),
      resolve: (handle, options) => baseBlobStore.resolve(handle, options),
      open: async (ref) => {
        if (bindingContexts.length === 2 && !fallbackReadPaused) {
          fallbackReadPaused = true;
          fallbackReadStarted.resolve(undefined);
          await releaseFallbackRead.promise;
        }
        return baseBlobStore.open(ref);
      },
      delete: (target) => baseBlobStore.delete(target),
      maintain: (input) => baseBlobStore.maintain(input),
      close: (input) => baseBlobStore.close(input),
    };
    const toolset = level1TestToolset();
    toolset.tools.builtin = tool({
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: (_input, options) => {
        toolContexts.push(options.context);
        return "ok";
      },
    });
    const pluginManager = corePrimaryTestPluginManager((context) => {
      bindingContexts.push(context);
    }, toolset);
    const bus = createLilacBus(createInMemoryRawBus());
    let fallbackCalls = 0;
    const fallbackModel = new MockLanguageModelV4({
      modelId: "fallback",
      doStream: async () => {
        fallbackCalls += 1;
        return fallbackCalls === 1
          ? level1ToolCallStep([{ toolCallId: "fallback-sender", toolName: "builtin" }])
          : level1TextStep("done");
      },
    });
    const runner = await startBusAgentRunner({
      bus,
      blobStore,
      config,
      pluginManager,
      subscriptionId: "fallback-concurrent-follow-up",
      reportFatalPanic: () => undefined,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: (input) => ({
        capability: "test-capability",
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
            modelId: "primary",
            doStream: async () => {
              throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
            },
          }),
        });
        const setModel = agent.setModel.bind(agent);
        spyOn(agent, "setModel").mockImplementation((_model, options, spec, reasoning) => {
          setModel(fallbackModel, options, spec, reasoning);
        });
        const followUp = agent.followUp.bind(agent);
        spyOn(agent, "followUp").mockImplementation((message) => {
          const id = followUp(message);
          followUpApplied.resolve(undefined);
          return id;
        });
        return agent;
      },
    });
    const sessionId = "fallback-concurrent-follow-up";
    const requestId = `discord:${sessionId}:first`;
    const origin = (userId: string, messageId: string) => ({
      authenticatedOrigin: {
        platform: "discord",
        userId,
        messageRef: { platform: "discord", channelId: sessionId, messageId },
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(
        await runner.resumeAcceptedDelivery(
          acceptedRunnerDelivery({
            requestDeliveryId: crypto.randomUUID(),
            requestId,
            sessionId,
            requestClient: "discord",
            queue: "prompt",
            raw: origin("user-a", "first"),
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "first" },
                  {
                    type: "blob",
                    blob: attachment,
                    mediaType: "text/plain",
                    filename: "context.txt",
                  },
                ],
              },
            ],
          }),
        ),
      );
      expect(
        await Promise.race([
          fallbackReadStarted.promise.then(() => "fallback-read"),
          lifecycle.terminal,
        ]),
      ).toBe("fallback-read");
      await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        requestClient: "discord",
        queue: "followUp",
        text: "second",
        raw: origin("user-b", "second"),
      });
      expect(
        await Promise.race([followUpApplied.promise.then(() => "follow-up"), lifecycle.terminal]),
      ).toBe("follow-up");
      releaseFallbackRead.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      expect(bindingContexts).toHaveLength(2);
      expect(toolContexts).toHaveLength(1);
      expect(toolContexts[0]).toBe(bindingContexts[1]);
      expect(toolContexts[0]).toMatchObject({
        requestInitiator: { platform: "discord", userId: "user-a" },
        currentTurnUserId: "user-b",
        currentTurnMessageRef: { platform: "discord", channelId: sessionId, messageId: "second" },
        safetyMode: "trusted",
        metadata: { controlCapability: "test-capability", onActivity: expect.any(Function) },
      });
    } finally {
      releaseFallbackRead.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
      transcriptResultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    }
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

describe("native execution runner controls", () => {
  it("cancels the native model and waits for terminal cleanup before returning", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const started = deferred<void>();
    const requestId = "native:cancel:test";
    const requestDeliveryId = crypto.randomUUID();
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const contexts: unknown[] = [];
    const runner = await startBusAgentRunner({
      bus,
      blobStore: transcriptResultValue(await createMemoryBlobStore()),
      pluginManager,
      config: parseCoreConfigV2ToUniversal({}),
      subscriptionId: "native-cancel-control",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      nativeExecution: {
        validate: () => Result.ok({ safetyMode: "restricted" }),
        settled: async () => Result.ok(undefined),
      },
      issueControlCapability: (input) => {
        contexts.push(input);
        return { capability: "native-test", principal: null };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "cancellable-native",
            doStream: async ({ abortSignal }) => {
              started.resolve(undefined);
              await new Promise<void>((resolve) => {
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
              throw Object.assign(new Error("cancelled"), { name: "AbortError" });
            },
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        requestDeliveryId,
        sessionId: "native:cancel",
        requestClient: "native",
        text: "start",
        raw: {
          native: {
            requestId,
            requestDeliveryId,
            threadId: "cancel",
            authorUserId: "participant",
            starterUserId: "starter",
            turnId: "turn",
            inputId: "input",
            historyGeneration: 0,
          },
          authenticatedActor: { platform: "native", userId: "starter" },
          authenticatedOrigin: {
            platform: "native",
            userId: "starter",
            messageRef: { platform: "native", channelId: "cancel", messageId: "test" },
          },
        },
      });
      expect(await Promise.race([started.promise.then(() => "started"), lifecycle.terminal])).toBe(
        "started",
      );
      transcriptResultValue(await runner.cancelNativeSession("native:cancel"));
      expect(await lifecycle.terminal).toBe("cancelled");
      expect(runner.getActiveLevel1Work()).toEqual([]);
      expect(contexts).toEqual([
        expect.objectContaining({
          safetyMode: "restricted",
          authenticatedOrigin: expect.objectContaining({ userId: "starter" }),
        }),
      ]);
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
});

it("persists heartbeat handoff before deferred messages have surface references", () => {
  const store = new SqliteTranscriptStore(":memory:");
  try {
    persistHeartbeatSurfaceHandoffs({
      logger: createLogger({}),
      transcriptStore: store,
      requestId: "heartbeat:deferred",
      requestClient: "unknown",
      sessionId: "__heartbeat__",
      modelLabel: "test",
      responseMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "send",
              toolName: "surface.messages.send",
              input: { client: "native", sessionId: "dm", text: "Forecast changed" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "send",
              toolName: "surface.messages.send",
              output: { type: "json", value: { status: "queued" } },
            },
          ],
        },
        { role: "assistant", content: "HEARTBEAT_OK" },
      ],
    });
    const transcript = store
      .getRequestTranscript({ requestId: "heartbeat:deferred:heartbeat-handoff:deferred" })
      .unwrap();
    expect(transcript?.finalText).toBe("Forecast changed");
    expect(JSON.stringify(transcript?.messages)).toContain("Forecast changed");
    expect(
      store.listSurfaceMessagesForRequest({
        requestId: "heartbeat:deferred:heartbeat-handoff:deferred",
      }),
    ).toEqual([]);
  } finally {
    store.close();
  }
});

describe("deferred questions in the production runner", () => {
  it("reports a native run as waiting until the answer resumes the model", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const requestId = "native:wait:test";
    const requestDeliveryId = crypto.randomUUID();
    const waiting = deferred<void>();
    const reports: Array<{ requestId: string; waiting: boolean }> = [];
    let listener: ((requestId: string) => void) | undefined;
    let pending: QuestionCall | undefined;
    let modelCalls = 0;
    const questions = {
      subscribe: (callback: (requestId: string) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      listDeferred: () => Result.ok(pending ? [pending] : []),
      cancelRequest: async () => {},
    } as unknown as QuestionService;
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "openai/question-test" };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    const runner = await startBusAgentRunner({
      bus,
      blobStore: transcriptResultValue(await createMemoryBlobStore()),
      pluginManager,
      questions,
      config,
      subscriptionId: "native-wait-test",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      nativeExecution: {
        validate: () => Result.ok({ safetyMode: "restricted" }),
        settled: async () => Result.ok(undefined),
        waiting: (request, value) => {
          reports.push({ requestId: request.requestId, waiting: value });
          if (value) waiting.resolve(undefined);
        },
      },
      issueControlCapability: () => ({ capability: "native-test", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "question-test",
            doStream: async () => {
              modelCalls++;
              if (modelCalls > 1) return level1TextStep("Using staging.");
              pending = {
                questionCallId: "q1",
                requestDeliveryId: "d1",
                requestId,
                toolCallId: "t1",
                platform: "native",
                mode: "deferred",
                sessionId: "wait",
                userId: "u1",
                input: { questions: [] },
                currentIndex: 0,
                answers: [],
                messageId: "q1",
                state: "pending",
                createdAt: 1,
                updatedAt: 1,
              };
              return level1TextStep("NO_REPLY");
            },
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestId,
        requestDeliveryId,
        sessionId: "native:wait",
        requestClient: "native",
        text: "Choose a target",
        raw: {
          native: {
            requestId,
            requestDeliveryId,
            threadId: "wait",
            authorUserId: "participant",
            starterUserId: "starter",
            turnId: "turn",
            inputId: "input",
            historyGeneration: 0,
          },
          authenticatedActor: { platform: "native", userId: "starter" },
          authenticatedOrigin: {
            platform: "native",
            userId: "starter",
            messageRef: { platform: "native", channelId: "wait", messageId: "test" },
          },
        },
      });
      expect(
        await Promise.race([waiting.promise.then(() => "waiting"), lifecycle.terminal]),
        lifecycle.details.join("; "),
      ).toBe("waiting");
      expect(reports).toEqual([{ requestId, waiting: true }]);
      pending = {
        ...pending!,
        state: "answered",
        answers: [{ questionId: "target", answer: { kind: "custom", text: "Use staging" } }],
      };
      listener!(requestId);
      expect(await lifecycle.terminal).toBe("resolved");
      expect(reports).toEqual([
        { requestId, waiting: true },
        { requestId, waiting: false },
      ]);
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  describe("background jobs", () => {
    function jobHarness() {
      const dir = mkdtempSync(path.join(tmpdir(), "lilac-runner-jobs-"));
      const store = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
      const jobs = new JobService({ store, logDir: path.join(dir, "logs") });
      return {
        dir,
        store,
        jobs,
        close: async () => {
          await jobs.close();
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    }

    function nativeRaw(requestId: string, requestDeliveryId: string, threadId: string) {
      return {
        native: {
          requestId,
          requestDeliveryId,
          threadId,
          authorUserId: "participant",
          starterUserId: "starter",
          turnId: "turn",
          inputId: "input",
          historyGeneration: 0,
        },
        authenticatedActor: { platform: "native", userId: "starter" },
        authenticatedOrigin: {
          platform: "native",
          userId: "starter",
          messageRef: { platform: "native", channelId: threadId, messageId: "test" },
        },
      };
    }

    const jobOwner = (requestId: string, sessionId: string) => ({
      requestId,
      requestDeliveryId: null,
      sessionId,
      platform: "native" as const,
      userId: "starter",
      originMessageId: "test",
      runProfile: "primary",
    });

    const launch = (command: string) => ({
      args: ["bash", "-c", command],
      cwd: tmpdir(),
      env: process.env,
      literalSecrets: [],
      redactedCommand: command,
    });

    function promptHasJobEvent(prompt: unknown, jobId: string): boolean {
      const text = JSON.stringify(prompt);
      return text.includes("LILAC_GENERATED") && text.includes(jobId);
    }

    it("parks the request on an await job, then resumes with its event", async () => {
      const harness = jobHarness();
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "native:job-await:test";
      const requestDeliveryId = crypto.randomUUID();
      const parked = deferred<void>();
      const gate = path.join(harness.dir, "gate");
      let jobId = "";
      let modelCalls = 0;
      let secondPrompt: unknown;
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        jobs: harness.jobs,
        config,
        subscriptionId: "job-await-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        nativeExecution: {
          validate: () => Result.ok({ safetyMode: "trusted" }),
          settled: async () => Result.ok(undefined),
          waiting: (_request, value) => {
            if (value) parked.resolve(undefined);
          },
        },
        issueControlCapability: () => ({ capability: "native-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async (call) => {
                modelCalls++;
                if (modelCalls > 1) {
                  secondPrompt = call.prompt;
                  return level1TextStep("The build finished.");
                }
                const started = await harness.jobs.start({
                  owner: jobOwner(requestId, "native:job-await"),
                  toolCallId: "call-1",
                  mode: "await",
                  label: "build",
                  launch: launch(`until [ -e '${gate}' ]; do sleep 0.02; done; echo built`),
                });
                jobId = started.match({
                  ok: (job) => job.jobId,
                  err: (error) => {
                    throw error;
                  },
                });
                return level1TextStep("NO_REPLY");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          requestDeliveryId,
          sessionId: "native:job-await",
          requestClient: "native",
          text: "Run the build",
          raw: nativeRaw(requestId, requestDeliveryId, "job-await"),
        });
        expect(
          await Promise.race([parked.promise.then(() => "parked"), lifecycle.terminal]),
          lifecycle.details.join("; "),
        ).toBe("parked");
        expect(modelCalls).toBe(1);

        writeFileSync(gate, "");

        expect(await lifecycle.terminal).toBe("resolved");
        expect(modelCalls).toBe(2);
        expect(promptHasJobEvent(secondPrompt, jobId)).toBe(true);
        expect(JSON.stringify(secondPrompt)).toContain("built");
        expect(harness.jobs.hasPendingEvents("native:job-await")).toBe(false);
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
        await harness.close();
      }
    });

    it("finishes the request while a service job keeps running", async () => {
      const harness = jobHarness();
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "native:job-service:test";
      const requestDeliveryId = crypto.randomUUID();
      let jobId = "";
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        jobs: harness.jobs,
        config,
        subscriptionId: "job-service-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        nativeExecution: {
          validate: () => Result.ok({ safetyMode: "trusted" }),
          settled: async () => Result.ok(undefined),
        },
        issueControlCapability: () => ({ capability: "native-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async () => {
                const started = await harness.jobs.start({
                  owner: jobOwner(requestId, "native:job-service"),
                  toolCallId: "call-1",
                  mode: "service",
                  label: "dev server",
                  launch: launch("sleep 60"),
                });
                jobId = started.match({
                  ok: (job) => job.jobId,
                  err: (error) => {
                    throw error;
                  },
                });
                return level1TextStep("The server is running.");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          requestDeliveryId,
          sessionId: "native:job-service",
          requestClient: "native",
          text: "Start the server",
          raw: nativeRaw(requestId, requestDeliveryId, "job-service"),
        });
        expect(await lifecycle.terminal, lifecycle.details.join("; ")).toBe("resolved");
        const job = harness.store.get(jobId).match({ ok: (value) => value, err: () => null });
        expect(job?.status).toBe("running");
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
        await harness.close();
      }
    });

    it("hands an event left over from an earlier run to the next run's first turn", async () => {
      const harness = jobHarness();
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "native:job-next:test";
      const requestDeliveryId = crypto.randomUUID();
      const exited = deferred<void>();
      const unsubscribe = harness.jobs.subscribe(() => exited.resolve(undefined));
      const started = await harness.jobs.start({
        owner: jobOwner("earlier-request", "native:job-next"),
        toolCallId: "call-earlier",
        mode: "service",
        label: "dev server",
        launch: launch("echo crashed; exit 1"),
      });
      const jobId = started.match({
        ok: (job) => job.jobId,
        err: (error) => {
          throw error;
        },
      });
      await exited.promise;
      unsubscribe();
      let firstPrompt: unknown;
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        jobs: harness.jobs,
        config,
        subscriptionId: "job-next-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        nativeExecution: {
          validate: () => Result.ok({ safetyMode: "trusted" }),
          settled: async () => Result.ok(undefined),
        },
        issueControlCapability: () => ({ capability: "native-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async (call) => {
                firstPrompt ??= call.prompt;
                return level1TextStep("The server crashed earlier.");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          requestDeliveryId,
          sessionId: "native:job-next",
          requestClient: "native",
          text: "How is the server?",
          raw: nativeRaw(requestId, requestDeliveryId, "job-next"),
        });
        expect(await lifecycle.terminal, lifecycle.details.join("; ")).toBe("resolved");
        expect(promptHasJobEvent(firstPrompt, jobId)).toBe(true);
        expect(harness.jobs.hasPendingEvents("native:job-next")).toBe(false);
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
        await harness.close();
      }
    });

    it("stops await jobs on the user's Stop and leaves service jobs running", async () => {
      const harness = jobHarness();
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "native:job-stop:test";
      const requestDeliveryId = crypto.randomUUID();
      const parked = deferred<void>();
      const jobIds = { await: "", service: "" };
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        jobs: harness.jobs,
        config,
        subscriptionId: "job-stop-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        nativeExecution: {
          validate: () => Result.ok({ safetyMode: "trusted" }),
          settled: async () => Result.ok(undefined),
          waiting: (_request, value) => {
            if (value) parked.resolve(undefined);
          },
        },
        issueControlCapability: () => ({ capability: "native-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async () => {
                for (const mode of ["await", "service"] as const) {
                  const started = await harness.jobs.start({
                    owner: jobOwner(requestId, "native:job-stop"),
                    toolCallId: `call-${mode}`,
                    mode,
                    label: mode,
                    launch: launch("sleep 60"),
                  });
                  jobIds[mode] = started.match({
                    ok: (job) => job.jobId,
                    err: (error) => {
                      throw error;
                    },
                  });
                }
                return level1TextStep("NO_REPLY");
              },
            }),
          }),
      });
      const read = (jobId: string) =>
        harness.store.get(jobId).match({ ok: (value) => value, err: () => null });
      try {
        const raw = nativeRaw(requestId, requestDeliveryId, "job-stop");
        await publishRunnerRequest({
          bus,
          requestId,
          requestDeliveryId,
          sessionId: "native:job-stop",
          requestClient: "native",
          text: "Run both",
          raw,
        });
        expect(
          await Promise.race([parked.promise.then(() => "parked"), lifecycle.terminal]),
          lifecycle.details.join("; "),
        ).toBe("parked");

        // The web's Stop reaches the runner through this call.
        const canceled = await runner.cancelNativeSession("native:job-stop");
        expect(canceled.match({ ok: () => true, err: () => false })).toBe(true);

        expect(await lifecycle.terminal).toBe("cancelled");
        expect(read(jobIds.await)?.stopReason).toBe("user_stop");
        expect(read(jobIds.await)?.delivery).toBe("suppressed");
        expect(read(jobIds.service)?.status).toBe("running");
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
        await harness.close();
      }
    });

    it("stops await jobs when an interrupt cancels the run", async () => {
      const harness = jobHarness();
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "github:job-interrupt:test";
      const started = deferred<string>();
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        jobs: harness.jobs,
        config,
        subscriptionId: "job-interrupt-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        issueControlCapability: () => ({ capability: "job-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async () => {
                const job = await harness.jobs.start({
                  owner: jobOwner(requestId, "job-interrupt"),
                  toolCallId: "call-1",
                  mode: "await",
                  label: "build",
                  launch: launch("sleep 60"),
                });
                started.resolve(
                  job.match({
                    ok: (value) => value.jobId,
                    err: (error) => {
                      throw error;
                    },
                  }),
                );
                return level1TextStep("NO_REPLY");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId: "job-interrupt",
          text: "Run the build",
        });
        const jobId = await started.promise;
        await publishRunnerRequest({
          bus,
          requestId,
          sessionId: "job-interrupt",
          queue: "interrupt",
          text: "",
          messages: [],
          raw: { cancel: true },
        });
        expect(await lifecycle.terminal, lifecycle.details.join("; ")).toBe("cancelled");
        const job = harness.store.get(jobId).match({ ok: (value) => value, err: () => null });
        expect(job?.stopReason).toBe("user_stop");
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
        await harness.close();
      }
    });

    it("gives a Discord wake the authority of the message that started the job", async () => {
      const bus = createLilacBus(createInMemoryRawBus());
      const contexts: Record<string, unknown>[] = [];
      const pluginManager = corePrimaryTestPluginManager((requestContext) => {
        contexts.push(requestContext as Record<string, unknown>);
      });
      const sessionId = "wake-channel";
      const originRef = { platform: "discord", channelId: sessionId, messageId: "origin" };
      const raw = {
        authenticatedOrigin: { platform: "discord", userId: "owner", messageRef: originRef },
      };
      const plainRequestId = `discord:${sessionId}:origin`;
      const wakeRequestId = `discord:${sessionId}:origin:wake:${crypto.randomUUID()}`;
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/job-test" };
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        config,
        subscriptionId: "job-discord-wake-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        issueControlCapability: () => ({ capability: "job-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "job-test",
              doStream: async () => level1TextStep("NO_REPLY"),
            }),
          }),
      });
      try {
        for (const requestId of [plainRequestId, wakeRequestId]) {
          const lifecycle = await observeRequestLifecycle(bus, requestId);
          await publishRunnerRequest({
            bus,
            requestId,
            sessionId,
            requestClient: "discord",
            text: "Background job update",
            corePrimaryLineage: transcriptResultValue(
              createCorePrimaryLineageFreshOnlyV2("job-wake", 0),
            ),
            raw: requestId === wakeRequestId ? { ...raw, jobWake: true } : raw,
          });
          expect(await lifecycle.terminal, lifecycle.details.join("; ")).toBe("resolved");
          await lifecycle.stop();
        }
        expect(contexts).toHaveLength(2);
        const [plain, wake] = contexts;
        expect(wake?.["safetyMode"]).toBe(plain?.["safetyMode"]);
        expect(wake?.["currentTurnUserId"]).toBe("owner");
        expect(wake?.["requestInitiator"]).toEqual(plain?.["requestInitiator"]);
        expect(wake?.["serverOwnedRequest"]).toBe(plain?.["serverOwnedRequest"]);
      } finally {
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    });

    it("does not treat a wake as input from a person", () => {
      expect(isJobWakeRequestRaw({ jobWake: true })).toBe(true);
      expect(isJobWakeRequestRaw({ native: { authorUserId: "lilac" } })).toBe(true);
      expect(isJobWakeRequestRaw({ native: { authorUserId: "participant" } })).toBe(false);
      expect(isJobWakeRequestRaw(undefined)).toBe(false);
    });
  });

  it.each(["answer", "cancel"] as const)(
    "settles a silent pending-question request on %s",
    async (action) => {
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      const requestId = "question-runner-test";
      const pendingObserved = deferred<void>();
      let listener: ((requestId: string) => void) | undefined;
      let pending: QuestionCall | undefined;
      let modelCalls = 0;
      const questions = {
        subscribe: (callback: (requestId: string) => void) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        listDeferred: () => {
          if (pending?.state === "pending") pendingObserved.resolve(undefined);
          return Result.ok(pending ? [pending] : []);
        },
        cancelRequest: async () => {},
      } as unknown as QuestionService;
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/question-test" };
      const lifecycle = await observeRequestLifecycle(bus, requestId);
      const runner = await startBusAgentRunner({
        bus,
        blobStore: transcriptResultValue(await createMemoryBlobStore()),
        pluginManager,
        questions,
        config,
        subscriptionId: "question-runner-test",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        issueControlCapability: () => ({ capability: "question-test", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "question-test",
              doStream: async ({ prompt }) => {
                modelCalls++;
                if (modelCalls === 1) {
                  pending = {
                    questionCallId: "q1",
                    requestDeliveryId: "d1",
                    requestId,
                    toolCallId: "t1",
                    platform: "discord",
                    mode: "deferred",
                    sessionId: "question-channel",
                    userId: "u1",
                    input: { questions: [] },
                    currentIndex: 0,
                    answers: [],
                    messageId: "q1",
                    state: "pending",
                    createdAt: 1,
                    updatedAt: 1,
                  };
                  return level1TextStep("NO_REPLY");
                }
                expect(JSON.stringify(prompt)).toContain("question_result");
                expect(JSON.stringify(prompt)).toContain("Use staging");
                return level1TextStep("Using staging.");
              },
            }),
          }),
      });
      try {
        await publishRunnerRequest({
          bus,
          requestId,
          requestDeliveryId: crypto.randomUUID(),
          sessionId: "question-channel",
          requestClient: "discord",
          text: "Choose a target",
        });
        expect(
          await Promise.race([pendingObserved.promise.then(() => "pending"), lifecycle.terminal]),
          lifecycle.details.join("; "),
        ).toBe("pending");
        if (action === "cancel") {
          await publishRunnerRequest({
            bus,
            requestId,
            sessionId: "question-channel",
            requestClient: "discord",
            queue: "interrupt",
            text: "cancel",
            raw: { cancel: true },
          });
          expect(await lifecycle.terminal).toBe("cancelled");
          expect(modelCalls).toBe(1);
          return;
        }
        pending = {
          ...pending!,
          state: "answered",
          answers: [{ questionId: "target", answer: { kind: "custom", text: "Use staging" } }],
        };
        listener!(requestId);
        expect(await lifecycle.terminal).toBe("resolved");
        expect(modelCalls).toBe(2);
      } finally {
        await lifecycle.stop();
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );
});
