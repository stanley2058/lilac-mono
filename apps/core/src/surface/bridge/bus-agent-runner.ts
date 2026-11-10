import { findCatalogModel } from "@stanley2058/lilac-utils";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import { planJobEventBoundary } from "../../jobs/job-events";
import type { JobService } from "../../jobs/job-service";
import type { QuestionService } from "../../question/question-service";
import { QuestionContinuation } from "../../question/question-continuation";
import { createRunWaitTracker } from "./bus-agent-runner/run-wait";
import { buildGeneratedMessage, generatedMessageMetadata } from "@stanley2058/lilac-agent";
import { customCommandUserContent } from "./bus-agent-runner/generated-command-content";
import { expandConversationReferencesForModel } from "./conversation-references";
import type { NativeOutputFrontier } from "@stanley2058/lilac-event-bus";
import {
  McpImageCheckpointRegistry,
  materializeMcpImageCheckpoint,
  type McpImageCheckpointReference,
} from "../../mcp/image-checkpoint";
import {
  createCoreAgentComposition,
  resolveStoredResourceProviderTarget,
  selectNextNativeModelFallback,
  prepareCoreProviderBinding,
  supportsCoreModelFallback,
} from "../../agent/agent-composition";
import { createCoreClaudeComposition } from "../../agent/claude-composition";
/* oxlint-disable eslint/no-control-regex */

import { captureError } from "../../shared/error-capture";
import { consumerId } from "../../shared/event-bus-consumer";

import {
  type CallWarning,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type {
  ConfiguredModelChainEntry,
  CoreConfig,
  CustomCommandResult,
  DurableResolvedModelRequest,
  ModelCapabilityInfo,
  ModelResolutionFailed,
  ModelReasoningEffort,
  ResolvedModelPlan,
  ResolvedModelRef,
} from "@stanley2058/lilac-utils";
import {
  CUSTOM_COMMAND_TOOL_NAME,
  deriveSubagentIdleTimeoutMs,
  env,
  getCoreConfig,
  isRecord,
  ModelCapability,
  openAIMessagePhase,
  createLogger,
  resolveEditingToolMode,
  fromDurableResolvedModelPlanResult,
  resolveModelChainResult,
  resolveModelPlanResult,
  resolveRouterSessionConfig,
  resolveSubagentPermissionProfile,
  resolveSubagentPermissionProfileName,
  withModelPlanReasoning,
} from "@stanley2058/lilac-utils";
import {
  EventDeliveryStopped,
  lilacEventTypes,
  type AdapterPlatform,
  type DecodedLilacMessageForTopic,
  type LilacBus,
  type RequestLifecycleState,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  advanceHistoryProviderState,
  AiSdkPiAgent,
  attachAutoCompaction,
  buildSafeRecoveryCheckpoint,
  buildSyntheticToolCallId,
  classifyHistoryProviderFamily,
  createAgentRunIdleWatchdog,
  createRetryBackoffBudget,
  type AiSdkPiAgentOptions,
  type AiSdkPiAgentEvent,
  type AgentInputQueueId,
  type HistoryProviderState,
  type RetryBackoffAborted,
  type RetryBackoffAttempt,
  type RetryBackoffDelayFailed,
  type TransformMessagesContext,
  type PrepareFullModelView,
} from "@stanley2058/lilac-agent";

import fs from "node:fs/promises";

import path from "node:path";

import type { BuiltLevel1Toolset, CoreToolPluginManager } from "../../plugins";
import type { ToolResultArtifactStore } from "../../artifacts/tool-result-artifact-store";
import { createAgentOutputActivityPublisher } from "../../shared/agent-output-activity";
import {
  createToolResultOutputNormalizer,
  normalizeSubagentFinalText,
} from "../../artifacts/tool-result-output-normalizer";
import type {
  SubagentDelegationRegistration,
  TrustedSubagentDelegationRegistration,
} from "../../tools/subagent";
import type {
  WorkflowLiveParentBridge,
  WorkflowLiveParentCompletion,
} from "../../workflow/workflow-live-parent-bridge";
import type { WorkflowSubagentDispatcher } from "../../workflow/workflow-subagent-dispatcher";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowUsage } from "../../workflow/workflow-domain";
import type { WorkflowRequestPolicy } from "../../workflow/workflow-request-authority";
import {
  createRequestMessageCache,
  type RequestIdentityAliasTargetOccupied,
  type RequestIdentitySourceMissing,
  type RequestMessageCache,
  type RequestMessageCacheAdmissionError,
  type RequestMessageCacheAliasOwner,
  type RequestMessageCacheOwner,
} from "../../tool-server/request-message-cache";
import {
  parseNativeRequestMetadata,
  AuthenticatedRequestProjectionInvalid,
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../authenticated-request";
import { getBuiltinSurfaceProtocol } from "../builtin-surface-protocols";
import { formatToolArgsForDisplayWithSpecs } from "../../tools/tool-args-display";
import { isHeartbeatAckText, isHeartbeatSessionId } from "../../heartbeat/common";

import {
  buildHeartbeatHandoffTranscript,
  heartbeatDeferredHandoffRequestId,
  extractHeartbeatSurfaceSendHandoffs,
  HEARTBEAT_HANDOFF_SESSION_ID,
} from "../../transcript/heartbeat-handoff";
import {
  COMPACTION_CHECKPOINT_FORMAT_VERSION,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import { type ConversationThreadToolService } from "../../conversation/thread-service";
import {
  createStoredMessageIdentityProjectionV1,
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
  type StoredMessageIdentityProjectionV1,
} from "../../transcript/stored-message-materialization";
import type { ResourceAccess } from "../../resource";
import { defaultStoredBlobFilename } from "../../transcript/transcript-persistence-codec";
import type {
  CoreAcceptedRequestWork,
  CorePreparedRequestEnvelope,
  CoreRequestOutputMetadata,
  RequestDeliveryCoordinator,
  RequestDeliveryTerminalOutcome,
} from "./request-delivery";
import type { AcceptedRequestDelivery } from "./request-delivery/types";
import { type AgentRunJournal, type AgentRunRecoveryHead } from "./agent-run-journal";
import { isPossibleNoReplyPrefix, resolveReplyDeliveryFromFinalText } from "./reply-directive";
import { formatBridgeLogContext, formatBridgeTaggedErrorForLog } from "./bridge-log";
import { recordRequestLatencyStage } from "./request-latency-trace";
import { selectWorkspaceSystemPrompt } from "./bus-agent-runner/subagent-prompt";
import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "./bus-agent-runner/tool-failure-logging";
import {
  LineageToolAuthority,
  resolveCorePrimaryLoadedCatalogIds,
} from "./bus-agent-runner/lineage-tool-authority";
import { type AnthropicFallbackBlobStore } from "../../agent/anthropic-fallback-media";
import {
  nativeToolActivityDetail,
  nativeToolOnlyWaits,
  nativeToolActivityLabel,
  nativeToolActivityResult,
  type NativeToolActivityResult,
} from "./bus-agent-runner/native-activity-result";
import { debugJsonStringify, sanitizeFilenameToken } from "./bus-agent-runner/formatting";

import {
  parseCustomCommandFromRaw,
  isJobWakeRequestRaw,
  parseRequestControlFromRaw,
  parseRequestModelOverrideFromRaw,
  parseParentChannelIdFromRaw,
  parseGuildIdFromRaw,
  parseRouterSessionModeFromRaw,
  parseSessionConfigIdFromRaw,
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
  preserveAgentRunnerRaw,
  requestRawReferencesMessage,
  type AgentRunProfile,
  type AgentRunnerRaw,
  type ParsedSubagentMeta,
} from "./bus-agent-runner/raw";
import { createRunCheckpointWriter } from "./bus-agent-runner/run-checkpoint-writer";
import {
  type AgentOutputPublishFailed,
  createAgentOutputPublisher,
} from "./bus-agent-runner/output-publisher";
import { createTransientModelRetryController } from "./bus-agent-runner/transient-retry";
import {
  type materializeClaudeCodeRunResult,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import {
  buildInputCompositionLine,
  buildNoAssistantTextError,
  buildStatsLine,
  formatCallWarning,
  getStatsForNerdsOptions,
  maybeAppendWarningSummaryToUnclearError,
  summarizeCallWarnings,
  systemPromptToText,
} from "./bus-agent-runner/stats";
import {
  buildHeartbeatOverlayForRequest,
  resolveSessionAdditionalPrompts,
} from "./bus-agent-runner/prompt-overlays";
import { maybeBuildSkillsSectionForPrimary } from "./bus-agent-runner/skills-context";
import { buildAgentRunSystemPrompt } from "./bus-agent-runner/system-prompt";
import { resolveSessionSafetyMode, type SessionSafetyMode } from "../session-policy";
import type { AuthenticatedSurfaceOrigin, MsgRef, SurfacePrincipal } from "../types";
import type { SurfaceProtocolResolver } from "../runtime-descriptor";
import type { NativeOutputPublisher } from "../native/output";
import type {
  CustomCommandExecutionError,
  CustomCommandManager,
} from "../../custom-commands/manager";
import { type CoreNamedClaudeRuntime } from "../../agent/core-named-continuation";
import { type CorePrimaryClaudeRuntime } from "../../agent/core-primary-continuation";
import {
  type ReasoningChunkState,
  consumeAssistantTextDelta,
  consumeReasoningChunkEvent,
  createAssistantTextPartBoundaryState,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  removeSilentAssistantTurnMessages,
} from "./bus-agent-runner/agent-event-projector";
import {
  BusAgentRunnerAuthenticationProjectionInvalid,
  type BusAgentRunnerDeliveryError,
  type BusAgentRunnerErrorProjection,
  BusAgentRunnerIntakeFailed,
  BusAgentRunnerOperationFailed,
  BusAgentRunnerQueueAttemptRouteInvalid,
  BusAgentRunnerRecoveryStopped,
  BusAgentRunnerRequestHeadersInvalid,
  type BusAgentRunnerTerminalCleanup,
  type BusAgentRunnerTerminalCleanupOperation,
  PreAgentRunCancelledError,
  ShutdownDrainingAbort,
  busAgentRunnerDeliveryDisposition,
  captureBusAgentRunnerOperation,
  projectBusAgentRunnerError,
  rethrowBusAgentRunnerPanic,
  signalBusAgentRunnerHostFailure,
  startBusAgentRunnerTerminalCleanup,
} from "./bus-agent-runner/errors";
import {
  applyToolOutputCompactionView,
  maybeMarkOldToolOutputsCompacted,
  scrubLargeBinaryForModelView,
} from "./bus-agent-runner/tool-output-policy";
import { maybeBuildAutoInjectedThreadSearchMessages } from "./bus-agent-runner/auto-inject-thread-search";
import {
  appendAutoInjectedThreadSearchLineage,
  corePrimaryLineageHasCompactionCheckpoint,
  degradeCorePrimaryLineageForMutation,
  mapCorePrimaryCompactionCurrentCanonicalStart,
  persistedCompleteLineage,
  requireStoredMessageHash,
  resolveCorePrimaryTranscriptProviderState,
  validateCorePrimaryLineageAtRunnerIntake,
} from "./bus-agent-runner/lineage";
import {
  type Enqueued,
  type QueueLifecycleAttempt,
  type SessionQueue,
  collectBufferedPromptEntriesForActiveRequest,
  groupQueueCancellationEntries,
  isCancelControlEntry,
  mergeQueuedControlsForRecovery,
  mergeQueuedForSameRequest,
  removeQueuedEntriesByReference,
  settlesBefore,
  shouldCancelRunPolicyRequest,
} from "./bus-agent-runner/session-queue";
import { applyToRunningAgent, type RunningAgentControlTarget } from "./bus-agent-runner/controls";
export { mergeToSingleUserMessage } from "./bus-agent-runner/controls";
export {
  type AgentRunnerRetainedRequestDelivery,
  shouldCancelIdleOnlyGlobalRequest,
  shouldCancelRunPolicyRequest,
} from "./bus-agent-runner/session-queue";
export {
  appendAutoInjectedThreadSearchLineage,
  corePrimaryLineageHasCompactionCheckpoint,
  degradeCorePrimaryLineageForMutation,
  mapCorePrimaryCompactionCurrentCanonicalStart,
  resolveCorePrimaryTranscriptProviderState,
  validateCorePrimaryLineageAtRunnerIntake,
} from "./bus-agent-runner/lineage";
export {
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH,
  type AutoInjectedThreadSearchPayload,
  buildAutoInjectedThreadSearchMessages,
  maybeBuildAutoInjectedThreadSearchMessages,
} from "./bus-agent-runner/auto-inject-thread-search";
export {
  applyToolOutputCompactionView,
  maybeMarkOldToolOutputsCompacted,
  scrubLargeBinaryForModelView,
} from "./bus-agent-runner/tool-output-policy";
export {
  BusAgentRunnerAuthenticationProjectionInvalid,
  type BusAgentRunnerDeliveryError,
  BusAgentRunnerIntakeFailed,
  BusAgentRunnerOperationFailed,
  BusAgentRunnerQueueAttemptRouteInvalid,
  BusAgentRunnerRecoveryStopped,
  BusAgentRunnerRequestHeadersInvalid,
  type BusAgentRunnerTerminalCleanup,
  type BusAgentRunnerTerminalCleanupBatch,
  type BusAgentRunnerTerminalCleanupOperation,
  busAgentRunnerDeliveryDisposition,
  captureBusAgentRunnerOperation,
  projectBusAgentRunnerError,
  rethrowBusAgentRunnerCleanupDefect,
  rethrowBusAgentRunnerPanic,
  signalBusAgentRunnerHostFailure,
  startBusAgentRunnerTerminalCleanup,
} from "./bus-agent-runner/errors";
export {
  type AssistantTextPartBoundaryState,
  type ReasoningChunkState,
  consumeAssistantTextDelta,
  consumeReasoningChunkEvent,
  createAssistantTextPartBoundaryState,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  removeSilentAssistantTurnMessages,
  withBlankLineBetweenTextParts,
} from "./bus-agent-runner/agent-event-projector";

export { formatUnknownErrorForDisplay } from "./bus-agent-runner/error-display";
export {
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../agent/provider-options";
export {
  measureMeaningfulTextUnits,
  shouldRunAutoInjectedThreadSearch,
} from "./bus-agent-runner/text-units";
export {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildGeneratedMessageOverlay,
  buildHeartbeatOverlayForRequest,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
} from "./bus-agent-runner/prompt-overlays";

export class CoreStableNamedContinuationInvalid extends TaggedError(
  "CoreStableNamedContinuationInvalid",
)<{
  readonly reason: "primary-run" | "session-mismatch";
  readonly message: string;
}> {}

export function resolveCoreStableNamedContinuation(input: {
  readonly runProfile: AgentRunProfile;
  readonly sessionId: string;
  readonly workflowPolicy: WorkflowRequestPolicy | null;
}): ResultType<
  NonNullable<WorkflowRequestPolicy["stableNamedContinuation"]> | null,
  CoreStableNamedContinuationInvalid
> {
  const identity = input.workflowPolicy?.stableNamedContinuation;
  if (!identity) return Result.ok(null);
  if (input.runProfile === "primary") {
    return Result.err(
      new CoreStableNamedContinuationInvalid({
        reason: "primary-run",
        message: "Stable named continuation cannot authorize a primary run",
      }),
    );
  }
  if (identity.sessionId !== input.sessionId) {
    return Result.err(
      new CoreStableNamedContinuationInvalid({
        reason: "session-mismatch",
        message: "Stable named continuation identity does not match the child session",
      }),
    );
  }
  return Result.ok(identity);
}

export { shouldUsePersistentCoreClaudeRuntime } from "../../agent/claude-composition";

export { resolveStoredResourceProviderTarget } from "../../agent/agent-composition";

export function toIdleRetryDecision(
  backoff: ResultType<RetryBackoffAttempt | null, RetryBackoffAborted | RetryBackoffDelayFailed>,
):
  | { readonly status: "retry"; readonly attempt: RetryBackoffAttempt }
  | {
      readonly status: "fail";
      readonly reason: "aborted" | "delay-failed" | "exhausted";
    } {
  return backoff.match<
    | { readonly status: "retry"; readonly attempt: RetryBackoffAttempt }
    | {
        readonly status: "fail";
        readonly reason: "aborted" | "delay-failed" | "exhausted";
      }
  >({
    ok: (attempt) =>
      attempt === null ? { status: "fail", reason: "exhausted" } : { status: "retry", attempt },
    err: (error) => {
      switch (error._tag) {
        case "RetryBackoffAborted":
          return { status: "fail", reason: "aborted" };
        case "RetryBackoffDelayFailed":
          return { status: "fail", reason: "delay-failed" };
      }
    },
  });
}

export function settleStoredMessageIdentityRemember(
  result: ResultType<void, StoredMessageProjectionError>,
): void {
  const failure = result.match({ ok: () => null, err: (error) => error });
  if (failure) signalBusAgentRunnerHostFailure(failure);
}

export async function projectTranscriptMessagesForPersistence(input: {
  readonly identityProjection: StoredMessageIdentityProjectionV1;
  readonly providerMessages: readonly (ModelMessage | StoredMessageV1)[];
  readonly blobStore: AnthropicFallbackBlobStore;
  readonly transcriptStore: TranscriptStore;
}): Promise<StoredMessageV1[]> {
  const retainUploadedFile = input.transcriptStore.putCoreOwnedBlob;
  if (!retainUploadedFile) {
    return signalBusAgentRunnerHostFailure(
      new Error("Transcript store cannot retain provider file blobs"),
    );
  }
  const projected = await input.identityProjection.projectForPersistence({
    providerMessages: input.providerMessages,
    blobStore: input.blobStore,
    retainUploadedFile: (file) =>
      retainUploadedFile
        .call(input.transcriptStore, {
          blob: file.blob,
          mediaType: file.mediaType,
          filename: defaultStoredBlobFilename(file),
        })
        .map(() => undefined)
        .mapError(
          (error) =>
            new StoredMessageProjectionError({
              message: `Provider file blob could not be retained: ${error.message}`,
            }),
        ),
  });
  const projection = projected.match({
    ok: (value) => () => value,
    err: (error) => () => signalBusAgentRunnerHostFailure(error),
  })();
  return projection.messages;
}

function adaptModelResolutionToBusRunnerHost<T>(result: ResultType<T, ModelResolutionFailed>): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      switch (error._tag) {
        case "ModelResolutionFailed":
          throw error;
      }
    },
  })();
}

export { resolveCoreClaudeCompactionSummaryModel } from "../../agent/claude-composition";

function buildResumePrompt(partialText: string): ModelMessage {
  const base =
    "System notice: the server restarted during your previous turn. Continue from the last stable boundary. If a tool was interrupted, treat it as failed with error: server restarted, and proceed safely.";
  const content =
    partialText.trim().length > 0
      ? `${base}\n\nPartial response already shown to user:\n\n${partialText}\n\nContinue from there without duplicating already visible text.`
      : `${base}\n\nNo visible partial response was persisted.`;

  return {
    role: "user",
    content,
  };
}

function getSubagentOkFromResult(event: { readonly result: unknown }): boolean | null {
  const { result } = event;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
}

function decodeDeferredSubagentAcceptedResult(event: { readonly result: unknown }): {
  ok: true;
  mode: "deferred";
  status: "accepted";
  sessionName: string;
} | null {
  const { result } = event;
  if (!isRecord(result)) return null;
  const sessionName = result["sessionName"];
  if (
    result["ok"] !== true ||
    result["mode"] !== "deferred" ||
    result["status"] !== "accepted" ||
    typeof sessionName !== "string"
  ) {
    return null;
  }
  return { ok: true, mode: "deferred", status: "accepted", sessionName };
}

function buildSubagentResultToolCallId(seed: string): string {
  return buildSyntheticToolCallId({
    prefix: "subagent_result",
    seed,
  });
}

function buildCustomCommandToolCallId(requestId: string, name: string): string {
  return buildSyntheticToolCallId({
    prefix: CUSTOM_COMMAND_TOOL_NAME,
    seed: `${requestId}:${name}`,
  });
}

function formatCompactCount(count: number | undefined): string {
  if (typeof count !== "number" || !Number.isFinite(count)) return "?";
  return String(Math.max(0, Math.trunc(count)));
}

export function formatAutoCompactionToolDisplay(
  input:
    | { phase: "start"; messageCountBefore: number }
    | {
        phase: "end";
        ok: boolean;
        messageCountBefore: number;
        messageCountAfter?: number;
      },
): string {
  if (input.phase === "start") {
    return `compact context (${formatCompactCount(input.messageCountBefore)} msgs)`;
  }

  if (!input.ok) return "compact context failed";

  return `compact context (${formatCompactCount(input.messageCountBefore)}->${formatCompactCount(input.messageCountAfter)} msgs)`;
}

function buildCustomCommandMessages(params: {
  toolCallId: string;
  name: string;
  args: readonly unknown[];
  prompt?: string;
  text: string;
  source: "text" | "discord-slash";
  output: CustomCommandResult;
  provider: string;
}): ModelMessage[] {
  return [
    buildGeneratedMessage({
      kind: "custom_command_result",
      id: params.toolCallId,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: params.name,
            args: params.args,
            prompt: params.prompt,
            text: params.text,
            source: params.source,
          }),
        },
        ...customCommandUserContent(params.output, params.provider),
      ],
    }),
  ];
}

export function buildCustomCommandFailureFinalText(params: {
  commandText: string;
  normalizedOutput: CustomCommandResult;
}): string {
  const normalizedError =
    params.normalizedOutput.type === "error-text"
      ? params.normalizedOutput.value
      : "Custom command failed.";
  return `Error running ${params.commandText}: ${normalizedError}`;
}

export function customCommandExecutionErrorText(error: CustomCommandExecutionError): string {
  switch (error._tag) {
    case "CustomCommandImportError":
    case "CustomCommandExecuteMissingError":
    case "CustomCommandExecuteThrownError":
    case "CustomCommandExecuteRejectedError":
    case "CustomCommandResultInvalidError":
      return error.message;
  }
}

export function buildDeferredSubagentResultMessages(
  completion: WorkflowLiveParentCompletion,
): ModelMessage[] {
  const payload = {
    ok: completion.ok,
    mode: "deferred" as const,
    status: completion.status,
    workflowRunId: completion.runId,
    profile: completion.profile,
    sessionName: completion.sessionName,
    finalText: completion.finalText,
    ...(completion.detail ? { detail: completion.detail } : {}),
  };

  return [
    buildGeneratedMessage({
      kind: "subagent_completion",
      id: completion.runId,
      content: JSON.stringify(payload),
    }),
  ];
}

function buildDeferredSubagentDisplay(completion: WorkflowLiveParentCompletion): string {
  return `subagent (${completion.profile}; ${completion.status})`;
}

function hasToolResult(messages: readonly ModelMessage[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId),
  );
}

function hasDeferredSubagentWorkflowResult(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
    const generated = generatedMessageMetadata(message);
    if (generated?.kind === "subagent_completion" && generated.id === workflowRunId) return true;
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        part.toolName === "subagent_result" &&
        part.output.type === "json" &&
        isRecord(part.output.value) &&
        part.output.value["workflowRunId"] === workflowRunId
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasConsumedDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId">,
): boolean {
  return hasDeferredSubagentWorkflowResult(messages, completion.runId);
}

export function hasDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId" | "childRequestId">,
): boolean {
  return (
    hasDeferredSubagentWorkflowResult(messages, completion.runId) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.runId)) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.childRequestId))
  );
}

function closeLegacyDeferredSubagentCalls(
  messages: readonly ModelMessage[],
  runId: string,
): ModelMessage[] {
  const closures: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "subagent_result") continue;
      if (!isRecord(part.input) || part.input["workflowRunId"] !== runId) continue;
      if (hasToolResult(messages, part.toolCallId)) continue;
      closures.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            output: {
              type: "text",
              value: "Completion delivered in the following generated user message.",
            },
          },
        ],
      });
    }
  }
  return closures;
}

export function planDeferredSubagentBoundary(input: {
  canonicalMessages: readonly ModelMessage[];
  modelInputMessages: readonly ModelMessage[];
  completions: readonly WorkflowLiveParentCompletion[];
}): {
  append: ModelMessage[];
  consumedRunIds: string[];
  forceNextTurn: boolean;
} {
  const consumedRunIds = input.completions
    .filter((completion) => hasConsumedDeferredSubagentResult(input.modelInputMessages, completion))
    .map((completion) => completion.runId);
  const consumed = new Set(consumedRunIds);
  const unconsumed = input.completions.filter((completion) => !consumed.has(completion.runId));
  const append = unconsumed.flatMap((completion) => {
    if (hasDeferredSubagentWorkflowResult(input.canonicalMessages, completion.runId)) return [];
    return [
      ...closeLegacyDeferredSubagentCalls(input.canonicalMessages, completion.runId),
      ...buildDeferredSubagentResultMessages(completion),
    ];
  });

  return {
    append,
    consumedRunIds,
    forceNextTurn: unconsumed.length > 0,
  };
}

function buildHeartbeatHandoffRequestId(requestId: string, index: number): string {
  return `${requestId}:heartbeat-handoff:${index + 1}`;
}

export function persistHeartbeatSurfaceHandoffs(params: {
  logger: ReturnType<typeof createLogger>;
  transcriptStore: TranscriptStore;
  requestId: string;
  requestClient: AdapterPlatform;
  sessionId: string;
  modelLabel: string;
  responseMessages: readonly ModelMessage[];
}): void {
  if (!isHeartbeatSessionId(params.sessionId)) return;

  const refs = params.transcriptStore.listSurfaceMessagesForRequest?.({
    requestId: params.requestId,
  });
  const extracted = extractHeartbeatSurfaceSendHandoffs(params.responseMessages);
  const fallback = buildHeartbeatHandoffTranscript(params.responseMessages);
  if (!fallback) return;

  if (extracted.length > 0) {
    const deferredMessages = projectStoredMessagesV1(fallback.messages);
    const saved = deferredMessages.andThen((messages) =>
      params.transcriptStore.saveRequestTranscript({
        requestId: heartbeatDeferredHandoffRequestId(params.requestId),
        sessionId: HEARTBEAT_HANDOFF_SESSION_ID,
        requestClient: params.requestClient,
        messages,
        finalText: extracted
          .map((handoff) => handoff.finalText)
          .filter(Boolean)
          .join("\n\n"),
        modelLabel: params.modelLabel,
      }),
    );
    saved.match({
      ok: () => undefined,
      err: (error) =>
        params.logger.warn(
          "deferred heartbeat handoff persistence failed",
          formatBridgeTaggedErrorForLog(error, { requestId: params.requestId }),
        ),
    });
  }
  if (!refs || refs.length === 0) return;

  if (extracted.length !== refs.length) {
    params.logger.warn("heartbeat handoff transcript count mismatch", {
      requestId: params.requestId,
      linkedSurfaceMessages: refs.length,
      detectedSends: extracted.length,
    });
  }

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i]!;
    const handoff = extracted[i] ?? fallback;
    const handoffRequestId = buildHeartbeatHandoffRequestId(params.requestId, i);

    const storedHandoff = projectStoredMessagesV1(handoff.messages);
    const storedHandoffError = storedHandoff.match({
      ok: () => null,
      err: (error) => error,
    });
    if (storedHandoffError) {
      params.logger.warn(
        "heartbeat handoff transcript projection failed",
        formatBridgeTaggedErrorForLog(storedHandoffError, {
          requestId: handoffRequestId,
        }),
      );
      continue;
    }
    const saved = params.transcriptStore.saveRequestTranscript({
      requestId: handoffRequestId,
      sessionId: HEARTBEAT_HANDOFF_SESSION_ID,
      requestClient: params.requestClient,
      messages: storedHandoff.match({
        ok: (messages) => messages,
        err: () => [],
      }),
      finalText: handoff.finalText,
      modelLabel: params.modelLabel,
    });
    const saveError = saved.match({ ok: () => null, err: (error) => error });
    if (saveError) {
      params.logger.warn(
        "heartbeat handoff transcript persistence failed",
        formatBridgeLogContext({
          requestId: handoffRequestId,
          errorTag: saveError.name,
          errorMessage: saveError.message,
        }),
      );
      continue;
    }
    params.transcriptStore.linkSurfaceMessagesToRequest({
      requestId: handoffRequestId,
      created: [ref],
      last: ref,
    });
  }
}

export type NativeRunnerRequest = {
  readonly requestId: string;
  readonly requestDeliveryId: string;
  readonly sessionId: string;
  readonly raw: unknown;
};

export type NativeRunnerLifecycle = {
  compacted?(requestId: string, messages: readonly ModelMessage[]): void;
  waiting?(request: Pick<NativeRunnerRequest, "requestId" | "raw">, waiting: boolean): void;
  rejected?(requestDeliveryId: string): Promise<ResultType<void, Error>>;
  validate(request: NativeRunnerRequest): ResultType<
    {
      readonly safetyMode: SessionSafetyMode;
      readonly resolvedModelRequest?: DurableResolvedModelRequest;
      readonly historyProviderState?: HistoryProviderState;
    },
    Error
  >;
  settled(
    request: NativeRunnerRequest,
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<ResultType<void, Error>>;
};

export type BusAgentRunnerRequestDelivery = Pick<
  RequestDeliveryCoordinator<
    CorePreparedRequestEnvelope,
    CoreAcceptedRequestWork,
    CoreRequestOutputMetadata
  >,
  "handleDelivery" | "replaceAcceptedWork" | "terminalize"
>;

const AGENT_TIMEOUT_ABORT_GRACE_MS = 5_000;
const TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS = 4_000;
const SHUTDOWN_ABORT_GRACE_MS = 500;
const COMPACTED_TOOL_CALL_SESSION_LIMIT = 1_000;
const LIVE_PARENT_RECONCILE_MS = 1_000;
const SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS = 3;
export const WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS = 10_000;

export function buildPersistedHeartbeatMessages(finalText: string): StoredMessageV1[] {
  return [{ role: "assistant", content: finalText }];
}

function toolCallIdsFromMessages(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") ids.add(part.toolCallId);
    }
  }
  return ids;
}

export class AgentRunModelSelectionInvalid extends TaggedError("AgentRunModelSelectionInvalid")<{
  readonly reason: "alias-not-selectable" | "alias-required";
  readonly modelOverride: string;
  readonly message: string;
}> {}

export class SubagentPermissionProfileNotConfigured extends TaggedError(
  "SubagentPermissionProfileNotConfigured",
)<{
  readonly profile: string;
  readonly message: string;
}> {}

type AgentRunModelResolutionError =
  | AgentRunModelSelectionInvalid
  | SubagentPermissionProfileNotConfigured
  | ModelResolutionFailed;

export function resolveAgentRunModelResult(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: DurableResolvedModelRequest;
}): ResultType<ResolvedModelPlan, AgentRunModelResolutionError> {
  if (params.resolvedModelRequest) {
    const plan = fromDurableResolvedModelPlanResult(params.resolvedModelRequest);
    return plan.map((value) =>
      params.reasoningOverride ? withModelPlanReasoning(value, params.reasoningOverride) : value,
    );
  }

  if (
    params.runProfile !== "primary" &&
    resolveSubagentPermissionProfileName(params.cfg, params.runProfile) === undefined
  ) {
    return Result.err(
      new SubagentPermissionProfileNotConfigured({
        profile: params.runProfile,
        message: `Subagent permission profile '${params.runProfile}' is not configured`,
      }),
    );
  }

  if (
    params.cfg.configVersion === 3 &&
    params.runProfile !== "primary" &&
    params.requestModelOverride &&
    !findCatalogModel(params.cfg, params.requestModelOverride)
  )
    return Result.err(
      new AgentRunModelSelectionInvalid({
        reason: "alias-required",
        modelOverride: params.requestModelOverride,
        message: "Selected model is unavailable in the configured catalog",
      }),
    );
  if (
    params.cfg.configVersion !== 3 &&
    params.runProfile !== "primary" &&
    params.requestModelOverride
  ) {
    const selectedPreset = params.cfg.models.def[params.requestModelOverride];
    if (!selectedPreset || params.requestModelOverride.includes("/")) {
      return Result.err(
        new AgentRunModelSelectionInvalid({
          reason: "alias-required",
          modelOverride: params.requestModelOverride,
          message: `Subagent model override must be a models.def alias (got '${params.requestModelOverride}')`,
        }),
      );
    }
    if (selectedPreset.agentCanSelect !== true) {
      return Result.err(
        new AgentRunModelSelectionInvalid({
          reason: "alias-not-selectable",
          modelOverride: params.requestModelOverride,
          message: `Subagent model alias '${params.requestModelOverride}' is not available for agent selection`,
        }),
      );
    }
  }

  const applyHeadReasoning = (head: ResolvedModelRef): ResolvedModelRef =>
    params.reasoningOverride ? { ...head, reasoning: params.reasoningOverride } : head;

  const resolved = params.requestModelOverride
    ? resolveModelPlanResult(params.cfg, {
        head: { model: params.requestModelOverride },
        fallback: [],
        headSource: "cmd.request.message.modelOverride",
        fallbackSource: "cmd.request.message.modelOverride.fallback",
      })
    : resolveModelPlanResult(params.cfg, {
        head: params.cfg.models.main,
        fallback: [],
        headSource: "models.main.model",
        fallbackSource: "models.main.fallback",
      });
  const fallbacks = resolveAgentRunModelFallbacksResult(params);
  return Result.all([resolved, fallbacks]).map(([plan, fallbackValues]) => ({
    head: applyHeadReasoning(plan.head),
    fallbacks: fallbackValues,
  }));
}

export function resolveAgentRunModel(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: DurableResolvedModelRequest;
}): ResolvedModelPlan {
  const resolved = resolveAgentRunModelResult(params);
  return resolved.match({
    ok: (value) => () => value,
    err: (error) => () => signalBusAgentRunnerHostFailure(error),
  })();
}

type AgentRunFallbackSource = {
  entries: readonly ConfiguredModelChainEntry[];
  source: string;
};

function resolveAgentRunFallbackSource(params: {
  cfg: CoreConfig;
  requestModelOverride?: string;
}): AgentRunFallbackSource | null {
  if (params.requestModelOverride) {
    if (params.requestModelOverride.includes("/")) {
      return {
        entries: [],
        source: "cmd.request.message.modelOverride.fallback",
      };
    }
    const preset = params.cfg.models.def[params.requestModelOverride];
    if (!preset) return null;
    return {
      entries: preset.fallback ?? [],
      source: `models.def.${params.requestModelOverride}.fallback`,
    };
  }

  const slotConfig = params.cfg.models.main;
  if (slotConfig.fallback !== undefined) {
    return { entries: slotConfig.fallback, source: "models.main.fallback" };
  }
  const preset = slotConfig.model.includes("/")
    ? undefined
    : params.cfg.models.def[slotConfig.model];
  if (!slotConfig.model.includes("/") && !preset) return null;
  return {
    entries: preset?.fallback ?? [],
    source: `models.def.${slotConfig.model}.fallback`,
  };
}

export function resolveAgentRunModelFallbacksResult(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
}): ResultType<readonly ResolvedModelRef[], ModelResolutionFailed> {
  const fallbackSource = resolveAgentRunFallbackSource(params);
  if (!fallbackSource) return Result.ok([]);
  const resolved = resolveModelChainResult(
    params.cfg,
    fallbackSource.entries,
    fallbackSource.source,
  );
  return resolved.map((fallbacks) =>
    params.reasoningOverride
      ? fallbacks.map((fallback) => ({
          ...fallback,
          reasoning: params.reasoningOverride,
        }))
      : fallbacks,
  );
}

export function resolveAgentRunModelFallbacks(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
}): readonly ResolvedModelRef[] {
  return adaptModelResolutionToBusRunnerHost(resolveAgentRunModelFallbacksResult(params));
}

export { selectNextNativeModelFallback } from "../../agent/agent-composition";

export class WorkflowDispatchPolicyMismatch extends TaggedError("WorkflowDispatchPolicyMismatch")<{
  readonly field: "profile" | "reasoning";
  readonly message: string;
}> {}

export function assertWorkflowDispatchPolicy(
  workflowPolicy: WorkflowRequestPolicy,
  subagentMeta: ParsedSubagentMeta,
): ResultType<void, WorkflowDispatchPolicyMismatch> {
  if (workflowPolicy.profile !== subagentMeta.profile) {
    return Result.err(
      new WorkflowDispatchPolicyMismatch({
        field: "profile",
        message: "Workflow request profile envelope does not match the runner profile",
      }),
    );
  }
  if ((workflowPolicy.reasoning ?? null) !== (subagentMeta.reasoning ?? null)) {
    return Result.err(
      new WorkflowDispatchPolicyMismatch({
        field: "reasoning",
        message: "Workflow request reasoning does not match the approved operation policy",
      }),
    );
  }
  return Result.ok(undefined);
}

type Level1ToolAuthorityTarget = Pick<AiSdkPiAgent<ToolSet>, "setTools" | "setActiveTools">;

export function selectedLevel1ToolNames(
  toolset: BuiltLevel1Toolset,
  selectedCatalogIds: readonly string[],
): ReadonlySet<string> {
  const selected = new Set(selectedCatalogIds);
  const active = new Set(toolset.directToolNames);
  for (const entry of toolset.catalog) {
    if (selected.has(entry.stableId)) active.add(entry.modelName);
  }
  return active;
}

export function shouldLogLevel1ToolCompletionAtInfo(
  toolName: string,
  catalog: BuiltLevel1Toolset["catalog"],
): boolean {
  return (
    toolName === "find_tools" ||
    catalog.some((entry) => entry.source === "mcp" && entry.modelName === toolName)
  );
}

export async function refreshSelectedLevel1Tools(params: {
  target: Pick<Level1ToolAuthorityTarget, "setActiveTools">;
  toolset: BuiltLevel1Toolset;
  listSelectedCatalogIds: () => readonly string[];
}): Promise<BuiltLevel1Toolset> {
  const toolset = params.toolset;
  const activeToolNames = selectedLevel1ToolNames(toolset, params.listSelectedCatalogIds());
  params.target.setActiveTools(activeToolNames);
  return toolset;
}

export { applyCompleteLevel1Tools } from "../../agent/claude-composition";

export { completeLevel1ToolMapping } from "../../agent/claude-composition";

export function isActiveRuntimeModelCompatible(input: {
  readonly activeSpec: string;
  readonly activeReasoning: ModelReasoningEffort | undefined;
  readonly activeFamily: HistoryProviderState["lastFamily"];
  readonly requested: ResolvedModelRef;
}): boolean {
  return (
    input.activeSpec === input.requested.spec &&
    input.activeReasoning === input.requested.reasoning &&
    input.activeFamily === classifyHistoryProviderFamily({ type: input.requested.provider })
  );
}

export function shouldQueueIncompatibleActiveRuntimeModel(input: {
  readonly activeSpec: string;
  readonly activeReasoning: ModelReasoningEffort | undefined;
  readonly activeFamily: HistoryProviderState["lastFamily"];
  readonly requested: ResolvedModelRef;
}): boolean {
  return !isActiveRuntimeModelCompatible(input);
}

export function deriveModelChangingRequestId(input: {
  readonly requestId: string;
  readonly authenticatedOrigin?: AuthenticatedSurfaceOrigin;
}): string {
  const messageRef = input.authenticatedOrigin?.messageRef;
  if (messageRef) {
    return `${messageRef.platform}:${messageRef.channelId}:${messageRef.messageId}`;
  }
  return `${input.requestId}:model-turn:${crypto.randomUUID()}`;
}

function projectDurableWorkflowRequestIdentity(input: {
  readonly projection: AuthenticatedRequestProjection;
  readonly raw: AgentRunnerRaw | undefined;
  readonly store?: DurableWorkflowStore;
}): AuthenticatedRequestProjection {
  if (input.projection.requestClient !== "unknown" || !input.store) return input.projection;
  const hint = parseWorkflowRequestHintFromRaw(input.raw);
  if (!hint) return input.projection;
  const authorized = input.store.authorizeWorkflowRequest({
    requestId: input.projection.requestId,
    sessionId: input.projection.sessionId,
    platform: input.projection.requestClient,
  });
  if (
    !authorized ||
    authorized.policy.runId !== hint.runId ||
    authorized.policy.operationId !== hint.operationId ||
    authorized.policy.dispatchEpoch !== hint.dispatchEpoch
  ) {
    return input.projection;
  }
  const origin = authorized.policy.originSession;
  const authenticatedOrigin = projectAuthorizedWorkflowOrigin(origin);
  return {
    ...input.projection,
    source: "internal-delegated",
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind: authenticatedOrigin ? "origin" : "absent",
    verifiedIngress: false,
  };
}

function projectAuthorizedWorkflowOrigin(origin: {
  readonly client: AdapterPlatform | null;
  readonly sessionId: string | null;
  readonly userId: string | null;
}): AuthenticatedSurfaceOrigin | undefined {
  if (!origin.client || !origin.sessionId || !origin.userId) return undefined;
  const protocol = getBuiltinSurfaceProtocol(origin.client);
  if (!protocol) return undefined;
  return {
    platform: protocol.platform,
    userId: origin.userId,
    sessionRef: protocol.refs.createSessionRef(origin.sessionId),
  } as AuthenticatedSurfaceOrigin;
}

export type AgentRunnerActiveWork = {
  requestId: string;
  requestClient: AdapterPlatform;
  runProfile: AgentRunProfile;
  phase: "preparing" | "model" | "tool";
  runAgeMs: number;
  tools: readonly {
    toolCallId: string;
    toolName: string;
    ageMs: number;
  }[];
};

export { formatClaudeLifecycleLogFields } from "../../agent/claude-composition";

export function formatBusAgentRunnerDrainFailureForLog(
  error: unknown,
  context: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  return formatBridgeTaggedErrorForLog(error, context, {
    errorTag: "BusAgentRunnerDrainFailed",
    errorMessage: "Agent runner session queue drain failed",
  });
}

export async function startBusAgentRunner(params: {
  questions?: QuestionService;
  jobs?: JobService;
  bus: LilacBus;
  blobStore: AnthropicFallbackBlobStore;
  resourceAccess?: Pick<ResourceAccess, "describe" | "open">;
  requestDelivery?: BusAgentRunnerRequestDelivery;
  onRequestSettled?: (requestDeliveryId: string) => void;
  createNativeOutput?: (input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly requestClient: AdapterPlatform;
    readonly raw: AgentRunnerRaw | undefined;
    readonly recovering: boolean;
    readonly recoveryOutputFrontier?: NativeOutputFrontier;
    readonly workflowRunId?: string;
    readonly prompt: string;
  }) => NativeOutputPublisher | undefined;
  nativeExecution?: NativeRunnerLifecycle;
  nativeResourceAccess?: (
    request: NativeRunnerRequest,
  ) => Pick<ResourceAccess, "describe" | "open">;
  nativeConversationThreads?: (request: NativeRunnerRequest) => ConversationThreadToolService;
  agentRunJournal?: Pick<
    AgentRunJournal,
    "openRun" | "writeCheckpoint" | "markTerminal" | "resetRun" | "removeReconciled"
  > &
    Partial<Pick<AgentRunJournal, "promotePreviousCheckpoint">>;
  subscriptionId: string;
  config?: CoreConfig;
  pluginManager: CoreToolPluginManager;
  customCommands?: CustomCommandManager;
  conversationThreads?: ConversationThreadToolService;
  /** Where core tools operate (fs tool root). */
  cwd?: string;
  transcriptStore?: TranscriptStore;
  toolResultArtifacts?: ToolResultArtifactStore;
  workflowLiveParentBridge?: WorkflowLiveParentBridge;
  workflowSubagentDispatcher?: WorkflowSubagentDispatcher;
  durableWorkflowStore?: DurableWorkflowStore;
  projectAuthenticatedRequest?: (
    message: Extract<
      DecodedLilacMessageForTopic<"cmd.request">,
      { type: typeof lilacEventTypes.CmdRequestMessage }
    >,
  ) => ResultType<
    AuthenticatedRequestProjection | undefined,
    AuthenticatedRequestProjectionInvalid
  >;
  requestMessageCache?: RequestMessageCache;
  surfaceProtocolResolver?: SurfaceProtocolResolver;
  startPaused?: boolean;
  beforeRequestIntake?: (
    message: DecodedLilacMessageForTopic<"cmd.request">,
  ) => void | Promise<void>;
  /** Resolve trusted stored Discord hierarchy for config inheritance and safety policy. */
  resolveDiscordSessionContext?: (sessionId: string) =>
    | {
        parentChannelId: string | null;
        guildId: string | null;
      }
    | undefined;
  issueControlCapability?: (input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    profile: AgentRunProfile;
    canonicalCwd: string;
    safetyMode: SessionSafetyMode;
    expiresAt: number;
    authenticatedOrigin?: AuthenticatedSurfaceOrigin;
    verifiedIngress?: boolean;
  }) =>
    | {
        capability: string;
        principal: SurfacePrincipal | null;
        authenticatedOrigin?: AuthenticatedSurfaceOrigin | null;
        safetyMode?: SessionSafetyMode;
      }
    | Promise<{
        capability: string;
        principal: SurfacePrincipal | null;
        authenticatedOrigin?: AuthenticatedSurfaceOrigin | null;
        safetyMode?: SessionSafetyMode;
      }>;
  issueHeartbeatCapability?: (input: {
    profile: AgentRunProfile;
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    canonicalCwd: string;
    expiresAt: number;
  }) => string | Promise<string>;
  expireControlCapability?: (requestId: string) => void;
  /** Injection seam for exercising the complete bus runner with deterministic model transports. */
  createAgent?: (options: AiSdkPiAgentOptions<ToolSet>) => AiSdkPiAgent<ToolSet>;
  /** Injection seam for deterministic Claude native lifecycle/observation coverage. */
  materializeClaudeCodeRun?: (
    options: Parameters<typeof materializeClaudeCodeRunResult>[0],
  ) => Promise<MaterializedClaudeCodeRun>;
  reportFatalPanic: (panic: Panic) => void;
}) {
  const { bus, subscriptionId } = params;

  const logger = createLogger({
    module: "bus-agent-runner",
  });
  const storedMessageIdentity = createStoredMessageIdentityProjectionV1();

  let cfg = params.config ?? (await getCoreConfig());
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    const loaded = await captureBusAgentRunnerOperation("core config reload", getCoreConfig);
    const applyLoadedConfig = loaded.match<() => void>({
      err: (loadError) => () => {
        const message = loadError.message;
        if (!coreConfigReloadHadError || lastCoreConfigReloadError !== message) {
          logger.warn(
            "core-config reload failed; using last known config",
            formatBridgeTaggedErrorForLog(loadError, {
              path: "core-config.yaml",
            }),
          );
        }
        coreConfigReloadHadError = true;
        lastCoreConfigReloadError = message;
      },
      ok: (loadedConfig) => () => {
        cfg = loadedConfig;
        if (coreConfigReloadHadError) {
          logger.info("core-config reload recovered", {
            path: "core-config.yaml",
          });
        }
        coreConfigReloadHadError = false;
        lastCoreConfigReloadError = null;
      },
    });
    applyLoadedConfig();
  }
  const cwd = params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();
  const workflowRunnerOwnerId = `agent-runner:${process.pid}:${crypto.randomUUID()}`;

  const bySession = new Map<string, SessionQueue>();
  const compactedToolCallIdsBySession = new Map<string, Set<string>>();
  const sessionControlOperations = new Map<string, Promise<void>>();
  const nativeBlockedSessions = new Set<string>();
  // Only drains that dequeued work are tracked; a run's drain stays tracked until it settles.
  const sessionDrainOperations = new Map<string, Set<Promise<void>>>();
  const allSessionDrainOperations = (): Promise<void>[] =>
    [...sessionDrainOperations.values()].flatMap((operations) => [...operations]);
  const cancelledByRequestId = new Set<string>();
  const reservedQueueEntries = new Set<Enqueued>();
  const queueLifecycleAttempts = new Map<string, QueueLifecycleAttempt>();
  const shutdownAbortRequestIds = new Set<string>();
  const requestMessageCache = params.requestMessageCache ?? createRequestMessageCache();
  let draining = false;
  let terminalPanic: Panic | null = null;
  let terminalPanicReported = false;
  let terminalCleanupOperations: readonly BusAgentRunnerTerminalCleanupOperation[] = [];
  let terminalCleanupCompletion: Promise<void> | null = null;
  let runnerActivated = params.startPaused !== true;
  let runnerAdmissionStopped = false;
  let resolveRunnerAdmission: ((outcome: "active" | "stopped") => void) | null = null;
  const runnerActivation = runnerActivated
    ? Promise.resolve("active" as const)
    : new Promise<"active" | "stopped">((resolve) => {
        resolveRunnerAdmission = resolve;
      });
  const activateRunnerAdmission = (): void => {
    if (runnerActivated || runnerAdmissionStopped) return;
    runnerActivated = true;
    resolveRunnerAdmission?.("active");
    resolveRunnerAdmission = null;
  };
  const stopRunnerAdmission = (): void => {
    if (runnerActivated || runnerAdmissionStopped) return;
    runnerAdmissionStopped = true;
    resolveRunnerAdmission?.("stopped");
    resolveRunnerAdmission = null;
  };
  const reportFatalPanic = (panic: Panic): void => {
    terminalPanic ??= panic;
    if (terminalPanicReported) return;
    terminalPanicReported = true;
    params.reportFatalPanic(panic);
  };

  const runCheckpointWriter = createRunCheckpointWriter({
    params,
    logger,
    bySession,
    reportFatalPanic,
  });
  const {
    releaseRunCheckpointBlobs,
    openRunJournal,
    enqueueRunCheckpoint,
    flushRunCheckpointWriter,
    stopRunCheckpointWriters,
    materializePreviousRunCheckpoint,
    installPreviousRunCheckpoint,
    fallBackRunCheckpointToAcceptedWork,
    markRunTerminal,
  } = runCheckpointWriter;

  async function resumeQueueLifecycleAttempt(
    attempt: QueueLifecycleAttempt,
    state: SessionQueue,
  ): Promise<void> {
    if (attempt.kind === "buffered-absorption" && !attempt.controlApplied) {
      return signalBusAgentRunnerHostFailure(
        new Error("Buffered absorption publication resumed before control application"),
      );
    }
    while (attempt.pendingGroups.length > 0) {
      const group = attempt.pendingGroups[0]!;
      await publishLifecycle({
        bus,
        headers: {
          request_id: group.requestId,
          session_id: attempt.sessionId,
          request_client: group.requestClient,
        },
        state: "cancelled",
        detail: attempt.detail,
      });
      if (params.requestDelivery) {
        for (const queued of group.entries) {
          if (!queued.requestDeliveryId) continue;
          const terminalized = await params.requestDelivery.terminalize({
            requestDeliveryId: queued.requestDeliveryId,
            outcome: {
              kind: "cancelled",
              code:
                attempt.kind === "buffered-absorption"
                  ? "absorbed-into-active-control"
                  : "cancelled-while-queued",
            },
            transportCommitRequired: true,
          });
          terminalized.match({
            ok: () => undefined,
            err: (error) => signalBusAgentRunnerHostFailure(error),
          });
        }
      }
      removeQueuedEntriesByReference(state.queue, group.entries);
      for (const queued of group.entries) {
        reservedQueueEntries.delete(queued);
        if (queued.identityOwner) requestMessageCache.releaseOwner(queued.identityOwner);
      }
      attempt.pendingGroups.shift();
    }
    queueLifecycleAttempts.delete(attempt.eventId);
    if (!state.running) startSessionQueueDrain(attempt.sessionId, state);
  }

  function abandonQueueLifecycleAttempt(eventId: string): void {
    const attempt = queueLifecycleAttempts.get(eventId);
    if (!attempt) return;
    for (const group of attempt.pendingGroups) {
      for (const queued of group.entries) reservedQueueEntries.delete(queued);
    }
    queueLifecycleAttempts.delete(eventId);
    const state = bySession.get(attempt.sessionId);
    if (state && !state.running) startSessionQueueDrain(attempt.sessionId, state);
  }

  function createSessionQueue(sessionId: string): SessionQueue {
    return {
      running: false,
      agent: null,
      queue: [],
      activeRequestId: null,
      activeRun: null,
      compactedToolCallIds: compactedToolCallIdsFor(sessionId),
    };
  }

  /**
   * Compaction choices outlive session eviction so pruning keeps batching by `minimumTokens`
   * instead of re-pruning every run; the least recently used sessions are forgotten past the cap.
   */
  function compactedToolCallIdsFor(sessionId: string): Set<string> {
    const existing = compactedToolCallIdsBySession.get(sessionId) ?? new Set<string>();
    compactedToolCallIdsBySession.delete(sessionId);
    compactedToolCallIdsBySession.set(sessionId, existing);
    const oldest = compactedToolCallIdsBySession.keys().next().value;
    if (compactedToolCallIdsBySession.size > COMPACTED_TOOL_CALL_SESSION_LIMIT && oldest) {
      compactedToolCallIdsBySession.delete(oldest);
    }
    return existing;
  }

  /** Drops a session's in-memory state once it has no run, queued work, or pending control. */
  function evictIdleSession(sessionId: string | undefined): void {
    if (!sessionId || sessionControlOperations.has(sessionId)) return;
    const state = bySession.get(sessionId);
    if (!state || state.running || state.activeRun || state.agent || state.queue.length > 0) {
      return;
    }
    bySession.delete(sessionId);
  }

  /** Runs control settlement for one session in arrival order, off the shared bus handler. */
  function enqueueSessionControl(sessionId: string, operation: () => Promise<void>): void {
    const settled = settleSessionControl(sessionControlOperations.get(sessionId), operation);
    sessionControlOperations.set(sessionId, settled);
    const forget = (): void => {
      if (sessionControlOperations.get(sessionId) !== settled) return;
      sessionControlOperations.delete(sessionId);
      evictIdleSession(sessionId);
    };
    void ignoreDetachedFailure(settled).then(forget);
  }

  async function settleSessionControl(
    previous: Promise<void> | undefined,
    operation: () => Promise<void>,
  ): Promise<void> {
    // Start at once when nothing is pending so the control reaches the agent in the same tick.
    if (previous) await ignoreDetachedFailure(previous);
    const applied = await Result.tryPromise({ try: operation, catch: captureError });
    applied.match({
      ok: () => undefined,
      err: ({ cause }) => superviseAgentRunnerBackgroundFailure(cause),
    });
  }

  function startSessionQueueDrain(
    sessionId: string,
    state: SessionQueue,
    requestId?: string,
  ): void {
    const superviseDetachedDrain = <ErrorCause>(error: ErrorCause): void => {
      rethrowBusAgentRunnerPanic(error, reportFatalPanic);
      logger.error(
        "drainSessionQueue failed",
        formatBusAgentRunnerDrainFailureForLog(error, { sessionId, requestId }),
      );
    };
    if (nativeBlockedSessions.has(sessionId)) return;
    const dequeues = nextDequeueableEntry(state) !== undefined;
    const operation = superviseDrain();
    void ignoreDetachedFailure(operation);
    if (!dequeues) {
      evictIdleSession(sessionId);
      return;
    }
    const operations = sessionDrainOperations.get(sessionId) ?? new Set<Promise<void>>();
    operations.add(operation);
    sessionDrainOperations.set(sessionId, operations);
    const forget = (): void => {
      operations.delete(operation);
      if (operations.size === 0 && sessionDrainOperations.get(sessionId) === operations) {
        sessionDrainOperations.delete(sessionId);
      }
    };
    void ignoreDetachedFailure(operation).then(forget);

    async function superviseDrain(): Promise<void> {
      const drained = await Result.tryPromise({
        try: () => drainSessionQueue(sessionId, state),
        catch: captureError,
      });
      const failure = drained.match({
        ok: () => null,
        err: ({ cause }) => ({ cause }),
      });
      if (failure) superviseDetachedDrain(failure.cause);
    }
  }

  type CmdRequestMessage = Extract<
    DecodedLilacMessageForTopic<"cmd.request">,
    { type: typeof lilacEventTypes.CmdRequestMessage }
  >;

  async function handleCmdRequestMessage(
    msg: CmdRequestMessage,
  ): Promise<ResultType<void, BusAgentRunnerDeliveryError>> {
    const runnerReceivedAt = Date.now();
    let requestId = msg.headers?.request_id;
    let sessionId = msg.headers?.session_id;
    let requestClient = msg.headers?.request_client ?? "unknown";
    if (requestId && requestClient === "discord") {
      recordRequestLatencyStage(requestId, "requestPublishedAt", msg.ts);
      recordRequestLatencyStage(requestId, "runnerReceivedAt", runnerReceivedAt);
    }

    if ((await runnerActivation) === "stopped") {
      return Result.err(
        new BusAgentRunnerRecoveryStopped({
          message: "Paused agent recovery stopped before delivery activation",
        }),
      );
    }
    const pendingAttempt = queueLifecycleAttempts.get(msg.id);
    if (
      pendingAttempt &&
      (requestId !== pendingAttempt.controlRequestId ||
        sessionId !== pendingAttempt.sessionId ||
        requestClient !== pendingAttempt.controlRequestClient)
    ) {
      return Result.err(
        new BusAgentRunnerQueueAttemptRouteInvalid({
          eventId: msg.id,
          message: "Redelivered queue control route conflicts with persisted delivery ownership",
        }),
      );
    }
    if (!requestId || !sessionId) {
      const missing: ("request_id" | "session_id")[] = [];
      if (!requestId) missing.push("request_id");
      if (!sessionId) missing.push("session_id");
      return Result.err(
        new BusAgentRunnerRequestHeadersInvalid({
          missing,
          message: "cmd.request.message missing required request/session headers",
        }),
      );
    }

    if (requestClient === "native") {
      const validated = validateNativeRequest({
        requestId,
        requestDeliveryId: msg.data.requestDeliveryId,
        sessionId,
        raw: preserveAgentRunnerRaw(msg),
      });
      const rejection = validated.match({ ok: () => null, err: (error) => error });
      if (rejection) return rejectNativeDelivery(msg.data.requestDeliveryId, rejection);
    }

    const requestDelivery = params.requestDelivery;
    const acceptedDelivery = requestDelivery
      ? await captureBusAgentRunnerOperation("durable request delivery admission", () =>
          requestDelivery.handleDelivery(msg.data.requestDeliveryId),
        )
      : null;
    type DurableAdmissionDecision =
      | {
          readonly disposition: "accepted";
          readonly record: AcceptedRequestDelivery<CoreAcceptedRequestWork>;
        }
      | { readonly disposition: "owned-commit" }
      | { readonly disposition: "park"; readonly error: Error };
    const acceptedDecision = acceptedDelivery?.match<DurableAdmissionDecision>({
      ok: (delivery) =>
        delivery.match<DurableAdmissionDecision>({
          ok: (outcome) => {
            if (outcome.disposition === "accepted") return outcome;
            if (outcome.disposition === "commit") return { disposition: "owned-commit" };
            return outcome;
          },
          err: (error) => ({
            disposition: "park",
            error: captureError(error, "Durable request delivery handler failed").cause,
          }),
        }),
      err: (error) => ({ disposition: "park", error }),
    });
    if (acceptedDecision?.disposition === "owned-commit") return Result.ok(undefined);
    if (acceptedDecision?.disposition === "park") {
      return Result.err(
        new BusAgentRunnerIntakeFailed({
          cause: acceptedDecision.error,
          message: "Durable request delivery admission is pending",
        }),
      );
    }
    const acceptedRecord = acceptedDecision?.record ?? null;
    const reconcileAcceptedProjectionFailure = async (
      error: BusAgentRunnerDeliveryError,
    ): Promise<ResultType<void, BusAgentRunnerDeliveryError>> => {
      if (!acceptedRecord) return Result.err(error);
      const resumed = await resumeAcceptedDelivery(acceptedRecord);
      return resumed.match<() => ResultType<void, BusAgentRunnerDeliveryError>>({
        ok: () => () => Result.ok(undefined),
        err: (cause) => () =>
          Result.err(
            new BusAgentRunnerIntakeFailed({
              cause,
              message: "Accepted durable work could not enter the recovery queue",
            }),
          ),
      })();
    };
    const intakeMessage: CmdRequestMessage = msg;
    if (!requestId || !sessionId) {
      return Result.err(
        new BusAgentRunnerRequestHeadersInvalid({
          missing: [
            ...(!requestId ? ["request_id" as const] : []),
            ...(!sessionId ? ["session_id" as const] : []),
          ],
          message: "Accepted request delivery is missing durable request/session identity",
        }),
      );
    }
    const storedMessages = acceptedRecord
      ? [...acceptedRecord.work.data.messages]
      : projectStoredMessagesV1(msg.data.messages).match({
          ok: (messages) => messages,
          err: () => null,
        });
    if (storedMessages === null) {
      return Result.err(
        new BusAgentRunnerIntakeFailed({
          cause: new Error("Request messages are not durable stored messages"),
          message: "cmd.request.message durable projection failed",
        }),
      );
    }
    const materializedMessages = await materializeStoredMessagesV1({
      messages: storedMessages,
      blobStore: params.blobStore,
      identityProjection: storedMessageIdentity,
    });
    const messageMaterializationError = materializedMessages.match({
      ok: () => null,
      err: (error) => error,
    });
    if (messageMaterializationError) {
      return reconcileAcceptedProjectionFailure(
        new BusAgentRunnerIntakeFailed({
          cause: messageMaterializationError,
          message: "Durable request message materialization failed",
        }),
      );
    }
    const messages = materializedMessages.match({
      ok: (value) => value,
      err: () => [],
    });
    const deliveryData = acceptedRecord?.work.data ?? msg.data;

    const projectedRequest = (params.projectAuthenticatedRequest ?? projectAuthenticatedRequest)(
      intakeMessage,
    );
    let projectionFailure: BusAgentRunnerAuthenticationProjectionInvalid | null = null;
    const selectRequestProjection = projectedRequest.match<
      () => AuthenticatedRequestProjection | undefined
    >({
      err: (error) => () => {
        projectionFailure = new BusAgentRunnerAuthenticationProjectionInvalid({
          cause: error,
          message: "cmd.request.message authentication projection is invalid",
        });
        return undefined;
      },
      ok: (projection) => () => projection,
    });
    const requestProjection = selectRequestProjection();
    if (projectionFailure) {
      return reconcileAcceptedProjectionFailure(projectionFailure);
    }
    if (!requestProjection) {
      if (acceptedRecord) {
        return reconcileAcceptedProjectionFailure(
          new BusAgentRunnerIntakeFailed({
            cause: new Error("Accepted request has no authenticated runtime projection"),
            message: "Accepted durable work must enter restricted recovery",
          }),
        );
      }
      return Result.ok(undefined);
    }
    const raw = preserveAgentRunnerRaw({ data: deliveryData });
    let cacheAdmitted = false;
    let identityError:
      | RequestIdentitySourceMissing
      | RequestIdentityAliasTargetOccupied
      | AuthenticatedRequestProjectionInvalid
      | undefined;
    let intakeError: BusAgentRunnerOperationFailed | undefined;
    let parkPending = false;
    const intakeResult: ResultType<void, BusAgentRunnerDeliveryError> = await (async (): Promise<
      ResultType<void, BusAgentRunnerDeliveryError>
    > => {
      const attempted = await Result.tryPromise({
        try: async () => {
          const cachedExternal = requestMessageCache.cacheMessage(intakeMessage, requestProjection);
          let cachedExternalError: RequestMessageCacheAdmissionError | null = null;
          const selectExternalProjection = cachedExternal.match<
            () => AuthenticatedRequestProjection | undefined
          >({
            err: (error) => () => {
              cachedExternalError = error;
              return undefined;
            },
            ok: (projection) => () => projection,
          });
          const externalProjection = selectExternalProjection();
          if (cachedExternalError) {
            return {
              status: "return",
              value: Result.err(
                new BusAgentRunnerAuthenticationProjectionInvalid({
                  cause: cachedExternalError,
                  message: "cmd.request.message cache admission is invalid",
                }),
              ),
            } as const;
          }
          if (!externalProjection)
            return { status: "return", value: Result.ok(undefined) } as const;
          cacheAdmitted = true;
          const trustedProjection = projectDurableWorkflowRequestIdentity({
            projection: requestProjection,
            raw,
            store: params.durableWorkflowStore,
          });
          const cachedTrusted = requestMessageCache.cacheMessage(intakeMessage, trustedProjection);
          let cachedTrustedError: RequestMessageCacheAdmissionError | null = null;
          const selectAuthenticatedRequest = cachedTrusted.match<
            () => AuthenticatedRequestProjection | undefined
          >({
            err: (error) => () => {
              cachedTrustedError = error;
              return undefined;
            },
            ok: (projection) => () => projection ?? externalProjection,
          });
          const authenticatedRequest = selectAuthenticatedRequest();
          if (cachedTrustedError) {
            return {
              status: "return",
              value: Result.err(
                new BusAgentRunnerAuthenticationProjectionInvalid({
                  cause: cachedTrustedError,
                  message: "cmd.request.message trusted cache admission is invalid",
                }),
              ),
            } as const;
          }
          if (!authenticatedRequest)
            return { status: "return", value: Result.ok(undefined) } as const;
          await (async () => {
            rethrowBusAgentRunnerPanic(terminalPanic);
            await params.beforeRequestIntake?.(intakeMessage);

            if (env.perf.log) {
              const lagMs = Date.now() - msg.ts;
              const shouldWarn = lagMs >= env.perf.lagWarnMs;
              const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
              if (shouldWarn || shouldSample) {
                if (shouldWarn) {
                  logger.warn(
                    "perf.bus_lag",
                    formatBridgeLogContext({
                      stage: "cmd.request->agent_runner",
                      lagMs,
                      requestId,
                      sessionId,
                      requestClient,
                      queue: deliveryData.queue,
                    }),
                  );
                } else {
                  logger.info(
                    "perf.bus_lag",
                    formatBridgeLogContext({
                      stage: "cmd.request->agent_runner",
                      lagMs,
                      requestId,
                      sessionId,
                      requestClient,
                      queue: deliveryData.queue,
                    }),
                  );
                }
              }
            }

            logger.debug(
              "cmd.request.message received",
              formatBridgeLogContext({
                requestId,
                sessionId,
                requestClient,
                queue: deliveryData.queue,
                runPolicy: deliveryData.runPolicy ?? "normal",
                originKind: deliveryData.origin?.kind,
                modelOverride: deliveryData.modelOverride,
                messageCount: storedMessages.length,
              }),
            );

            // reload config opportunistically (mtime cached in getCoreConfig).
            // If reload fails, keep using the last known good config.
            await reloadCoreConfigIfNeeded();

            const intakeRunProfile = parseSubagentMetaFromRaw(raw).profile;
            if (intakeRunProfile === "primary" && !isJobWakeRequestRaw(raw)) {
              params.jobs?.noteUserInput(sessionId);
            }
            const entry: Enqueued = {
              queueEntryId: msg.id,
              ...(acceptedRecord ? { requestDeliveryId: acceptedRecord.requestDeliveryId } : {}),
              requestId,
              sessionId,
              requestClient,
              queue: deliveryData.queue,
              runPolicy: deliveryData.runPolicy ?? "normal",
              origin: deliveryData.origin,
              messages,
              storedMessages,
              corePrimaryLineage:
                acceptedRecord?.work.data.corePrimaryLineage ??
                validateCorePrimaryLineageAtRunnerIntake({
                  requestClient,
                  sessionId,
                  runProfile: intakeRunProfile,
                  messages,
                  corePrimaryLineage: deliveryData.corePrimaryLineage,
                  transcriptStore: params.transcriptStore,
                }),
              modelOverride: deliveryData.modelOverride,
              raw,
              authenticatedOrigin: authenticatedRequest?.authenticatedOrigin,
              currentTurnUserId: trustedProjection.authenticatedOrigin?.userId,
              currentTurnMessageRef: trustedProjection.authenticatedOrigin?.messageRef,
              verifiedIngress: authenticatedRequest?.verifiedIngress,
              ...(requestClient === "native"
                ? {
                    restoredSafetyMode: validateNativeRequest({
                      requestId,
                      requestDeliveryId: deliveryData.requestDeliveryId,
                      sessionId,
                      raw,
                    }).match({ ok: (value) => value.safetyMode, err: () => "restricted" as const }),
                  }
                : {}),
            };

            const requestControl = parseRequestControlFromRaw(entry.raw);

            let state = bySession.get(sessionId) ?? createSessionQueue(sessionId);
            bySession.set(sessionId, state);

            const logQueueTransition = (input: {
              action: string;
              queueDepthBefore: number;
              queueDepthAfter: number;
              reason?: string;
              activeRequestId?: string | null;
            }) => {
              logger.debug(
                "agent.queue.transition",
                formatBridgeLogContext({
                  requestId,
                  sessionId,
                  requestClient,
                  queueMode: entry.queue,
                  running: state.running,
                  queueDepthBefore: input.queueDepthBefore,
                  queueDepthAfter: input.queueDepthAfter,
                  action: input.action,
                  reason: input.reason,
                  activeRequestId: input.activeRequestId ?? state.activeRequestId,
                  draining,
                }),
              );
            };
            const logQueuedBehindActiveRun = (queuedRequestId: string) => {
              logger.info("request queued behind active run", {
                requestId: queuedRequestId,
                activeRequestId: state.activeRequestId,
                queueDepth: state.queue.length,
              });
            };

            const enqueueWithLifecycle = async (
              queuedEntry: Enqueued,
              detail: string,
            ): Promise<ResultType<void, BusAgentRunnerOperationFailed>> => {
              state.queue.push(queuedEntry);
              const published = await captureBusAgentRunnerOperation(
                "queued lifecycle publication",
                () =>
                  publishLifecycle({
                    bus,
                    headers: {
                      request_id: queuedEntry.requestId,
                      session_id: sessionId,
                      request_client: queuedEntry.requestClient,
                    },
                    state: "queued",
                    detail,
                  }),
              );
              const publishError = published.match({
                ok: () => null,
                err: (error) => error,
              });
              if (publishError) {
                removeQueuedEntriesByReference(state.queue, [queuedEntry]);
                if (queuedEntry.identityOwner) {
                  requestMessageCache.releaseOwner(queuedEntry.identityOwner);
                }
                return Result.err(publishError);
              }
              return Result.ok(undefined);
            };
            const terminalizeProjectedDelivery = async (
              kind: "completed" | "cancelled" | "abandoned",
              code: string,
            ): Promise<boolean> => {
              if (!entry.requestDeliveryId || !params.requestDelivery) return true;
              const terminalized = await params.requestDelivery.terminalize({
                requestDeliveryId: entry.requestDeliveryId,
                outcome: { kind, code },
                transportCommitRequired: true,
              });
              const terminalError = terminalized.match({
                ok: () => null,
                err: (error) => error,
              });
              if (!terminalError) return true;
              intakeError = new BusAgentRunnerOperationFailed({
                cause: terminalError,
                operation: "request delivery projection terminalization",
                failureKind: "other",
                displayMessage: terminalError.message,
                message: "Applied request delivery could not be terminalized",
              });
              return false;
            };
            const retainProjectedDeliveryUntilRunTerminal = (
              kind: "completed" | "cancelled" | "abandoned",
              code: string,
              checkpoint:
                | { readonly kind: "canonical" }
                | {
                    readonly kind: "queued";
                    readonly inputId: AgentInputQueueId;
                  }
                | { readonly kind: "pending" } = { kind: "pending" },
              appliedEntry: Enqueued = entry,
            ): void => {
              if (checkpoint.kind === "queued") {
                state.activeRun?.queuedControlEntries.set(checkpoint.inputId, appliedEntry);
              }
              if (!entry.requestDeliveryId || !params.requestDelivery || !state.activeRun) return;
              if (!state.activeRun.retainedRequestDeliveries.has(entry.requestDeliveryId)) {
                state.activeRun.retainedRequestDeliveries.set(entry.requestDeliveryId, {
                  kind,
                  code,
                });
                state.activeRun.storedMessages = [
                  ...state.activeRun.storedMessages,
                  ...entry.storedMessages,
                ];
              }
              if (checkpoint.kind === "canonical") {
                state.activeRun.checkpointedRetainedRequestDeliveryIds.add(entry.requestDeliveryId);
                return;
              }
              if (checkpoint.kind === "queued") {
                state.activeRun.retainedRequestDeliveryByInputId.set(
                  checkpoint.inputId,
                  entry.requestDeliveryId,
                );
              }
            };

            if (pendingAttempt) {
              await resumeQueueLifecycleAttempt(pendingAttempt, state);
              if (pendingAttempt.kind === "buffered-absorption") {
                retainProjectedDeliveryUntilRunTerminal(
                  "completed",
                  "active-control-projection-recovered",
                );
              } else {
                await terminalizeProjectedDelivery("completed", "control-projection-recovered");
              }
              return;
            }

            if (
              !requestControl.cancel &&
              shouldCancelRunPolicyRequest({
                runPolicy: entry.runPolicy,
                sessionId,
                states: bySession,
              })
            ) {
              await publishLifecycle({
                bus,
                headers: {
                  request_id: requestId,
                  session_id: sessionId,
                  request_client: requestClient,
                },
                state: "cancelled",
                detail:
                  entry.runPolicy === "idle_only_session"
                    ? "idle_only_session_busy"
                    : "idle_only_global_busy",
              });
              logQueueTransition({
                action: "drop",
                queueDepthBefore: state.queue.length,
                queueDepthAfter: state.queue.length,
                reason:
                  entry.runPolicy === "idle_only_session"
                    ? "idle_only_session_busy"
                    : "idle_only_global_busy",
              });
              await terminalizeProjectedDelivery("cancelled", "idle-run-policy-drop");
              return;
            }

            if (draining) {
              // Accepted durable work stays non-terminal so the next start recovers it.
              logger.debug(
                "leaving request message for recovery while draining",
                formatBridgeLogContext({
                  requestId,
                  sessionId,
                  queue: deliveryData.queue,
                }),
              );
              logQueueTransition({
                action: "drop",
                queueDepthBefore: state.queue.length,
                queueDepthAfter: state.queue.length,
                reason: "draining",
              });
              return;
            }

            const dropCancelNoTarget = async (reason: string) => {
              logger.debug(
                "dropping cancel request with no target",
                formatBridgeLogContext({
                  requestId,
                  sessionId,
                  queue: entry.queue,
                  activeRequestId: state.activeRequestId,
                  reason,
                }),
              );
              logQueueTransition({
                action: "drop",
                queueDepthBefore: state.queue.length,
                queueDepthAfter: state.queue.length,
                reason,
              });
              await terminalizeProjectedDelivery("abandoned", "control-target-absent");
            };

            /** Queues a control for an idle session, or drops one that needs an active run. */
            const routeToIdleSession = async (): Promise<void> => {
              // Some messages only make sense when a run is already active.
              if (requestControl.requiresActive && entry.queue !== "prompt") {
                logger.debug(
                  "dropping request message (requires active run)",
                  formatBridgeLogContext({
                    requestId,
                    sessionId,
                    queue: entry.queue,
                  }),
                );
                logQueueTransition({
                  action: "drop",
                  queueDepthBefore: state.queue.length,
                  queueDepthAfter: state.queue.length,
                  reason: "requires_active_without_run",
                });
                await terminalizeProjectedDelivery("abandoned", "active-run-required");
                return;
              }

              const queueDepthBefore = state.queue.length;
              const owner = requestMessageCache.acquireOwner(requestId);
              const selectOwner = owner.match<() => RequestMessageCacheOwner | null>({
                err: (error) => () => {
                  identityError = error;
                  return null;
                },
                ok: (identityOwner) => () => identityOwner,
              });
              const identityOwner = selectOwner();
              if (!identityOwner) return;
              entry.identityOwner = identityOwner;
              state.queue.push(entry);
              logQueueTransition({
                action: "enqueue",
                queueDepthBefore,
                queueDepthAfter: state.queue.length,
                reason: "start_when_idle",
              });
              startSessionQueueDrain(sessionId, state, requestId);
            };
            /** Queues a prompt behind another request's run, or drops a control aimed at a stale run. */
            const routeBehindOtherRequest = async (): Promise<void> => {
              // Prevent stale surface controls (e.g. Cancel button) from enqueueing behind
              // an unrelated active request.
              if (requestControl.requiresActive || requestControl.cancel) {
                logger.debug(
                  "dropping request message (requires active request id)",
                  formatBridgeLogContext({
                    requestId,
                    sessionId,
                    activeRequestId: state.activeRequestId,
                    queue: entry.queue,
                  }),
                );
                logQueueTransition({
                  action: "drop",
                  queueDepthBefore: state.queue.length,
                  queueDepthAfter: state.queue.length,
                  reason: "requires_active_different_request_id",
                });
                await terminalizeProjectedDelivery("abandoned", "active-request-mismatch");
                return;
              }

              // No parallel runs: queue prompt messages for later.
              const queueDepthBefore = state.queue.length;
              const owner = requestMessageCache.acquireOwner(requestId);
              const selectOwner = owner.match<() => RequestMessageCacheOwner | null>({
                err: (error) => () => {
                  identityError = error;
                  return null;
                },
                ok: (identityOwner) => () => identityOwner,
              });
              const identityOwner = selectOwner();
              if (!identityOwner) return;
              entry.identityOwner = identityOwner;
              const enqueued = await enqueueWithLifecycle(entry, "queued behind active request");
              const enqueueError = enqueued.match({
                ok: () => null,
                err: (error) => error,
              });
              if (enqueueError) {
                intakeError = enqueueError;
                return;
              }

              logQueuedBehindActiveRun(requestId);
              logQueueTransition({
                action: "enqueue",
                queueDepthBefore,
                queueDepthAfter: state.queue.length,
                reason: "queued_behind_active",
              });
            };
            // A control whose run ended while its messages loaded is routed as if it arrived after.
            const routeAfterTargetEnded = async (): Promise<void> => {
              // The ended run may have evicted this session's state while the control loaded.
              state = bySession.get(sessionId) ?? createSessionQueue(sessionId);
              bySession.set(sessionId, state);
              if (state.running) return routeBehindOtherRequest();
              return routeToIdleSession();
            };
            const dropControlForEndedRun = async (): Promise<void> => {
              logQueueTransition({
                action: "drop",
                queueDepthBefore: state.queue.length,
                queueDepthAfter: state.queue.length,
                reason: "target_run_ended",
              });
              if (await terminalizeProjectedDelivery("abandoned", "control-target-absent")) return;
              if (intakeError) signalBusAgentRunnerHostFailure(intakeError);
            };
            const controlTargetFor = (
              runningAgent: AiSdkPiAgent<ToolSet>,
            ): RunningAgentControlTarget => {
              const targetRun = state.activeRun;
              return {
                isCurrent: () => state.activeRun === targetRun && state.agent === runningAgent,
                dropEnded: dropControlForEndedRun,
              };
            };

            if (requestControl.cancel && requestControl.cancelQueued) {
              const matchedEntries: Enqueued[] = [];

              for (const queued of state.queue) {
                if (queued.requestId === requestId && !reservedQueueEntries.has(queued)) {
                  matchedEntries.push(queued);
                }
              }

              const targetMessageId = requestControl.targetMessageId;
              if (targetMessageId) {
                for (const queued of state.queue) {
                  if (
                    !matchedEntries.includes(queued) &&
                    !reservedQueueEntries.has(queued) &&
                    requestRawReferencesMessage(queued.raw, targetMessageId)
                  ) {
                    matchedEntries.push(queued);
                  }
                }
              }

              if (matchedEntries.length > 0) {
                for (const queued of matchedEntries) reservedQueueEntries.add(queued);
                const attempt: QueueLifecycleAttempt = {
                  eventId: msg.id,
                  controlRequestId: requestId,
                  controlRequestClient: requestClient,
                  sessionId,
                  kind: "queued-cancellation",
                  detail: "cancelled while queued",
                  pendingGroups: groupQueueCancellationEntries(matchedEntries),
                  controlApplied: true,
                };
                queueLifecycleAttempts.set(msg.id, attempt);
                await resumeQueueLifecycleAttempt(attempt, state);

                logger.debug("queued request cancelled", {
                  requestId,
                  sessionId,
                  cancelledRequestIds: [
                    ...new Set(matchedEntries.map((queued) => queued.requestId)),
                  ],
                  queueDepth: state.queue.length,
                });
                logQueueTransition({
                  action: "cancel_queued",
                  queueDepthBefore: state.queue.length + matchedEntries.length,
                  queueDepthAfter: state.queue.length,
                  reason: "cancel_queued",
                });

                await terminalizeProjectedDelivery("completed", "queued-cancel-applied");
                return;
              }

              const targetMessageIdForActive = requestControl.targetMessageId;
              const targetMatchesActive =
                typeof targetMessageIdForActive === "string" &&
                requestRawReferencesMessage(state.activeRun?.raw, targetMessageIdForActive);

              if (
                !state.running ||
                !state.activeRequestId ||
                (!state.agent && !state.activeRun?.cancel)
              ) {
                await dropCancelNoTarget("request not queued or active");
                return;
              }

              if (state.activeRequestId === requestId || targetMatchesActive) {
                const activeCancelEntry: Enqueued = {
                  ...entry,
                  requestId: state.activeRequestId,
                  requestClient: state.activeRun?.requestClient ?? entry.requestClient,
                };
                if (state.activeRun?.started === false) {
                  state.activeRun.cancel();
                } else if (state.agent) {
                  await applyToRunningAgent(
                    state.agent,
                    activeCancelEntry,
                    cancelledByRequestId,
                    state.activeRun,
                    (checkpoint) =>
                      retainProjectedDeliveryUntilRunTerminal(
                        "completed",
                        "active-cancel-applied",
                        checkpoint,
                      ),
                    (operation) => enqueueSessionControl(sessionId, operation),
                    controlTargetFor(state.agent),
                  );
                }
                logQueueTransition({
                  action: "apply_to_active",
                  queueDepthBefore: state.queue.length,
                  queueDepthAfter: state.queue.length,
                  reason: targetMatchesActive
                    ? "cancel_active_by_message_id"
                    : "cancel_active_by_request_id",
                });
                if (state.activeRun?.started === false) {
                  retainProjectedDeliveryUntilRunTerminal("completed", "active-cancel-applied");
                }
                return;
              }

              await dropCancelNoTarget("request not queued or active");
              return;
            }

            if (!state.running) {
              if (requestControl.cancel) {
                await dropCancelNoTarget("request not active");
                return;
              }

              await routeToIdleSession();
            } else {
              if (
                state.activeRequestId === requestId &&
                requestControl.cancel &&
                state.activeRun?.started === false &&
                state.activeRun?.cancel
              ) {
                state.activeRun.cancel();
                logQueueTransition({
                  action: "apply_to_active",
                  queueDepthBefore: state.queue.length,
                  queueDepthAfter: state.queue.length,
                  reason: "cancel_active_before_agent_start",
                });
                retainProjectedDeliveryUntilRunTerminal("completed", "active-cancel-applied");
                return;
              }

              if (
                state.activeRequestId === requestId &&
                !requestControl.cancel &&
                state.activeRun?.runProfile === "primary"
              ) {
                const activeRun = state.activeRun;
                const incomingOverride =
                  entry.modelOverride ?? parseRequestModelOverrideFromRaw(entry.raw) ?? undefined;
                let incompatible =
                  activeRun.resolvedModelSpec === null &&
                  incomingOverride !== undefined &&
                  incomingOverride !== activeRun.modelOverride;
                if (
                  incomingOverride !== undefined &&
                  activeRun.resolvedModelSpec !== null &&
                  activeRun.resolvedProviderFamily !== null
                ) {
                  const activeSpec = activeRun.resolvedModelSpec;
                  const activeFamily = activeRun.resolvedProviderFamily;
                  const requestedPlan = resolveAgentRunModelResult({
                    cfg,
                    runProfile: "primary",
                    requestModelOverride: incomingOverride,
                  });
                  incompatible = requestedPlan.match({
                    ok: (plan) =>
                      shouldQueueIncompatibleActiveRuntimeModel({
                        activeSpec,
                        activeReasoning: activeRun.resolvedReasoning,
                        activeFamily,
                        requested: plan.head,
                      }),
                    err: () => true,
                  });
                }
                if (incompatible) {
                  const aliasRequestId = deriveModelChangingRequestId(entry);
                  const aliased = requestMessageCache.createAliasOwner({
                    sourceRequestId: requestId,
                    aliasRequestId,
                    requestClient,
                    sessionId,
                  });
                  const selectAlias = aliased.match<() => RequestMessageCacheAliasOwner | null>({
                    err: (error) => () => {
                      identityError = error;
                      return null;
                    },
                    ok: (aliasOwner) => () => aliasOwner,
                  });
                  const alias = selectAlias();
                  if (!alias) return;
                  const aliasProjection = alias.projection;
                  const queuedEntry: Enqueued = {
                    ...entry,
                    requestId: aliasProjection.requestId,
                    sessionId: aliasProjection.sessionId,
                    requestClient: aliasProjection.requestClient,
                    queue: "prompt",
                    authenticatedOrigin: aliasProjection.authenticatedOrigin,
                    verifiedIngress: aliasProjection.verifiedIngress,
                    identityOwner: {
                      requestId: alias.requestId,
                      ownerId: alias.ownerId,
                    },
                  };
                  if (acceptedRecord && params.requestDelivery) {
                    const projectedWork = {
                      ...acceptedRecord.work,
                      requestId: aliasProjection.requestId,
                      sessionId: aliasProjection.sessionId,
                      requestClient: aliasProjection.requestClient,
                      headers: {
                        ...acceptedRecord.work.headers,
                        request_id: aliasProjection.requestId,
                        session_id: aliasProjection.sessionId,
                        request_client: aliasProjection.requestClient,
                      },
                      data: {
                        ...acceptedRecord.work.data,
                        queue: "prompt" as const,
                      },
                    } satisfies CoreAcceptedRequestWork;
                    const replaced = params.requestDelivery.replaceAcceptedWork({
                      requestDeliveryId: acceptedRecord.requestDeliveryId,
                      requestId: projectedWork.requestId,
                      work: projectedWork,
                    });
                    const replaceError = replaced.match({
                      ok: () => null,
                      err: (error) => error,
                    });
                    if (replaceError) {
                      requestMessageCache.releaseOwner({
                        requestId: alias.requestId,
                        ownerId: alias.ownerId,
                      });
                      intakeError = new BusAgentRunnerOperationFailed({
                        operation: "durable incompatible-model queue projection",
                        cause: replaceError,
                        failureKind: "other",
                        displayMessage: replaceError.message,
                        message: "Incompatible-model queue projection could not be persisted",
                      });
                      return;
                    }
                  }
                  const queueDepthBefore = state.queue.length;
                  const enqueued = await enqueueWithLifecycle(
                    queuedEntry,
                    "queued for incompatible model or reasoning selection",
                  );
                  const enqueueError = enqueued.match({
                    ok: () => null,
                    err: (error) => error,
                  });
                  if (enqueueError) {
                    intakeError = enqueueError;
                    return;
                  }
                  logQueueTransition({
                    action: "enqueue",
                    queueDepthBefore,
                    queueDepthAfter: state.queue.length,
                    reason: "incompatible_active_model",
                  });
                  logQueuedBehindActiveRun(queuedEntry.requestId);
                  return;
                }
              }

              // If the message is intended for the currently active request, apply immediately.
              if (state.activeRequestId && state.activeRequestId === requestId && state.agent) {
                const runningAgent = state.agent;
                const queueDepthBefore = state.queue.length;
                const shouldAbsorbBufferedPrompts =
                  (entry.queue === "steer" || entry.queue === "interrupt") &&
                  !isCancelControlEntry(entry);

                const bufferedPrompts = shouldAbsorbBufferedPrompts
                  ? collectBufferedPromptEntriesForActiveRequest({
                      queue: state.queue,
                      activeRequestId: requestId,
                    }).filter((queued) => !reservedQueueEntries.has(queued))
                  : [];

                const mergedEntry =
                  bufferedPrompts.length > 0
                    ? ({
                        ...entry,
                        messages: [
                          ...bufferedPrompts.flatMap((queuedPrompt) => queuedPrompt.messages),
                          ...entry.messages,
                        ],
                        storedMessages: [
                          ...bufferedPrompts.flatMap((queuedPrompt) => queuedPrompt.storedMessages),
                          ...entry.storedMessages,
                        ],
                        corePrimaryLineage: degradeCorePrimaryLineageForMutation(
                          "queued-buffer-absorbed-into-steering",
                          runningAgent.state.messages.length,
                        ),
                      } satisfies Enqueued)
                    : entry;

                if (bufferedPrompts.length > 0) {
                  const absorbMode: "steer" | "interrupt" =
                    entry.queue === "interrupt" ? "interrupt" : "steer";
                  for (const bufferedPrompt of bufferedPrompts) {
                    reservedQueueEntries.add(bufferedPrompt);
                  }
                  const attempt: QueueLifecycleAttempt = {
                    eventId: msg.id,
                    controlRequestId: requestId,
                    controlRequestClient: requestClient,
                    sessionId,
                    kind: "buffered-absorption",
                    detail:
                      absorbMode === "interrupt"
                        ? "cancelled: absorbed into active interrupt"
                        : "cancelled: absorbed into active steer",
                    pendingGroups: groupQueueCancellationEntries(bufferedPrompts),
                    controlApplied: false,
                  };
                  queueLifecycleAttempts.set(msg.id, attempt);
                  const applied = await captureBusAgentRunnerOperation(
                    "buffered prompt control application",
                    () =>
                      applyToRunningAgent(
                        runningAgent,
                        mergedEntry,
                        cancelledByRequestId,
                        state.activeRun,
                        (checkpoint) =>
                          retainProjectedDeliveryUntilRunTerminal(
                            "completed",
                            "active-input-applied",
                            checkpoint,
                            { ...mergedEntry, corePrimaryLineage: entry.corePrimaryLineage },
                          ),
                        (operation) => enqueueSessionControl(sessionId, operation),
                        controlTargetFor(runningAgent),
                      ),
                  );
                  const applyError = applied.match({
                    ok: () => null,
                    err: (error) => error,
                  });
                  if (applyError) {
                    for (const bufferedPrompt of bufferedPrompts) {
                      reservedQueueEntries.delete(bufferedPrompt);
                    }
                    queueLifecycleAttempts.delete(msg.id);
                    signalBusAgentRunnerHostFailure(applyError);
                  }
                  if (applied.match({ ok: (o) => o === "target-ended", err: () => false })) {
                    for (const bufferedPrompt of bufferedPrompts) {
                      reservedQueueEntries.delete(bufferedPrompt);
                    }
                    queueLifecycleAttempts.delete(msg.id);
                    await routeAfterTargetEnded();
                    return;
                  }
                  attempt.controlApplied = true;
                  await resumeQueueLifecycleAttempt(attempt, state);
                } else {
                  const applied = await applyToRunningAgent(
                    runningAgent,
                    mergedEntry,
                    cancelledByRequestId,
                    state.activeRun,
                    (checkpoint) =>
                      retainProjectedDeliveryUntilRunTerminal(
                        "completed",
                        "active-input-applied",
                        checkpoint,
                      ),
                    (operation) => enqueueSessionControl(sessionId, operation),
                    controlTargetFor(runningAgent),
                  );
                  if (applied === "target-ended") {
                    await routeAfterTargetEnded();
                    return;
                  }
                }

                logQueueTransition({
                  action: "apply_to_active",
                  queueDepthBefore,
                  queueDepthAfter: state.queue.length,
                  reason:
                    bufferedPrompts.length > 0
                      ? `same_request_id_absorbed_${bufferedPrompts.length}`
                      : "same_request_id",
                });
              } else {
                await routeBehindOtherRequest();
              }
            }
          })();
          if (intakeError) {
            parkPending = true;
            return {
              status: "return",
              value: Result.err(
                new BusAgentRunnerIntakeFailed({
                  cause: intakeError,
                  message: "cmd.request.message intake failed",
                }),
              ),
            } as const;
          }
          if (identityError) {
            return {
              status: "return",
              value: Result.err(
                new BusAgentRunnerAuthenticationProjectionInvalid({
                  cause: identityError,
                  message: "cmd.request.message identity ownership is invalid",
                }),
              ),
            } as const;
          }
          return { status: "return", value: Result.ok(undefined) } as const;
        },
        catch: (cause) =>
          Panic.is(cause)
            ? ({ kind: "panic", panic: cause } as const)
            : ({
                kind: "failure",
                error: new BusAgentRunnerIntakeFailed({
                  cause,
                  message: "cmd.request.message intake failed",
                }),
              } as const),
      });
      const outcome = attempted.match<
        | {
            readonly kind: "success";
            readonly operation: import("better-result").InferOk<typeof attempted>;
          }
        | { readonly kind: "panic"; readonly panic: Panic }
        | {
            readonly kind: "failure";
            readonly error: BusAgentRunnerIntakeFailed;
          }
      >({
        ok: (operation) => ({ kind: "success", operation }),
        err: (failure) => failure,
      });
      if (outcome.kind === "panic") {
        rethrowBusAgentRunnerPanic(outcome.panic);
        return Result.err(
          new BusAgentRunnerIntakeFailed({
            cause: outcome.panic,
            message: "cmd.request.message intake failed",
          }),
        );
      }
      if (outcome.kind === "failure") {
        parkPending = true;
        return Result.err(outcome.error);
      }
      return outcome.operation.value;
    })().finally(() => {
      if (!parkPending) abandonQueueLifecycleAttempt(msg.id);
      if (cacheAdmitted) {
        requestMessageCache.finishDelivery({
          requestId,
          eventId: msg.id,
          disposition: parkPending ? "park" : "release",
        });
      }
    });
    return intakeResult.match<() => Promise<ResultType<void, BusAgentRunnerDeliveryError>>>({
      ok: () => async () => Result.ok(undefined),
      err: (error) => () => reconcileAcceptedProjectionFailure(error),
    })();
  }

  let stopStartedSubscription: (() => Promise<void>) | null = null;
  let subscriptionStart: Promise<void> | null = null;
  const superviseAgentRunnerBackgroundFailure = <Cause>(cause: Cause): void => {
    rethrowBusAgentRunnerPanic(cause, reportFatalPanic);
    const error = projectBusAgentRunnerError(cause, "agent runner background operation failed");
    logger.error("agent runner background operation failed", {
      error: error.message,
    });
  };
  const ignoreDetachedFailure = async (operation: Promise<unknown>): Promise<void> => {
    await Result.tryPromise({ try: () => operation, catch: () => undefined });
  };
  /** Logs a detached operation's failure, or forwards its Panic, once nobody awaits it. */
  const superviseDetachedOperation = async (operation: Promise<unknown>): Promise<void> => {
    const settled = await Result.tryPromise({ try: () => operation, catch: captureError });
    settled.match({
      ok: () => undefined,
      err: ({ cause }) => superviseAgentRunnerBackgroundFailure(cause),
    });
  };
  const isRunnerAdmissionStop = (error: EventDeliveryStopped): boolean =>
    runnerAdmissionStopped && error.reason === "requested";
  const startSubscription = (): Promise<void> => {
    if (subscriptionStart) return subscriptionStart;
    subscriptionStart = (async () => {
      const startedSubscription = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: consumerId(subscriptionId),
          batch: { maxWaitMs: 1000 },
        },
        async (msg) => {
          switch (msg.type) {
            case lilacEventTypes.CmdRequestMessage: {
              const handled = await handleCmdRequestMessage(msg);
              evictIdleSession(msg.headers?.session_id);
              return handled;
            }
          }
        },
        busAgentRunnerDeliveryDisposition,
      );
      const sub = startedSubscription.match({
        ok: (subscription) => () => subscription,
        err: (error) => () => signalBusAgentRunnerHostFailure(error),
      })();
      const subscriptionDone = sub.done.then((done) => {
        done.match({
          ok: () => () => undefined,
          err: (error) => () => {
            if (!(error instanceof EventDeliveryStopped && isRunnerAdmissionStop(error))) {
              signalBusAgentRunnerHostFailure(error);
            }
          },
        })();
      });
      const supervisedSubscriptionDone = superviseSubscriptionDone();
      void ignoreDetachedFailure(supervisedSubscriptionDone);

      async function superviseSubscriptionDone(): Promise<void> {
        const completed = await Result.tryPromise({
          try: () => subscriptionDone,
          catch: captureError,
        });
        const failure = completed.match({
          ok: () => null,
          err: ({ cause }) => ({ cause }),
        });
        if (failure) superviseAgentRunnerBackgroundFailure(failure.cause);
      }
      stopStartedSubscription = async () => {
        const stopped = await sub.stop();
        stopped.match({
          ok: () => () => undefined,
          err: (error) => () => signalBusAgentRunnerHostFailure(error),
        })();
        const done = await sub.done;
        done.match({
          ok: () => () => undefined,
          err: (error) => () => {
            if (!(error instanceof EventDeliveryStopped && isRunnerAdmissionStop(error))) {
              signalBusAgentRunnerHostFailure(error);
            }
          },
        })();
      };
    })();
    return subscriptionStart;
  };

  let subscriptionStop: Promise<void> | null = null;
  const stopSubscription = (): Promise<void> => {
    subscriptionStop ??= (async () => {
      await stopStartedSubscription?.();
    })();
    return subscriptionStop;
  };

  /** Stops admission, lets active runs finish, then aborts the rest within the same deadline. */
  async function beginDrain(opts?: { deadlineMs?: number }) {
    draining = true;
    const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
    const deadlineAtMs = Date.now() + deadlineMs;
    const abortGraceMs = Math.min(SHUTDOWN_ABORT_GRACE_MS, Math.floor(deadlineMs / 4));
    // Stopping the subscription waits for in-flight bus handlers, so it shares the drain deadline.
    const subscriptionStopped = stopSubscription();
    void ignoreDetachedFailure(subscriptionStopped);
    const pending = () => [subscriptionStopped, ...allSessionDrainOperations()];
    if (await settlesBefore(pending(), deadlineAtMs - abortGraceMs))
      return await subscriptionStopped;

    for (const state of bySession.values()) {
      if (!state.running || !state.activeRun) continue;
      shutdownAbortRequestIds.add(state.activeRun.requestId);
      state.agent?.abort();
      state.activeRun.notifyWaiters();
    }

    if (await settlesBefore(pending(), deadlineAtMs)) await subscriptionStopped;
  }

  function nextDequeueableEntry(state: SessionQueue): Enqueued | undefined {
    if (state.running || draining) return undefined;
    const next = state.queue[0];
    if (!next || reservedQueueEntries.has(next)) return undefined;
    return next;
  }

  /**
   * Collects controls the ended run queued but never consumed. Each gets its own identity owner
   * now, while the run's owner still keeps the request's cache entry live.
   */
  function takeUnconsumedControls(state: SessionQueue): Enqueued[] {
    const run = state.activeRun;
    if (!run || !state.agent || run.queuedControlEntries.size === 0) return [];
    const unconsumedInputIds = new Set<AgentInputQueueId>([
      ...state.agent.getQueuedSteeringIds(),
      ...state.agent.getQueuedFollowUpIds(),
    ]);
    // The map keeps arrival order across steers and follow-ups.
    return [...run.queuedControlEntries].flatMap(([inputId, entry]) => {
      if (!unconsumedInputIds.has(inputId)) return [];
      const owner = requestMessageCache.acquireOwner(entry.requestId).match({
        ok: (identityOwner) => identityOwner,
        err: () => null,
      });
      return [{ ...entry, ...(owner ? { identityOwner: owner } : {}) }];
    });
  }

  /**
   * Runs unconsumed controls as the session's next prompts. Their deliveries leave the run's
   * retained set, so each stays accepted until its own run ends.
   */
  function requeueUnconsumedControls(state: SessionQueue, controls: readonly Enqueued[]): void {
    const run = state.activeRun;
    if (!run || controls.length === 0) return;
    for (const entry of controls) {
      if (!entry.requestDeliveryId) continue;
      run.retainedRequestDeliveries.delete(entry.requestDeliveryId);
      run.checkpointedRetainedRequestDeliveryIds.delete(entry.requestDeliveryId);
      logger.info("requeueing a control the ended run did not consume", {
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        requestDeliveryId: entry.requestDeliveryId,
      });
    }
    state.queue.unshift(...controls);
  }

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    rethrowBusAgentRunnerPanic(terminalPanic);
    const queueDepthBefore = state.queue.length;
    const next = nextDequeueableEntry(state);
    if (!next) return;
    state.queue.shift();
    // Claim the session before the first await so a concurrent admission cannot start a second run.
    state.running = true;
    state.activeRequestId = next.requestId;
    const releaseDequeuedSession = (): void => {
      state.running = false;
      state.activeRequestId = null;
    };
    if (next.requestClient === "native") {
      const validated = validateNativeRequest({
        requestId: next.requestId,
        requestDeliveryId: next.requestDeliveryId ?? "",
        sessionId,
        raw: next.raw,
      });
      const rejection = validated.match({ ok: () => null, err: (error) => error });
      if (rejection) {
        const rejected = await rejectNativeDelivery(next.requestDeliveryId ?? "", rejection);
        releaseDequeuedSession();
        const failure = rejected.match({ ok: () => null, err: (error) => error });
        if (failure) return signalBusAgentRunnerHostFailure(failure);
        if (next.identityOwner) requestMessageCache.releaseOwner(next.identityOwner);
        startSessionQueueDrain(sessionId, state);
        return;
      }
      next.restoredSafetyMode = validated.match({
        ok: (value) => value.safetyMode,
        err: () => "restricted",
      });
      next.nativeHistoryProviderState = validated.match({
        ok: (value) => value.historyProviderState,
        err: () => undefined,
      });
      next.nativeResolvedModelRequest = validated.match({
        ok: (value) => value.resolvedModelRequest,
        err: () => undefined,
      });
    }
    const mcpImages = new McpImageCheckpointRegistry();
    let recoveredQueuedControlStoredMessages: StoredMessageV1[] = [];

    if (next.messages.length === 0 && next.storedMessages.length > 0) {
      const materialized = await materializeStoredMessagesV1({
        messages: next.storedMessages,
        blobStore: params.blobStore,
        identityProjection: storedMessageIdentity,
      });
      const materializationError = materialized.match({
        ok: () => null,
        err: (error) => error,
      });
      if (materializationError) {
        releaseDequeuedSession();
        await failUnmaterializableEntry(next, materializationError);
        startSessionQueueDrain(sessionId, state);
        return;
      }
      next.messages = materialized.match({
        ok: (value) => value,
        err: () => [],
      });
    }
    if (next.recovery && next.storedRecoveryCheckpoint) {
      const materialized = await materializeMcpImageCheckpoint({
        imageRegistry: mcpImages,
        mcpImages: next.recoveryMcpImages,
        messages: next.storedRecoveryCheckpoint,
        blobStore: params.blobStore,
        identityProjection: storedMessageIdentity,
      });
      const materializationError = materialized.match({
        ok: () => null,
        err: (error) => error,
      });
      if (materializationError) {
        const previous = await materializePreviousRunCheckpoint({
          imageRegistry: mcpImages,
          entry: next,
          identityProjection: storedMessageIdentity,
        });
        if (previous.kind === "restored") {
          installPreviousRunCheckpoint({
            entry: next,
            recovery: next.recovery,
            checkpoint: previous.checkpoint,
            messages: previous.messages,
            handle: previous.handle,
          });
        } else {
          fallBackRunCheckpointToAcceptedWork({ entry: next, error: materializationError });
        }
      } else {
        next.recovery.checkpointMessages = materialized.match({
          ok: (value) => value,
          err: () => [],
        });
      }
    }
    if (draining) {
      // beginDrain's abort pass cannot reach a run that has no activeRun yet; keep the work
      // queued and accepted so the next start recovers it instead of starting the model now.
      state.queue.unshift(next);
      releaseDequeuedSession();
      return;
    }
    if (next.recovery) {
      const mergedControls = mergeQueuedControlsForRecovery(
        next,
        state.queue,
        reservedQueueEntries,
      );
      recoveredQueuedControlStoredMessages = [...mergedControls.storedMessages];
      next.storedMessages = [...next.storedMessages, ...mergedControls.storedMessages];
      const retained = new Map(
        next.retainedRequestDeliveries?.map(
          ({ requestDeliveryId, outcome }) => [requestDeliveryId, outcome] as const,
        ),
      );
      for (const entry of mergedControls.reapplied) {
        if (entry.requestDeliveryId && !retained.has(entry.requestDeliveryId)) {
          retained.set(entry.requestDeliveryId, {
            kind: "completed",
            code: "active-control-projection-recovered",
          });
        }
        for (const nested of entry.retainedRequestDeliveries ?? []) {
          retained.set(nested.requestDeliveryId, nested.outcome);
        }
      }
      next.retainedRequestDeliveries = [...retained].map(([requestDeliveryId, outcome]) => ({
        requestDeliveryId,
        outcome,
      }));
      for (const discarded of mergedControls.discarded) {
        if (discarded.identityOwner) requestMessageCache.releaseOwner(discarded.identityOwner);
      }
    }

    if (next.requestClient === "native") {
      const validated = validateNativeRequest({
        requestId: next.requestId,
        requestDeliveryId: next.requestDeliveryId ?? "",
        sessionId,
        raw: next.raw,
      });
      const rejection = validated.match({ ok: () => null, err: (error) => error });
      if (rejection) {
        const rejected = await rejectNativeDelivery(next.requestDeliveryId ?? "", rejection);
        releaseDequeuedSession();
        const failure = rejected.match({ ok: () => null, err: (error) => error });
        if (failure) return signalBusAgentRunnerHostFailure(failure);
        if (next.identityOwner) requestMessageCache.releaseOwner(next.identityOwner);
        startSessionQueueDrain(sessionId, state);
        return;
      }
    }

    logger.debug("agent.queue.transition", {
      requestId: next.requestId,
      sessionId,
      requestClient: next.requestClient,
      queueMode: next.queue,
      running: state.running,
      queueDepthBefore,
      queueDepthAfter: state.queue.length,
      action: "dequeue",
      reason: "drain_session_queue",
      activeRequestId: state.activeRequestId,
      draining,
    });

    const runStartedAt = Date.now();

    const subagentMeta = parseSubagentMetaFromRaw(next.raw);
    const runProfile = subagentMeta.profile;
    if (next.recovery && runProfile === "primary" && next.requestClient === "discord") {
      next.corePrimaryLineage = degradeCorePrimaryLineageForMutation("restart-recovery-checkpoint");
    }
    const workflowHint = parseWorkflowRequestHintFromRaw(next.raw);
    let workflowDispatchEpoch = workflowHint?.dispatchEpoch;
    let workflowPolicy: WorkflowRequestPolicy | null = null;
    let workflowRequestClaimed = false;
    let workflowClaimTimer: ReturnType<typeof setInterval> | null = null;
    let preserveWorkflowClaim = false;
    let controlCapability: string | null = null;
    let trustedFallbackSurface: TrustedSubagentDelegationRegistration["fallbackSurface"] | null =
      null;
    const subagents = cfg.agent.subagents;

    const routerSessionMode = parseRouterSessionModeFromRaw(next.raw);

    let activeAgent: AiSdkPiAgent<ToolSet> | null = null;
    const requiresAgentRecovery = (): boolean => activeAgent?.state.recoveryRequired !== undefined;
    let claudeCodeRun: MaterializedClaudeCodeRun | null = null;
    let coreNamedClaudeRuntime: CoreNamedClaudeRuntime | null = null;
    let corePrimaryClaudeRuntime: CorePrimaryClaudeRuntime | null = null;
    let retireProviderForRetry: () => Promise<void> = async () => {};
    const getClaudeCodeRun = (): MaterializedClaudeCodeRun | null => claudeCodeRun;
    const getCoreNamedClaudeRuntime = (): CoreNamedClaudeRuntime | null => coreNamedClaudeRuntime;
    const getCorePrimaryClaudeRuntime = (): CorePrimaryClaudeRuntime | null =>
      corePrimaryClaudeRuntime;
    let activeRunOperation: Promise<unknown> | null = null;
    let customCommandAbortController: AbortController | null = null;
    let activeCustomCommandTool: {
      toolCallId: string;
      display: string;
    } | null = null;
    let rejectPreAgentCancellation: ((error: PreAgentRunCancelledError) => void) | null = null;
    const preAgentCancellationPromise = new Promise<never>((_, reject) => {
      rejectPreAgentCancellation = reject;
    });
    void captureBusAgentRunnerOperation(
      "pre-agent cancellation observation",
      () => preAgentCancellationPromise,
    );
    let unsubscribe = () => {};
    let unsubscribeCompaction = () => {};
    const level1ToolsetReleases = new Set<BuiltLevel1Toolset["release"]>();
    let level1ToolsetsClosed = false;
    const releaseLevel1Toolset = async (release: BuiltLevel1Toolset["release"]): Promise<void> => {
      const released = await captureBusAgentRunnerOperation(
        "Level 1 toolset release",
        release,
        reportFatalPanic,
      );
      const failure = released.match<Error | null>({
        ok: (result) => result.match({ ok: () => null, err: (error) => error }),
        err: (error) => error,
      });
      if (failure) {
        logger.warn(
          "failed to release Level 1 toolset",
          formatBridgeTaggedErrorForLog(failure, {
            requestId: next.requestId,
            sessionId: next.sessionId,
          }),
        );
      }
    };
    const retainLevel1Toolset = async (
      result: Awaited<ReturnType<CoreToolPluginManager["buildLevel1ToolsetResult"]>>,
    ): Promise<Awaited<ReturnType<CoreToolPluginManager["buildLevel1ToolsetResult"]>>> => {
      const release = result.match({ ok: (toolset) => toolset.release, err: () => null });
      if (!release) return result;
      if (level1ToolsetsClosed) {
        await releaseLevel1Toolset(release);
        return result;
      }
      level1ToolsetReleases.add(release);
      return result;
    };

    const headers: {
      request_id: string;
      session_id: string;
      request_client: AdapterPlatform;
      request_delivery_id?: string;
      workflow_dispatch_epoch?: string;
      router_session_mode?: "mention" | "active";
    } = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
      ...(next.requestDeliveryId ? { request_delivery_id: next.requestDeliveryId } : {}),
      ...(workflowDispatchEpoch ? { workflow_dispatch_epoch: workflowDispatchEpoch } : {}),
      ...(routerSessionMode ? { router_session_mode: routerSessionMode } : {}),
    };
    const reportOutputPublisherError = (label: string, cause: AgentOutputPublishFailed): void => {
      logger.error(
        `failed to publish ${label}`,
        formatBridgeTaggedErrorForLog(cause, {
          requestId: headers.request_id,
          sessionId: headers.session_id,
        }),
      );
    };
    const nativeOutput = params.createNativeOutput?.({
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      raw: next.raw,
      recovering: next.recovery !== undefined,
      recoveryOutputFrontier: next.recovery?.nativeOutputFrontier,
      workflowRunId: workflowHint?.runId,
      prompt: next.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        )
        .join("\n\n"),
    });
    let nativeStep = 0;
    let nativeHasText = false;
    const nativeStepId = (): string => `${next.requestId}:step:${nativeStep}`;
    const outputPublisher = createAgentOutputPublisher({
      bus,
      headers,
      onError: reportOutputPublisherError,
      reportFatalPanic,
    });
    const nativeToolSteps = new Map<string, string>();
    const publishNativeToolActivity = (
      toolCallId: string,
      status: "start" | "update" | "end",
      label: string,
      ok?: boolean,
      outcome?: NativeToolActivityResult & { durationMs?: number },
    ): void => {
      const stepId = nativeToolSteps.get(toolCallId) ?? nativeStepId();
      nativeToolSteps.set(toolCallId, stepId);
      const terminalState = ok === false ? "failed" : "complete";
      nativeOutput?.activity({
        activityId: toolCallId,
        stepId,
        kind: "tool",
        state: status === "end" ? terminalState : "start",
        label,
        ...outcome,
      });
    };
    const publishNonAgentToolStatus = async ({
      output,
      ...update
    }: Parameters<typeof outputPublisher.publishToolCall>[0] & {
      output?: string;
    }): Promise<void> => {
      publishNativeToolActivity(
        update.toolCallId,
        update.status,
        update.display,
        update.ok,
        output ? { output } : undefined,
      );
      await outputPublisher.publishToolCall(update);
    };
    const publishAuxiliaryOutput = async (
      operation: string,
      publish: () => Promise<void>,
    ): Promise<void> => {
      const published = await captureBusAgentRunnerOperation(operation, publish);
      published.match({
        ok: () => undefined,
        err: (error) => {
          logger.error(
            operation,
            formatBridgeTaggedErrorForLog(error, {
              requestId: headers.request_id,
              sessionId: headers.session_id,
            }),
          );
        },
      });
    };
    let auxiliaryOutputTail = Promise.resolve();
    const publishCurrentLifecycle = async (input: {
      state: RequestLifecycleState;
      detail?: string;
      output?: string;
      usage?: WorkflowUsage;
    }): Promise<void> => {
      if (input.state === "resolved" || input.state === "failed" || input.state === "cancelled") {
        await auxiliaryOutputTail;
        await outputPublisher.drain();
      }
      if (
        workflowPolicy &&
        workflowRequestClaimed &&
        workflowDispatchEpoch &&
        (input.state === "resolved" || input.state === "failed" || input.state === "cancelled")
      ) {
        const recorded = params.durableWorkflowStore?.recordWorkflowRequestTerminal({
          requestId: next.requestId,
          runId: workflowPolicy.runId,
          operationId: workflowPolicy.operationId,
          dispatchEpoch: workflowDispatchEpoch,
          ownerId: workflowRunnerOwnerId,
          state: input.state,
          detail: input.detail,
          output: input.output,
          usage: input.usage,
          now: Date.now(),
        });
        if (recorded !== true) {
          return signalBusAgentRunnerHostFailure(
            new Error("Workflow terminal receipt persistence lost its fenced dispatch claim"),
          );
        }
      }
      await publishLifecycle({ bus, headers, ...input });
    };
    const reportAgentActivityError = (cause: unknown): void => {
      const error = projectBusAgentRunnerError(cause, "Agent activity publish failed");
      logger.debug("agent activity publish failed", {
        requestId: next.requestId,
        sessionId: next.sessionId,
        error: error.message,
      });
    };
    const publishAgentActivity = createAgentOutputActivityPublisher({
      publish: async (source) => {
        await outputPublisher.publishActivity({ source });
      },
      onError: reportAgentActivityError,
    });
    const idleRetryBudget = createRetryBackoffBudget(cfg.agent.retry);
    let idleRecoveryPromise: ReturnType<AiSdkPiAgent<ToolSet>["requestIdleRecovery"]> | null = null;
    const decideIdleRecovery = async (
      _idleError: unknown,
      { abortSignal }: { readonly abortSignal: AbortSignal },
    ) => {
      await liveParentSession?.cancelAll("parent idle timeout recovery");

      await retireProviderForRetry();
      const retryResult = await captureBusAgentRunnerOperation("idle retry backoff", () =>
        idleRetryBudget.next(abortSignal),
      );
      const selectDecision = retryResult.match<() => ReturnType<typeof toIdleRetryDecision> | null>(
        {
          err: () => () => null,
          ok: (backoff) => () => toIdleRetryDecision(backoff),
        },
      );
      const decision = selectDecision();
      if (!decision) return "fail" as const;
      if (decision.status === "fail") return "fail" as const;
      const retry = decision.attempt;
      logger.warn(
        "agent idle timeout; retrying",
        formatBridgeLogContext({
          requestId: headers.request_id,
          sessionId: headers.session_id,
          attempt: retry.attempt,
          maxRetries: cfg.agent.retry.maxRetries,
          delayMs: retry.delayMs,
        }),
      );
      return "retry" as const;
    };
    const runIdleWatchdog =
      runProfile === "primary"
        ? createAgentRunIdleWatchdog({
            idleTimeoutMs: cfg.agent.idleTimeoutMs,
            onTimeout: (error) => {
              logger.warn(
                "agent run idle timeout",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  idleTimeoutMs: cfg.agent.idleTimeoutMs,
                }),
              );
              customCommandAbortController?.abort();
              const agent = activeAgent;
              if (!agent) return;
              idleRecoveryPromise = agent.requestIdleRecovery(error, decideIdleRecovery);
            },
          })
        : null;
    const waitForRun = async <T>(
      promise: Promise<T>,
    ): Promise<ResultType<T, BusAgentRunnerOperationFailed>> => {
      let tracked: Promise<T>;
      tracked = promise.finally(() => {
        if (activeRunOperation === tracked) activeRunOperation = null;
      });
      activeRunOperation = tracked;
      if (!runIdleWatchdog) {
        return await captureBusAgentRunnerOperation("agent run wait", () => tracked);
      }

      while (true) {
        const waited = await captureBusAgentRunnerOperation("agent idle watchdog wait", () =>
          runIdleWatchdog.waitFor(tracked),
        );
        const continueWait = waited.match<
          () => Promise<ResultType<T, BusAgentRunnerOperationFailed> | null>
        >({
          ok: (value) => async () => Result.ok(value),
          err: (waitError) => async () => {
            const recovery = idleRecoveryPromise;
            if (waitError.failureKind !== "idle-timeout" || !recovery) {
              return Result.err(waitError);
            }
            const result = await recovery;
            if (idleRecoveryPromise === recovery) idleRecoveryPromise = null;
            if (
              result.status !== "retried" &&
              !(
                result.status === "superseded" &&
                (result.reason === "cancel" || result.reason === "interrupt")
              )
            ) {
              return Result.err(waitError);
            }
            runIdleWatchdog.restart();
            return null;
          },
        });
        const outcome = await continueWait();
        if (outcome) return outcome;
      }
    };
    const waitForRunAtHost = async <T>(promise: Promise<T>): Promise<T> => {
      const waited = await waitForRun(promise);
      return waited.match({
        ok: (value) => () => value,
        err: (error) => () => signalBusAgentRunnerHostFailure(error),
      })();
    };
    const getActiveRunOperation = (): Promise<unknown> | null => activeRunOperation;
    const waitForPreAgent = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, preAgentCancellationPromise]);
    const markRunActivity = (source: "model" | "tool" | "subagent") => {
      publishAgentActivity(source);
      runIdleWatchdog?.reset();
    };

    const normalizeToolResultOutput = createToolResultOutputNormalizer({
      artifacts: params.toolResultArtifacts,
      owner: {
        requestId: next.requestId,
        sessionId: next.sessionId,
      },
      getOutputConfig: () => cfg.tools.output,
    });

    let liveParentSession: ReturnType<WorkflowLiveParentBridge["registerParent"]> | undefined;
    const workflowSubagentDispatcher = params.workflowSubagentDispatcher;
    const runWait = createRunWaitTracker((waiting) => {
      if (next.requestClient !== "native") return;
      params.nativeExecution?.waiting?.({ requestId: next.requestId, raw: next.raw }, waiting);
    });
    let continuationSignalVersion = 0;
    const continuationWaiters = new Set<() => void>();
    const notifyContinuationWaiters = () => {
      continuationSignalVersion += 1;
      const current = [...continuationWaiters];
      continuationWaiters.clear();
      for (const waiter of current) waiter();
    };
    const questionContinuation = new QuestionContinuation(next.questionResultIds);
    const stopQuestionNotifications = params.questions?.subscribe((requestId) => {
      if (requestId === next.requestId) notifyContinuationWaiters();
    });
    const stopJobNotifications = params.jobs?.subscribe(notifyContinuationWaiters);
    const deferredQuestions = () =>
      params.questions ? adaptToolResultToHost(params.questions.listDeferred(next.requestId)) : [];
    const waitForContinuationSignalSince = async (version: number, abortSignal?: AbortSignal) => {
      if (continuationSignalVersion !== version || abortSignal?.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          continuationWaiters.delete(finish);
          abortSignal?.removeEventListener("abort", finish);
          resolve();
        };
        if (continuationSignalVersion !== version || abortSignal?.aborted) {
          finish();
          return;
        }
        continuationWaiters.add(finish);
        abortSignal?.addEventListener("abort", finish, { once: true });
      });
    };
    const waitForDeferredWake = async (
      liveParentSignalVersion: number,
      continuationVersion: number,
    ) => {
      if (!liveParentSession) {
        await waitForContinuationSignalSince(continuationVersion);
        return;
      }
      const controller = new AbortController();
      await Promise.race([
        liveParentSession.waitForSignalSince(liveParentSignalVersion, controller.signal),
        waitForContinuationSignalSince(continuationVersion, controller.signal),
        Bun.sleep(LIVE_PARENT_RECONCILE_MS),
      ]).finally(() => controller.abort());
    };

    const toolAuthority = new LineageToolAuthority();
    state.activeRun = {
      ...(next.requestDeliveryId ? { requestDeliveryId: next.requestDeliveryId } : {}),
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      runProfile,
      queue: next.queue,
      runPolicy: next.runPolicy,
      origin: next.origin,
      messages: next.messages,
      storedMessages: next.storedMessages,
      corePrimaryLineage: next.corePrimaryLineage,
      toolAuthority,
      questionContinuation,
      modelOverride: next.modelOverride,
      currentTurnUserId: next.currentTurnUserId,
      currentTurnMessageRef: next.currentTurnMessageRef,
      raw: next.raw,
      resolvedModelSpec: null,
      resolvedReasoning: undefined,
      resolvedProviderFamily: null,
      partialText: next.recovery?.partialText ?? "",
      liveParent: liveParentSession,
      hasPendingJobEvents: () => params.jobs?.hasPendingEvents(next.sessionId) ?? false,
      stopAwaitJobs: async () => {
        await params.jobs?.stopAwaitJobs(next.requestId, "user_stop");
      },
      materializeStoredMessages: null,
      rememberStoredMessages: (providerMessages, storedMessages) => {
        settleStoredMessageIdentityRemember(
          storedMessageIdentity.remember(providerMessages, storedMessages),
        );
      },
      notifyWaiters: notifyContinuationWaiters,
      flushOutput: outputPublisher.flush,
      setCurrentTurnContext: () => undefined,
      cancel: () => {
        cancelledByRequestId.add(headers.request_id);
        void params.jobs?.stopAwaitJobs(next.requestId, "user_stop");
        notifyContinuationWaiters();
        customCommandAbortController?.abort();
        rejectPreAgentCancellation?.(new PreAgentRunCancelledError());
        rejectPreAgentCancellation = null;
      },
      started: false,
      startedAt: runStartedAt,
      activeTools: new Map(),
      retainedRequestDeliveries: new Map(
        next.retainedRequestDeliveries?.map(
          ({ requestDeliveryId, outcome }) => [requestDeliveryId, outcome] as const,
        ),
      ),
      checkpointedRetainedRequestDeliveryIds: new Set(
        next.retainedRequestDeliveries?.map(({ requestDeliveryId }) => requestDeliveryId),
      ),
      retainedRequestDeliveryByInputId: new Map(),
      queuedControlEntries: new Map(),
      journalHandle: null,
      nativeOutput,
      mcpImages,
      checkpointWriter: {
        disabled: false,
        pending: null,
        operation: null,
        closed: false,
        abandoned: false,
        retryInputIds: new Set(),
        inFlightInputIds: null,
        lastCommittedProviderMessages: next.recovery?.checkpointMessages ?? [],
        lastCommittedStoredMessages: next.storedRecoveryCheckpoint ?? [],
        retainedPredecessorStoredMessages: next.previousRecoveryCheckpoint?.messages ?? [],
      },
    };

    let initialMessages: ModelMessage[] = [];
    const parsedCustomCommand = next.recovery ? null : parseCustomCommandFromRaw(next.raw);
    let customCommandInput: Omit<
      Parameters<typeof buildCustomCommandMessages>[0],
      "provider"
    > | null = null;
    let initialMessagesEndWithGeneratedContext = false;
    let responseStartIndex = 0;
    let transcriptHasCompactionCheckpoint = corePrimaryLineageHasCompactionCheckpoint(
      next.corePrimaryLineage,
    );
    const runStats: {
      totalUsage?: LanguageModelUsage;
      finalMessages?: ModelMessage[];
      firstTextDeltaAt?: number;
      lastTurnFinishReason?: FinishReason;
      lastTurnEndAt?: number;
    } = {};
    let completedCompactionCount = 0;
    const streamWarnings: CallWarning[] = [];
    const modelCapabilityConfig = cfg.models.capability;
    const modelCapability = new ModelCapability({
      forceUnknownProviders: modelCapabilityConfig?.forceUnknownProviders ?? ["openai-compatible"],
      overrides: modelCapabilityConfig?.overrides ?? {},
    });
    let modelCapabilityInfo: ModelCapabilityInfo | null = null;
    let costEstimateStatus: "estimated" | "unavailable" = "unavailable";
    let costEstimateReason: string | undefined;
    let roundEstimatedCostUsdTotal: number | undefined;
    let roundEstimatedCostCount = 0;

    let resolvedModelLabel = "unknown";
    let resolvedProviderFamily: HistoryProviderState["lastFamily"] = "ai-sdk";
    let requestTerminalKind: "completed" | "failed" | "cancelled" = "failed";
    let shouldTerminalizeRequest = true;
    let terminalMarkerAttempted = false;
    let terminalMarkerOperation: Promise<void> | null = null;
    let terminalSurfaceWriteAttempted = false;
    let terminalSurfaceWriteInitiated = false;
    let nativeTerminalPublished = nativeOutput === undefined;
    const publishNativeTerminal = async (kind: typeof requestTerminalKind): Promise<boolean> => {
      if (!nativeOutput || nativeTerminalPublished) return true;
      const state = ({ completed: "complete", cancelled: "canceled", failed: "failed" } as const)[
        kind
      ];
      const result = await nativeOutput.terminal(state);
      const failure = result.match({ ok: () => null, err: (error) => error });
      if (failure) {
        shouldTerminalizeRequest = false;
        logger.error(
          "native output prevented request terminalization",
          formatBridgeTaggedErrorForLog(failure, {
            requestId: next.requestId,
            sessionId: next.sessionId,
          }),
        );
        return false;
      }
      nativeTerminalPublished = true;
      return true;
    };
    const markActiveRunTerminal = (): void => {
      if (
        terminalMarkerAttempted ||
        terminalPanic ||
        !shouldTerminalizeRequest ||
        !nativeTerminalPublished
      )
        return;
      const run = state.activeRun;
      if (!run || run.checkpointWriter.abandoned) return;
      terminalMarkerAttempted = true;
      const outcome = { kind: requestTerminalKind } as const;
      const finalReplayDeadline = outputPublisher.getFinalReplayDeadline();
      terminalMarkerOperation = (async () => {
        await flushRunCheckpointWriter(run);
        if (terminalPanic || run.checkpointWriter.abandoned) return;
        markRunTerminal(run, outcome, finalReplayDeadline);
      })();
    };
    const publishTerminalResponseText = async (
      input: Parameters<typeof outputPublisher.publishResponseText>[0],
      terminalKind: typeof requestTerminalKind = requestTerminalKind,
    ): Promise<void> => {
      terminalSurfaceWriteAttempted = true;
      if (
        nativeOutput &&
        !nativeHasText &&
        input.delivery !== "skip" &&
        input.finalText.length > 0
      ) {
        nativeOutput.textStart({
          partId: "terminal",
          stepId: nativeStepId(),
          phase: "final_answer",
        });
        nativeOutput.textDelta("terminal", input.finalText);
        nativeHasText = true;
      }
      if (!(await publishNativeTerminal(terminalKind))) return;
      await outputPublisher.publishResponseText(input);
      terminalSurfaceWriteInitiated = true;
      requestTerminalKind = terminalKind;
      markActiveRunTerminal();
      await terminalMarkerOperation;
    };
    const outcome = await (async () => {
      const runResult = await captureBusAgentRunnerOperation(
        "agent queue run",
        async () => {
          liveParentSession = params.workflowLiveParentBridge?.registerParent({
            parentRequestId: next.requestId,
            onActivity: () => markRunActivity("subagent"),
            publishToolStatus: publishNonAgentToolStatus,
            recoverSynchronousDeliveries: next.recovery !== undefined,
          });
          await liveParentSession?.ready;
          if (state.activeRun) state.activeRun.liveParent = liveParentSession;
          const runJournalHandle = next.requestDeliveryId
            ? (next.journalHandle ??
              openRunJournal({
                requestDeliveryId: next.requestDeliveryId,
                requestId: next.requestId,
                sessionId: next.sessionId,
              }))
            : null;
          toolAuthority.select(
            next.loadedCatalogIds ??
              (runProfile === "primary"
                ? resolveCorePrimaryLoadedCatalogIds({
                    lineage: next.corePrimaryLineage,
                    transcriptStore: params.transcriptStore,
                  })
                : []),
          );
          if (state.activeRun) state.activeRun.journalHandle = runJournalHandle;
          const looksLikeWorkflowRequest =
            next.requestId.startsWith("wfr:") || next.sessionId.startsWith("workflow:");
          if (workflowHint || looksLikeWorkflowRequest) {
            if (!workflowHint || !params.durableWorkflowStore) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request is missing server-issued dispatch authority"),
              );
            }
            const authorized = params.durableWorkflowStore.authorizeWorkflowRequest({
              requestId: next.requestId,
              sessionId: next.sessionId,
              platform: next.requestClient,
            });
            if (
              !authorized ||
              authorized.policy.runId !== workflowHint.runId ||
              authorized.policy.operationId !== workflowHint.operationId ||
              authorized.policy.dispatchEpoch !== workflowHint.dispatchEpoch
            ) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request dispatch authority is invalid or inactive"),
              );
            }
            workflowDispatchEpoch = authorized.policy.dispatchEpoch;
            headers.workflow_dispatch_epoch = workflowDispatchEpoch;
            if (
              !params.durableWorkflowStore.claimWorkflowRequest({
                requestId: next.requestId,
                dispatchEpoch: authorized.policy.dispatchEpoch,
                ownerId: workflowRunnerOwnerId,
                now: Date.now(),
              })
            ) {
              return signalBusAgentRunnerHostFailure(
                new Error("Workflow request dispatch is owned by another live runner"),
              );
            }
            workflowRequestClaimed = true;
            workflowPolicy = authorized.policy;
            const fallbackClient = authorized.policy.originSession.client;
            const fallbackProtocol = fallbackClient
              ? params.surfaceProtocolResolver?.resolve(fallbackClient)
              : null;
            trustedFallbackSurface =
              authorized.policy.originSession.sessionId &&
              fallbackProtocol &&
              authorized.policy.originSession.userId
                ? {
                    platform: fallbackProtocol.platform,
                    sessionId: authorized.policy.originSession.sessionId,
                    userId: authorized.policy.originSession.userId,
                  }
                : null;
            workflowClaimTimer = setInterval(() => {
              const refreshed = params.durableWorkflowStore?.refreshWorkflowRequestClaim(
                next.requestId,
                workflowRunnerOwnerId,
                Date.now(),
              );
              if (refreshed === false) {
                activeAgent?.abort();
                rejectPreAgentCancellation?.(new PreAgentRunCancelledError());
              }
            }, WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS);
            workflowClaimTimer.unref?.();
          }
          if (workflowPolicy) {
            const validatedPolicy = assertWorkflowDispatchPolicy(workflowPolicy, subagentMeta);
            validatedPolicy.match({
              ok: () => () => undefined,
              err: (error) => () => signalBusAgentRunnerHostFailure(error),
            })();
          }
          const resolvedStableNamedContinuation = resolveCoreStableNamedContinuation({
            runProfile,
            sessionId: next.sessionId,
            workflowPolicy,
          });
          const stableNamedContinuation = resolvedStableNamedContinuation.match({
            ok: (value) => () => value,
            err: (error) => () => signalBusAgentRunnerHostFailure(error),
          })();
          const maxSubagentDepth = subagents.maxDepth;
          if (subagentMeta.depth > maxSubagentDepth) {
            const detail = `subagent depth ${subagentMeta.depth} exceeds maxDepth=${maxSubagentDepth}`;
            await publishCurrentLifecycle({
              state: "failed",
              detail,
              output: `Error: ${detail}`,
            });
            await publishTerminalResponseText({
              finalText: `Error: ${detail}`,
            });
            return;
          }

          let lifecycleDetail: string | undefined;
          if (next.recovery) {
            lifecycleDetail = "resumed after server restart";
          } else {
            switch (next.queue) {
              case "prompt":
                lifecycleDetail = undefined;
                break;
              case "steer":
              case "followUp":
              case "interrupt":
                lifecycleDetail = `coerced queue=${next.queue} to prompt (no active run)`;
                break;
              default: {
                const _exhaustive: never = next.queue;
                lifecycleDetail = _exhaustive;
                break;
              }
            }
          }
          await publishCurrentLifecycle({
            state: "running",
            detail: lifecycleDetail,
          });
          const replyPublished = await bus.publish(
            lilacEventTypes.EvtRequestReply,
            {},
            { headers },
          );
          replyPublished.match({
            ok: () => () => undefined,
            err: (error) => () => signalBusAgentRunnerHostFailure(error),
          })();

          if (parsedCustomCommand) {
            if (runProfile === "primary" && next.requestClient === "discord") {
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "custom-command-tool-insertion",
                next.corePrimaryLineage?.currentCanonicalStart,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            const toolCallId = buildCustomCommandToolCallId(
              next.requestId,
              parsedCustomCommand.name,
            );
            const display = `${CUSTOM_COMMAND_TOOL_NAME} ${parsedCustomCommand.text}`;
            activeCustomCommandTool = { toolCallId, display };

            await publishNonAgentToolStatus({
              toolCallId,
              status: "start",
              display,
            });

            let output: CustomCommandResult = { type: "json", value: null };
            let customError = parsedCustomCommand.error ?? null;
            const command = params.customCommands?.get(parsedCustomCommand.name) ?? null;

            if (!customError && !params.customCommands) {
              customError = "Custom command manager is unavailable.";
            }
            if (!customError && !command) {
              customError = `Unknown custom command '${parsedCustomCommand.name}'.`;
            }

            if (!customError && command && params.customCommands) {
              if (cancelledByRequestId.has(headers.request_id)) {
                return signalBusAgentRunnerHostFailure(new PreAgentRunCancelledError());
              }
              customCommandAbortController = new AbortController();
              runIdleWatchdog?.start();
              await (async () => {
                const executed = await waitForPreAgent(
                  waitForRunAtHost(
                    params.customCommands!.execute({
                      command,
                      args: parsedCustomCommand.args,
                      context: {
                        cwd,
                        dataDir: env.dataDir,
                        commandDir: command.dir,
                        commandName: command.def.name,
                        requestId: next.requestId,
                        sessionId: next.sessionId,
                        abortSignal: customCommandAbortController!.signal,
                        reportActivity: () => markRunActivity("tool"),
                      },
                    }),
                  ),
                );
                executed.match({
                  ok: (value) => {
                    output = value;
                  },
                  err: (error) => {
                    customError = customCommandExecutionErrorText(error);
                  },
                });
              })().finally(() => {
                runIdleWatchdog?.pause();
                customCommandAbortController = null;
              });
            }

            const customCancelled = cancelledByRequestId.has(headers.request_id);

            if (customCancelled) {
              requestTerminalKind = "cancelled";
              const finalText = "Cancelled.";
              await publishNonAgentToolStatus({
                toolCallId,
                status: "end",
                display,
                ok: false,
                error: "cancelled by interrupt",
              });
              activeCustomCommandTool = null;
              await publishCurrentLifecycle({
                state: "cancelled",
                detail: "cancelled by interrupt",
                output: finalText,
              });
              await publishTerminalResponseText({ finalText });
              return;
            }

            if (customError) {
              output = { type: "error-text", value: customError };
            }

            output = await waitForPreAgent(
              Promise.resolve(
                normalizeToolResultOutput(output, {
                  toolCallId,
                  toolName: CUSTOM_COMMAND_TOOL_NAME,
                }),
              ),
            );

            customCommandInput = {
              toolCallId,
              name: parsedCustomCommand.name,
              args: parsedCustomCommand.args,
              prompt: parsedCustomCommand.prompt,
              text: parsedCustomCommand.text,
              source: parsedCustomCommand.source,
              output,
            };

            await publishNonAgentToolStatus({
              toolCallId,
              status: "end",
              display,
              ok: !customError,
              error: customError ?? undefined,
            });
            activeCustomCommandTool = null;

            if (customError) {
              const finalText = buildCustomCommandFailureFinalText({
                commandText: parsedCustomCommand.text,
                normalizedOutput: output,
              });
              resolvedModelLabel = CUSTOM_COMMAND_TOOL_NAME;

              if (params.transcriptStore) {
                const storedCustomMessages = projectStoredMessagesV1([
                  ...buildCustomCommandMessages({ ...customCommandInput, provider: "" }),
                  {
                    role: "assistant",
                    content: finalText,
                  } satisfies ModelMessage,
                ]);
                const persisted = storedCustomMessages.andThen((messages) =>
                  params.transcriptStore!.saveRequestTranscript({
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    requestClient: headers.request_client,
                    messages:
                      next.requestClient === "native"
                        ? [...next.storedMessages, ...messages]
                        : messages,
                    finalText,
                    modelLabel: resolvedModelLabel,
                    loadedCatalogIds: toolAuthority.snapshot(),
                  }),
                );
                const persistError = persisted.match({
                  ok: () => null,
                  err: (error) => error,
                });
                if (persistError) {
                  logger.error(
                    "failed to persist transcript after custom command error",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      errorTag: persistError.name,
                      errorMessage: persistError.message,
                    }),
                  );
                }
              }

              await publishCurrentLifecycle({
                state: "failed",
                detail: customError,
                output: finalText,
              });
              await publishTerminalResponseText({ finalText });

              logger.warn(
                "custom command failed",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  commandName: parsedCustomCommand.name,
                  errorMessage: customError,
                }),
              );
              return;
            }
          }

          const requestModelOverride =
            runProfile === "primary"
              ? (next.modelOverride ?? parseRequestModelOverrideFromRaw(next.raw) ?? undefined)
              : next.modelOverride;
          if (
            workflowPolicy &&
            requestModelOverride !== undefined &&
            requestModelOverride !== workflowPolicy.resolvedModelRequest.alias &&
            requestModelOverride !== workflowPolicy.resolvedModelRequest.spec
          ) {
            return signalBusAgentRunnerHostFailure(
              new Error("Workflow request model does not match the approved operation policy"),
            );
          }
          const resolvedModelPlan = resolveAgentRunModelResult({
            cfg,
            runProfile,
            requestModelOverride,
            reasoningOverride: subagentMeta.reasoning,
            resolvedModelRequest:
              workflowPolicy?.resolvedModelRequest ?? next.nativeResolvedModelRequest,
          });
          const modelPlan = resolvedModelPlan.match({
            ok: (value) => () => value,
            err: (error) => () => signalBusAgentRunnerHostFailure(error),
          })();
          const initialResolvedModel = modelPlan.head;
          nativeOutput?.model(initialResolvedModel.spec, initialResolvedModel.reasoning);
          resolvedModelLabel = initialResolvedModel.modelId;
          resolvedProviderFamily = classifyHistoryProviderFamily({
            type: initialResolvedModel.provider,
          });
          if (state.activeRun) {
            state.activeRun.resolvedModelSpec = initialResolvedModel.spec;
            state.activeRun.resolvedReasoning = initialResolvedModel.reasoning;
            state.activeRun.resolvedProviderFamily = resolvedProviderFamily;
          }

          const skillsSection = await waitForPreAgent(
            maybeBuildSkillsSectionForPrimary(
              next.requestClient,
              next.authenticatedOrigin?.platform,
            ),
          );

          const sessionConfigId = parseSessionConfigIdFromRaw(next.raw) ?? sessionId;
          const discordSessionContext =
            next.requestClient === "discord"
              ? params.resolveDiscordSessionContext?.(sessionId)
              : null;
          const rawParentChannelId = parseParentChannelIdFromRaw(next.raw);
          const rawGuildId = parseGuildIdFromRaw(next.raw);
          const parentChannelId =
            rawParentChannelId ?? discordSessionContext?.parentChannelId ?? undefined;
          const guildId = rawGuildId ?? discordSessionContext?.guildId ?? undefined;
          const legacyConfigFallbackId =
            sessionConfigId === sessionId ? undefined : sessionConfigId;
          const sessionConfig = resolveRouterSessionConfig(cfg, {
            sessionId,
            parentChannelId,
            guildId: guildId ?? legacyConfigFallbackId,
          });
          let safetyMode: SessionSafetyMode =
            next.restoredSafetyMode ??
            (next.requestClient === "discord" && discordSessionContext === undefined
              ? "restricted"
              : resolveSessionSafetyMode(
                  cfg,
                  sessionId,
                  discordSessionContext?.parentChannelId ?? undefined,
                  discordSessionContext?.guildId ?? undefined,
                ));
          const heartbeatAuthority = workflowPolicy
            ? workflowPolicy.originSession.client === "unknown" &&
              workflowPolicy.originSession.userId === null &&
              isHeartbeatSessionId(workflowPolicy.originSession.sessionId ?? "")
            : runProfile === "primary" && isHeartbeatSessionId(next.sessionId);
          if (heartbeatAuthority) {
            controlCapability =
              (await params.issueHeartbeatCapability?.({
                profile: runProfile,
                requestId: next.requestId,
                sessionId: next.sessionId,
                requestClient: next.requestClient,
                canonicalCwd: workflowPolicy?.cwd ?? cwd,
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              })) ?? null;
            if (!controlCapability) {
              return signalBusAgentRunnerHostFailure(
                new Error("Heartbeat request is missing server-issued Level-2 authority"),
              );
            }
            safetyMode = "trusted";
          } else if (
            workflowPolicy ||
            (params.surfaceProtocolResolver?.resolve(next.requestClient) ?? null) !== null
          ) {
            let capabilityOrigin: AuthenticatedSurfaceOrigin | undefined = next.authenticatedOrigin;
            if (trustedFallbackSurface) {
              const protocol = getBuiltinSurfaceProtocol(trustedFallbackSurface.platform);
              capabilityOrigin = {
                platform: protocol.platform,
                userId: trustedFallbackSurface.userId,
                sessionRef: protocol.refs.createSessionRef(trustedFallbackSurface.sessionId),
              } as AuthenticatedSurfaceOrigin;
            }
            const issuedControl = await params.issueControlCapability?.({
              requestId: next.requestId,
              sessionId: next.sessionId,
              requestClient: next.requestClient,
              profile: runProfile,
              canonicalCwd: workflowPolicy?.cwd ?? cwd,
              safetyMode,
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              ...(capabilityOrigin ? { authenticatedOrigin: capabilityOrigin } : {}),
              ...(next.verifiedIngress === undefined
                ? {}
                : { verifiedIngress: next.verifiedIngress }),
            });
            if (!issuedControl) {
              return signalBusAgentRunnerHostFailure(
                new Error(
                  "Native profile request is missing server-issued Level-2 control authority",
                ),
              );
            }
            controlCapability = issuedControl.capability;
            safetyMode = issuedControl.safetyMode ?? safetyMode;
            if (issuedControl.authenticatedOrigin) {
              trustedFallbackSurface = {
                platform: issuedControl.authenticatedOrigin.platform,
                sessionId: issuedControl.authenticatedOrigin.sessionRef.channelId,
                userId: issuedControl.authenticatedOrigin.userId,
              };
            }
          }

          const additionalSessionPrompts = await waitForPreAgent(
            resolveSessionAdditionalPrompts({
              entries: sessionConfig.additionalPrompts,
              onWarn: (warning) => {
                logger.warn("skipping invalid session additionalPrompts entry", {
                  requestId: next.requestId,
                  sessionId,
                  sessionConfigId,
                  reason: warning.reason,
                  value: warning.value,
                  filePath: warning.filePath,
                  error: warning.error,
                });
              },
            }),
          );

          const heartbeatOverlay = buildHeartbeatOverlayForRequest({
            cfg,
            requestId: next.requestId,
            sessionId: next.sessionId,
            runProfile,
            nowMs: Date.now(),
          });

          const buildSystemPrompt = (
            resolved: ResolvedModelRef,
            editingToolMode: ReturnType<typeof resolveEditingToolMode>,
          ): string =>
            buildAgentRunSystemPrompt({
              cfg,
              runProfile,
              requestClient: next.requestClient,
              resolved,
              editingToolMode,
              skillsSection,
              additionalSessionPrompts,
              messages: next.messages,
              safetyMode,
              sessionId: next.sessionId,
              heartbeatOverlay,
            });

          const workspaceSystemPrompt = selectWorkspaceSystemPrompt({
            profile: runProfile,
            primarySystemPrompt: cfg.agent.systemPrompt,
            workerSystemPrompt: cfg.agent.workerSystemPrompt,
          });

          let seededSessionMessages: ModelMessage[] = [];
          let seededStoredMessages: StoredMessageV1[] = [];
          let seededSessionTranscript: TranscriptSnapshot | null = null;
          const seededToolState: { loadedCatalogIds: string[] } = { loadedCatalogIds: [] };
          if (!next.recovery && runProfile !== "primary" && params.transcriptStore) {
            const loadedTranscript = await captureBusAgentRunnerOperation(
              "subagent continuation transcript load",
              () =>
                stableNamedContinuation
                  ? params.transcriptStore?.getLatestCompleteNamedTranscript?.({
                      requestClient: stableNamedContinuation.requestClient,
                      sessionId: next.sessionId,
                    })
                  : params.transcriptStore?.getLatestTranscriptBySession?.({
                      sessionId: next.sessionId,
                    }),
            );
            const applyLoadedTranscript = loadedTranscript.match<() => void>({
              err: (loadError) => () => {
                logger.warn(
                  "failed to load subagent continuation transcript",
                  formatBridgeTaggedErrorForLog(loadError, {
                    requestId: next.requestId,
                    sessionId: next.sessionId,
                  }),
                );
              },
              ok: (transcript) => () => {
                const applyDecodedTranscript = transcript?.match<() => void>({
                  ok: (latest) => () => {
                    if (!latest || latest.messages.length === 0) return;
                    seededStoredMessages = [...latest.messages];
                    seededSessionTranscript = latest;
                    seededToolState.loadedCatalogIds = [...(latest.loadedCatalogIds ?? [])];
                    logger.info(
                      "subagent continuation seeded from transcript",
                      formatBridgeLogContext({
                        requestId: next.requestId,
                        sessionId: next.sessionId,
                        fromRequestId: latest.requestId,
                        messagesSeeded: latest.messages.length,
                      }),
                    );
                  },
                  err: (error) => () => {
                    logger.warn(
                      "failed to decode subagent continuation transcript",
                      formatBridgeTaggedErrorForLog(error, {
                        requestId: next.requestId,
                        sessionId: next.sessionId,
                      }),
                    );
                  },
                });
                applyDecodedTranscript?.();
              },
            });
            applyLoadedTranscript();
            if (seededStoredMessages.length > 0) {
              const materialized = await materializeStoredMessagesV1({
                messages: seededStoredMessages,
                blobStore: params.blobStore,
                identityProjection: storedMessageIdentity,
              });
              materialized.match({
                ok: (messages) => {
                  seededSessionMessages = messages;
                },
                err: (error) => {
                  logger.warn(
                    "failed to materialize subagent continuation transcript",
                    formatBridgeTaggedErrorForLog(error, {
                      requestId: next.requestId,
                      sessionId: next.sessionId,
                    }),
                  );
                  seededSessionTranscript = null;
                },
              });
            }
          }

          if (runProfile !== "primary" && !next.recovery) {
            toolAuthority.select(seededToolState.loadedCatalogIds);
          }

          const fallbackSurfaceForDelegation = trustedFallbackSurface;
          const executionCwd = path.resolve(workflowPolicy?.cwd ?? cwd);
          let currentTurnUserId = next.currentTurnUserId;
          let currentTurnMessageRef = next.currentTurnMessageRef;
          const listSelectedCatalogIds = () => toolAuthority.snapshot();
          const buildModelBinding = async (resolved: ResolvedModelRef) => {
            let capabilityInfo: ModelCapabilityInfo | null = null;
            let bindingCostEstimateStatus: "estimated" | "unavailable" = "unavailable";
            let bindingCostEstimateReason: string | undefined;
            const capability = await captureBusAgentRunnerOperation(
              "model capability resolution",
              () => waitForPreAgent(modelCapability.resolve(resolved.spec)),
            );
            const applyCapability = capability.match<() => BusAgentRunnerOperationFailed | null>({
              ok: (resolvedCapability) => () => {
                capabilityInfo = resolvedCapability;
                if (resolvedCapability.cost) {
                  bindingCostEstimateStatus = "estimated";
                } else {
                  bindingCostEstimateReason = "model_cost_missing";
                }
                return null;
              },
              err: (error) => () => error,
            });
            const capabilityError = applyCapability();
            if (capabilityError) {
              if (capabilityError.failureKind === "pre-agent-cancelled") {
                return Result.err(capabilityError);
              }
              bindingCostEstimateReason = `capability_resolve_failed:${capabilityError.message}`;
            }

            const editingToolMode = resolveEditingToolMode({
              provider: resolved.provider,
              modelId: resolved.modelId,
            });
            const {
              anthropicPromptCachingEnabled,
              providerOptionsForAgent,
              agentSystem,
              experimentalDownload,
            } = prepareCoreProviderBinding({
              resolved,
              reasoningDisplay:
                resolved.reasoningDisplay ??
                workflowPolicy?.resolvedModelRequest.reasoningDisplay ??
                cfg.agent.reasoningDisplay,
              systemPrompt: buildSystemPrompt(resolved, editingToolMode),
              sessionId,
              blobStore: params.blobStore,
            });
            const resourceProviderTarget = resolveStoredResourceProviderTarget({
              provider: resolved.provider,
              capability: capabilityInfo,
            });
            const level1RequestContext = {
              requestId: next.requestId,
              ...(next.requestDeliveryId ? { requestDeliveryId: next.requestDeliveryId } : {}),
              sessionId: next.sessionId,
              requestClient: next.requestClient,
              subagentDepth: subagentMeta.depth,
              subagentProfile: runProfile,
              safetyMode,
              ...(trustedFallbackSurface
                ? {
                    requestInitiator: {
                      platform: trustedFallbackSurface.platform,
                      userId: trustedFallbackSurface.userId,
                    },
                    requestInitiatorSessionId: trustedFallbackSurface.sessionId,
                  }
                : {}),
              ...(next.requestClient === "native" && next.authenticatedOrigin
                ? {
                    requestInitiator: {
                      platform: "native" as const,
                      userId: next.authenticatedOrigin.userId,
                    },
                    requestInitiatorSessionId: next.sessionId,
                    serverOwnedRequest: next.verifiedIngress === true,
                  }
                : {}),
              currentTurnUserId,
              currentTurnMessageRef,
              metadata: {
                controlCapability: controlCapability ?? undefined,
                readFileDirectImageSupported: resourceProviderTarget.supportsImage,
                readFileDirectPdfSupported: resourceProviderTarget.supportsPdf,
                onActivity: (source: "tool" | "subagent") => markRunActivity(source),
                onSubagentDelegate:
                  workflowSubagentDispatcher &&
                  liveParentSession &&
                  (fallbackSurfaceForDelegation || heartbeatAuthority)
                    ? async (registration: SubagentDelegationRegistration) =>
                        await workflowSubagentDispatcher.delegate({
                          ...registration,
                          projectRoot: executionCwd,
                          fallbackSurface: fallbackSurfaceForDelegation,
                        })
                    : undefined,
              },
            };
            const toolsetResult = await waitForPreAgent(
              params.pluginManager
                .buildLevel1ToolsetResult({
                  cwd: executionCwd,
                  runProfile,
                  editingToolMode:
                    runProfile !== "primary" &&
                    !resolveSubagentPermissionProfile(cfg, runProfile).workspaceWrites
                      ? "none"
                      : editingToolMode,
                  subagentDepth: subagentMeta.depth,
                  subagentConfig: {
                    enabled: subagents.enabled,
                    idleTimeoutMs: deriveSubagentIdleTimeoutMs(cfg.agent.idleTimeoutMs),
                    maxDepth: subagents.maxDepth,
                  },
                  requestContext: level1RequestContext,
                  onMcpImageMaterialized: (reference) => mcpImages.remember(reference),
                  onSelectCatalogIds: (catalogIds) => toolAuthority.select(catalogIds),
                  reportToolStatus: (update) => {
                    void publishAuxiliaryOutput("failed to publish tool status", () =>
                      outputPublisher.publishToolCall(update),
                    );
                  },
                })
                .then(retainLevel1Toolset),
            );
            return toolsetResult.map((toolset) => {
              level1RequestContext.currentTurnUserId = currentTurnUserId;
              level1RequestContext.currentTurnMessageRef = currentTurnMessageRef;
              return {
                resolved,
                capabilityInfo,
                costEstimateStatus: bindingCostEstimateStatus,
                costEstimateReason: bindingCostEstimateReason,
                editingToolMode,
                anthropicPromptCachingEnabled,
                providerOptionsForAgent,
                agentSystem: toolset.mcpDiagnostics
                  ? `${agentSystem}\n\n${toolset.mcpDiagnostics}`
                  : agentSystem,
                experimentalDownload,
                toolset,
                requestContext: level1RequestContext,
                activeToolNames: selectedLevel1ToolNames(toolset, listSelectedCatalogIds()),
              };
            });
          };
          type BuildModelBindingResult = Awaited<ReturnType<typeof buildModelBinding>>;
          type BuiltModelBinding =
            BuildModelBindingResult extends ResultType<infer T, unknown> ? T : never;
          type BuildModelBindingError =
            BuildModelBindingResult extends ResultType<unknown, infer E> ? E : never;

          const initialBinding: ResultType<BuiltModelBinding, BuildModelBindingError> =
            await waitForPreAgent(buildModelBinding(initialResolvedModel));
          let activeBinding = initialBinding.match({
            ok: (value) => () => value,
            err: (error) => () => signalBusAgentRunnerHostFailure(error),
          })();
          const materializeForBinding = async (
            storedMessages: readonly StoredMessageV1[],
            binding: BuiltModelBinding,
            imageReferences?: readonly McpImageCheckpointReference[],
            resourceTarget?: Parameters<typeof materializeStoredMessagesV1>[0]["resourceTarget"],
          ): Promise<ModelMessage[]> =>
            await materializeMcpImageCheckpoint({
              imageRegistry: mcpImages,
              mcpImages: imageReferences,
              messages: storedMessages,
              blobStore: params.blobStore,
              identityProjection: storedMessageIdentity,
              resourceAccess:
                next.requestClient === "native"
                  ? params.nativeResourceAccess?.({
                      requestId: next.requestId,
                      requestDeliveryId: next.requestDeliveryId ?? "",
                      sessionId: next.sessionId,
                      raw: next.raw,
                    })
                  : params.resourceAccess,
              resourceTarget:
                resourceTarget ??
                resolveStoredResourceProviderTarget({
                  provider: binding.resolved.provider,
                  capability: binding.capabilityInfo,
                }),
            }).then((materialized) =>
              materialized.match({
                ok: (messages) => () => messages,
                err: (error) => () => signalBusAgentRunnerHostFailure(error),
              })(),
            );
          next.messages = await materializeForBinding(next.storedMessages, activeBinding);
          if (next.recovery && next.storedRecoveryCheckpoint) {
            next.recovery.checkpointMessages = await materializeForBinding(
              next.storedRecoveryCheckpoint,
              activeBinding,
              next.recoveryMcpImages,
            );
          }
          if (seededStoredMessages.length > 0) {
            seededSessionMessages = await materializeForBinding(
              seededStoredMessages,
              activeBinding,
            );
          }
          if (state.activeRun) {
            state.activeRun.messages = next.messages;
            state.activeRun.materializeStoredMessages = (messages) =>
              materializeForBinding(messages, activeBinding);
          }
          modelCapabilityInfo = activeBinding.capabilityInfo;
          costEstimateStatus = activeBinding.costEstimateStatus;
          costEstimateReason = activeBinding.costEstimateReason;

          logger.info(
            "agent run starting",
            formatBridgeLogContext({
              requestId: next.requestId,
              runProfile,
              safetyMode,
              model: activeBinding.resolved.spec,
              isRecoveryResume: Boolean(next.recovery),
            }),
          );

          let agent: AiSdkPiAgent<ToolSet> | null = null;
          let activeModelIndex = 0;
          let didSwitchModel = false;
          const advanceModel = async () => {
            if (!agent) {
              return signalBusAgentRunnerHostFailure(
                new Error("Model fallback started before the agent was ready"),
              );
            }
            const nextFallback = selectNextNativeModelFallback({
              plan: modelPlan,
              activeIndex: activeModelIndex,
              onSkipClaudeCode: (candidate, index) => {
                logger.warn("skipping claude-code model fallback for native agent run", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: candidate.spec,
                  fallbackIndex: index,
                });
              },
            });
            if (!nextFallback) return { ok: false as const, reason: "model fallback exhausted" };

            const builtNextBinding: ResultType<BuiltModelBinding, BuildModelBindingError> =
              await buildModelBinding(nextFallback.candidate);
            const nextBinding = builtNextBinding.match({
              ok: (value) => () => value,
              err: (error) => () => signalBusAgentRunnerHostFailure(error),
            })();
            const storedCanonicalMessages = storedMessageIdentity
              .project(agent.state.messages)
              .match({
                ok: (messages) => () => messages,
                err: (error) => () => signalBusAgentRunnerHostFailure(error),
              })();
            const reboundMessages = await materializeForBinding(
              storedCanonicalMessages,
              nextBinding,
            );
            agent.replaceMessages(reboundMessages);
            agent.setModel(
              nextBinding.resolved.model,
              nextBinding.providerOptionsForAgent,
              nextBinding.resolved.spec,
              nextBinding.resolved.reasoning,
            );
            agent.setSystem(nextBinding.agentSystem);
            agent.setTools(nextBinding.toolset.tools);
            agent.setActiveTools(nextBinding.activeToolNames);
            agent.setExperimentalDownload(nextBinding.experimentalDownload);
            agent.setGenericOutputNormalizerBypassTools(
              nextBinding.toolset.genericOutputNormalizerBypassTools,
            );
            agent.setAggregateOutputBudgetExemptTools(
              nextBinding.toolset.aggregateOutputBudgetExemptTools,
            );

            nativeOutput?.model(nextBinding.resolved.spec, nextBinding.resolved.reasoning);
            activeBinding = nextBinding;
            setCurrentTurnContext(currentTurnUserId, currentTurnMessageRef);
            activeModelIndex = nextFallback.index;
            didSwitchModel = true;
            modelCapabilityInfo = nextBinding.capabilityInfo;
            costEstimateStatus = nextBinding.costEstimateStatus;
            costEstimateReason = nextBinding.costEstimateReason;
            resolvedModelLabel = nextBinding.resolved.modelId;
            resolvedProviderFamily = classifyHistoryProviderFamily({
              type: nextBinding.resolved.provider,
            });
            if (state.activeRun) {
              state.activeRun.resolvedModelSpec = nextBinding.resolved.spec;
              state.activeRun.resolvedReasoning = nextBinding.resolved.reasoning;
              state.activeRun.resolvedProviderFamily = resolvedProviderFamily;
            }
            return { ok: true as const, modelSpec: nextBinding.resolved.spec };
          };
          const hasNativeModelFallback = supportsCoreModelFallback(
            activeBinding.resolved,
            modelPlan.fallbacks.length,
          );
          const transientRetryController = createTransientModelRetryController({
            retry: cfg.agent.retry,
            logger,
            requestId: headers.request_id,
            sessionId: headers.session_id,
            modelSpec: activeBinding.resolved.spec,
            ...(hasNativeModelFallback ? { advanceModel } : {}),
          });
          const turnErrorHandler = async <ErrorCause>(
            error: ErrorCause,
            errorContext: Parameters<
              NonNullable<Parameters<typeof attachAutoCompaction>[1]["baseTurnErrorHandler"]>
            >[1],
          ) => {
            const projectedError = projectBusAgentRunnerError(error, "Model turn failed");
            const transientDecision = await transientRetryController.handler(error, errorContext);
            if (transientDecision === "retry") return "retry" as const;
            if (
              agentComposition.recoverProtocolFailure(
                new Error(projectedError.message),
                errorContext,
              )
            )
              return "retry" as const;
            return "fail" as const;
          };
          const claudeComposition = await createCoreClaudeComposition({
            cfg,
            runProfile,
            safetyMode,
            next,
            activeBinding,
            executionCwd,
            stableNamedContinuation,
            workflowPolicy,
            workspaceSystemPrompt,
            additionalSessionPrompts,
            skillsSection,
            subagentMeta,
            seededSessionTranscript,
            seededSessionMessages,
            getCurrentTurnMessages: () => initialMessages,
            getLineage: () => state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
            projectCanonicalStoredMessages: (messages) => storedMessageIdentity.project(messages),
            transcriptStore: params.transcriptStore,
            materializeClaudeCodeRun: params.materializeClaudeCodeRun,
            getAgent: () => activeAgent,
            waitForPreAgent,
          });
          claudeCodeRun = claudeComposition.run;
          coreNamedClaudeRuntime = claudeComposition.namedRuntime;
          corePrimaryClaudeRuntime = claudeComposition.primaryRuntime;

          const agentComposition = createCoreAgentComposition({
            diagnosticContext: { requestId: headers.request_id, sessionId: headers.session_id },
            getBinding: () => activeBinding,
            claude: claudeComposition,
            getAgent: () => {
              if (!agent)
                return signalBusAgentRunnerHostFailure(
                  new Error("Agent composition used before construction"),
                );
              return agent;
            },
            runProfile,
            hasNamedContinuation: stableNamedContinuation !== null,
            getLineage: () => state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
            transcriptStore: params.transcriptStore,
            sourceMessages: seededSessionMessages,
            sourceTranscript: seededSessionTranscript,
            sourceProviderState: next.nativeHistoryProviderState,
            getCurrentTurnMessages: () => initialMessages,
            onReplayFallback: (error) =>
              logger.warn(
                "OpenAI server compaction replay failed; retrying portable summary",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: activeBinding.resolved.spec,
                  error: error.message,
                }),
              ),
            onUtilityModelFailure: (error) =>
              logger.warn(
                "Claude utility model construction failed; using model fallback",
                formatBridgeTaggedErrorForLog(error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: activeBinding.resolved.spec,
                  operation: error.operation,
                }),
              ),
          });
          retireProviderForRetry = agentComposition.retireForRetry;
          const agentOptions: AiSdkPiAgentOptions<ToolSet> = agentComposition.configureOptions(
            {
              system: activeBinding.agentSystem,
              model: activeBinding.resolved.model,
              modelSpecifier: activeBinding.resolved.spec,
              messages: next.recovery?.checkpointMessages ?? seededSessionMessages,
              tools: activeBinding.toolset.tools,
              deferredToolNames: () =>
                activeBinding.toolset.catalog.map((entry) => entry.modelName),
              providerOptions: activeBinding.providerOptionsForAgent,
              reasoning: activeBinding.resolved.reasoning,
              turnErrorHandler,
              recoveryCheckpointHandler: (messages, canonicalInputIds) => {
                const activeRun = state.activeRun;
                if (!activeRun || activeRun.requestId !== next.requestId) return;
                enqueueRunCheckpoint(activeRun, messages, canonicalInputIds, storedMessageIdentity);
              },
              normalizeToolResultOutput,
              genericOutputNormalizerBypassTools:
                activeBinding.toolset.genericOutputNormalizerBypassTools,
              aggregateOutputBudgetExemptTools:
                activeBinding.toolset.aggregateOutputBudgetExemptTools,
              experimentalDownload: activeBinding.experimentalDownload,
              debug: {
                captureModelViewMessages: env.debug.contextDump.enabled,
              },
            },
            {
              hasModelFallback: hasNativeModelFallback,
              refreshTools: async () => {
                if (!agent)
                  return signalBusAgentRunnerHostFailure(
                    new Error("Tool refresh started before the agent was ready"),
                  );
                await refreshSelectedLevel1Tools({
                  target: agent,
                  toolset: activeBinding.toolset,
                  listSelectedCatalogIds,
                });
              },
            },
          );
          agent = params.createAgent
            ? params.createAgent(agentOptions)
            : new AiSdkPiAgent<ToolSet>(agentOptions);
          agentComposition.initializeTools(agent, activeBinding.toolset);
          activeAgent = agent;

          const setCurrentTurnContext = (
            userId: string | undefined,
            messageRef: MsgRef | undefined,
          ) => {
            currentTurnUserId = userId;
            currentTurnMessageRef = messageRef;
            if (state.activeRun) state.activeRun.currentTurnUserId = userId;
            if (state.activeRun) state.activeRun.currentTurnMessageRef = messageRef;
            activeBinding.requestContext.currentTurnUserId = userId;
            activeBinding.requestContext.currentTurnMessageRef = messageRef;
            agent?.setContext(activeBinding.requestContext);
          };
          setCurrentTurnContext(next.currentTurnUserId, next.currentTurnMessageRef);
          if (state.activeRun) state.activeRun.setCurrentTurnContext = setCurrentTurnContext;

          // Drain all buffered messages at boundaries (better UX in chat surfaces).
          agent.setFollowUpMode("all");
          agent.setSteeringMode("all");

          const prepareModelView = async (
            messages: readonly ModelMessage[],
            transformContext: TransformMessagesContext,
            fullBudget: boolean,
          ): Promise<ModelMessage[]> => {
            const historyPrepared = agentComposition.prepareHistory(
              messages,
              transformContext,
              fullBudget,
            );
            // First, remove pathological binary blobs from the *model-facing* view.
            const scrubbed = scrubLargeBinaryForModelView(historyPrepared, {
              maxBytesPerPart: cfg.tools.media.maxInlineBytesPerPart,
              maxBytesTotal: cfg.tools.media.maxInlineBytesTotal,
            });

            // Then, compact older tool outputs (placeholder) with session-stable state.
            if (cfg.tools.historicalResultPruning.enabled) {
              const estimatedPrunedTokens = maybeMarkOldToolOutputsCompacted({
                messages: scrubbed,
                compactedToolCallIds: state.compactedToolCallIds,
                protectTokens: cfg.tools.historicalResultPruning.protectTokens,
                minimumTokens: cfg.tools.historicalResultPruning.minimumTokens,
              });
              if (estimatedPrunedTokens > 0) {
                logger.info(
                  "agent.historical_result_pruned",
                  formatBridgeLogContext({
                    requestId: next.requestId,
                    sessionId: next.sessionId,
                    compactedToolCallCount: state.compactedToolCallIds.size,
                    estimatedPrunedTokens,
                  }),
                );
              }
            }

            const compacted = cfg.tools.historicalResultPruning.enabled
              ? applyToolOutputCompactionView({
                  messages: scrubbed,
                  compactedToolCallIds: state.compactedToolCallIds,
                })
              : scrubbed;

            return next.requestClient === "native"
              ? compacted
              : expandConversationReferencesForModel(compacted, cfg.surface.native.publicUrl);
          };
          const toolPruneTransform: PrepareFullModelView = (messages, transformContext) =>
            prepareModelView(messages, transformContext, false);
          const fullBudgetTransform: PrepareFullModelView = (messages, transformContext) =>
            prepareModelView(messages, transformContext, true);
          // History protocol safety is required even when automatic compaction is disabled.
          agent.setPrepareFullModelView(toolPruneTransform);
          agent.setPrepareFullBudgetView(fullBudgetTransform);

          let autoCompactionSeq = 0;
          let activeAutoCompactionToolCallId: string | null = null;
          const publishAutoCompactionToolStatus = (update: {
            toolCallId: string;
            status: "start" | "end";
            display: string;
            ok?: boolean;
            error?: string;
          }) => {
            const publishOne = async () => {
              await publishAuxiliaryOutput("failed to publish auto-compaction tool status", () =>
                outputPublisher.publishToolCall(update),
              );
            };

            auxiliaryOutputTail = auxiliaryOutputTail.then(publishOne);
          };
          const reportServerCompactionError = <Cause>(cause: Cause): void => {
            const error = projectBusAgentRunnerError(cause, "OpenAI server compaction failed");
            logger.warn(
              "OpenAI server compaction failed; using portable summary",
              formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                modelSpec: activeBinding.resolved.spec,
                ...error.details,
                error: error.message,
              }),
            );
          };

          unsubscribeCompaction = await waitForPreAgent(
            attachAutoCompaction(agent, {
              model: activeBinding.resolved.spec,
              ...agentComposition.compaction,
              compactOnStart:
                next.requestClient === "native" &&
                parseNativeRequestMetadata(next.raw)?.compact === true,
              modelCapability,
              resolveCurrentModelSpecifier: () =>
                agent.state.modelSpecifier ?? activeBinding.resolved.spec,
              prepareFullModelView: toolPruneTransform,
              prepareFullBudgetView: fullBudgetTransform,
              baseTurnErrorHandler: turnErrorHandler,
              onServerCompactionError: reportServerCompactionError,
              onUnknownCapability: ({ spec, reason }) => {
                logger.warn("auto-compaction capability unknown; disabling threshold compaction", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: spec,
                  reason,
                });
              },
              onOverflowRecoveryAttempt: ({ spec, attempt, maxAttempts }) => {
                logger.info("auto-compaction overflow recovery retry", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: spec,
                  attempt,
                  maxAttempts,
                });
              },
              onOverflowRecoveryExhausted: ({ spec, attempts, maxAttempts }) => {
                logger.warn("auto-compaction overflow recovery exhausted", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: spec,
                  attempts,
                  maxAttempts,
                });
              },
              onCompactionStart: ({
                spec,
                reason,
                messageCountBefore,
                observedInputTokens,
                inputTokenSource,
                estimatedInputTokens,
                budget,
              }) => {
                autoCompactionSeq += 1;
                activeAutoCompactionToolCallId = buildSyntheticToolCallId({
                  prefix: "auto_compaction",
                  seed: `${headers.request_id}:${autoCompactionSeq}`,
                });

                nativeOutput?.compaction({
                  compactionId: activeAutoCompactionToolCallId,
                  state: "start",
                  beforeCount: messageCountBefore,
                });
                publishAutoCompactionToolStatus({
                  toolCallId: activeAutoCompactionToolCallId,
                  status: "start",
                  display: formatAutoCompactionToolDisplay({
                    phase: "start",
                    messageCountBefore,
                  }),
                });

                logger.info("auto-compaction start", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  subagentDepth: subagentMeta.depth,
                  modelSpec: spec,
                  reason,
                  messageCountBefore,
                  observedInputTokens,
                  inputTokenSource,
                  estimatedInputTokens,
                  inputBudget: budget.inputBudget,
                  safeInputBudget: budget.safeInputBudget,
                  reservedOutputTokens: budget.reservedOutputTokens,
                });
              },
              onCompactionEnd: ({
                spec,
                reason,
                messageCountBefore,
                messageCountAfter,
                estimatedInputTokens,
                estimatedInputTokensAfter,
                durationMs,
                status,
                canonicalReplacement,
              }) => {
                const toolCallId =
                  activeAutoCompactionToolCallId ??
                  buildSyntheticToolCallId({
                    prefix: "auto_compaction",
                    seed: `${headers.request_id}:orphan-end`,
                  });
                activeAutoCompactionToolCallId = null;
                nativeOutput?.compaction({
                  compactionId: toolCallId,
                  state: status === "completed" ? "complete" : "failed",
                  beforeCount: messageCountBefore,
                  afterCount: messageCountAfter,
                });

                publishAutoCompactionToolStatus({
                  toolCallId,
                  status: "end",
                  display: formatAutoCompactionToolDisplay({
                    phase: "end",
                    ok: status === "completed",
                    messageCountBefore,
                    messageCountAfter,
                  }),
                  ok: status === "completed",
                  error: status === "completed" ? undefined : "auto compaction failed",
                });

                const payload = {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  subagentDepth: subagentMeta.depth,
                  modelSpec: spec,
                  reason,
                  status,
                  durationMs,
                  messageCountBefore,
                  messageCountAfter,
                  estimatedInputTokens,
                  estimatedInputTokensAfter,
                };
                if (status === "completed") {
                  completedCompactionCount += 1;
                  if (next.requestClient === "native")
                    params.nativeExecution?.compacted?.(next.requestId, agent.state.messages);
                  if (runProfile === "primary" && next.requestClient === "discord") {
                    const previousLineage =
                      state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                    const mappedCurrentStart = (() => {
                      if (!canonicalReplacement || !previousLineage) return 0;
                      return mapCorePrimaryCompactionCurrentCanonicalStart({
                        previousCurrentCanonicalStart: previousLineage.currentCanonicalStart,
                        replacement: canonicalReplacement,
                      });
                    })();
                    next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                      "compaction-checkpoint-transform",
                      mappedCurrentStart,
                    );
                    if (state.activeRun)
                      state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
                  }
                  logger.info("auto-compaction end", payload);
                  return;
                }
                logger.warn("auto-compaction end", payload);
              },
            }),
          );

          const publishedDeferredCompletionRunIds = new Set<string>();
          let lastBoundaryModelInputMessages: readonly ModelMessage[] = [];
          const drainDeferredCompletions = async (input: {
            modelInputMessages: readonly ModelMessage[];
            abortSignal?: AbortSignal;
          }): Promise<
            ResultType<
              { append: ModelMessage[]; forceNextTurn: boolean },
              BusAgentRunnerOperationFailed
            >
          > => {
            const parentSession = liveParentSession;
            if (!parentSession) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const pendingIdentities = parentSession.listPendingIdentities();
            const consumedBeforeMaterialization = pendingIdentities
              .filter((identity) =>
                hasConsumedDeferredSubagentResult(input.modelInputMessages, identity),
              )
              .map((identity) => identity.runId);
            if (consumedBeforeMaterialization.length > 0) {
              await parentSession.acknowledge(consumedBeforeMaterialization);
            }
            if (input.abortSignal?.aborted) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const queried = await captureBusAgentRunnerOperation(
              "workflow subagent completion query",
              () => parentSession.listPendingSettledAsync(),
            );
            let queryError: BusAgentRunnerOperationFailed | null = null;
            let settled: Awaited<ReturnType<typeof parentSession.listPendingSettledAsync>> = [];
            const applyQuery = queried.match<() => void>({
              ok: (results) => () => {
                settled = results;
              },
              err: (error) => () => {
                queryError = error;
              },
            });
            applyQuery();
            if (queryError) {
              logger.warn(
                "workflow subagent completion query failed; delivery remains pending",
                formatBridgeTaggedErrorForLog(queryError, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
              return Result.err(queryError);
            }

            if (input.abortSignal?.aborted) {
              return Result.ok({ append: [], forceNextTurn: false });
            }

            const completions: WorkflowLiveParentCompletion[] = [];
            for (const result of settled) {
              let completion: WorkflowLiveParentCompletion | null = null;
              let materializationError: BusAgentRunnerErrorProjection | undefined;
              if (result.loaded) {
                const normalized = await captureBusAgentRunnerOperation(
                  "workflow subagent completion materialization",
                  () =>
                    normalizeSubagentFinalText({
                      normalize: normalizeToolResultOutput,
                      finalText: result.completion.finalText,
                      toolCallId: buildSubagentResultToolCallId(result.completion.runId),
                    }),
                );
                completion = normalized.match<WorkflowLiveParentCompletion | null>({
                  ok: (finalText) => ({ ...result.completion, finalText }),
                  err: (error) => {
                    materializationError = {
                      message: error.message,
                      details: error.details,
                    };
                    return null;
                  },
                });
              } else {
                materializationError = projectBusAgentRunnerError(
                  result,
                  "Workflow subagent completion load failed",
                );
              }

              if (completion) {
                if (!parentSession.isPending(completion.runId)) continue;
                parentSession.clearMaterializationFailure(completion.runId);
                completions.push(completion);
                continue;
              }

              const identity = result.loaded ? result.completion : result.identity;
              const errorMessage =
                materializationError?.message ??
                "Workflow subagent completion materialization failed";
              const attempts = parentSession.recordMaterializationFailure(
                identity.runId,
                errorMessage,
              );
              logger.warn(
                "workflow subagent completion materialization failed",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  runId: identity.runId,
                  attempts,
                  maxAttempts: SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS,
                  errorMessage,
                }),
              );
              if (attempts === null || attempts < SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS)
                continue;
              if (!parentSession.isPending(identity.runId)) continue;

              completions.push({
                ...identity,
                status: "failed",
                ok: false,
                finalText: "",
                detail: `subagent result delivery failed after ${attempts} attempts: ${errorMessage}`,
              });
            }

            const deliverableCompletions = completions.filter((completion) =>
              parentSession.isPending(completion.runId),
            );

            const provisionalPlan = planDeferredSubagentBoundary({
              canonicalMessages: agent.state.messages,
              modelInputMessages: input.modelInputMessages,
              completions: deliverableCompletions,
            });

            for (const completion of deliverableCompletions) {
              if (!parentSession.isPending(completion.runId)) continue;
              if (publishedDeferredCompletionRunIds.has(completion.runId)) continue;
              const published = await captureBusAgentRunnerOperation(
                "workflow subagent completion publish",
                () =>
                  outputPublisher.publishToolCall({
                    toolCallId: completion.parentToolCallId,
                    status: "end",
                    display: buildDeferredSubagentDisplay(completion),
                    ok: completion.ok,
                    error: completion.ok
                      ? undefined
                      : (completion.detail ?? `subagent ${completion.status}`),
                  }),
              );
              published.match({
                ok: () => {
                  publishedDeferredCompletionRunIds.add(completion.runId);
                },
                err: (error) => {
                  logger.warn(
                    "workflow subagent completion publish failed",
                    formatBridgeTaggedErrorForLog(error, {
                      runId: completion.runId,
                    }),
                  );
                },
              });
            }

            if (provisionalPlan.consumedRunIds.length > 0 && !input.abortSignal?.aborted) {
              await parentSession.acknowledge(provisionalPlan.consumedRunIds);
            }

            const finalPlan = planDeferredSubagentBoundary({
              canonicalMessages: agent.state.messages,
              modelInputMessages: input.modelInputMessages,
              completions: deliverableCompletions.filter((completion) =>
                parentSession.isPending(completion.runId),
              ),
            });
            if (
              finalPlan.append.length > 0 &&
              runProfile === "primary" &&
              next.requestClient === "discord"
            ) {
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "deferred-result-insertion",
                agent.state.messages.length,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }

            return Result.ok({
              append: finalPlan.append,
              forceNextTurn: finalPlan.forceNextTurn,
            });
          };
          const adaptDeferredDrainToHost = (
            drained: Awaited<ReturnType<typeof drainDeferredCompletions>>,
          ): { append: ModelMessage[]; forceNextTurn: boolean } => {
            const selectDrain = drained.match<
              () => { append: ModelMessage[]; forceNextTurn: boolean }
            >({
              ok: (plan) => () => plan,
              err: () => () => ({ append: [], forceNextTurn: false }),
            });
            return selectDrain();
          };
          const drainJobEvents = async (
            modelInputMessages: readonly ModelMessage[],
          ): Promise<{ append: ModelMessage[]; forceNextTurn: boolean }> => {
            const jobs = params.jobs;
            if (!jobs?.hasPendingEvents(next.sessionId)) {
              return { append: [], forceNextTurn: false };
            }
            const plan = planJobEventBoundary({
              canonicalMessages: agent.state.messages,
              modelInputMessages,
              events: await jobs.pendingEvents(next.sessionId),
            });
            jobs.acknowledgeEvents(plan.consumedJobIds);
            if (
              plan.append.length > 0 &&
              runProfile === "primary" &&
              next.requestClient === "discord"
            ) {
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "deferred-result-insertion",
                agent.state.messages.length,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            return { append: plan.append, forceNextTurn: plan.forceNextTurn };
          };
          let pendingSilentTurnStartIndex: number | null = null;
          const removePendingSilentTurn = () => {
            if (pendingSilentTurnStartIndex === null) return;
            const startIndex = pendingSilentTurnStartIndex;
            pendingSilentTurnStartIndex = null;
            const hasAssistantMessage = agent.state.messages
              .slice(startIndex)
              .some((message) => message.role === "assistant");
            if (!hasAssistantMessage) return;

            const messages = removeSilentAssistantTurnMessages({
              messages: agent.state.messages,
              startIndex,
              messageCount: agent.state.messages.length - startIndex,
            });
            if (runProfile === "primary" && next.requestClient === "discord") {
              const currentCanonicalStart =
                state.activeRun?.corePrimaryLineage?.currentCanonicalStart ??
                next.corePrimaryLineage?.currentCanonicalStart ??
                startIndex;
              next.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
                "silent-turn-removal",
                currentCanonicalStart,
              );
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            agent.replaceMessages(messages);
          };

          agent.setTurnBoundaryHandler(async (context) => {
            removePendingSilentTurn();

            lastBoundaryModelInputMessages = context.modelInputMessages;
            const drained = await drainDeferredCompletions({
              modelInputMessages: context.modelInputMessages,
              abortSignal: context.abortSignal,
            });
            const decision = adaptDeferredDrainToHost(drained);
            const jobEvents = await drainJobEvents(context.modelInputMessages);
            const answers = questionContinuation.drain(
              deferredQuestions(),
              context.modelInputMessages,
            );
            return {
              append: [...decision.append, ...jobEvents.append, ...answers],
              forceNextTurn:
                decision.forceNextTurn || jobEvents.forceNextTurn || answers.length > 0,
            };
          });

          state.agent = agent;

          let finalText = "";
          let stableFinalText = "";
          let stablePartialText = state.activeRun?.partialText ?? "";
          let attemptStartFinalText = stableFinalText;
          let attemptStartPartialText = stablePartialText;
          const currentTurnToolCallIds = new Set<string>();
          let turnTextStartIndex = 0;
          let turnPartialTextStartIndex = stablePartialText.length;
          let pendingNoReplyTurnText = "";
          let pendingNoReplyTurnOutputs: Array<{
            partId: string;
            delta: string;
            phase?: ReturnType<typeof openAIMessagePhase>;
            phaseBoundaryPrefixChars: number;
          }> = [];
          let bufferNoReplyTurnText = true;
          let lastCompletedTurnWasSilent = false;
          let turnFinalAnswerText = "";
          let turnHasFinalAnswerPhase = false;
          let lastCompletedTurnFinalAnswerText: string | undefined;
          let currentTextPhase: ReturnType<typeof openAIMessagePhase>;
          let retainedTextPhase: ReturnType<typeof openAIMessagePhase>;
          const assistantTextPhaseByPartId = new Map<
            string,
            NonNullable<ReturnType<typeof openAIMessagePhase>>
          >();
          const assistantTextPartBoundaryState = createAssistantTextPartBoundaryState(
            next.recovery?.partialText,
          );
          const appendPendingNoReplyOutput = (
            partId: string,
            delta: string,
            phase: ReturnType<typeof openAIMessagePhase>,
            phaseBoundaryPrefixChars: number,
          ): void => {
            const previous = pendingNoReplyTurnOutputs.at(-1);
            if (
              previous !== undefined &&
              previous.partId === partId &&
              previous.phase === phase &&
              phaseBoundaryPrefixChars === 0
            ) {
              previous.delta += delta;
              return;
            }
            pendingNoReplyTurnOutputs.push({
              partId,
              delta,
              phase,
              phaseBoundaryPrefixChars,
            });
          };
          const publishPendingNoReplyOutputs = (): void => {
            for (const output of pendingNoReplyTurnOutputs) {
              nativeOutput?.textStart({
                partId: output.partId,
                stepId: nativeStepId(),
                phase: output.phase,
              });
              nativeOutput?.textDelta(
                output.partId,
                output.delta.slice(output.phaseBoundaryPrefixChars),
              );
              nativeHasText = true;
              outputPublisher.publishText(
                output.delta,
                output.phase,
                output.phaseBoundaryPrefixChars,
              );
            }
            pendingNoReplyTurnOutputs = [];
          };
          const reasoningChunkState: ReasoningChunkState = {
            chunks: new Map<string, string>(),
            seq: 0,
          };
          let retryAttemptHadReasoning = false;

          const toolStartMs = new Map<string, number>();

          const contextDumpEnabled = env.debug.contextDump.enabled;
          const contextDumpDir = env.debug.contextDump.dir;
          let turnEndCount = 0;

          const dumpContextAfterTurn = async (
            event: Extract<AiSdkPiAgentEvent<ToolSet>, { type: "turn_end" }>,
          ) => {
            if (!contextDumpEnabled) return;

            const tsMs = Date.now();
            const safeSessionId = sanitizeFilenameToken(headers.session_id);
            const safeRequestId = sanitizeFilenameToken(headers.request_id);
            const fileName = `${safeSessionId}-${safeRequestId}-${tsMs}.json`;
            const filePath = path.join(contextDumpDir, fileName);

            const modelView = agent.state.debug?.lastModelViewMessages;
            const modelViewTurn = agent.state.debug?.lastModelViewTurn;

            const payload = {
              meta: {
                tsMs,
                ts: new Date(tsMs).toISOString(),
                sessionId: headers.session_id,
                requestId: headers.request_id,
                requestClient: headers.request_client,
                runProfile,
                subagentDepth: subagentMeta.depth,
                modelSpec: activeBinding.resolved.spec,
                modelId: activeBinding.resolved.modelId,
                turnEndIndex: turnEndCount,
                modelViewTurn,
              },
              system: agent.state.system,
              providerOptions: agent.state.providerOptions,
              reasoning: agent.state.reasoning,
              tools: {
                names: Object.keys(agent.state.tools ?? {}),
              },
              usage: {
                lastTurn: event.usage,
                lastTurnTotal: event.totalUsage,
              },
              transcript: {
                messages: agent.state.messages,
              },
              modelViewMessagesForTurn: modelView,
            };

            const dumped = await captureBusAgentRunnerOperation("context dump write", async () => {
              await fs.mkdir(contextDumpDir, { recursive: true });
              await fs.writeFile(filePath, debugJsonStringify(payload), "utf8");
            });
            dumped.match({
              ok: () => {
                logger.debug("context dump wrote", {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  filePath,
                });
              },
              err: (error) => {
                logger.warn(
                  "context dump failed",
                  formatBridgeTaggedErrorForLog(error, {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    filePath,
                  }),
                );
              },
            });
          };

          const estimateUsageCostUsd = (
            usage: LanguageModelUsage | undefined,
          ): number | undefined => {
            if (!usage || !modelCapabilityInfo?.cost) return undefined;
            return modelCapability.estimateCostUsd(modelCapabilityInfo, usage);
          };

          unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
            markRunActivity(
              event.type === "tool_execution_start" ||
                event.type === "tool_execution_update" ||
                event.type === "tool_execution_end"
                ? "tool"
                : "model",
            );

            if (event.type === "agent_end") {
              runStats.totalUsage = event.totalUsage;
              runStats.finalMessages = event.messages;
            }

            if (event.type === "turn_start") {
              runWait.resume();
              nativeStep += 1;
              attemptStartFinalText = stableFinalText;
              attemptStartPartialText = stablePartialText;
              currentTurnToolCallIds.clear();
            }

            if (event.type === "messages_reset") {
              removePendingSilentTurn();
            }

            if (event.type === "turn_end") {
              transientRetryController.reset();
              retryAttemptHadReasoning = false;
              const turnText = finalText.slice(turnTextStartIndex);
              const turnDeliveryText = turnHasFinalAnswerPhase ? turnFinalAnswerText : turnText;
              const silentTurn = resolveReplyDeliveryFromFinalText(turnDeliveryText) === "skip";
              lastCompletedTurnWasSilent = silentTurn;
              lastCompletedTurnFinalAnswerText = turnHasFinalAnswerPhase
                ? turnFinalAnswerText
                : undefined;
              if (silentTurn) {
                nativeOutput?.reset(crypto.randomUUID(), nativeStepId());
                finalText = finalText.slice(0, turnTextStartIndex);
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText = state.activeRun.partialText.slice(
                    0,
                    turnPartialTextStartIndex,
                  );
                }
                void outputPublisher.publishTextReset({
                  text:
                    state.activeRun?.requestId === next.requestId
                      ? state.activeRun.partialText
                      : `${next.recovery?.partialText ?? ""}${finalText}`,
                  ...(retainedTextPhase === undefined ? {} : { phase: retainedTextPhase }),
                });
                pendingSilentTurnStartIndex =
                  agent.state.messages.length - event.newMessages.length;
              } else if (bufferNoReplyTurnText && pendingNoReplyTurnText.length > 0) {
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText += pendingNoReplyTurnText;
                }
                publishPendingNoReplyOutputs();
              }
              if (!silentTurn) retainedTextPhase = currentTextPhase ?? retainedTextPhase;
              const nativeFinishReason =
                event.finishReason === "stop" ||
                event.finishReason === "tool-calls" ||
                event.finishReason === "length"
                  ? event.finishReason
                  : "error";
              nativeOutput?.stepEnd(nativeFinishReason);

              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = finalText.length;
              turnPartialTextStartIndex = state.activeRun?.partialText.length ?? 0;
              stableFinalText = finalText;
              stablePartialText = state.activeRun?.partialText ?? stablePartialText;

              turnEndCount++;
              runStats.lastTurnFinishReason = event.finishReason;
              runStats.lastTurnEndAt = Date.now();

              const roundEstimatedCostUsd = estimateUsageCostUsd(event.usage);
              if (roundEstimatedCostUsd !== undefined) {
                roundEstimatedCostUsdTotal =
                  (roundEstimatedCostUsdTotal ?? 0) + roundEstimatedCostUsd;
                roundEstimatedCostCount += 1;
              }

              logger.debug(
                "agent.round.stats",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  round: turnEndCount,
                  finishReason: event.finishReason,
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  totalTokens: event.usage.totalTokens,
                  cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens,
                  cacheWriteTokens: event.usage.inputTokenDetails.cacheWriteTokens,
                  estimatedCostUsd: roundEstimatedCostUsd,
                  estimatedCostUsdTotal: roundEstimatedCostUsdTotal,
                  modelSpec: activeBinding.resolved.spec,
                  costEstimateStatus:
                    roundEstimatedCostUsd !== undefined ? "estimated" : costEstimateStatus,
                  costEstimateReason:
                    roundEstimatedCostUsd === undefined ? costEstimateReason : undefined,
                }),
              );

              // Fire-and-forget debug dump; do not block the run.
              void dumpContextAfterTurn(event);
            }

            if (event.type === "turn_abort" && event.reason === "interrupt") {
              transientRetryController.reset();
            }

            if (event.type === "turn_abort") {
              nativeOutput?.stepEnd("canceled");
              if (bufferNoReplyTurnText) {
                finalText = finalText.slice(0, turnTextStartIndex);
              }
              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = finalText.length;
              turnPartialTextStartIndex = state.activeRun?.partialText.length ?? 0;
            }

            if (
              event.type === "turn_retry" ||
              (event.type === "messages_reset" && event.reason === "recovery")
            ) {
              nativeOutput?.reset(crypto.randomUUID(), nativeStepId());
              if (event.type === "messages_reset") {
                const retainedToolCallIds = toolCallIdsFromMessages(event.messages);
                const retainsCurrentTurn = [...currentTurnToolCallIds].some((toolCallId) =>
                  retainedToolCallIds.has(toolCallId),
                );
                if (!retainsCurrentTurn) {
                  stableFinalText = attemptStartFinalText;
                  stablePartialText = attemptStartPartialText;
                }
              }
              outputPublisher.flush();
              assistantTextPartBoundaryState.lastTextPartId = null;
              assistantTextPartBoundaryState.pendingTextPartStartIds.clear();
              assistantTextPartBoundaryState.pendingRecoveryTextBoundary =
                event.type === "turn_retry" ? event.hadPartialOutput : true;
              finalText = stableFinalText;
              if (state.activeRun?.requestId === next.requestId) {
                state.activeRun.partialText = stablePartialText;
              }
              pendingNoReplyTurnText = "";
              pendingNoReplyTurnOutputs = [];
              bufferNoReplyTurnText = true;
              turnFinalAnswerText = "";
              turnHasFinalAnswerPhase = false;
              currentTextPhase = undefined;
              assistantTextPhaseByPartId.clear();
              turnTextStartIndex = stableFinalText.length;
              turnPartialTextStartIndex = stablePartialText.length;

              if (event.type === "messages_reset") {
                void outputPublisher.publishTextReset({
                  text: stablePartialText,
                  ...(retainedTextPhase === undefined ? {} : { phase: retainedTextPhase }),
                });
              }

              if (retryAttemptHadReasoning) {
                reasoningChunkState.chunks.clear();
                reasoningChunkState.seq += 1;
                void publishAuxiliaryOutput("failed to clear reasoning after model retry", () =>
                  outputPublisher.publishReasoningBoundary({
                    delta: "",
                    seq: reasoningChunkState.seq,
                  }),
                );
              }
              retryAttemptHadReasoning = false;
            }

            if (event.type === "turn_warnings") {
              streamWarnings.push(...event.warnings);

              logger.warn("model stream warnings", {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                count: event.warnings.length,
                warnings: event.warnings.map((warning) => formatCallWarning(warning)),
              });
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_start"
            ) {
              const phase = openAIMessagePhase(event.assistantMessageEvent.raw.providerMetadata);
              nativeOutput?.textStart({
                partId: event.assistantMessageEvent.id,
                stepId: nativeStepId(),
                phase,
              });
              if (phase !== undefined) {
                assistantTextPhaseByPartId.set(event.assistantMessageEvent.id, phase);
              }
              markAssistantTextPartStarted(
                assistantTextPartBoundaryState,
                event.assistantMessageEvent.id,
              );
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              runStats.firstTextDeltaAt ??= Date.now();
              const phase =
                openAIMessagePhase(event.assistantMessageEvent.raw.providerMetadata) ??
                assistantTextPhaseByPartId.get(event.assistantMessageEvent.id);
              if (phase === "final_answer" && currentTextPhase === "commentary") {
                if (pendingNoReplyTurnText.length > 0) {
                  if (state.activeRun?.requestId === next.requestId) {
                    state.activeRun.partialText += pendingNoReplyTurnText;
                  }
                  publishPendingNoReplyOutputs();
                  pendingNoReplyTurnText = "";
                }
                bufferNoReplyTurnText = true;
              }
              currentTextPhase = phase ?? currentTextPhase;

              const delta = consumeAssistantTextDelta({
                state: assistantTextPartBoundaryState,
                finalText,
                recoveryPartialText: next.recovery?.partialText,
                partId: event.assistantMessageEvent.id,
                delta: event.assistantMessageEvent.delta,
              });
              const phaseBoundaryPrefixChars = Math.max(
                0,
                delta.length - event.assistantMessageEvent.delta.length,
              );

              finalText += delta;
              if (phase === "final_answer") {
                turnHasFinalAnswerPhase = true;
                turnFinalAnswerText += event.assistantMessageEvent.delta;
              }

              if (bufferNoReplyTurnText) {
                pendingNoReplyTurnText += delta;
                appendPendingNoReplyOutput(
                  event.assistantMessageEvent.id,
                  delta,
                  phase,
                  phaseBoundaryPrefixChars,
                );
                if (!isPossibleNoReplyPrefix(pendingNoReplyTurnText)) {
                  bufferNoReplyTurnText = false;
                  if (state.activeRun?.requestId === next.requestId) {
                    state.activeRun.partialText += pendingNoReplyTurnText;
                  }
                  publishPendingNoReplyOutputs();
                  pendingNoReplyTurnText = "";
                }
              } else {
                if (state.activeRun?.requestId === next.requestId) {
                  state.activeRun.partialText += delta;
                }
                nativeOutput?.textStart({
                  partId: event.assistantMessageEvent.id,
                  stepId: nativeStepId(),
                  phase,
                });
                nativeOutput?.textDelta(
                  event.assistantMessageEvent.id,
                  event.assistantMessageEvent.delta,
                );
                nativeHasText = true;
                outputPublisher.publishText(delta, phase, phaseBoundaryPrefixChars);
              }
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_end"
            ) {
              if (!bufferNoReplyTurnText) nativeOutput?.textEnd(event.assistantMessageEvent.id);
              markAssistantTextPartEnded(
                assistantTextPartBoundaryState,
                event.assistantMessageEvent.id,
              );
              assistantTextPhaseByPartId.delete(event.assistantMessageEvent.id);
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_start"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              nativeOutput?.activity({
                activityId: chunkId,
                stepId: nativeStepId(),
                kind: "thinking",
                state: "start",
              });
              retryAttemptHadReasoning = true;
              consumeReasoningChunkEvent(reasoningChunkState, {
                type: "start",
                chunkId,
              });

              void publishAuxiliaryOutput("failed to publish reasoning start", () =>
                outputPublisher.publishReasoningBoundary({ delta: "" }),
              );
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_delta"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              const delta = event.assistantMessageEvent.delta;
              retryAttemptHadReasoning = true;
              const update = consumeReasoningChunkEvent(reasoningChunkState, {
                type: "delta",
                chunkId,
                delta,
              });
              if (update.publishStart) {
                void publishAuxiliaryOutput("failed to publish implicit reasoning start", () =>
                  outputPublisher.publishReasoningBoundary({ delta: "" }),
                );
              }

              if (update.snapshot) {
                outputPublisher.publishReasoningSnapshot(update.snapshot, Buffer.byteLength(delta));
              }
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "thinking_end"
            ) {
              const chunkId = event.assistantMessageEvent.id;
              const reasoning = reasoningChunkState.chunks.get(chunkId)?.trim();
              nativeOutput?.activity({
                activityId: chunkId,
                stepId: nativeStepId(),
                kind: "thinking",
                state: "complete",
                ...(reasoning ? { detail: reasoning } : {}),
              });
              consumeReasoningChunkEvent(reasoningChunkState, {
                type: "end",
                chunkId,
              });
              outputPublisher.flush();
            }

            if (event.type === "tool_execution_start") {
              runWait.toolStarted(
                event.toolCallId,
                nativeToolOnlyWaits({ toolName: event.toolName, event }),
              );
              if (nativeOutput)
                publishNativeToolActivity(
                  event.toolCallId,
                  "start",
                  nativeToolActivityLabel({ toolName: event.toolName, event }),
                  undefined,
                  nativeToolActivityDetail({ toolName: event.toolName, event }),
                );
              const startedAt = Date.now();
              toolStartMs.set(event.toolCallId, startedAt);
              currentTurnToolCallIds.add(event.toolCallId);
              state.activeRun?.activeTools.set(event.toolCallId, {
                toolName: event.toolName,
                startedAt,
              });

              {
                void publishAuxiliaryOutput("failed to publish tool start", () =>
                  outputPublisher.publishToolCall({
                    toolCallId: event.toolCallId,
                    status: "start",
                    display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, undefined, activeBinding.toolset.specs, undefined, event)}`,
                  }),
                );
              }
            }

            if (event.type === "tool_execution_end") {
              runWait.toolEnded(event.toolCallId);
              state.activeRun?.activeTools.delete(event.toolCallId);
              const started = toolStartMs.get(event.toolCallId);
              const toolDurationMs = started ? Date.now() - started : undefined;
              const toolFailure = summarizeToolFailure({
                toolName: event.toolName,
                isError: event.isError,
                event,
                toolSpecs: activeBinding.toolset.specs,
              });
              const deferredAccepted =
                event.toolName === "subagent_delegate" &&
                decodeDeferredSubagentAcceptedResult(event) !== null;

              let ok: boolean;
              switch (event.toolName) {
                case "subagent_delegate":
                  ok = getSubagentOkFromResult(event) ?? toolFailure.ok;
                  break;
                default:
                  ok = toolFailure.ok;
                  break;
              }
              if (nativeOutput)
                publishNativeToolActivity(
                  event.toolCallId,
                  "end",
                  nativeToolActivityLabel({ toolName: event.toolName, event }),
                  ok,
                  {
                    ...nativeToolActivityDetail({ toolName: event.toolName, event }),
                    ...nativeToolActivityResult({ toolName: event.toolName, event }),
                    ...(toolDurationMs === undefined ? {} : { durationMs: toolDurationMs }),
                  },
                );
              const interruptedForShutdown = shutdownAbortRequestIds.has(headers.request_id);
              const toolFailureError = toolFailure.error ?? "tool failed";

              if (!ok) {
                logger.warn(
                  "tool call failed",
                  formatBridgeLogContext({
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    durationMs: toolDurationMs,
                    failureKind: toolFailure.failureKind ?? "soft",
                    failureClass: toolFailure.failureClass,
                    failureCode: toolFailure.failureCode,
                    retryable: toolFailure.retryable,
                    exitCode: toolFailure.exitCode,
                    error: interruptedForShutdown ? "server shutting down" : toolFailureError,
                    argsPreview: formatToolLogPreview({
                      toolName: event.toolName,
                      event,
                      field: "args",
                    }),
                    resultPreview: formatToolLogPreview({
                      toolName: event.toolName,
                      event,
                      field: "result",
                    }),
                  }),
                );
              }

              const toolCompletionLogContext = formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                ok,
                deferredAccepted,
                durationMs: toolDurationMs,
                failureKind: ok ? undefined : (toolFailure.failureKind ?? "soft"),
                failureClass: ok ? undefined : toolFailure.failureClass,
                failureCode: ok ? undefined : toolFailure.failureCode,
                retryable: ok ? undefined : toolFailure.retryable,
                exitCode: ok ? undefined : toolFailure.exitCode,
              });
              if (
                shouldLogLevel1ToolCompletionAtInfo(event.toolName, activeBinding.toolset.catalog)
              ) {
                logger.info("tool finished", toolCompletionLogContext);
              } else {
                logger.debug("tool finished", toolCompletionLogContext);
              }

              if (deferredAccepted) {
                return;
              }

              let publishedToolError: string | undefined;
              if (!ok) {
                publishedToolError = interruptedForShutdown
                  ? "server shutting down"
                  : toolFailureError;
              }
              void publishAuxiliaryOutput("failed to publish tool end", () =>
                outputPublisher.publishToolCall({
                  toolCallId: event.toolCallId,
                  status: "end",
                  display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, undefined, activeBinding.toolset.specs, undefined, event)}`,
                  ok,
                  error: publishedToolError,
                }),
              );
            }

            if (event.type === "agent_end") {
              // Best-effort fallback: if deltas didn't populate finalText, take last assistant string.
              if (!finalText) {
                const last = event.messages[event.messages.length - 1];
                if (last && last.role === "assistant") {
                  if (typeof last.content === "string") {
                    finalText = last.content;
                  } else {
                    const buf: string[] = [];
                    for (const part of last.content) {
                      if (part.type !== "text") continue;
                      buf.push(part.text);
                    }
                    finalText = buf.join("\n\n");
                  }
                }
              }
            }
          });

          if (next.recovery) {
            const recoveredQueuedControls = await materializeForBinding(
              recoveredQueuedControlStoredMessages,
              activeBinding,
            );
            initialMessages = [
              buildResumePrompt(next.recovery.partialText),
              ...recoveredQueuedControls,
            ];
            responseStartIndex = agent.state.messages.length + initialMessages.length;
          } else if (parsedCustomCommand) {
            initialMessages = [...next.messages];
            agent.appendMessages(initialMessages);
            responseStartIndex = agent.state.messages.length;
            const commandModel = activeBinding.resolved.model;
            const commandProvider =
              typeof commandModel === "string" ? "gateway" : commandModel.provider.split(".")[0]!;
            if (customCommandInput)
              agent.appendMessages(
                buildCustomCommandMessages({
                  ...customCommandInput,
                  provider:
                    activeBinding.resolved.provider === "codex" ? "openai" : commandProvider,
                }),
              );
          } else {
            // First message should be a prompt.
            // If additional messages for the same request id were queued before the run started,
            // merge them into the initial prompt so they don't become separate runs.
            const coalesced = mergeQueuedForSameRequest(next, state.queue, reservedQueueEntries);
            const mergedInitial = await materializeForBinding(
              coalesced.storedMessages,
              activeBinding,
            );
            state.activeRun?.setCurrentTurnContext(
              next.currentTurnUserId,
              next.currentTurnMessageRef,
            );
            for (const discarded of coalesced.discarded) {
              if (discarded.requestDeliveryId && state.activeRun) {
                state.activeRun.retainedRequestDeliveries.set(discarded.requestDeliveryId, {
                  kind: "completed",
                  code: "coalesced-into-active-run",
                });
                state.activeRun.checkpointedRetainedRequestDeliveryIds.add(
                  discarded.requestDeliveryId,
                );
                for (const retained of discarded.retainedRequestDeliveries ?? []) {
                  state.activeRun.retainedRequestDeliveries.set(
                    retained.requestDeliveryId,
                    retained.outcome,
                  );
                  state.activeRun.checkpointedRetainedRequestDeliveryIds.add(
                    retained.requestDeliveryId,
                  );
                }
                state.activeRun.storedMessages = [
                  ...state.activeRun.storedMessages,
                  ...discarded.storedMessages,
                ];
              }
              if (discarded.identityOwner)
                requestMessageCache.releaseOwner(discarded.identityOwner);
            }
            if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            const control = parseRequestControlFromRaw(next.raw);
            const reportAutoInjectedThreadSearchError = (
              message: string,
              error: BusAgentRunnerErrorProjection,
            ): void => {
              logger.warn(message, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                ...error.details,
                error: error.message,
              });
            };
            const autoInjectedThreadSearchMessages =
              runProfile === "primary" &&
              !isHeartbeatSessionId(headers.session_id) &&
              !control.cancel &&
              !control.requiresActive
                ? await waitForPreAgent(
                    maybeBuildAutoInjectedThreadSearchMessages({
                      surface: next.requestClient === "native" ? "native" : "discord",
                      cfg,
                      conversationThreads:
                        next.requestClient === "native"
                          ? params.nativeConversationThreads?.({
                              requestId: next.requestId,
                              requestDeliveryId: next.requestDeliveryId ?? "",
                              sessionId: next.sessionId,
                              raw: next.raw,
                            })
                          : params.conversationThreads,
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      raw: next.raw,
                      previousMessages: agent.state.messages,
                      userMessages: mergedInitial,
                      loadDecisionUserMessages: coalesced.storedMessages.some(
                        (message) =>
                          message.role === "user" &&
                          Array.isArray(message.content) &&
                          message.content.some(
                            (part) => part.type === "resource" || part.type === "blob",
                          ),
                      )
                        ? () =>
                            materializeForBinding(
                              coalesced.storedMessages,
                              activeBinding,
                              undefined,
                              { family: "ai-sdk", supportsImage: true, supportsPdf: false },
                            )
                        : undefined,
                      publishToolStatus: publishNonAgentToolStatus,
                      onError: reportAutoInjectedThreadSearchError,
                      onDecisionEvaluated: (event) => {
                        logger.info("conversation.thread.auto_inject.gate", {
                          requestId: headers.request_id,
                          sessionId: headers.session_id,
                          ...event,
                        });
                      },
                      onInjected: (event) => {
                        logger.info("conversation.thread.auto_inject.appended", {
                          requestId: headers.request_id,
                          sessionId: headers.session_id,
                          toolCallId: event.toolCallId,
                          mode: event.mode,
                          limit: event.limit,
                          minScore: event.minScore,
                          searchCount: event.searches.length,
                          queryCount: event.searches.reduce(
                            (sum, queries) => sum + queries.length,
                            0,
                          ),
                          searches: event.searches,
                          participantFilterUserCount: event.participantFilterUserCount,
                          appendedCount: event.entries.length,
                          entries: event.entries,
                          ranking: event.ranking,
                          highestRejectedByConfidence: event.highestRejectedByConfidence,
                          expansionMinConfidence: event.expansionMinConfidence,
                          corpusDocumentCount: event.corpusDocumentCount,
                        });
                      },
                    }),
                  )
                : [];
            initialMessages = [...mergedInitial, ...autoInjectedThreadSearchMessages];
            if (
              autoInjectedThreadSearchMessages.length > 0 &&
              runProfile === "primary" &&
              next.requestClient === "discord"
            ) {
              next.corePrimaryLineage = appendAutoInjectedThreadSearchLineage({
                lineage: next.corePrimaryLineage,
                canonicalMessages: mergedInitial,
                injectedMessages: autoInjectedThreadSearchMessages,
              });
              if (state.activeRun) state.activeRun.corePrimaryLineage = next.corePrimaryLineage;
            }
            initialMessagesEndWithGeneratedContext = autoInjectedThreadSearchMessages.length > 0;
            responseStartIndex = agent.state.messages.length + initialMessages.length;
          }

          if (cancelledByRequestId.has(headers.request_id)) {
            requestTerminalKind = "cancelled";
            const finalText = "Cancelled.";
            await publishCurrentLifecycle({
              state: "cancelled",
              detail: "cancelled by interrupt",
              output: finalText,
            });
            await publishTerminalResponseText({ finalText });
            return;
          }

          // Events waiting since the last run reach the model with this run's first turn.
          const startingJobEvents = (await drainJobEvents([])).append;
          if (startingJobEvents.length > 0) {
            if (parsedCustomCommand) {
              agent.appendMessages(startingJobEvents);
              responseStartIndex = agent.state.messages.length;
            } else {
              initialMessages = [...initialMessages, ...startingJobEvents];
              initialMessagesEndWithGeneratedContext = true;
              responseStartIndex += startingJobEvents.length;
            }
          }

          // The drain abort pass may have run while setup awaited, before the agent could stop.
          if (shutdownAbortRequestIds.delete(headers.request_id)) {
            return signalBusAgentRunnerHostFailure(new ShutdownDrainingAbort());
          }
          if (state.activeRun) state.activeRun.started = true;
          runIdleWatchdog?.start();

          if (parsedCustomCommand) {
            await waitForRunAtHost(agent.continue());
          } else if (initialMessagesEndWithGeneratedContext) {
            agent.appendMessages(initialMessages);
            await waitForRunAtHost(agent.continue());
          } else {
            await waitForRunAtHost(agent.prompt(initialMessages));
          }

          while (true) {
            await waitForRunAtHost(agent.waitForIdle());

            if (shutdownAbortRequestIds.delete(headers.request_id)) {
              return signalBusAgentRunnerHostFailure(new ShutdownDrainingAbort());
            }

            if (cancelledByRequestId.has(headers.request_id)) break;
            const continuationWaitVersion = continuationSignalVersion;
            const deferredWaitState = liveParentSession?.snapshot();

            if (liveParentSession && deferredWaitState?.hasPendingCompletions) {
              const drained = await drainDeferredCompletions({
                modelInputMessages: lastBoundaryModelInputMessages,
              });
              const decision = adaptDeferredDrainToHost(drained);
              if (decision.append.length > 0) agent.appendMessages(decision.append);
              if (cancelledByRequestId.has(headers.request_id)) break;
              if (decision.append.length > 0 || decision.forceNextTurn) {
                await waitForRunAtHost(agent.continue());
              } else if (liveParentSession.snapshot().hasPendingCompletions) {
                await waitForRunAtHost(
                  waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
                );
              }
              continue;
            }

            // The agent has gone idle, so it has seen every event already in its history.
            const jobEvents = await drainJobEvents(agent.state.messages);
            if (cancelledByRequestId.has(headers.request_id)) break;
            if (jobEvents.append.length > 0) {
              agent.appendMessages(jobEvents.append);
              await waitForRunAtHost(agent.continue());
              continue;
            }

            const questions = deferredQuestions();
            const answers = questionContinuation.drain(questions, agent.state.messages);
            if (answers.length > 0) {
              agent.appendMessages(answers);
              await waitForRunAtHost(agent.continue());
              continue;
            }
            if (questions.some((question) => question.state === "pending")) {
              runWait.enterIdleWait();
              runIdleWatchdog?.pause();
              if (liveParentSession && deferredWaitState?.hasOutstandingRuns) {
                await waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion);
              } else {
                await waitForContinuationSignalSince(continuationWaitVersion);
              }
              runIdleWatchdog?.start();
              if (cancelledByRequestId.has(headers.request_id)) break;
              continue;
            }
            if (params.jobs?.hasActiveAwait(next.requestId)) {
              runWait.enterIdleWait();
              runIdleWatchdog?.pause();
              await waitForDeferredWake(
                deferredWaitState?.signalVersion ?? 0,
                continuationWaitVersion,
              );
              runIdleWatchdog?.start();
              if (cancelledByRequestId.has(headers.request_id)) break;
              continue;
            }
            if (!deferredWaitState?.hasOutstandingRuns) {
              break;
            }
            if (!liveParentSession) break;

            runWait.enterIdleWait();
            await waitForRunAtHost(
              waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
            );
            if (agent.state.isStreaming) {
              continue;
            }
          }
          runWait.resume();
          runIdleWatchdog?.stop();

          let isCancelled = cancelledByRequestId.has(headers.request_id);
          if (isCancelled) coreNamedClaudeRuntime?.markTerminalFailure(true);
          if (isCancelled) corePrimaryClaudeRuntime?.markTerminalFailure(true);
          if (isCancelled && !finalText) {
            finalText = "Cancelled.";
          }

          const terminalDeliveryText = isCancelled
            ? finalText
            : (lastCompletedTurnFinalAnswerText ?? finalText);
          const isHeartbeatAckOnly =
            isHeartbeatSessionId(headers.session_id) && isHeartbeatAckText(terminalDeliveryText);
          const delivery =
            finalText.length === 0 && lastCompletedTurnWasSilent
              ? "skip"
              : resolveReplyDeliveryFromFinalText(terminalDeliveryText);
          if (
            !isCancelled &&
            delivery !== "skip" &&
            !isHeartbeatAckOnly &&
            finalText.length === 0
          ) {
            return signalBusAgentRunnerHostFailure(
              new Error(
                buildNoAssistantTextError({
                  provider: activeBinding.resolved.provider,
                  modelId: activeBinding.resolved.modelId,
                  finishReason: runStats.lastTurnFinishReason,
                  warningSummary: summarizeCallWarnings(streamWarnings) ?? undefined,
                }),
              ),
            );
          }

          const shouldSkipSurfaceReply = delivery === "skip" || isHeartbeatAckOnly;
          if (shouldSkipSurfaceReply) {
            logger.info("agent requested skip reply", {
              requestId: headers.request_id,
              sessionId: headers.session_id,
            });
            finalText = "";
          }

          const transcriptStore = params.transcriptStore;
          if (
            transcriptStore &&
            (!shouldSkipSurfaceReply || runProfile !== "primary" || next.requestClient === "native")
          ) {
            const persistedTranscript = await captureBusAgentRunnerOperation(
              "successful transcript persistence",
              async () => {
                const finalMessagesForPersistence = runStats.finalMessages ?? agent.state.messages;
                const checkpointMeta = resolveCompactionCheckpointMeta({
                  runSucceeded: true,
                  isPrimary: runProfile === "primary",
                  isCancelled,
                  shouldSkipSurfaceReply,
                  completedCompactionCount,
                });
                const isCompactionCheckpoint = checkpointMeta !== undefined;
                const persistenceCandidates = (() => {
                  if (isHeartbeatSessionId(headers.session_id)) {
                    return buildPersistedHeartbeatMessages(finalText);
                  }

                  return selectPersistedTranscriptMessages({
                    finalMessages: finalMessagesForPersistence,
                    responseStartIndex,
                    isPrimary: runProfile === "primary" && next.requestClient !== "native",
                    didCompact: isCompactionCheckpoint,
                  });
                })();
                const persistedMessages = await projectTranscriptMessagesForPersistence({
                  identityProjection: storedMessageIdentity,
                  providerMessages: persistenceCandidates,
                  blobStore: params.blobStore,
                  transcriptStore,
                });
                const targetProviderFamily = classifyHistoryProviderFamily({
                  type: activeBinding.resolved.provider,
                });
                let providerState: HistoryProviderState | undefined;
                if (runProfile === "primary") {
                  providerState = resolveCorePrimaryTranscriptProviderState({
                    targetFamily: targetProviderFamily,
                    lineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                    transcriptStore,
                  });
                } else if (stableNamedContinuation && !isCancelled) {
                  const sourceProviderState =
                    seededSessionTranscript === null
                      ? "empty-history"
                      : (seededSessionTranscript.providerState ?? "unknown-populated-history");
                  providerState = advanceHistoryProviderState(
                    sourceProviderState,
                    targetProviderFamily,
                  );
                }
                const terminalPrimaryLineage =
                  state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                const canPublishCorePrimaryClaude =
                  corePrimaryClaudeRuntime !== null &&
                  terminalPrimaryLineage?.state === "complete" &&
                  !isCompactionCheckpoint;

                const savedTranscript = transcriptStore.saveRequestTranscript({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  requestClient: headers.request_client,
                  messages: persistedMessages,
                  finalText,
                  modelLabel: resolvedModelLabel,
                  contextMeta: checkpointMeta,
                  loadedCatalogIds: toolAuthority.snapshot(),
                  ...(providerState && !coreNamedClaudeRuntime && !canPublishCorePrimaryClaude
                    ? { providerState }
                    : {}),
                  ...(runProfile === "primary"
                    ? persistedCompleteLineage(terminalPrimaryLineage)
                    : {}),
                  ...(stableNamedContinuation && !isCancelled && !coreNamedClaudeRuntime
                    ? {
                        stableNamedRequestClient: stableNamedContinuation.requestClient,
                      }
                    : {}),
                });
                const saveError = savedTranscript.match({
                  ok: () => null,
                  err: (error) => error,
                });
                if (saveError) {
                  coreNamedClaudeRuntime?.markTerminalFailure(false);
                  corePrimaryClaudeRuntime?.markTerminalFailure(false);
                  logger.error(
                    "failed to persist transcript",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      errorTag: saveError.name,
                      errorMessage: saveError.message,
                    }),
                  );
                  return signalBusAgentRunnerHostFailure(saveError);
                }
                if (coreNamedClaudeRuntime && !isCancelled) {
                  if (!providerState) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Core named Claude finalization requires provider history state"),
                    );
                  }
                  const verified = transcriptStore.getRequestTranscript?.({
                    requestId: headers.request_id,
                  });
                  const verifiedTranscript =
                    verified?.match({
                      ok: (value) => value,
                      err: () => null,
                    }) ?? null;
                  const expectedHash = requireStoredMessageHash(persistedMessages);
                  if (
                    !verifiedTranscript ||
                    verifiedTranscript.messages.length !== persistedMessages.length ||
                    requireStoredMessageHash(verifiedTranscript.messages) !== expectedHash
                  ) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("persisted Core named transcript failed canonical re-read"),
                    );
                  }
                  const canonicalMessages = await materializeStoredMessagesV1({
                    messages: persistedMessages,
                    blobStore: params.blobStore,
                    identityProjection: storedMessageIdentity,
                  }).then((result) =>
                    result.match({
                      ok: (messages) => () => messages,
                      err: (error) => () => signalBusAgentRunnerHostFailure(error),
                    })(),
                  );
                  const promoted = await coreNamedClaudeRuntime.finalize({
                    terminalTranscript: verifiedTranscript,
                    canonicalMessages,
                    storedCanonicalMessages: persistedMessages,
                    providerState,
                    isCancellationRequested: () => cancelledByRequestId.has(headers.request_id),
                  });
                  const cancelledDuringFinalization = cancelledByRequestId.has(headers.request_id);
                  isCancelled ||= cancelledDuringFinalization;
                  logger.info(
                    "Core named Claude binding promotion",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      promoted,
                    }),
                  );
                }
                if (corePrimaryClaudeRuntime && !isCancelled && canPublishCorePrimaryClaude) {
                  if (!providerState) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Core primary Claude finalization requires provider history state"),
                    );
                  }
                  const verified = transcriptStore.getRequestTranscript?.({
                    requestId: headers.request_id,
                  });
                  const verifiedManifest = transcriptStore.getCorePrimaryLineageManifest?.({
                    requestId: headers.request_id,
                  });
                  const verifiedTranscript =
                    verified?.match({
                      ok: (value) => value,
                      err: () => null,
                    }) ?? null;
                  const manifest =
                    verifiedManifest?.match({
                      ok: (value) => value,
                      err: () => null,
                    }) ?? null;
                  const expectedHash = requireStoredMessageHash(persistedMessages);
                  const terminalCanonicalMessages = runStats.finalMessages ?? agent.state.messages;
                  if (
                    !verifiedTranscript ||
                    !manifest ||
                    verifiedTranscript.providerState != null ||
                    verifiedTranscript.messages.length !== persistedMessages.length ||
                    requireStoredMessageHash(verifiedTranscript.messages) !== expectedHash
                  ) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("persisted Core primary transcript failed canonical re-read"),
                    );
                  }
                  const promoted = await corePrimaryClaudeRuntime.finalize({
                    terminalTranscript: verifiedTranscript,
                    canonicalMessages: terminalCanonicalMessages,
                    providerState,
                    isCancellationRequested: () => cancelledByRequestId.has(headers.request_id),
                  });
                  const cancelledDuringFinalization = cancelledByRequestId.has(headers.request_id);
                  isCancelled ||= cancelledDuringFinalization;
                  logger.info(
                    "Core primary Claude binding promotion",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      promoted,
                    }),
                  );
                } else if (corePrimaryClaudeRuntime && !isCancelled) {
                  corePrimaryClaudeRuntime.markTerminalFailure(false);
                }
                if (isCompactionCheckpoint) {
                  transcriptHasCompactionCheckpoint = true;
                  logger.info(
                    "compaction checkpoint persisted",
                    formatBridgeLogContext({
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      messageCount: persistedMessages.length,
                      compactionCount: completedCompactionCount,
                      formatVersion: COMPACTION_CHECKPOINT_FORMAT_VERSION,
                    }),
                  );
                }
              },
            );
            const persistError = persistedTranscript.match({
              ok: () => null,
              err: (error) => error,
            });
            if (persistError) {
              coreNamedClaudeRuntime?.markTerminalFailure(false);
              corePrimaryClaudeRuntime?.markTerminalFailure(false);
              logger.error(
                "failed to persist transcript",
                formatBridgeTaggedErrorForLog(persistError, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
              return signalBusAgentRunnerHostFailure(persistError);
            }
          }
          if (corePrimaryClaudeRuntime && shouldSkipSurfaceReply) {
            corePrimaryClaudeRuntime.markTerminalFailure(false);
          }

          // Build stats in the js-llmcord-ish one-liner format.
          const endAt = runStats.lastTurnEndAt ?? Date.now();
          const ttftMs = runStats.firstTextDeltaAt
            ? runStats.firstTextDeltaAt - runStartedAt
            : null;
          const outputTokens = runStats.totalUsage?.outputTokens;
          const rawTps =
            typeof outputTokens === "number" &&
            runStats.lastTurnFinishReason === "stop" &&
            endAt > runStartedAt
              ? outputTokens / ((endAt - runStartedAt) / 1000)
              : null;
          const tps = rawTps !== null && Number.isFinite(rawTps) ? rawTps : null;

          const responseMessages = runStats.finalMessages
            ? runStats.finalMessages.slice(responseStartIndex)
            : [];

          if (transcriptStore && isHeartbeatSessionId(headers.session_id)) {
            const persistedHandoffs = await captureBusAgentRunnerOperation(
              "heartbeat handoff transcript persistence",
              () =>
                persistHeartbeatSurfaceHandoffs({
                  logger,
                  transcriptStore,
                  requestId: headers.request_id,
                  requestClient: headers.request_client,
                  sessionId: headers.session_id,
                  modelLabel: resolvedModelLabel,
                  responseMessages,
                }),
            );
            const handoffError = persistedHandoffs.match({
              ok: () => null,
              err: (error) => error,
            });
            if (handoffError) {
              logger.error(
                "failed to persist heartbeat handoff transcripts",
                formatBridgeTaggedErrorForLog(handoffError, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            }
          }

          const icLine = buildInputCompositionLine({
            system: systemPromptToText(agent.state.system),
            initialMessages,
            responseMessages,
            tools: agent.state.tools,
          });

          const modelLabel = activeBinding.resolved.modelId;
          const statsForNerds = getStatsForNerdsOptions(cfg.agent.statsForNerds);
          const statsForNerdsLine = statsForNerds.enabled
            ? buildStatsLine({
                modelLabel,
                usage: runStats.totalUsage,
                ttftMs,
                tps,
                icLine: statsForNerds.verbose ? icLine : null,
              })
            : undefined;

          const estimatedCostUsdFromTotalUsage = didSwitchModel
            ? undefined
            : estimateUsageCostUsd(runStats.totalUsage);
          const estimatedCostUsdTotal =
            estimatedCostUsdFromTotalUsage ?? roundEstimatedCostUsdTotal;
          const resolvedCostEstimateStatus =
            estimatedCostUsdTotal !== undefined ? "estimated" : costEstimateStatus;
          const resolvedCostEstimateReason =
            estimatedCostUsdTotal !== undefined ? undefined : costEstimateReason;

          await publishCurrentLifecycle({
            state: isCancelled ? "cancelled" : "resolved",
            detail: isCancelled ? "cancelled by interrupt" : undefined,
            output: finalText,
            usage: runStats.totalUsage
              ? {
                  inputTokens: runStats.totalUsage.inputTokens ?? 0,
                  outputTokens: runStats.totalUsage.outputTokens ?? 0,
                  totalTokens: runStats.totalUsage.totalTokens ?? 0,
                }
              : undefined,
          });

          await publishTerminalResponseText(
            {
              finalText,
              delivery,
              statsForNerdsLine,
              usage: runStats.totalUsage
                ? {
                    inputTokens: runStats.totalUsage.inputTokens ?? 0,
                    outputTokens: runStats.totalUsage.outputTokens ?? 0,
                    totalTokens: runStats.totalUsage.totalTokens ?? 0,
                  }
                : undefined,
            },
            isCancelled ? "cancelled" : "completed",
          );
          logger.info(
            "agent run resolved",
            formatBridgeLogContext({
              requestId: headers.request_id,
              model: activeBinding.resolved.spec,
              durationMs: Date.now() - runStartedAt,
              turns: turnEndCount,
              transcriptMessageCount: (runStats.finalMessages ?? agent.state.messages).length,
              transcriptHasCompactionCheckpoint,
              finalTextChars: finalText.length,
              ttftMs,
              tokensPerSecond: tps,
              inputComposition: icLine,
              inputTokens: runStats.totalUsage?.inputTokens,
              outputTokens: runStats.totalUsage?.outputTokens,
              totalTokens: runStats.totalUsage?.totalTokens,
              noCacheTokens: runStats.totalUsage?.inputTokenDetails.noCacheTokens,
              cacheReadTokens: runStats.totalUsage?.inputTokenDetails.cacheReadTokens,
              cacheWriteTokens: runStats.totalUsage?.inputTokenDetails.cacheWriteTokens,
              textTokens: runStats.totalUsage?.outputTokenDetails.textTokens,
              reasoningTokens: runStats.totalUsage?.outputTokenDetails.reasoningTokens,
              estimatedCostUsd: estimatedCostUsdTotal,
              costEstimateStatus: resolvedCostEstimateStatus,
              costEstimateReason: resolvedCostEstimateReason,
              estimatedCostTurnCoverage:
                turnEndCount > 0 ? roundEstimatedCostCount / turnEndCount : undefined,
            }),
          );
        },
        (panic) => {
          terminalPanic = panic;
        },
      );
      const runFailure = runResult.match({
        ok: () => null,
        err: (error) => error,
      });
      if (runFailure) {
        if (requiresAgentRecovery()) {
          shouldTerminalizeRequest = false;
          preserveWorkflowClaim = true;
        }
        const failure = runFailure;
        const failedCoreNamedRuntime = getCoreNamedClaudeRuntime();
        const failedCorePrimaryRuntime = getCorePrimaryClaudeRuntime();
        runIdleWatchdog?.stop();

        if (failure.failureKind === "shutdown-draining") {
          shouldTerminalizeRequest = false;
          failedCoreNamedRuntime?.markUncertain();
          failedCorePrimaryRuntime?.markUncertain();
        } else if (failure.failureKind === "pre-agent-cancelled") {
          failedCoreNamedRuntime?.markTerminalFailure(true);
          failedCorePrimaryRuntime?.markTerminalFailure(true);
        } else {
          failedCoreNamedRuntime?.markTerminalFailure(false);
          failedCorePrimaryRuntime?.markTerminalFailure(false);
        }

        if (activeCustomCommandTool) {
          const { toolCallId, display } = activeCustomCommandTool;
          activeCustomCommandTool = null;
          let customCommandError: string;
          if (failure.failureKind === "pre-agent-cancelled") {
            customCommandError = "cancelled by interrupt";
          } else {
            customCommandError = failure.displayMessage;
          }
          await captureBusAgentRunnerOperation("custom command failure status publish", () =>
            publishNonAgentToolStatus({
              toolCallId,
              status: "end",
              display,
              ok: false,
              error: customCommandError,
            }),
          );
        }

        const timedOutOperation = getActiveRunOperation();
        if (
          (failure.failureKind === "idle-timeout" ||
            failure.failureKind === "pre-agent-cancelled") &&
          timedOutOperation
        ) {
          const observeTimedOutOperation = captureBusAgentRunnerOperation(
            "cancelled agent operation settlement",
            () => timedOutOperation,
            (panic) => {
              terminalPanic ??= panic;
            },
          ).then(() => true);
          const settled = await Promise.race([
            observeTimedOutOperation,
            Bun.sleep(AGENT_TIMEOUT_ABORT_GRACE_MS).then(() => false),
          ]);
          if (!settled) {
            logger.warn(
              "agent operation did not settle after cancellation grace period",
              formatBridgeLogContext({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                reason: failure.failureKind === "idle-timeout" ? "idle_timeout" : "cancelled",
                abortGraceMs: AGENT_TIMEOUT_ABORT_GRACE_MS,
              }),
            );
          }
        }

        if (failure.failureKind === "shutdown-draining") {
          preserveWorkflowClaim = true;
          if (workflowHint) {
            params.durableWorkflowStore?.releaseWorkflowRequestClaim(
              next.requestId,
              workflowRunnerOwnerId,
              Date.now(),
            );
          }
          logger.info("agent run interrupted after shutdown drain deadline", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            durationMs: Date.now() - runStartedAt,
          });
          return { status: "return", value: undefined } as const;
        }

        if (failure.failureKind === "pre-agent-cancelled") {
          requestTerminalKind = "cancelled";
          if (liveParentSession) {
            await captureBusAgentRunnerOperation("cancel deferred subagents", () =>
              liveParentSession?.cancelAll("parent request cancelled"),
            );
          }
          const finalText = "Cancelled.";
          await publishCurrentLifecycle({
            state: "cancelled",
            detail: "cancelled by interrupt",
            output: finalText,
          });
          await publishTerminalResponseText({ finalText });
          return { status: "return", value: undefined } as const;
        }

        const rawMsg = failure.displayMessage;
        const msg = maybeAppendWarningSummaryToUnclearError(
          rawMsg,
          summarizeCallWarnings(streamWarnings),
        );

        const failureTranscriptStore = params.transcriptStore;
        if (failureTranscriptStore) {
          const persistedFailure = await captureBusAgentRunnerOperation(
            "failed run transcript persistence",
            async () => {
              const finalMessagesForPersistence =
                runStats.finalMessages ?? activeAgent?.getRecoverableMessages() ?? [];
              const safeFinalMessages = buildSafeRecoveryCheckpoint(
                finalMessagesForPersistence,
                "agent run failed",
              );
              const responseMessages = safeFinalMessages.slice(responseStartIndex);
              const persistenceCandidates = (() => {
                if (isHeartbeatSessionId(headers.session_id)) {
                  return buildPersistedHeartbeatMessages(`Error: ${msg}`);
                }

                if (next.requestClient === "native")
                  return safeFinalMessages.length > 0 ? safeFinalMessages : next.messages;
                return runProfile === "primary" ? responseMessages : safeFinalMessages;
              })();
              const persistedMessages = await projectTranscriptMessagesForPersistence({
                identityProjection: storedMessageIdentity,
                providerMessages: persistenceCandidates,
                blobStore: params.blobStore,
                transcriptStore: failureTranscriptStore,
              });

              return failureTranscriptStore.saveRequestTranscript({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                requestClient: headers.request_client,
                messages: persistedMessages,
                finalText: `Error: ${msg}`,
                modelLabel: resolvedModelLabel,
                loadedCatalogIds: toolAuthority.snapshot(),
                ...(runProfile === "primary"
                  ? {
                      providerState: resolveCorePrimaryTranscriptProviderState({
                        targetFamily: resolvedProviderFamily,
                        lineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                        transcriptStore: failureTranscriptStore,
                      }),
                    }
                  : {}),
                ...(runProfile === "primary"
                  ? persistedCompleteLineage(
                      state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                    )
                  : {}),
              });
            },
          );
          const reportPersistence = persistedFailure.match<() => void>({
            err: (persistenceError) => () => {
              logger.error(
                "failed to persist transcript after error",
                formatBridgeTaggedErrorForLog(persistenceError, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            },
            ok: (saved) => () => {
              const reportSave = saved.match<() => void>({
                ok: () => () => undefined,
                err: (saveError) => () => {
                  logger.error(
                    "failed to persist transcript after error",
                    formatBridgeTaggedErrorForLog(saveError, {
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                    }),
                  );
                },
              });
              reportSave();
            },
          });
          reportPersistence();
        }

        if (liveParentSession) {
          const cancelledSubagents = await captureBusAgentRunnerOperation(
            "deferred subagent cancellation after parent failure",
            () => liveParentSession?.cancelAll(`parent run failed: ${msg}`),
          );
          const cancellationError = cancelledSubagents.match({
            ok: () => null,
            err: (error) => error,
          });
          if (cancellationError) {
            logger.warn(
              "failed to cancel deferred subagents after parent failure",
              formatBridgeTaggedErrorForLog(cancellationError, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }

        if (failureTranscriptStore && isHeartbeatSessionId(headers.session_id)) {
          const persistedFailureHandoffs = await captureBusAgentRunnerOperation(
            "failed run heartbeat handoff persistence",
            () => {
              const finalMessagesForPersistence =
                runStats.finalMessages ?? activeAgent?.getRecoverableMessages() ?? [];
              const responseMessages = buildSafeRecoveryCheckpoint(
                finalMessagesForPersistence,
                "agent run failed",
              ).slice(responseStartIndex);

              persistHeartbeatSurfaceHandoffs({
                logger,
                transcriptStore: failureTranscriptStore,
                requestId: headers.request_id,
                requestClient: headers.request_client,
                sessionId: headers.session_id,
                modelLabel: resolvedModelLabel,
                responseMessages,
              });
            },
          );
          const handoffError = persistedFailureHandoffs.match({
            ok: () => null,
            err: (error) => error,
          });
          if (handoffError) {
            logger.error(
              "failed to persist heartbeat handoff transcripts after error",
              formatBridgeTaggedErrorForLog(handoffError, {
                requestId: headers.request_id,
                sessionId: headers.session_id,
              }),
            );
          }
        }
        await publishCurrentLifecycle({
          state: "failed",
          detail: msg,
          output: `Error: ${msg}`,
          usage: runStats.totalUsage
            ? {
                inputTokens: runStats.totalUsage.inputTokens ?? 0,
                outputTokens: runStats.totalUsage.outputTokens ?? 0,
                totalTokens: runStats.totalUsage.totalTokens ?? 0,
              }
            : undefined,
        });
        await publishTerminalResponseText({
          finalText: `Error: ${msg}`,
        });

        const projectedError: BusAgentRunnerErrorProjection = {
          message: failure.message,
          details: failure.details,
        };
        logger.error(
          "agent run failed",
          formatBridgeLogContext({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            durationMs: Date.now() - runStartedAt,
            model: resolvedModelLabel,
            ...projectedError.details,
            errorMessage: projectedError.message,
          }),
        );
      }

      return { status: "continue" } as const;
    })().finally(async () => {
      level1ToolsetsClosed = true;
      const cleanupCoreNamedRuntime = getCoreNamedClaudeRuntime();
      const cleanupCorePrimaryRuntime = getCorePrimaryClaudeRuntime();
      const cleanupClaudeCodeRun = getClaudeCodeRun();
      const unconsumedControls =
        terminalPanic || cancelledByRequestId.has(headers.request_id)
          ? []
          : takeUnconsumedControls(state);
      if (next.identityOwner) requestMessageCache.releaseOwner(next.identityOwner);
      if (terminalPanic) {
        rejectPreAgentCancellation = null;
        const terminalCleanups: BusAgentRunnerTerminalCleanup[] = [];
        if (workflowClaimTimer) {
          const timer = workflowClaimTimer;
          terminalCleanups.push({
            label: "workflow-claim-timer-clear",
            run: () => clearInterval(timer),
          });
        }
        if (params.expireControlCapability) {
          const expireControlCapability = params.expireControlCapability;
          terminalCleanups.push({
            label: "control-capability-expire",
            run: () => expireControlCapability(next.requestId),
          });
        }
        if (workflowHint && !preserveWorkflowClaim && params.durableWorkflowStore) {
          const durableWorkflowStore = params.durableWorkflowStore;
          terminalCleanups.push({
            label: "workflow-request-expire",
            run: () => {
              durableWorkflowStore.expireWorkflowRequest(
                next.requestId,
                Date.now(),
                workflowRunnerOwnerId,
              );
            },
          });
        }
        if (runIdleWatchdog) {
          const watchdog = runIdleWatchdog;
          terminalCleanups.push({
            label: "run-idle-watchdog-stop",
            run: () => watchdog.stop(),
          });
        }
        terminalCleanups.push(
          { label: "agent-unsubscribe", run: unsubscribe },
          { label: "compaction-unsubscribe", run: unsubscribeCompaction },
          {
            label: "output-publisher-drain",
            run: () => outputPublisher.drain(),
          },
        );
        if (cleanupCoreNamedRuntime) {
          const runtime = cleanupCoreNamedRuntime;
          terminalCleanups.push({
            label: "core-named-retire",
            run: () => runtime.retireAtRunEnd(),
          });
        }
        if (cleanupCorePrimaryRuntime) {
          const runtime = cleanupCorePrimaryRuntime;
          terminalCleanups.push({
            label: "core-primary-retire",
            run: () => runtime.retireAtRunEnd(),
          });
        }
        if (cleanupClaudeCodeRun) {
          const run = cleanupClaudeCodeRun;
          terminalCleanups.push({
            label: "claude-dispose",
            run: () => run.dispose(),
          });
        }
        for (const release of level1ToolsetReleases) {
          terminalCleanups.push({
            label: "level1-toolset-release",
            run: () => releaseLevel1Toolset(release),
          });
        }
        if (liveParentSession) {
          const session = liveParentSession;
          terminalCleanups.push({
            label: "live-close",
            run: () => session.close(),
          });
        }
        stopQuestionNotifications?.();
        stopJobNotifications?.();
        if (params.questions)
          terminalCleanups.push({
            label: "questions-cancel",
            run: () => params.questions!.cancelRequest(next.requestId),
          });
        const cleanupBatch = startBusAgentRunnerTerminalCleanup(terminalCleanups);
        terminalCleanupOperations = [...terminalCleanupOperations, ...cleanupBatch.operations];
        terminalCleanupCompletion = terminalCleanupCompletion
          ? Promise.all([terminalCleanupCompletion, cleanupBatch.completion]).then(() => undefined)
          : cleanupBatch.completion;
      } else {
        if (workflowClaimTimer) clearInterval(workflowClaimTimer);
        if (controlCapability) params.expireControlCapability?.(next.requestId);
        if (workflowHint && !preserveWorkflowClaim) {
          params.durableWorkflowStore?.expireWorkflowRequest(
            next.requestId,
            Date.now(),
            workflowRunnerOwnerId,
          );
        }
        runIdleWatchdog?.stop();
        rejectPreAgentCancellation = null;
        unsubscribe();
        unsubscribeCompaction();
        await outputPublisher.drain();
        if (cleanupCoreNamedRuntime) {
          const runtime = cleanupCoreNamedRuntime;
          const retired = await captureBusAgentRunnerOperation(
            "Core named Claude runtime retirement",
            () => runtime.retireAtRunEnd(),
          );
          retired.match({
            ok: () => undefined,
            err: (error) => {
              logger.warn(
                "failed to retire Core named Claude runtime",
                formatBridgeTaggedErrorForLog(error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            },
          });
        }
        if (cleanupCorePrimaryRuntime) {
          const runtime = cleanupCorePrimaryRuntime;
          const retired = await captureBusAgentRunnerOperation(
            "Core primary Claude runtime retirement",
            () => runtime.retireAtRunEnd(),
          );
          retired.match({
            ok: () => undefined,
            err: (error) => {
              logger.warn(
                "failed to retire Core primary Claude runtime",
                formatBridgeTaggedErrorForLog(error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            },
          });
        }
        if (cleanupClaudeCodeRun) {
          const run = cleanupClaudeCodeRun;
          const disposed = await captureBusAgentRunnerOperation("Claude Code run disposal", () =>
            run.dispose(),
          );
          disposed.match({
            ok: () => undefined,
            err: (error) => {
              logger.warn(
                "failed to dispose Claude Code run resources",
                formatBridgeTaggedErrorForLog(error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                }),
              );
            },
          });
        }
        await liveParentSession?.close();
        stopQuestionNotifications?.();
        stopJobNotifications?.();
        await params.questions?.cancelRequest(next.requestId);
        await Promise.all([...level1ToolsetReleases].map(releaseLevel1Toolset));
      }
      const finalReplayDeadline = outputPublisher.getFinalReplayDeadline();
      if (!terminalPanic && shouldTerminalizeRequest)
        await publishNativeTerminal(requestTerminalKind);
      // A run left for recovery keeps its unconsumed controls, and recovery merges them back in.
      if (!terminalPanic && shouldTerminalizeRequest) {
        requeueUnconsumedControls(state, unconsumedControls);
      } else {
        for (const control of unconsumedControls) {
          if (control.identityOwner) requestMessageCache.releaseOwner(control.identityOwner);
        }
      }
      const terminalSurfaceWriteSatisfied =
        !terminalSurfaceWriteAttempted || terminalSurfaceWriteInitiated;
      if (terminalSurfaceWriteSatisfied) markActiveRunTerminal();
      if (terminalMarkerOperation) {
        await terminalMarkerOperation;
      } else if (state.activeRun) {
        await flushRunCheckpointWriter(state.activeRun);
      }
      const checkpointWriterAbandoned = state.activeRun?.checkpointWriter.abandoned === true;
      let owningDeliveryTerminalized = false;
      if (
        !terminalPanic &&
        !checkpointWriterAbandoned &&
        shouldTerminalizeRequest &&
        terminalSurfaceWriteSatisfied &&
        next.requestDeliveryId &&
        params.requestDelivery
      ) {
        const terminalized = await params.requestDelivery.terminalize({
          requestDeliveryId: next.requestDeliveryId,
          outcome: { kind: requestTerminalKind },
          ...(finalReplayDeadline === undefined
            ? {}
            : {
                finalReplayDeadline,
              }),
          transportCommitRequired: true,
        });
        const terminalError = terminalized.match({
          ok: () => null,
          err: (error) => error,
        });
        if (terminalError) {
          logger.error(
            "request delivery terminalization failed",
            formatBridgeTaggedErrorForLog(terminalError, {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              requestDeliveryId: next.requestDeliveryId,
            }),
          );
        } else {
          owningDeliveryTerminalized = true;
        }
      }
      let retainedDeliveriesTerminalized = true;
      if (
        !terminalPanic &&
        !checkpointWriterAbandoned &&
        shouldTerminalizeRequest &&
        terminalSurfaceWriteSatisfied &&
        params.requestDelivery
      ) {
        for (const [requestDeliveryId, retainedOutcome] of state.activeRun
          ?.retainedRequestDeliveries ?? []) {
          const terminalized = await params.requestDelivery.terminalize({
            requestDeliveryId,
            outcome: retainedOutcome,
            ...(finalReplayDeadline === undefined ? {} : { finalReplayDeadline }),
            transportCommitRequired: true,
          });
          terminalized.match({
            ok: () => undefined,
            err: (error) => {
              retainedDeliveriesTerminalized = false;
              logger.error(
                "retained request delivery terminalization failed",
                formatBridgeTaggedErrorForLog(error, {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  requestDeliveryId,
                }),
              );
            },
          });
        }
      }
      if (
        !checkpointWriterAbandoned &&
        owningDeliveryTerminalized &&
        retainedDeliveriesTerminalized &&
        next.requestDeliveryId
      ) {
        const removed = runCheckpointWriter.journal()?.removeReconciled(next.requestDeliveryId);
        const removeError = removed?.match({ ok: () => null, err: (error) => error });
        if (removed && !removeError) {
          releaseRunCheckpointBlobs({
            requestDeliveryId: next.requestDeliveryId,
            requestId: next.requestId,
            sessionId: next.sessionId,
          });
        }
      }
      if (
        next.requestClient === "native" &&
        next.requestDeliveryId &&
        owningDeliveryTerminalized &&
        !checkpointWriterAbandoned
      ) {
        const settled = await params.nativeExecution?.settled(
          {
            requestId: next.requestId,
            requestDeliveryId: next.requestDeliveryId,
            sessionId,
            raw: next.raw,
          },
          requestTerminalKind,
        );
        const settlementError = settled?.match({ ok: () => null, err: (error) => error });
        if (settlementError) signalBusAgentRunnerHostFailure(settlementError);
      }
      if (next.requestDeliveryId) params.onRequestSettled?.(next.requestDeliveryId);
      for (const requestDeliveryId of state.activeRun?.retainedRequestDeliveries.keys() ?? []) {
        params.onRequestSettled?.(requestDeliveryId);
      }
      state.agent = null;
      state.activeRequestId = null;
      state.activeRun = null;
      state.running = false;
      cancelledByRequestId.delete(headers.request_id);
      shutdownAbortRequestIds.delete(headers.request_id);
      if (!terminalPanic && shouldTerminalizeRequest) {
        await params.jobs?.onRunSettled({
          requestId: next.requestId,
          sessionId: next.sessionId,
          isPrimary: runProfile === "primary",
        });
      }
      if (!terminalPanic && !checkpointWriterAbandoned) {
        startSessionQueueDrain(sessionId, state);
      }
    });
    if (outcome.status === "return") return outcome.value;
  }

  function getActiveLevel1Work(): readonly AgentRunnerActiveWork[] {
    const now = Date.now();
    const active: AgentRunnerActiveWork[] = [];
    for (const state of bySession.values()) {
      const run = state.activeRun;
      if (!run) continue;
      const tools = [...run.activeTools.entries()].map(([toolCallId, tool]) => ({
        toolCallId,
        toolName: tool.toolName,
        ageMs: Math.max(0, now - tool.startedAt),
      }));
      let phase: AgentRunnerActiveWork["phase"] = "preparing";
      if (tools.length > 0) {
        phase = "tool";
      } else if (run.started) {
        phase = "model";
      }
      active.push({
        requestId: run.requestId,
        requestClient: run.requestClient,
        runProfile: run.runProfile,
        phase,
        runAgeMs: Math.max(0, now - run.startedAt),
        tools,
      });
    }
    return active;
  }

  function validateNativeRequest(request: NativeRunnerRequest): ResultType<
    {
      readonly safetyMode: SessionSafetyMode;
      readonly resolvedModelRequest?: DurableResolvedModelRequest;
      readonly historyProviderState?: HistoryProviderState;
    },
    Error
  > {
    if (!params.nativeExecution)
      return Result.err(new Error("Native request admission is unavailable"));
    if (nativeBlockedSessions.has(request.sessionId))
      return Result.err(new Error("Native session mutation is in progress"));
    return params.nativeExecution.validate(request);
  }

  async function rejectNativeDelivery(
    requestDeliveryId: string,
    cause: Error,
  ): Promise<ResultType<void, BusAgentRunnerDeliveryError>> {
    if (!params.requestDelivery) return Result.ok(undefined);
    const terminalized = await params.requestDelivery.terminalize({
      requestDeliveryId,
      outcome: { kind: "cancelled", code: "native-admission-rejected" },
      transportCommitRequired: true,
    });
    const rejection = await Result.gen(async function* () {
      yield* terminalized;
      if (params.nativeExecution?.rejected)
        yield* Result.await(params.nativeExecution.rejected(requestDeliveryId));
      return Result.ok(undefined);
    });
    return rejection.mapError(
      (error) => new BusAgentRunnerIntakeFailed({ cause: error, message: cause.message }),
    );
  }

  /** Ends accepted work whose stored messages cannot be loaded so the session queue can continue. */
  async function failUnmaterializableEntry(entry: Enqueued, cause: Error): Promise<void> {
    const context = {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      requestDeliveryId: entry.requestDeliveryId,
    };
    logger.error(
      "accepted request messages could not be materialized",
      formatBridgeTaggedErrorForLog(cause, context),
    );
    if (entry.identityOwner) requestMessageCache.releaseOwner(entry.identityOwner);
    await publishLifecycle({
      bus,
      headers: {
        request_id: entry.requestId,
        session_id: entry.sessionId,
        request_client: entry.requestClient,
      },
      state: "failed",
      detail: "stored request messages could not be loaded",
    });
    const requestDeliveryId = entry.requestDeliveryId;
    if (!requestDeliveryId || !params.requestDelivery) return;
    const outcomes: Array<readonly [string, RequestDeliveryTerminalOutcome]> = [
      [requestDeliveryId, { kind: "failed", code: "stored-message-materialization-failed" }],
      ...(entry.retainedRequestDeliveries ?? []).map(
        (retained) => [retained.requestDeliveryId, retained.outcome] as const,
      ),
    ];
    let terminalized = true;
    for (const [deliveryId, outcome] of outcomes) {
      const result = await params.requestDelivery.terminalize({
        requestDeliveryId: deliveryId,
        outcome,
        transportCommitRequired: true,
      });
      const failure = result.match({ ok: () => null, err: (error) => error });
      if (!failure) continue;
      terminalized = false;
      logger.error(
        "request delivery terminalization failed",
        formatBridgeTaggedErrorForLog(failure, { ...context, requestDeliveryId: deliveryId }),
      );
    }
    if (!terminalized) return;
    const removed = runCheckpointWriter.journal()?.removeReconciled(requestDeliveryId);
    if (removed?.isOk()) releaseRunCheckpointBlobs({ ...context, requestDeliveryId });
    if (entry.requestClient === "native") {
      const settled = await params.nativeExecution?.settled(
        {
          requestId: entry.requestId,
          requestDeliveryId,
          sessionId: entry.sessionId,
          raw: entry.raw,
        },
        "failed",
      );
      const settlementError = settled?.match({ ok: () => null, err: (error) => error });
      if (settlementError) {
        logger.error(
          "native request settlement failed",
          formatBridgeTaggedErrorForLog(settlementError, context),
        );
      }
    }
    for (const [deliveryId] of outcomes) params.onRequestSettled?.(deliveryId);
  }

  async function cancelNativeSession(sessionId: string): Promise<ResultType<void, Error>> {
    if (!sessionId.startsWith("native:"))
      return Result.err(new Error("Native cancellation requires a native session"));
    nativeBlockedSessions.add(sessionId);
    const state = bySession.get(sessionId);
    if (!state) {
      nativeBlockedSessions.delete(sessionId);
      return Result.ok(undefined);
    }
    const queued = state.queue.splice(0);
    for (const entry of queued) {
      const rejected = await rejectNativeDelivery(
        entry.requestDeliveryId ?? "",
        new Error("Native session canceled"),
      );
      const failure = rejected.match({ ok: () => null, err: (error) => error });
      if (failure) {
        nativeBlockedSessions.delete(sessionId);
        return Result.err(failure);
      }
      if (entry.identityOwner) requestMessageCache.releaseOwner(entry.identityOwner);
      reservedQueueEntries.delete(entry);
    }
    if (state.activeRun) {
      state.activeRun.cancel();
      state.agent?.cancel();
    }
    await Promise.allSettled(sessionDrainOperations.get(sessionId) ?? []);
    nativeBlockedSessions.delete(sessionId);
    return Result.ok(undefined);
  }

  function discardPausedRecoveredDelivery(requestDeliveryId: string): ResultType<void, Error> {
    for (const [sessionId, state] of bySession) {
      if (
        state.activeRun?.requestDeliveryId === requestDeliveryId ||
        state.activeRun?.retainedRequestDeliveries.has(requestDeliveryId)
      ) {
        return Result.err(
          new Error("A running recovery entry cannot be discarded before replay terminalization"),
        );
      }
      const retainedOwner = state.queue.find((entry) =>
        entry.retainedRequestDeliveries?.some(
          (retained) => retained.requestDeliveryId === requestDeliveryId,
        ),
      );
      if (retainedOwner) {
        return Result.err(
          new Error("A merged retained recovery delivery cannot be discarded independently"),
        );
      }
      const matches = state.queue.filter((entry) => entry.requestDeliveryId === requestDeliveryId);
      if (matches.some((entry) => reservedQueueEntries.has(entry))) {
        return Result.err(
          new Error("A reserved recovery entry cannot be discarded before replay terminalization"),
        );
      }
      if (matches.length === 0) continue;
      removeQueuedEntriesByReference(state.queue, matches);
      for (const entry of matches) {
        if (entry.identityOwner) requestMessageCache.releaseOwner(entry.identityOwner);
      }
      if (!state.running && state.queue.length === 0) bySession.delete(sessionId);
      return Result.ok(undefined);
    }
    return Result.ok(undefined);
  }

  function restoreAcceptedRequestIdentity(
    record: AcceptedRequestDelivery<CoreAcceptedRequestWork>,
  ):
    | {
        readonly identityOwner: RequestMessageCacheOwner;
        readonly projection: AuthenticatedRequestProjection;
      }
    | undefined {
    const work = record.work;
    const eventId = record.publication?.streamId ?? `accepted:${record.requestDeliveryId}`;
    const message: CmdRequestMessage = {
      id: eventId,
      topic: "cmd.request",
      type: lilacEventTypes.CmdRequestMessage,
      ts: record.acceptedAt,
      key: work.requestId,
      headers: work.headers,
      data: work.data,
    };
    const projected = (params.projectAuthenticatedRequest ?? projectAuthenticatedRequest)(message);
    let projectionError: AuthenticatedRequestProjectionInvalid | undefined;
    const selectProjection = projected.match<() => AuthenticatedRequestProjection | undefined>({
      err: (error) => () => {
        projectionError = error;
        return undefined;
      },
      ok: (projection) => () => projection,
    });
    const externalProjection = selectProjection();
    if (projectionError || !externalProjection) {
      logger.warn(
        "accepted request recovery identity restricted",
        formatBridgeLogContext({
          requestDeliveryId: record.requestDeliveryId,
          requestId: work.requestId,
          sessionId: work.sessionId,
          reason: projectionError ? "projection-invalid" : "projection-absent",
          errorTag: projectionError?.name,
        }),
      );
      return undefined;
    }

    const projection = projectDurableWorkflowRequestIdentity({
      projection: externalProjection,
      raw: preserveAgentRunnerRaw({ data: work.data }),
      store: params.durableWorkflowStore,
    });
    if (!isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(projection)) {
      logger.warn(
        "accepted request recovery identity restricted",
        formatBridgeLogContext({
          requestDeliveryId: record.requestDeliveryId,
          requestId: work.requestId,
          sessionId: work.sessionId,
          reason: "durable-proof-invalid",
        }),
      );
      return undefined;
    }

    const cached = requestMessageCache.cacheMessage(message, projection);
    let cacheError: RequestMessageCacheAdmissionError | undefined;
    const selectCachedProjection = cached.match<() => AuthenticatedRequestProjection | undefined>({
      err: (error) => () => {
        cacheError = error;
        return undefined;
      },
      ok: (value) => () => value,
    });
    const cachedProjection = selectCachedProjection();
    if (cacheError) {
      logger.warn(
        "accepted request recovery identity restricted",
        formatBridgeLogContext({
          requestDeliveryId: record.requestDeliveryId,
          requestId: work.requestId,
          sessionId: work.sessionId,
          reason: "cache-admission-failed",
          errorTag: cacheError.name,
        }),
      );
      return undefined;
    }
    if (!cachedProjection) {
      requestMessageCache.finishDelivery({
        requestId: work.requestId,
        eventId,
        disposition: "release",
      });
      logger.warn(
        "accepted request recovery identity restricted",
        formatBridgeLogContext({
          requestDeliveryId: record.requestDeliveryId,
          requestId: work.requestId,
          sessionId: work.sessionId,
          reason: "cache-admission-empty",
        }),
      );
      return undefined;
    }

    const owner = requestMessageCache.acquireOwner(work.requestId);
    let ownerError: RequestIdentitySourceMissing | undefined;
    const selectOwner = owner.match<() => RequestMessageCacheOwner | undefined>({
      err: (error) => () => {
        ownerError = error;
        return undefined;
      },
      ok: (identityOwner) => () => identityOwner,
    });
    const identityOwner = selectOwner();
    requestMessageCache.finishDelivery({
      requestId: work.requestId,
      eventId,
      disposition: "release",
    });
    if (ownerError || !identityOwner) {
      logger.warn(
        "accepted request recovery identity restricted",
        formatBridgeLogContext({
          requestDeliveryId: record.requestDeliveryId,
          requestId: work.requestId,
          sessionId: work.sessionId,
          reason: "cache-owner-failed",
          errorTag: ownerError?.name,
        }),
      );
      return undefined;
    }
    return { identityOwner, projection: cachedProjection };
  }

  async function resumeAcceptedDelivery(
    record: AcceptedRequestDelivery<CoreAcceptedRequestWork>,
    recoveryHead?: AgentRunRecoveryHead,
  ): Promise<ResultType<void, Error>> {
    const work = record.work;
    if (
      work.requestDeliveryId !== record.requestDeliveryId ||
      work.requestId !== record.requestId
    ) {
      return Result.err(
        new Error("Accepted request delivery identity does not match its durable work"),
      );
    }
    if (work.requestClient === "native") {
      const validated = validateNativeRequest({
        requestId: work.requestId,
        requestDeliveryId: work.requestDeliveryId,
        sessionId: work.sessionId,
        raw: preserveAgentRunnerRaw({ data: work.data }),
      });
      const rejection = validated.match({ ok: () => null, err: (error) => error });
      if (rejection) return rejectNativeDelivery(work.requestDeliveryId, rejection);
    }
    if (recoveryHead?.state === "terminal") return Result.ok(undefined);
    for (const state of bySession.values()) {
      if (
        state.activeRun?.requestDeliveryId === record.requestDeliveryId ||
        state.activeRun?.retainedRequestDeliveries.has(record.requestDeliveryId) ||
        state.queue.some(
          (entry) =>
            entry.requestDeliveryId === record.requestDeliveryId ||
            entry.retainedRequestDeliveries?.some(
              (retained) => retained.requestDeliveryId === record.requestDeliveryId,
            ),
        )
      ) {
        return Result.ok(undefined);
      }
    }
    const restoredIdentity = restoreAcceptedRequestIdentity(record);
    const restoredCurrentTurnUserId =
      recoveryHead?.checkpoint?.currentTurnUserId ??
      restoredIdentity?.projection.authenticatedOrigin?.userId;
    const restoredCurrentTurnMessageRef = recoveryHead?.checkpoint?.currentTurnUserId
      ? undefined
      : restoredIdentity?.projection.authenticatedOrigin?.messageRef;
    const entry: Enqueued = {
      queueEntryId: record.publication?.streamId ?? `accepted:${record.requestDeliveryId}`,
      requestDeliveryId: record.requestDeliveryId,
      requestId: work.requestId,
      sessionId: work.sessionId,
      requestClient: work.requestClient,
      queue: work.data.queue,
      runPolicy: work.data.runPolicy ?? "normal",
      origin: work.data.origin,
      messages: [],
      storedMessages: [...work.data.messages],
      corePrimaryLineage:
        recoveryHead?.checkpoint?.corePrimaryLineage ?? work.data.corePrimaryLineage,
      acceptedCorePrimaryLineage: work.data.corePrimaryLineage,
      modelOverride: work.data.modelOverride,
      raw: preserveAgentRunnerRaw({ data: work.data }),
      ...(restoredIdentity
        ? {
            identityOwner: restoredIdentity.identityOwner,
            ...(restoredIdentity.projection.authenticatedOrigin
              ? { authenticatedOrigin: restoredIdentity.projection.authenticatedOrigin }
              : {}),
            ...(restoredCurrentTurnUserId ? { currentTurnUserId: restoredCurrentTurnUserId } : {}),
            ...(restoredCurrentTurnMessageRef
              ? { currentTurnMessageRef: restoredCurrentTurnMessageRef }
              : {}),
            ...(restoredIdentity.projection.authenticatedOrigin?.userId
              ? {
                  acceptedCurrentTurnUserId: restoredIdentity.projection.authenticatedOrigin.userId,
                }
              : {}),
            verifiedIngress: restoredIdentity.projection.verifiedIngress,
          }
        : { restoredSafetyMode: "restricted" as const }),
      ...(recoveryHead?.checkpoint
        ? {
            recovery: {
              checkpointMessages: [],
              partialText: "",
              nativeOutputFrontier: recoveryHead.checkpoint.nativeOutput,
            },
            storedRecoveryCheckpoint: [...recoveryHead.checkpoint.messages],
            recoveryMcpImages: recoveryHead.checkpoint.mcpImages,
            questionResultIds: recoveryHead.checkpoint.questionResultIds,
            ...(recoveryHead.checkpoint.loadedCatalogIds
              ? {
                  loadedCatalogIds: [...recoveryHead.checkpoint.loadedCatalogIds],
                }
              : {}),
            ...(recoveryHead.previousCheckpoint
              ? { previousRecoveryCheckpoint: recoveryHead.previousCheckpoint }
              : {}),
            retainedRequestDeliveries: recoveryHead.checkpoint.retainedRequestDeliveries,
          }
        : {}),
      ...(recoveryHead ? { journalHandle: recoveryHead.handle } : {}),
    };
    const state = bySession.get(work.sessionId) ?? createSessionQueue(work.sessionId);
    state.queue.push(entry);
    bySession.set(work.sessionId, state);
    if (runnerActivated && !state.running) {
      startSessionQueueDrain(work.sessionId, state, work.requestId);
    }
    return Result.ok(undefined);
  }

  await startSubscription();
  const activate = (): void => {
    activateRunnerAdmission();
    for (const [sessionId, state] of bySession) {
      if (!state.running && state.queue.length > 0) {
        startSessionQueueDrain(sessionId, state, state.queue[0]?.requestId);
      }
    }
  };

  return {
    activate,
    beginDrain,
    getActiveLevel1Work,
    resumeAcceptedDelivery,
    discardPausedRecoveredDelivery,
    cancelNativeSession,
    isSessionBusy(sessionId: string): boolean {
      const state = bySession.get(sessionId);
      return Boolean(state && (state.running || state.activeRun || state.queue.length > 0));
    },
    readSubagentSnapshot(sessionId: string, requestId: string, includeMessages = false) {
      const state = bySession.get(sessionId);
      const run = state?.activeRun;
      if (!run || run.requestId !== requestId || run.runProfile === "primary") return undefined;
      const tool = [...run.activeTools.values()].at(-1);
      const stream = state.agent?.state.streamMessage;
      const responding =
        typeof stream?.content === "string"
          ? stream.content.length > 0
          : stream?.content.at(-1)?.type === "text";
      return {
        messages: includeMessages
          ? [
              ...(state.agent?.state.messages ?? []),
              ...(state.agent?.state.streamMessage ? [state.agent.state.streamMessage] : []),
            ]
          : [],
        streaming: !!state.agent?.state.streamMessage,
        model: run.resolvedModelSpec ?? undefined,
        reasoning: run.resolvedReasoning,
        activeTools: [...run.activeTools].map(([toolCallId, tool]) => ({
          toolCallId,
          toolName: tool.toolName,
        })),
        title: tool?.toolName ?? (responding ? "Responding…" : "Thinking…"),
      };
    },
    /** Resolves once no session drain or control is in flight; rejects with a drain's failure. */
    async waitForIdle(): Promise<void> {
      for (;;) {
        const pending = [...allSessionDrainOperations(), ...sessionControlOperations.values()];
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
    /** Number of sessions holding in-memory queue state; idle sessions are evicted. */
    trackedSessionCount: () => bySession.size,
    getTerminalCleanupOperations: () => terminalCleanupOperations,
    stop: async (opts?: { readonly deadlineAtMs?: number }) => {
      const deadlineAtMs = opts?.deadlineAtMs ?? Date.now() + TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS;
      stopRunnerAdmission();
      // Subscription shutdown waits for in-flight bus handlers, so it must not outlive the caller's deadline.
      const subscriptionStopped = stopSubscription();
      void ignoreDetachedFailure(subscriptionStopped);
      if (await settlesBefore([subscriptionStopped], deadlineAtMs)) {
        await subscriptionStopped;
      } else {
        logger.warn("agent-runner subscription stop exceeded shutdown wait", { deadlineAtMs });
        void ignoreDetachedFailure(superviseDetachedOperation(subscriptionStopped));
      }
      await stopRunCheckpointWriters(deadlineAtMs);
      if (
        terminalCleanupCompletion &&
        !(await settlesBefore([terminalCleanupCompletion], deadlineAtMs))
      ) {
        logger.warn("terminal agent-runner cleanup exceeded shutdown wait", {
          deadlineAtMs,
          pendingLabels: terminalCleanupOperations.map(({ label }) => label),
        });
      }
      bySession.clear();
      queueLifecycleAttempts.clear();
      reservedQueueEntries.clear();
      shutdownAbortRequestIds.clear();
    },
  };
}

async function publishLifecycle(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
    router_session_mode?: "mention" | "active";
  };
  state: RequestLifecycleState;
  detail?: string;
}) {
  const published = await params.bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state: params.state, detail: params.detail, ts: Date.now() },
    { headers: params.headers },
  );
  published.match({
    ok: () => () => undefined,
    err: (error) => () => signalBusAgentRunnerHostFailure(error),
  })();
}

export function selectPersistedTranscriptMessages(input: {
  finalMessages: readonly ModelMessage[];
  responseStartIndex: number;
  isPrimary: boolean;
  didCompact: boolean;
}): ModelMessage[] {
  if (!input.isPrimary || input.didCompact) return [...input.finalMessages];
  return input.finalMessages.slice(input.responseStartIndex);
}

export function resolveCompactionCheckpointMeta(input: {
  runSucceeded: boolean;
  isPrimary: boolean;
  isCancelled: boolean;
  shouldSkipSurfaceReply: boolean;
  completedCompactionCount: number;
}) {
  if (
    !input.runSucceeded ||
    !input.isPrimary ||
    input.isCancelled ||
    input.shouldSkipSurfaceReply ||
    input.completedCompactionCount <= 0
  ) {
    return undefined;
  }

  return {
    type: "compaction",
    formatVersion: COMPACTION_CHECKPOINT_FORMAT_VERSION,
  } as const;
}
