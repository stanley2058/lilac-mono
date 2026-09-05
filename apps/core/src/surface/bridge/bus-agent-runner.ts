/* oxlint-disable eslint/no-control-regex */

import { captureError } from "../../shared/error-capture";

import {
  type CallWarning,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolContent,
  type ToolSet,
  type UserContent,
} from "ai";
import {
  Panic,
  Result,
  TaggedError,
  type AnyTaggedError,
  type Result as ResultType,
} from "better-result";
import { boundToolResultMediaForModelView } from "@stanley2058/lilac-tool-results/tool-result-media";
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
  applyBasePromptForProvider,
  deriveSubagentIdleTimeoutMs,
  env,
  extractAiErrorLogDetails,
  getCoreConfig,
  isPanic,
  isRecord,
  opaqueErrorMessage,
  ModelCapability,
  openAIMessagePhase,
  createLogger,
  resolveEditingToolMode,
  fromDurableResolvedModelPlanResult,
  claudeCodeExecutableSettings,
  resolveModelChainResult,
  resolveModelPlanResult,
  resolveNativeSubagentProfile,
  resolveRouterSessionConfig,
  withModelPlanReasoning,
} from "@stanley2058/lilac-utils";
import {
  corePrimaryLineageV2Schema,
  createCorePrimaryLineageFreshOnlyV2,
  decodeCorePrimaryLineageV2,
  EventDeliveryStopped,
  extendCoreLineagePrefixDigestV2,
  lilacEventTypes,
  type AdapterPlatform,
  type CoreLineageManifestV2,
  type CorePrimaryLineageV2,
  type DecodedLilacMessageForTopic,
  type DeliveryDisposition,
  type LilacBus,
  type RequestLifecycleState,
  type RequestOrigin,
  type RequestQueueMode,
  type RequestRunPolicy,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  advanceHistoryProviderState,
  AgentIdleTimeoutError,
  AiSdkPiAgent,
  attachAutoCompaction,
  buildSafeRecoveryCheckpoint,
  buildSyntheticToolCallId,
  classifyHistoryProviderFamily,
  compactWithOpenAIResponsesResult,
  createAgentRunIdleWatchdog,
  createRetryBackoffBudget,
  hasMatchingOpenAIServerCompaction,
  hasOpenAIServerCompaction,
  materializeOpenAIServerCompaction,
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
import { homedir } from "node:os";
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
  extractHeartbeatSurfaceSendHandoffs,
  HEARTBEAT_HANDOFF_SESSION_ID,
} from "../../transcript/heartbeat-handoff";
import {
  COMPACTION_CHECKPOINT_FORMAT_VERSION,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import {
  createConversationThreadAutoInjectUsageAccumulator,
  type ConversationThreadAutoInjectUsageAccumulator,
  type ConversationThreadSearchResult,
  type ConversationThreadToolService,
} from "../../conversation/thread-service";
import {
  rankAutoInjectedThreadSearchResults,
  type RankedAutoInjectThread,
} from "../../conversation/thread-auto-inject-ranking";
import {
  createStoredMessageIdentityProjectionV1,
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
  StoredMessageProjectionError,
  type StoredMessageIdentityProjectionV1,
  type StoredResourceProviderTarget,
} from "../../transcript/stored-message-materialization";
import type { ResourceAccess } from "../../resource";
import {
  defaultStoredBlobFilename,
  hashCanonicalStoredMessagesV2,
} from "../../transcript/transcript-persistence-codec";
import type {
  CoreAcceptedRequestWork,
  CorePreparedRequestEnvelope,
  CoreRequestOutputMetadata,
  RequestDeliveryCoordinator,
  RequestDeliveryTerminalOutcome,
} from "./request-delivery";
import type { AcceptedRequestDelivery } from "./request-delivery/types";
import {
  AgentRunJournalConflict,
  type AgentRunCheckpointV1,
  type AgentRunJournal,
  type AgentRunJournalHandle,
  type AgentRunRecoveryHead,
} from "./agent-run-journal";
import {
  AgentRunCheckpointOwnershipRollbackFailed,
  AgentRunCheckpointPreparationFailed,
  persistBlobBackedAgentRunCheckpoint,
} from "./agent-run-checkpoint-persistence";
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
import {
  buildExperimentalDownloadForAnthropicFallback,
  isAnthropicModelSpec,
  withStableAnthropicUpstreamOrder,
  type AnthropicFallbackBlobStore,
} from "./bus-agent-runner/anthropic-fallback-media";
import { formatUnknownErrorForDisplay } from "./bus-agent-runner/error-display";
import {
  debugJsonStringify,
  safeStringify,
  sanitizeFilenameToken,
} from "./bus-agent-runner/formatting";
import {
  ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withOpenAIPromptCacheKey,
  withOpenAIServerCompaction,
  withProviderOptionsOnLastUserMessage,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "./bus-agent-runner/provider-options";
import {
  parseCustomCommandFromRaw,
  parseBufferedForActiveRequestIdFromRaw,
  getParticipantUserIdsFromRaw,
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
import {
  type AgentOutputPublishFailed,
  createAgentOutputPublisher,
} from "./bus-agent-runner/output-publisher";
import { latestUserInput, shouldRunAutoInjectedThreadSearch } from "./bus-agent-runner/text-units";
import { createTransientModelRetryController } from "./bus-agent-runner/transient-retry";
import {
  materializeClaudeCodeRun,
  materializeClaudeCodeRunResult,
  type ClaudeCodeRunExternalFailure,
  type ClaudeCodeRunControl,
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
import type {
  CustomCommandExecutionError,
  CustomCommandManager,
} from "../../custom-commands/manager";
import {
  coreProfileExecutionScopeAuthority,
  createCoreNamedClaudeRuntime as createCoreNamedClaudeRuntimeResult,
  hashCoreNamedExecutionScope,
  prepareCoreNamedHistoryView,
  shouldReplayCoreNamedHistory,
  supportsCoreNamedContinuationStore,
  type CoreNamedClaudeRuntime,
} from "./bus-agent-runner/core-named-continuation";
import {
  createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult,
  prepareCorePrimaryHistoryView,
  shouldReplayCorePrimaryHistory,
  supportsCorePrimaryContinuationStore,
  type CorePrimaryClaudeRuntime,
} from "./bus-agent-runner/core-primary-continuation";

export { formatUnknownErrorForDisplay } from "./bus-agent-runner/error-display";
export {
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "./bus-agent-runner/provider-options";
export {
  measureMeaningfulTextUnits,
  shouldRunAutoInjectedThreadSearch,
} from "./bus-agent-runner/text-units";
export {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildAutoInjectedThreadSearchOverlay,
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

export function shouldUsePersistentCoreClaudeRuntime(input: {
  runProfile: AgentRunProfile;
  requestClient: AdapterPlatform;
  stableNamedContinuation: NonNullable<WorkflowRequestPolicy["stableNamedContinuation"]> | null;
  corePrimaryLineage?: CorePrimaryLineageV2;
}): boolean {
  if (input.runProfile === "primary") return input.requestClient === "discord";
  return input.stableNamedContinuation !== null;
}

export function resolveStoredResourceProviderTarget(input: {
  readonly provider: ResolvedModelRef["provider"];
  readonly capability: ModelCapabilityInfo | null;
}): StoredResourceProviderTarget {
  if (input.provider === "claude-code") {
    return { family: "claude-code", supportsImage: true, supportsPdf: false };
  }
  const supportsAttachments = input.capability?.attachment === true;
  const inputModalities = input.capability?.modalities?.input ?? [];
  return {
    family: "ai-sdk",
    supportsImage: supportsAttachments && inputModalities.includes("image"),
    supportsPdf: supportsAttachments && inputModalities.includes("pdf"),
  };
}

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export function rethrowBusAgentRunnerPanic(
  cause: unknown,
  beforeRethrow?: (panic: Panic) => void,
): void {
  if (!isPanic(cause)) return;
  beforeRethrow?.(cause);
  throw cause;
}

export class BusAgentRunnerRequestHeadersInvalid extends TaggedError(
  "BusAgentRunnerRequestHeadersInvalid",
)<{
  readonly missing: readonly ("request_id" | "session_id")[];
  readonly message: string;
}> {}

export class BusAgentRunnerQueueAttemptRouteInvalid extends TaggedError(
  "BusAgentRunnerQueueAttemptRouteInvalid",
)<{
  readonly eventId: string;
  readonly message: string;
}> {}

export class BusAgentRunnerRecoveryStopped extends TaggedError("BusAgentRunnerRecoveryStopped")<{
  readonly message: string;
}> {}

export class BusAgentRunnerIntakeFailed extends TaggedError("BusAgentRunnerIntakeFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusAgentRunnerAuthenticationProjectionInvalid extends TaggedError(
  "BusAgentRunnerAuthenticationProjectionInvalid",
)<{
  readonly cause:
    | AuthenticatedRequestProjectionInvalid
    | RequestMessageCacheAdmissionError
    | RequestIdentitySourceMissing
    | RequestIdentityAliasTargetOccupied
    | AuthenticatedRequestProjectionInvalid;
  readonly message: string;
}> {}

export class BusAgentRunnerOperationFailed extends TaggedError("BusAgentRunnerOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly failureKind: "idle-timeout" | "pre-agent-cancelled" | "shutdown-draining" | "other";
  readonly displayMessage: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
  readonly message: string;
}> {}

export async function captureBusAgentRunnerOperation<T>(
  operation: string,
  run: () => T | Promise<T>,
  beforePanicRethrow?: (panic: Panic) => void,
): Promise<ResultType<Awaited<T>, BusAgentRunnerOperationFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await run());
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      rethrowBusAgentRunnerPanic(cause, beforePanicRethrow);
      const projection = projectBusAgentRunnerError(cause, `${operation} failed`);
      let failureKind: BusAgentRunnerOperationFailed["failureKind"] = "other";
      if (cause instanceof AgentIdleTimeoutError) failureKind = "idle-timeout";
      if (cause instanceof PreAgentRunCancelledError) failureKind = "pre-agent-cancelled";
      if (cause instanceof ShutdownDrainingAbort) failureKind = "shutdown-draining";
      return Result.err(
        new BusAgentRunnerOperationFailed({
          operation,
          cause,
          failureKind,
          displayMessage: formatUnknownErrorForDisplay(cause),
          details: projection.details,
          message: projection.message,
        }),
      );
    }
    return attempt.value;
  }
}

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

export function signalBusAgentRunnerHostFailure(
  failure: Error | BusAgentRunnerOperationFailed,
): never {
  throw failure instanceof BusAgentRunnerOperationFailed ? failure.cause : failure;
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

type BusAgentRunnerErrorProjection = {
  readonly message: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
};

export function projectBusAgentRunnerError(
  cause: unknown,
  fallback = "Agent runner operation failed",
): BusAgentRunnerErrorProjection {
  const projectedCause =
    isRecord(cause) && cause["loaded"] === false && "error" in cause ? cause["error"] : cause;
  const message = opaqueErrorMessage(projectedCause, fallback);
  {
    const attempt = Result.try({
      try: () => {
        const details = extractAiErrorLogDetails(projectedCause);
        return details ? { message, details } : { message };
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      return { message };
    }
    return attempt.value;
  }
}

export type BusAgentRunnerDeliveryError =
  | BusAgentRunnerRequestHeadersInvalid
  | BusAgentRunnerQueueAttemptRouteInvalid
  | BusAgentRunnerRecoveryStopped
  | BusAgentRunnerAuthenticationProjectionInvalid
  | BusAgentRunnerIntakeFailed;

export function busAgentRunnerDeliveryDisposition(
  error: BusAgentRunnerDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "BusAgentRunnerRequestHeadersInvalid":
    case "BusAgentRunnerQueueAttemptRouteInvalid":
    case "BusAgentRunnerAuthenticationProjectionInvalid":
      return "dead-letter";
    case "BusAgentRunnerRecoveryStopped":
      return "stop";
    case "BusAgentRunnerIntakeFailed":
      return "park-pending";
  }
}

export function resolveCoreClaudeCompactionSummaryModel(input: {
  readonly run: Pick<MaterializedClaudeCodeRun, "createUtilityModelResult"> | null;
  readonly fallback: () => LanguageModel;
  readonly onFailure: (error: ClaudeCodeRunExternalFailure) => void;
}): LanguageModel {
  if (input.run === null) return input.fallback();

  const created = input.run.createUtilityModelResult();
  return created.match({
    ok: (model) => model,
    err: (error) => {
      switch (error._tag) {
        case "ClaudeCodeRunExternalFailure":
          input.onFailure(error);
          return input.fallback();
      }
    },
  });
}

export async function rethrowBusAgentRunnerCleanupDefect(
  cleanup: () => void | Promise<void>,
): Promise<void> {
  await cleanup();
}

export type BusAgentRunnerTerminalCleanup = {
  readonly label:
    | "workflow-claim-timer-clear"
    | "control-capability-expire"
    | "workflow-request-expire"
    | "run-idle-watchdog-stop"
    | "agent-unsubscribe"
    | "compaction-unsubscribe"
    | "output-publisher-drain"
    | "core-named-retire"
    | "core-primary-retire"
    | "claude-dispose"
    | "level1-toolset-release"
    | "live-close";
  readonly run: () => void | Promise<void>;
};

export type BusAgentRunnerTerminalCleanupOperation = {
  readonly label: BusAgentRunnerTerminalCleanup["label"];
  readonly operation: Promise<void>;
};

export type BusAgentRunnerTerminalCleanupBatch = {
  readonly operations: readonly BusAgentRunnerTerminalCleanupOperation[];
  readonly completion: Promise<void>;
};

export function startBusAgentRunnerTerminalCleanup(
  cleanups: readonly BusAgentRunnerTerminalCleanup[],
): BusAgentRunnerTerminalCleanupBatch {
  const operations = cleanups.map((cleanup) => {
    const operation = rethrowBusAgentRunnerCleanupDefect(cleanup.run);
    return { label: cleanup.label, operation };
  });
  const completion = Promise.allSettled(operations.map(({ operation }) => operation)).then(
    () => undefined,
  );
  return { operations, completion };
}

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

// OpenCode-style tool output pruning:
// - Keep full tool call/result structure for forkability.
// - Compact *old* tool results (replace output with a placeholder) only in the
//   model-facing view, right before sending.
// - Track compacted toolCallIds in-memory per session for stability (cache hits).
const TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";
const TOOL_OUTPUT_CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS = new Set(["skill", "subagent_result"]);

export function withBlankLineBetweenTextParts(params: {
  accumulatedText: string;
  delta: string;
  partChanged: boolean;
}): string {
  if (!params.partChanged) return params.delta;
  if (params.accumulatedText.length === 0) return params.delta;
  if (params.delta.length === 0) return params.delta;
  if (/^\s/u.test(params.delta)) return params.delta;
  if (/\n\s*\n\s*$/u.test(params.accumulatedText)) return params.delta;
  if (/\n\s*$/u.test(params.accumulatedText)) return `\n${params.delta}`;
  return `\n\n${params.delta}`;
}

export type AssistantTextPartBoundaryState = {
  lastTextPartId: string | null;
  pendingRecoveryTextBoundary: boolean;
  pendingTextPartStartIds: Set<string>;
};

export function createAssistantTextPartBoundaryState(
  partialText: string | undefined,
): AssistantTextPartBoundaryState {
  return {
    lastTextPartId: null,
    pendingRecoveryTextBoundary: Boolean(partialText?.trim()),
    pendingTextPartStartIds: new Set<string>(),
  };
}

export function markAssistantTextPartStarted(
  state: AssistantTextPartBoundaryState,
  partId: string,
): void {
  state.pendingTextPartStartIds.add(partId);
}

export function markAssistantTextPartEnded(
  state: AssistantTextPartBoundaryState,
  partId: string,
): void {
  state.pendingTextPartStartIds.delete(partId);
}

export function consumeAssistantTextDelta(params: {
  state: AssistantTextPartBoundaryState;
  finalText: string;
  recoveryPartialText?: string;
  partId: string;
  delta: string;
}): string {
  const startedNewTextBlock = params.state.pendingTextPartStartIds.has(params.partId);
  const hasPartBoundary =
    startedNewTextBlock ||
    (params.state.lastTextPartId !== null && params.partId !== params.state.lastTextPartId);
  const accumulatedTextForBoundary =
    params.finalText.length > 0 ? params.finalText : (params.recoveryPartialText ?? "");
  const nextDelta = withBlankLineBetweenTextParts({
    accumulatedText: accumulatedTextForBoundary,
    delta: params.delta,
    partChanged: hasPartBoundary || params.state.pendingRecoveryTextBoundary,
  });
  if (nextDelta.length > 0) {
    const boundaryResolvedByThisDelta = /\S/u.test(params.delta);
    if (boundaryResolvedByThisDelta) {
      params.state.pendingRecoveryTextBoundary = false;
      params.state.pendingTextPartStartIds.delete(params.partId);
    }
  }
  params.state.lastTextPartId = params.partId;
  return nextDelta;
}

export function removeSilentAssistantTurnMessages(input: {
  messages: readonly ModelMessage[];
  startIndex: number;
  messageCount: number;
}): ModelMessage[] {
  const endIndex = input.startIndex + input.messageCount;
  const messages: ModelMessage[] = [];

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    if (index < input.startIndex || index >= endIndex || message.role !== "assistant") {
      messages.push(message);
      continue;
    }

    const text = (() => {
      if (typeof message.content === "string") return message.content;
      const textParts = message.content.filter((part) => part.type === "text");
      const finalAnswerParts = textParts.filter(
        (part) => openAIMessagePhase(part.providerOptions) === "final_answer",
      );
      return (finalAnswerParts.length > 0 ? finalAnswerParts : textParts)
        .map((part) => part.text)
        .join("\n\n");
    })();
    if (resolveReplyDeliveryFromFinalText(text) !== "skip") {
      messages.push(message);
      continue;
    }
    if (typeof message.content === "string") continue;

    const content = message.content.filter((part) => part.type !== "text");
    if (content.every((part) => part.type === "reasoning")) continue;
    messages.push({ ...message, content });
  }

  return messages;
}

export type ReasoningChunkState = {
  chunks: Map<string, string>;
  seq: number;
};

export function consumeReasoningChunkEvent(
  state: ReasoningChunkState,
  event:
    | { type: "start"; chunkId: string }
    | { type: "delta"; chunkId: string; delta: string }
    | { type: "end"; chunkId: string },
): {
  publishStart: boolean;
  snapshot: { delta: string; seq: number } | null;
} {
  if (event.type === "end") {
    state.chunks.delete(event.chunkId);
    return { publishStart: false, snapshot: null };
  }

  if (event.type === "start") {
    if (!state.chunks.has(event.chunkId)) {
      state.chunks.set(event.chunkId, "");
    }
    return { publishStart: true, snapshot: null };
  }

  const publishStart = !state.chunks.has(event.chunkId);
  const chunk = `${state.chunks.get(event.chunkId) ?? ""}${event.delta}`;
  state.chunks.set(event.chunkId, chunk);
  if (event.delta.length === 0) {
    return { publishStart, snapshot: null };
  }

  state.seq += 1;
  return {
    publishStart,
    snapshot: { delta: chunk, seq: state.seq },
  };
}

function estimateTokensFromValue(value: unknown): number {
  // Best-effort token estimate (OpenCode uses chars/4).
  const chars = safeStringify(value).length;
  return Math.max(0, Math.round(chars / TOOL_OUTPUT_CHARS_PER_TOKEN));
}

export function maybeMarkOldToolOutputsCompacted(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: Set<string>;
  protectTokens: number;
  minimumTokens: number;
}): number {
  let turns = 0;
  let total = 0;
  let pruned = 0;
  const toCompact = new Set<string>();

  // Walk backwards; skip the last turn (turn = user message).
  // This mirrors OpenCode's "turns < 2" behavior.
  outer: for (let msgIndex = params.messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = params.messages[msgIndex]!;
    if (msg.role === "user") turns++;
    if (turns < 2) continue;

    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.content[partIndex];
      if (part?.type !== "tool-result") continue;

      const toolName = part.toolName;
      if (toolName && TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS.has(toolName)) continue;
      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;

      // Once we reach already-compacted results, stop. Older ones should already be compacted.
      if (params.compactedToolCallIds.has(toolCallId)) break outer;

      const output = part.output;
      const estimate = estimateTokensFromValue(output);
      total += estimate;

      if (total > params.protectTokens) {
        pruned += estimate;
        toCompact.add(toolCallId);
      }
    }
  }

  if (pruned <= params.minimumTokens) return 0;

  let changed = false;
  for (const id of toCompact) {
    if (params.compactedToolCallIds.has(id)) continue;
    params.compactedToolCallIds.add(id);
    changed = true;
  }
  return changed ? pruned : 0;
}

export function applyToolOutputCompactionView(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: ReadonlySet<string>;
}): ModelMessage[] {
  let changed = false;

  const out = params.messages.map((m) => {
    if (m.role !== "tool") return m;
    if (!Array.isArray(m.content)) return m;

    let nextContent: ToolContent | null = null;

    for (let i = 0; i < m.content.length; i++) {
      const part = m.content[i];
      if (part?.type !== "tool-result") continue;

      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;
      if (!params.compactedToolCallIds.has(toolCallId)) continue;

      nextContent ??= m.content.map((p) => ({ ...p }));

      const nextPart = nextContent?.[i];
      if (nextPart?.type !== "tool-result") continue;

      nextPart["output"] = { type: "text", value: TOOL_OUTPUT_PLACEHOLDER };
      changed = true;
    }

    if (!nextContent) return m;
    return {
      ...m,
      content: nextContent,
    } satisfies ModelMessage;
  });

  return changed ? out : [...params.messages];
}

export function scrubLargeBinaryForModelView(
  messages: readonly ModelMessage[],
  limits: { maxBytesPerPart: number; maxBytesTotal: number },
): ModelMessage[] {
  return boundToolResultMediaForModelView(messages, limits);
}

function getBatchOkFromResult(event: { readonly result: unknown }): boolean | null {
  const { result } = event;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
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

function buildAutoInjectedThreadSearchToolCallId(requestId: string): string {
  return buildSyntheticToolCallId({
    prefix: "conversation_thread_search",
    seed: `${requestId}:auto-inject`,
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
}): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: params.toolCallId,
          toolName: CUSTOM_COMMAND_TOOL_NAME,
          input: {
            name: params.name,
            args: params.args,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            text: params.text,
            source: params.source,
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: params.toolCallId,
          toolName: CUSTOM_COMMAND_TOOL_NAME,
          output: params.output,
        },
      ],
    },
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

const AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME = "conversation_thread_search";
export const AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH = 320;
const AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD = Math.floor(
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1,
);

export type AutoInjectedThreadSearchPayload = {
  entries: Array<{
    threadId: string;
    title: string;
    brief?: string;
    timeRange?: string;
  }>;
};

type AutoInjectedThreadSearchEntry = AutoInjectedThreadSearchPayload["entries"][number];

type AutoInjectedThreadRankingDiagnostic = {
  threadId: string;
  rawScore: number;
  confidence: number;
  searchIndex: number;
  rank: number;
  breakdown: RankedAutoInjectThread["breakdown"];
};

type AutoInjectedThreadSearchAppendedEvent = {
  toolCallId: string;
  mode: "hybrid" | "semantic" | "lexical";
  limit: number;
  minScore: number;
  searches: readonly (readonly string[])[];
  participantFilterUserCount: number;
  entries: readonly AutoInjectedThreadSearchEntry[];
  ranking: readonly (AutoInjectedThreadRankingDiagnostic & {
    selection: RankedAutoInjectThread["selection"];
  })[];
  highestRejectedByConfidence: AutoInjectedThreadRankingDiagnostic | null;
  expansionMinConfidence: number;
  corpusDocumentCount: number;
};

export function buildAutoInjectedThreadSearchMessages(params: {
  toolCallId: string;
  entries: readonly AutoInjectedThreadSearchEntry[];
}): ModelMessage[] {
  const payload: AutoInjectedThreadSearchPayload = {
    entries: params.entries.map((entry) => ({
      threadId: entry.threadId,
      title: entry.title,
      ...(entry.brief ? { brief: entry.brief } : {}),
      ...(entry.timeRange ? { timeRange: entry.timeRange } : {}),
    })),
  };

  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: params.toolCallId,
          toolName: AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME,
          input: {
            note: "auto-injected after long user input",
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: params.toolCallId,
          toolName: AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME,
          output: {
            type: "json",
            value: payload,
          },
        },
      ],
    },
  ];
}

function formatAutoInjectedThreadBrief(brief: string): string | undefined {
  const trimmed = brief.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD) return trimmed;

  return `${trimmed.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH).trimEnd()} ...(${trimmed.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`;
}

function formatRankedAutoInjectedThread(
  candidate: RankedAutoInjectThread,
): AutoInjectedThreadSearchEntry {
  const timeRange = candidate.result.timeRange
    ? formatInjectedThreadTimeRange(candidate.result.timeRange)
    : undefined;
  const brief = formatAutoInjectedThreadBrief(candidate.result.brief);
  return {
    threadId: candidate.result.threadId,
    title: candidate.result.title,
    ...(brief ? { brief } : {}),
    ...(timeRange ? { timeRange } : {}),
  };
}

function collectAutoInjectedThreadIds(messages: readonly ModelMessage[]): Set<string> {
  const threadIds = new Set<string>();

  for (const message of messages) {
    const content: unknown = message.content;
    if (message.role !== "tool" || !Array.isArray(content)) continue;

    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type !== "tool-result" || part.toolName !== AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME) {
        continue;
      }

      const output = part.output;
      const payload = isRecord(output) && output.type === "json" ? output.value : output;
      const entries = isRecord(payload) ? payload.entries : undefined;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const threadId = entry.threadId;
        if (typeof threadId === "string" && threadId.length > 0) threadIds.add(threadId);
      }
    }
  }

  return threadIds;
}

function padLocalDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalThreadTime(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const year = date.getFullYear();
  const month = padLocalDatePart(date.getMonth() + 1);
  const day = padLocalDatePart(date.getDate());
  const hour = padLocalDatePart(date.getHours());
  const minute = padLocalDatePart(date.getMinutes());
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function formatInjectedThreadTimeRange(input: { start: string; end: string }): string | undefined {
  const start = formatLocalThreadTime(input.start);
  const end = formatLocalThreadTime(input.end);
  if (!start || !end) return undefined;
  return `${start} - ${end}`;
}

export async function maybeBuildAutoInjectedThreadSearchMessages(params: {
  cfg: CoreConfig;
  conversationThreads?: ConversationThreadToolService;
  requestId: string;
  raw?: AgentRunnerRaw;
  previousMessages?: readonly ModelMessage[];
  userMessages: readonly ModelMessage[];
  publishToolStatus: (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => Promise<void>;
  onInjected?: (event: AutoInjectedThreadSearchAppendedEvent) => void;
  onError: (message: string, error: BusAgentRunnerErrorProjection) => void;
  autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
}): Promise<ModelMessage[]> {
  const autoInject = params.cfg.conversation.thread.autoInject;
  if (!autoInject.enabled) return [];
  if (!params.conversationThreads) return [];
  const conversationThreads = params.conversationThreads;

  const latestInput = latestUserInput(params.userMessages);
  const text = latestInput.text;
  const previouslyInjectedThreadIds = collectAutoInjectedThreadIds(params.previousMessages ?? []);
  const minTextUnits =
    previouslyInjectedThreadIds.size > 0
      ? autoInject.followUpMinTextUnits
      : autoInject.minTextUnits;
  if (
    !latestInput.hasAttachment &&
    !shouldRunAutoInjectedThreadSearch({
      text: latestInput.authoredText,
      minTextUnits,
    })
  ) {
    return [];
  }

  const participantIds = autoInject.filterCurrentParticipants
    ? getParticipantUserIdsFromRaw(params.raw)
    : [];
  if (autoInject.filterCurrentParticipants && participantIds.length === 0) return [];

  const autoInjectUsage =
    params.autoInjectUsage ??
    createConversationThreadAutoInjectUsageAccumulator({ requestId: params.requestId });
  let usageStatus: "completed" | "abstained" | "partial" | "failed" = "failed";
  let usageSearchCount = 0;
  let usageQueryCount = 0;

  const toolCallId = buildAutoInjectedThreadSearchToolCallId(params.requestId);
  const display = `${AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME} auto-injected metadata`;
  const publishToolStatusBestEffort = async (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => {
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          await params.publishToolStatus(update);
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const error = attempt.error.cause;
        params.onError(
          "auto-injected thread search status publish failed; continuing",
          projectBusAgentRunnerError(error),
        );
      }
    }
  };

  await publishToolStatusBestEffort({ toolCallId, status: "start", display });

  {
    const attempt = await Result.tryPromise({
      try: async () => {
        const plan = await conversationThreads.planAutoInjectSearch({
          text,
          content: latestInput.content,
          autoInjectUsage,
        });
        usageSearchCount = plan.searches.length;
        usageQueryCount = plan.searches.reduce(
          (sum, searchPlan) => sum + searchPlan.queries.length,
          0,
        );
        if (plan.searches.length === 0) {
          usageStatus = "abstained";
          await publishToolStatusBestEffort({
            toolCallId,
            status: "end",
            display,
            ok: true,
          });
          return [];
        }
        const searchRecallLimit = Math.min(50, Math.max(autoInject.limit * 5, 10));
        const settledSearches = await Promise.allSettled(
          plan.searches.map((searchPlan) =>
            conversationThreads.search({
              query: searchPlan.queries,
              queryAboutness: searchPlan.aboutness,
              limit: searchRecallLimit,
              minScore: autoInject.minScore,
              mode: autoInject.mode,
              verbose: true,
              autoInjectUsage,
              ...(participantIds.length > 0 ? { participantIdsAny: participantIds } : {}),
            }),
          ),
        );
        let fulfilledSearches = 0;
        const successfulSearches: Array<{
          searchIndex: number;
          result: ConversationThreadSearchResult;
        }> = [];
        settledSearches.forEach((result, searchIndex) => {
          if (result.status === "fulfilled") {
            fulfilledSearches += 1;
            successfulSearches.push({ searchIndex, result: result.value });
            return;
          }

          params.onError(
            "auto-injected thread search failed; continuing with partial metadata",
            projectBusAgentRunnerError(result.reason, `Search ${searchIndex} failed`),
          );
        });
        if (fulfilledSearches === 0) {
          const failure = projectBusAgentRunnerError(
            new Error("all auto-injected thread searches failed"),
          );
          await publishToolStatusBestEffort({
            toolCallId,
            status: "end",
            display,
            ok: false,
            error: failure.message,
          });
          params.onError(
            "auto-injected thread search failed; continuing without metadata",
            failure,
          );
          return [];
        }
        usageStatus = fulfilledSearches === plan.searches.length ? "completed" : "partial";
        const corpusDocuments = conversationThreads.getAutoInjectRankingCorpusDocuments?.() ?? [];
        const rankingResult = rankAutoInjectedThreadSearchResults({
          plan,
          searches: successfulSearches,
          corpusDocuments,
          excludedThreadIds: previouslyInjectedThreadIds,
          limit: autoInject.limit,
          expansionMinConfidence: autoInject.expansionMinConfidence,
        });
        const rankedEntries = rankingResult.selected;
        const entries = rankedEntries.map(formatRankedAutoInjectedThread);

        await publishToolStatusBestEffort({
          toolCallId,
          status: "end",
          display,
          ok: true,
        });

        if (entries.length === 0) return [];
        {
          const attempt = Result.try({
            try: () => {
              params.onInjected?.({
                toolCallId,
                mode: autoInject.mode,
                limit: autoInject.limit,
                minScore: autoInject.minScore,
                searches: plan.searches.map((searchPlan) => searchPlan.queries),
                participantFilterUserCount: participantIds.length,
                entries,
                ranking: rankedEntries.map((entry) => ({
                  threadId: entry.result.threadId,
                  rawScore: entry.rawScore,
                  confidence: entry.confidence,
                  selection: entry.selection,
                  searchIndex: entry.searchIndex,
                  rank: entry.rank,
                  breakdown: entry.breakdown,
                })),
                highestRejectedByConfidence: rankingResult.highestRejectedByConfidence
                  ? {
                      threadId: rankingResult.highestRejectedByConfidence.result.threadId,
                      rawScore: rankingResult.highestRejectedByConfidence.rawScore,
                      confidence: rankingResult.highestRejectedByConfidence.confidence,
                      searchIndex: rankingResult.highestRejectedByConfidence.searchIndex,
                      rank: rankingResult.highestRejectedByConfidence.rank,
                      breakdown: rankingResult.highestRejectedByConfidence.breakdown,
                    }
                  : null,
                expansionMinConfidence: autoInject.expansionMinConfidence,
                corpusDocumentCount: corpusDocuments.length,
              });
            },
            catch: captureError,
          });

          if (attempt.isErr()) {
            const error = attempt.error.cause;
            params.onError(
              "auto-injected thread search append log failed; continuing",
              projectBusAgentRunnerError(error),
            );
          }
        }
        return buildAutoInjectedThreadSearchMessages({ toolCallId, entries });
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const error = attempt.error.cause;
      const projected = projectBusAgentRunnerError(error);
      await publishToolStatusBestEffort({
        toolCallId,
        status: "end",
        display,
        ok: false,
        error: projected.message,
      });
      params.onError("auto-injected thread search failed; continuing without metadata", projected);
      autoInjectUsage.finish({
        status: "failed",
        searchCount: usageSearchCount,
        queryCount: usageQueryCount,
      });
      return [];
    }
    autoInjectUsage.finish({
      status: usageStatus,
      searchCount: usageSearchCount,
      queryCount: usageQueryCount,
    });
    return attempt.value;
  }
}

export function buildDeferredSubagentResultMessages(
  completion: WorkflowLiveParentCompletion,
): ModelMessage[] {
  const toolCallId = buildSubagentResultToolCallId(completion.runId);
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
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "subagent_result",
          input: {
            profile: completion.profile,
            sessionName: completion.sessionName,
            status: completion.status,
            workflowRunId: completion.runId,
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "subagent_result",
          output: {
            type: "json",
            value: payload,
          },
        },
      ],
    },
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

function hasDeferredSubagentWorkflowCall(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        part.toolName === "subagent_result" &&
        isRecord(part.input) &&
        part.input["workflowRunId"] === workflowRunId
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasDeferredSubagentWorkflowResult(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
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
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "subagent_result") continue;
      if (
        part.output.type === "json" &&
        isRecord(part.output.value) &&
        part.output.value["workflowRunId"] === completion.runId
      ) {
        return true;
      }
    }
  }
  return false;
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

function hasCurrentDeferredSubagentResult(
  messages: readonly ModelMessage[],
  completion: Pick<WorkflowLiveParentCompletion, "runId">,
): boolean {
  return (
    hasDeferredSubagentWorkflowResult(messages, completion.runId) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.runId))
  );
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
    if (hasCurrentDeferredSubagentResult(input.canonicalMessages, completion)) return [];
    const messages = buildDeferredSubagentResultMessages(completion);
    return hasDeferredSubagentWorkflowCall(input.canonicalMessages, completion.runId)
      ? messages.slice(1)
      : messages;
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

function persistHeartbeatSurfaceHandoffs(params: {
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
  if (!refs || refs.length === 0) return;

  const extracted = extractHeartbeatSurfaceSendHandoffs(params.responseMessages);
  const fallback = buildHeartbeatHandoffTranscript(params.responseMessages);
  if (!fallback) return;

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

type Enqueued = {
  queueEntryId: string;
  requestDeliveryId?: string;
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  storedMessages: StoredMessageV1[];
  corePrimaryLineage?: CorePrimaryLineageV2;
  modelOverride?: string;
  raw?: AgentRunnerRaw;
  authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  currentTurnUserId?: string;
  currentTurnMessageRef?: MsgRef;
  verifiedIngress?: boolean;
  identityOwner?: RequestMessageCacheOwner;
  restoredSafetyMode?: SessionSafetyMode;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
  storedRecoveryCheckpoint?: StoredMessageV1[];
  previousRecoveryCheckpoint?: AgentRunCheckpointV1;
  loadedCatalogIds?: readonly string[];
  acceptedCorePrimaryLineage?: CorePrimaryLineageV2;
  acceptedCurrentTurnUserId?: string;
  retainedRequestDeliveries?: readonly AgentRunnerRetainedRequestDelivery[];
  journalHandle?: AgentRunJournalHandle;
};

type QueueCancellationGroup = {
  readonly requestId: string;
  readonly requestClient: AdapterPlatform;
  readonly entries: readonly Enqueued[];
};

type QueueLifecycleAttempt = {
  readonly eventId: string;
  readonly controlRequestId: string;
  readonly controlRequestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly kind: "queued-cancellation" | "buffered-absorption";
  readonly detail: string;
  pendingGroups: QueueCancellationGroup[];
  controlApplied: boolean;
};

export type AgentRunnerRetainedRequestDelivery = {
  readonly requestDeliveryId: string;
  readonly outcome: RequestDeliveryTerminalOutcome;
};

export type BusAgentRunnerRequestDelivery = Pick<
  RequestDeliveryCoordinator<
    CorePreparedRequestEnvelope,
    CoreAcceptedRequestWork,
    CoreRequestOutputMetadata
  >,
  "handleDelivery" | "replaceAcceptedWork" | "terminalize"
>;

function createFreshOnlyLineage(reason: string, currentCanonicalStart = 0): CorePrimaryLineageV2 {
  const created = createCorePrimaryLineageFreshOnlyV2(reason, currentCanonicalStart);
  const selectLineage = created.match<() => CorePrimaryLineageV2>({
    ok: (lineage) => () => lineage,
    err: () => () => ({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "lineage-fallback-construction-failed",
    }),
  });
  return selectLineage();
}

export function validateCorePrimaryLineageAtRunnerIntake(input: {
  requestClient: AdapterPlatform;
  sessionId?: string;
  runProfile: AgentRunProfile;
  messages: readonly ModelMessage[];
  corePrimaryLineage: unknown;
  transcriptStore?: TranscriptStore;
}): CorePrimaryLineageV2 | undefined {
  if (input.requestClient !== "discord" || input.runProfile !== "primary") return undefined;
  const fallbackCurrentCanonicalStart = Math.max(
    0,
    input.messages.findLastIndex((message) => message.role === "user"),
  );
  if (input.corePrimaryLineage === undefined) {
    return createFreshOnlyLineage("missing-manifest", fallbackCurrentCanonicalStart);
  }
  const decoded = decodeCorePrimaryLineageV2(input.corePrimaryLineage, input.messages);
  const continueDecoded = decoded.match<() => CorePrimaryLineageV2>({
    err: () => () =>
      createFreshOnlyLineage("malformed-or-unaligned-manifest", fallbackCurrentCanonicalStart),
    ok: (lineage) => () => {
      if (lineage.state !== "complete") return lineage;
      if (!input.sessionId) {
        return createFreshOnlyLineage("missing-lineage-scope", lineage.currentCanonicalStart);
      }
      if (!input.transcriptStore?.validateCorePrimaryLineageReferences) {
        return createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart);
      }
      const invalidReason = input.transcriptStore.validateCorePrimaryLineageReferences({
        manifest: lineage,
        requestClient: input.requestClient,
        sessionId: input.sessionId,
        surfaceId: `discord:${input.sessionId}`,
      });
      const continueValidation = invalidReason.match<() => CorePrimaryLineageV2>({
        err: () => () =>
          createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart),
        ok: (storedInvalidReason) => () =>
          storedInvalidReason
            ? createFreshOnlyLineage(storedInvalidReason, lineage.currentCanonicalStart)
            : lineage,
      });
      return continueValidation();
    },
  });
  return continueDecoded();
}

export function degradeCorePrimaryLineageForMutation(
  reason: string,
  currentCanonicalStart = 0,
): CorePrimaryLineageV2 {
  return createFreshOnlyLineage(reason, currentCanonicalStart);
}

export function corePrimaryLineageHasCompactionCheckpoint(
  lineage: CorePrimaryLineageV2 | undefined,
): boolean {
  return (
    lineage?.state === "complete" &&
    lineage.segments.some((segment) => segment.atoms.some((atom) => atom.kind === "checkpoint"))
  );
}

const AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE = "conversation-thread-auto-inject";

export function appendAutoInjectedThreadSearchLineage(input: {
  lineage: unknown;
  canonicalMessages: readonly ModelMessage[];
  injectedMessages: readonly ModelMessage[];
}): CorePrimaryLineageV2 {
  const parsedShape = corePrimaryLineageV2Schema.safeParse(input.lineage);
  const fallbackCurrentCanonicalStart = parsedShape.success
    ? parsedShape.data.currentCanonicalStart
    : Math.max(
        0,
        input.canonicalMessages.findLastIndex((message) => message.role === "user"),
      );
  const failClosed = () =>
    degradeCorePrimaryLineageForMutation(
      "synthetic-thread-search-insertion",
      fallbackCurrentCanonicalStart,
    );

  const decoded = decodeCorePrimaryLineageV2(input.lineage, input.canonicalMessages);
  const continueDecoded = decoded.match<() => CorePrimaryLineageV2>({
    err: () => failClosed,
    ok: (lineage) => () => {
      if (lineage.state !== "complete" || input.injectedMessages.length === 0) {
        return failClosed();
      }
      const previous = lineage.segments.at(-1);
      if (!previous || previous.canonicalEnd !== input.canonicalMessages.length) {
        return failClosed();
      }

      const preparedInjected = projectStoredMessagesV1(input.injectedMessages).andThen((messages) =>
        hashCanonicalStoredMessagesV2(messages).map((digest) => ({
          messages,
          messageDigest: digest.hash,
        })),
      );
      const prepared = preparedInjected.match({
        ok: (value) => value,
        err: () => null,
      });
      if (!prepared) return failClosed();
      const atom = {
        kind: "synthetic" as const,
        source: AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE,
        messageDigest: prepared.messageDigest,
      };
      const cumulativeAtomCount = previous.cumulativeAtomCount + 1;
      const extended = extendCoreLineagePrefixDigestV2(
        previous.cumulativePrefixDigest,
        cumulativeAtomCount,
        atom,
      );
      const continueExtended = extended.match<() => CorePrimaryLineageV2>({
        err: () => failClosed,
        ok: (cumulativePrefixDigest) => () => {
          const candidate = {
            ...lineage,
            segments: [
              ...lineage.segments,
              {
                atoms: [atom],
                canonicalMessages: prepared.messages,
                canonicalStart: previous.canonicalEnd,
                canonicalEnd: previous.canonicalEnd + input.injectedMessages.length,
                cumulativeAtomCount,
                cumulativePrefixDigest,
              },
            ],
          };
          const parsed = decodeCorePrimaryLineageV2(candidate, [
            ...input.canonicalMessages,
            ...prepared.messages,
          ]);
          const continueParsed = parsed.match<() => CorePrimaryLineageV2>({
            ok: (value) => () => (value.state === "complete" ? value : failClosed()),
            err: () => failClosed,
          });
          return continueParsed();
        },
      });
      return continueExtended();
    },
  });
  return continueDecoded();
}

export function mapCorePrimaryCompactionCurrentCanonicalStart(input: {
  previousCurrentCanonicalStart: number;
  replacement: {
    originalSuffixStart: number;
    replacementSuffixStart: number;
    replacementMessageCount: number;
  };
}): number {
  const retainedOffset =
    input.previousCurrentCanonicalStart - input.replacement.originalSuffixStart;
  if (retainedOffset < 0) return 0;
  return Math.min(
    input.replacement.replacementMessageCount,
    input.replacement.replacementSuffixStart + retainedOffset,
  );
}

function persistedCompleteLineage(lineage: CorePrimaryLineageV2 | undefined): {
  corePrimaryLineage?: CoreLineageManifestV2;
} {
  return lineage?.state === "complete" ? { corePrimaryLineage: lineage } : {};
}

function requireStoredMessageHash(messages: readonly StoredMessageV1[]): string {
  return hashCanonicalStoredMessagesV2(messages).match({
    ok: (digest) => () => digest.hash,
    err: (error) => () => signalBusAgentRunnerHostFailure(error),
  })();
}

export function resolveCorePrimaryTranscriptProviderState(input: {
  targetFamily: HistoryProviderState["lastFamily"];
  lineage?: CorePrimaryLineageV2;
  transcriptStore?: TranscriptStore;
}): HistoryProviderState {
  const lineage = input.lineage;
  let containsCrossFamilyTurns = lineage?.state !== "complete";
  if (lineage?.state === "complete") {
    for (const segment of lineage.segments) {
      const atom = segment.atoms[0];
      if (!atom) {
        containsCrossFamilyTurns = true;
        continue;
      }
      if (atom.kind === "request") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.match({
          ok: (value) => value?.providerState,
          err: () => undefined,
        });
        if (
          !state ||
          state.lastFamily !== atom.providerFamily ||
          state.containsCrossFamilyTurns !== atom.containsCrossFamilyTurns ||
          state.lastFamily !== input.targetFamily ||
          state.containsCrossFamilyTurns
        ) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (atom.kind === "checkpoint") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.match({
          ok: (value) => value?.providerState,
          err: () => undefined,
        });
        if (!state || state.lastFamily !== input.targetFamily || state.containsCrossFamilyTurns) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (
        segment.canonicalMessages.some(
          (message) => message.role === "assistant" || message.role === "tool",
        )
      ) {
        containsCrossFamilyTurns = true;
      }
    }
  }
  return {
    lastFamily: input.targetFamily,
    containsCrossFamilyTurns,
  };
}

class ShutdownDrainingAbort extends Error {
  constructor() {
    super("server shutting down");
    this.name = "ShutdownDrainingAbort";
  }
}

class PreAgentRunCancelledError extends Error {
  constructor() {
    super("cancelled before agent start");
    this.name = "PreAgentRunCancelledError";
  }
}

const AGENT_TIMEOUT_ABORT_GRACE_MS = 5_000;
const TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS = 4_000;
const LIVE_PARENT_RECONCILE_MS = 1_000;
const SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS = 3;
export const WORKFLOW_REQUEST_CLAIM_HEARTBEAT_MS = 10_000;

function isCancelControlEntry(entry: Enqueued): boolean {
  return parseRequestControlFromRaw(entry.raw).cancel;
}

function collectBufferedPromptEntriesForActiveRequest(input: {
  queue: readonly Enqueued[];
  activeRequestId: string;
}): Enqueued[] {
  const out: Enqueued[] = [];

  for (const next of input.queue) {
    if (next.queue !== "prompt") continue;
    if (parseBufferedForActiveRequestIdFromRaw(next.raw) !== input.activeRequestId) continue;
    out.push(next);
  }

  return out;
}

function removeQueuedEntriesByReference(queue: Enqueued[], removed: readonly Enqueued[]): number {
  if (removed.length === 0) return 0;
  const targets = new Set(removed);
  const before = queue.length;

  for (let i = 0; i < queue.length; ) {
    if (!targets.has(queue[i]!)) {
      i += 1;
      continue;
    }

    queue.splice(i, 1);
  }

  return before - queue.length;
}

function groupQueueCancellationEntries(entries: readonly Enqueued[]): QueueCancellationGroup[] {
  const groups = new Map<string, QueueCancellationGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.requestId);
    if (existing) {
      groups.set(entry.requestId, {
        ...existing,
        entries: [...existing.entries, entry],
      });
      continue;
    }
    groups.set(entry.requestId, {
      requestId: entry.requestId,
      requestClient: entry.requestClient,
      entries: [entry],
    });
  }
  return [...groups.values()];
}

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

export function shouldCancelIdleOnlyGlobalRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy !== "idle_only_global") return false;

  for (const [queuedSessionId, state] of params.states) {
    if (!state.running) continue;
    if (queuedSessionId === params.sessionId) return true;
    if (!isHeartbeatSessionId(queuedSessionId)) return true;
  }

  return false;
}

export function shouldCancelRunPolicyRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy === "idle_only_global") {
    return shouldCancelIdleOnlyGlobalRequest(params);
  }

  if (params.runPolicy !== "idle_only_session") return false;

  const state = params.states.get(params.sessionId);
  return Boolean(state?.running);
}

export class AgentRunModelSelectionInvalid extends TaggedError("AgentRunModelSelectionInvalid")<{
  readonly reason: "alias-not-selectable" | "alias-required";
  readonly modelOverride: string;
  readonly message: string;
}> {}

type AgentRunModelResolutionError = AgentRunModelSelectionInvalid | ModelResolutionFailed;

export function resolveAgentRunModelResult(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: DurableResolvedModelRequest;
}): ResultType<ResolvedModelPlan, AgentRunModelResolutionError> {
  const subagentProfileConfig =
    params.runProfile === "primary"
      ? null
      : resolveNativeSubagentProfile(params.cfg, params.runProfile);

  if (params.resolvedModelRequest) {
    const plan = fromDurableResolvedModelPlanResult(params.resolvedModelRequest);
    return plan.map((value) =>
      params.reasoningOverride ? withModelPlanReasoning(value, params.reasoningOverride) : value,
    );
  }

  if (params.runProfile !== "primary" && params.requestModelOverride) {
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

  const applyHeadReasoning = (head: ResolvedModelRef): ResolvedModelRef => {
    const profileHead = subagentProfileConfig?.reasoning
      ? { ...head, reasoning: subagentProfileConfig.reasoning }
      : head;
    return params.reasoningOverride
      ? { ...profileHead, reasoning: params.reasoningOverride }
      : profileHead;
  };

  if (params.requestModelOverride) {
    const resolved = resolveModelPlanResult(params.cfg, {
      head: { model: params.requestModelOverride },
      fallback: [],
      headSource: "cmd.request.message.modelOverride",
      fallbackSource: "cmd.request.message.modelOverride.fallback",
    });
    const fallbacks = resolveAgentRunModelFallbacksResult(params);
    return Result.all([resolved, fallbacks]).map(([plan, fallbackValues]) => ({
      head: applyHeadReasoning(plan.head),
      fallbacks: fallbackValues,
    }));
  }

  if (subagentProfileConfig?.model) {
    const resolved = resolveModelPlanResult(params.cfg, {
      head: {
        model: subagentProfileConfig.model,
        reasoning: subagentProfileConfig.reasoning,
        options: subagentProfileConfig.options,
      },
      fallback: [],
      headSource: `agent.subagents.profiles.${params.runProfile}.model`,
      fallbackSource: `agent.subagents.profiles.${params.runProfile}.fallback`,
    });
    const fallbacks = resolveAgentRunModelFallbacksResult(params);
    return Result.all([resolved, fallbacks]).map(([plan, fallbackValues]) => ({
      head: applyHeadReasoning(plan.head),
      fallbacks: fallbackValues,
    }));
  }

  const slot = subagentProfileConfig?.modelSlot ?? "main";
  const resolved = resolveModelPlanResult(params.cfg, {
    head: params.cfg.models[slot],
    fallback: [],
    headSource: `models.${slot}.model`,
    fallbackSource: `models.${slot}.fallback`,
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
  profileReasoning?: ModelReasoningEffort;
};

function resolveAgentRunFallbackSource(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
}): AgentRunFallbackSource | null {
  const profile =
    params.runProfile === "primary"
      ? null
      : resolveNativeSubagentProfile(params.cfg, params.runProfile);

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
      ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }

  if (profile?.model) {
    if (profile.fallback !== undefined) {
      return {
        entries: profile.fallback,
        source: `agent.subagents.profiles.${params.runProfile}.fallback`,
        ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
      };
    }
    const preset = profile.model.includes("/") ? undefined : params.cfg.models.def[profile.model];
    if (!profile.model.includes("/") && !preset) return null;
    return {
      entries: preset?.fallback ?? [],
      source: `models.def.${profile.model}.fallback`,
      ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }

  const slot = profile?.modelSlot ?? "main";
  const slotConfig = params.cfg.models[slot];
  if (profile?.fallback !== undefined) {
    return {
      entries: profile.fallback,
      source: `agent.subagents.profiles.${params.runProfile}.fallback`,
      ...(profile.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }
  if (slotConfig.fallback !== undefined) {
    return {
      entries: slotConfig.fallback,
      source: `models.${slot}.fallback`,
      ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
    };
  }
  const preset = slotConfig.model.includes("/")
    ? undefined
    : params.cfg.models.def[slotConfig.model];
  if (!slotConfig.model.includes("/") && !preset) return null;
  return {
    entries: preset?.fallback ?? [],
    source: `models.def.${slotConfig.model}.fallback`,
    ...(profile?.reasoning ? { profileReasoning: profile.reasoning } : {}),
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
  return resolved.map((values) => {
    let fallbacks = values;
    if (fallbackSource.profileReasoning) {
      fallbacks = fallbacks.map((candidate, index) => {
        const configured = fallbackSource.entries[index];
        return typeof configured === "object" && configured.reasoning !== undefined
          ? candidate
          : { ...candidate, reasoning: fallbackSource.profileReasoning };
      });
    }
    return params.reasoningOverride
      ? fallbacks.map((fallback) => ({
          ...fallback,
          reasoning: params.reasoningOverride,
        }))
      : fallbacks;
  });
}

export function resolveAgentRunModelFallbacks(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
}): readonly ResolvedModelRef[] {
  return adaptModelResolutionToBusRunnerHost(resolveAgentRunModelFallbacksResult(params));
}

export function selectNextNativeModelFallback(params: {
  plan: ResolvedModelPlan;
  activeIndex: number;
  onSkipClaudeCode?: (candidate: ResolvedModelRef, index: number) => void;
}): { candidate: ResolvedModelRef; index: number } | null {
  const candidates = [params.plan.head, ...params.plan.fallbacks];
  const current = candidates[params.activeIndex];
  if (!current) return null;
  const latchedFamily = classifyHistoryProviderFamily({
    type: params.plan.head.provider,
  });
  if (latchedFamily === "claude-code") return null;

  for (let index = params.activeIndex + 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (classifyHistoryProviderFamily({ type: candidate.provider }) !== latchedFamily) {
      params.onSkipClaudeCode?.(candidate, index);
      continue;
    }
    return { candidate, index };
  }
  return null;
}

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
  toolset.updateActiveBatchTools(activeToolNames);
  params.target.setActiveTools(activeToolNames);
  return toolset;
}

export function applyCompleteLevel1Tools(
  target: Level1ToolAuthorityTarget,
  toolset: BuiltLevel1Toolset,
): void {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  target.setTools(toolset.tools);
  target.setActiveTools(new Set(Object.keys(toolset.tools)));
}

export function completeLevel1ToolMapping(toolset: BuiltLevel1Toolset): {
  tools: ToolSet;
  catalogMetadata: BuiltLevel1Toolset["catalogMetadata"];
} {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  return {
    tools: toolset.tools,
    catalogMetadata: toolset.catalogMetadata,
  };
}

type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
  activeRun: {
    requestDeliveryId?: string;
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    runProfile: AgentRunProfile;
    queue: RequestQueueMode;
    runPolicy: RequestRunPolicy;
    origin?: RequestOrigin;
    messages: ModelMessage[];
    storedMessages: StoredMessageV1[];
    corePrimaryLineage?: CorePrimaryLineageV2;
    toolAuthority: LineageToolAuthority;
    modelOverride?: string;
    currentTurnUserId?: string;
    currentTurnMessageRef?: MsgRef;
    raw?: AgentRunnerRaw;
    resolvedModelSpec: string | null;
    resolvedReasoning: ModelReasoningEffort | undefined;
    resolvedProviderFamily: HistoryProviderState["lastFamily"] | null;
    partialText: string;
    liveParent: ReturnType<WorkflowLiveParentBridge["registerParent"]> | undefined;
    claudeCodeControl: ClaudeCodeRunControl | null;
    materializeStoredMessages:
      | ((messages: readonly StoredMessageV1[]) => Promise<ModelMessage[]>)
      | null;
    rememberStoredMessages: (
      providerMessages: readonly ModelMessage[],
      storedMessages: readonly StoredMessageV1[],
    ) => void;
    notifyWaiters: () => void;
    flushOutput: () => void;
    setCurrentTurnContext: (userId: string | undefined, messageRef: MsgRef | undefined) => void;
    cancel: () => void;
    started: boolean;
    startedAt: number;
    activeTools: Map<string, { toolName: string; startedAt: number }>;
    retainedRequestDeliveries: Map<string, RequestDeliveryTerminalOutcome>;
    checkpointedRetainedRequestDeliveryIds: Set<string>;
    retainedRequestDeliveryByInputId: Map<AgentInputQueueId, string>;
    journalHandle: AgentRunJournalHandle | null;
    checkpointWriter: {
      disabled: boolean;
      pending: {
        readonly messages: readonly ModelMessage[];
        readonly canonicalInputIds: ReadonlySet<AgentInputQueueId>;
        readonly identityProjection: StoredMessageIdentityProjectionV1;
      } | null;
      operation: Promise<void> | null;
      closed: boolean;
      abandoned: boolean;
      retryInputIds: Set<AgentInputQueueId>;
      inFlightInputIds: ReadonlySet<AgentInputQueueId> | null;
      lastCommittedProviderMessages: readonly ModelMessage[];
      lastCommittedStoredMessages: readonly StoredMessageV1[];
      retainedPredecessorStoredMessages: readonly StoredMessageV1[];
    };
  } | null;
  /** Track toolCallIds whose outputs are compacted in the model-facing view. */
  compactedToolCallIds: Set<string>;
};

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

export function formatClaudeLifecycleLogFields(
  event: string,
  detail: Readonly<Record<string, string | number | boolean | null | undefined>>,
  error?: AnyTaggedError,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  const context = formatBridgeLogContext({ lifecycle: event, ...detail });
  return error ? formatBridgeTaggedErrorForLog(error, context) : context;
}

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
  bus: LilacBus;
  blobStore: AnthropicFallbackBlobStore;
  resourceAccess?: Pick<ResourceAccess, "describe" | "open">;
  requestDelivery?: BusAgentRunnerRequestDelivery;
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
  materializeClaudeCodeRun?: typeof materializeClaudeCodeRun;
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
  const cancelledByRequestId = new Set<string>();
  const reservedQueueEntries = new Set<Enqueued>();
  const queueLifecycleAttempts = new Map<string, QueueLifecycleAttempt>();
  const shutdownAbortRequestIds = new Set<string>();
  const requestMessageCache = params.requestMessageCache ?? createRequestMessageCache();
  let draining = false;
  let terminalPanic: Panic | null = null;
  let terminalPanicReported = false;
  let activeDrainOperation: Promise<void> | null = null;
  let terminalCleanupOperations: readonly BusAgentRunnerTerminalCleanupOperation[] = [];
  let terminalCleanupCompletion: Promise<void> | null = null;
  let runnerActivated = params.startPaused !== true;
  let runnerAdmissionStopped = false;
  let activeAgentRunJournal = params.agentRunJournal ?? null;
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

  const logJournalReset = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly error: Error;
  }): void => {
    logger.warn("agent run journal reset", {
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      errorTag: input.error.name,
    });
  };

  const releaseRunCheckpointBlobs = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): void => {
    const releaseError = params.transcriptStore
      ?.releaseAgentRunCheckpointBlobs?.({ requestDeliveryId: input.requestDeliveryId })
      .match({ ok: () => null, err: (error) => error });
    if (!releaseError) return;
    logger.warn(
      "agent run checkpoint blob reference cleanup deferred",
      formatBridgeTaggedErrorForLog(releaseError, input),
    );
  };

  const resetRunJournal = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): boolean => {
    const journal = activeAgentRunJournal;
    if (!journal) return false;
    const reset = journal.resetRun(input.requestDeliveryId);
    const resetError = reset.match({ ok: () => null, err: (error) => error });
    if (!resetError) {
      releaseRunCheckpointBlobs(input);
      return true;
    }
    logJournalReset({ ...input, error: resetError });
    activeAgentRunJournal = null;
    return false;
  };

  const openRunJournal = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): AgentRunJournalHandle | null => {
    const journal = activeAgentRunJournal;
    if (!journal) return null;
    const opened = journal.openRun(input);
    const decision = opened.match<
      | { readonly kind: "opened"; readonly handle: AgentRunJournalHandle }
      | { readonly kind: "reset"; readonly error: Error }
    >({
      ok: (handle) => ({ kind: "opened", handle }),
      err: (error) => ({ kind: "reset", error }),
    });
    if (decision.kind === "opened") return decision.handle;
    logJournalReset({ ...input, error: decision.error });
    if (!resetRunJournal(input)) return null;
    return journal.openRun(input).match({
      ok: (handle) => handle,
      err: (error) => {
        logJournalReset({ ...input, error });
        activeAgentRunJournal = null;
        return null;
      },
    });
  };

  const persistRunCheckpoint = async (
    run: NonNullable<SessionQueue["activeRun"]>,
    messages: readonly ModelMessage[],
    canonicalInputIds: readonly AgentInputQueueId[],
    identityProjection: StoredMessageIdentityProjectionV1,
  ): Promise<"written" | "kept-previous"> => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = run.requestDeliveryId;
    if (!journal || !requestDeliveryId || run.checkpointWriter.disabled) return "written";
    const nextCheckpointedRetainedRequestDeliveryIds = new Set(
      run.checkpointedRetainedRequestDeliveryIds,
    );
    for (const inputId of canonicalInputIds) {
      const retainedRequestDeliveryId = run.retainedRequestDeliveryByInputId.get(inputId);
      if (!retainedRequestDeliveryId) continue;
      nextCheckpointedRetainedRequestDeliveryIds.add(retainedRequestDeliveryId);
    }
    const owner = {
      requestDeliveryId,
      requestId: run.requestId,
      sessionId: run.sessionId,
    };
    const handle = run.journalHandle ?? openRunJournal(owner);
    if (!handle) return activeAgentRunJournal ? "kept-previous" : "written";
    const persisted = await persistBlobBackedAgentRunCheckpoint({
      handle,
      journal,
      messages,
      previousCheckpoint: {
        providerMessages: run.checkpointWriter.lastCommittedProviderMessages,
        storedMessages: run.checkpointWriter.lastCommittedStoredMessages,
      },
      retainedPredecessorMessages: run.checkpointWriter.retainedPredecessorStoredMessages,
      identityProjection,
      blobStore: params.blobStore,
      transcriptStore: params.transcriptStore,
      shouldAbandon: () => run.checkpointWriter.abandoned,
      ...(run.corePrimaryLineage ? { corePrimaryLineage: run.corePrimaryLineage } : {}),
      loadedCatalogIds: run.toolAuthority.snapshot(),
      ...(run.currentTurnUserId ? { currentTurnUserId: run.currentTurnUserId } : {}),
      retainedRequestDeliveries: [...run.retainedRequestDeliveries]
        .filter(([retainedRequestDeliveryId]) =>
          nextCheckpointedRetainedRequestDeliveryIds.has(retainedRequestDeliveryId),
        )
        .map(([retainedRequestDeliveryId, outcome]) => ({
          requestDeliveryId: retainedRequestDeliveryId,
          outcome,
        })),
    });
    const decision = persisted.match<
      | {
          readonly kind: "written";
          readonly handle: AgentRunJournalHandle;
          readonly messages: readonly StoredMessageV1[];
          readonly advanced: boolean;
          readonly cleanupError?: Error;
        }
      | { readonly kind: "kept-previous"; readonly error: Error }
    >({
      ok: ({ handle: nextHandle, messages: storedMessages, advanced, cleanupError }) => ({
        kind: "written",
        handle: nextHandle,
        messages: storedMessages,
        advanced,
        ...(cleanupError ? { cleanupError } : {}),
      }),
      err: (error) => ({ kind: "kept-previous", error }),
    });
    if (decision.kind === "kept-previous") {
      logger.warn(
        "agent run checkpoint kept previous",
        formatBridgeTaggedErrorForLog(decision.error, {
          requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          ...(AgentRunCheckpointPreparationFailed.is(decision.error)
            ? { stage: decision.error.stage }
            : {}),
        }),
      );
      const journalError = AgentRunCheckpointOwnershipRollbackFailed.is(decision.error)
        ? decision.error.journalError
        : decision.error;
      if (AgentRunCheckpointOwnershipRollbackFailed.is(decision.error)) {
        logger.warn(
          "agent run checkpoint blob reference cleanup deferred",
          formatBridgeTaggedErrorForLog(decision.error.cleanupError, {
            requestDeliveryId,
            requestId: run.requestId,
            sessionId: run.sessionId,
          }),
        );
      }
      if (AgentRunJournalConflict.is(journalError)) {
        run.journalHandle = openRunJournal(owner);
        run.checkpointWriter.disabled = true;
      }
      return "kept-previous";
    }
    const priorCommittedCheckpointMessages = run.checkpointWriter.lastCommittedStoredMessages;
    run.journalHandle = decision.handle;
    if (decision.advanced) {
      run.checkpointWriter.retainedPredecessorStoredMessages = priorCommittedCheckpointMessages;
    }
    run.checkpointWriter.lastCommittedProviderMessages = messages;
    run.checkpointWriter.lastCommittedStoredMessages = decision.messages;
    for (const inputId of canonicalInputIds) {
      run.retainedRequestDeliveryByInputId.delete(inputId);
    }
    run.checkpointedRetainedRequestDeliveryIds = nextCheckpointedRetainedRequestDeliveryIds;
    if (decision.cleanupError) {
      logger.warn(
        "agent run checkpoint blob reference cleanup deferred",
        formatBridgeTaggedErrorForLog(decision.cleanupError, {
          requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
        }),
      );
    }
    return "written";
  };

  const enqueueRunCheckpoint = (
    run: NonNullable<SessionQueue["activeRun"]>,
    messages: readonly ModelMessage[],
    canonicalInputIds: readonly AgentInputQueueId[],
    identityProjection: StoredMessageIdentityProjectionV1,
  ): void => {
    if (
      run.checkpointWriter.closed ||
      run.checkpointWriter.disabled ||
      !activeAgentRunJournal ||
      !run.requestDeliveryId
    ) {
      return;
    }
    const pendingInputIds = new Set(run.checkpointWriter.pending?.canonicalInputIds ?? []);
    for (const inputId of canonicalInputIds) pendingInputIds.add(inputId);
    run.checkpointWriter.pending = {
      messages,
      canonicalInputIds: pendingInputIds,
      identityProjection,
    };
    startRunCheckpointWriter(run);
  };

  function startRunCheckpointWriter(run: NonNullable<SessionQueue["activeRun"]>): void {
    if (run.checkpointWriter.operation || !run.checkpointWriter.pending) return;
    const operation = deferRunCheckpointWriter(run);
    run.checkpointWriter.operation = operation;
  }

  async function deferRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await superviseRunCheckpointWriter(run);
  }

  async function superviseRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    const completed = await Result.tryPromise({
      try: () => drainRunCheckpointWriter(run),
      catch: captureError,
    });
    const failure = completed.match({
      ok: () => null,
      err: ({ cause }) => ({ cause }),
    });
    const inFlightInputIds = run.checkpointWriter.inFlightInputIds;
    run.checkpointWriter.inFlightInputIds = null;
    run.checkpointWriter.operation = null;
    if (failure) {
      for (const inputId of inFlightInputIds ?? []) {
        run.checkpointWriter.retryInputIds.add(inputId);
      }
      if (Panic.is(failure.cause)) {
        reportFatalPanic(failure.cause);
      } else {
        const error = projectBusAgentRunnerError(
          failure.cause,
          "Agent run checkpoint background write failed",
        );
        logger.error("agent run checkpoint background write failed", {
          requestDeliveryId: run.requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          errorMessage: error.message,
        });
      }
    }
    if (run.checkpointWriter.pending) startRunCheckpointWriter(run);
  }

  async function drainRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    while (run.checkpointWriter.pending) {
      const pending = run.checkpointWriter.pending;
      run.checkpointWriter.pending = null;
      const canonicalInputIds = new Set(run.checkpointWriter.retryInputIds);
      for (const inputId of pending.canonicalInputIds) canonicalInputIds.add(inputId);
      run.checkpointWriter.inFlightInputIds = canonicalInputIds;
      const outcome = await persistRunCheckpoint(
        run,
        pending.messages,
        [...canonicalInputIds],
        pending.identityProjection,
      );
      run.checkpointWriter.inFlightInputIds = null;
      if (outcome === "kept-previous") {
        for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.add(inputId);
        continue;
      }
      for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.delete(inputId);
    }
  }

  const flushRunCheckpointWriter = async (
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> => {
    run.checkpointWriter.closed = true;
    while (run.checkpointWriter.operation) {
      await run.checkpointWriter.operation;
    }
  };

  const stopRunCheckpointWriters = async (): Promise<void> => {
    const operations = [...bySession.values()].flatMap((state) => {
      const run = state.activeRun;
      if (!run) return [];
      run.checkpointWriter.closed = true;
      run.checkpointWriter.abandoned = true;
      run.checkpointWriter.pending = null;
      return run.checkpointWriter.operation ? [run.checkpointWriter.operation] : [];
    });
    if (operations.length === 0) return;

    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const completed = await Promise.race([
      Promise.all(operations).then(() => true),
      new Promise<false>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(false), TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS);
        deadlineTimer.unref?.();
      }),
    ]).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    });
    if (completed) return;
    logger.warn("agent run checkpoint writes exceeded shutdown wait", {
      timeoutMs: TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS,
      pendingCount: operations.length,
    });
  };

  const restorePreviousRunCheckpoint = async (input: {
    readonly entry: Enqueued;
    readonly checkpoint: AgentRunCheckpointV1;
  }): Promise<AgentRunJournalHandle | null> => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = input.entry.requestDeliveryId;
    if (!journal || !requestDeliveryId || !journal.promotePreviousCheckpoint) return null;
    const owner = {
      requestDeliveryId,
      requestId: input.entry.requestId,
      sessionId: input.entry.sessionId,
    };
    const currentHandle = input.entry.journalHandle;
    if (!currentHandle) return null;
    const promoted = journal.promotePreviousCheckpoint(currentHandle, input.checkpoint);
    const decision = promoted.match<
      | {
          readonly kind: "restored";
          readonly handle: AgentRunJournalHandle;
        }
      | { readonly kind: "failed"; readonly error: Error }
    >({
      ok: (handle) => ({ kind: "restored", handle }),
      err: (error) => ({ kind: "failed", error }),
    });
    if (decision.kind === "failed") {
      logger.warn(
        "agent run previous checkpoint restore failed",
        formatBridgeTaggedErrorForLog(decision.error, owner),
      );
      return null;
    }
    const cleanupError = params.transcriptStore?.replaceAgentRunCheckpointBlobs
      ?.call(params.transcriptStore, {
        requestDeliveryId,
        messages: input.checkpoint.messages,
      })
      .match({ ok: () => undefined, err: (error) => error });
    if (cleanupError) {
      logger.warn(
        "agent run checkpoint blob reference cleanup deferred",
        formatBridgeTaggedErrorForLog(cleanupError, owner),
      );
    }
    return decision.handle;
  };

  const materializePreviousRunCheckpoint = async (input: {
    readonly entry: Enqueued;
    readonly identityProjection: StoredMessageIdentityProjectionV1;
  }): Promise<
    | {
        readonly kind: "restored";
        readonly checkpoint: AgentRunCheckpointV1;
        readonly messages: ModelMessage[];
        readonly handle: AgentRunJournalHandle;
      }
    | { readonly kind: "unavailable" }
  > => {
    const checkpoint = input.entry.previousRecoveryCheckpoint;
    if (!checkpoint) return { kind: "unavailable" };
    const materialized = await materializeStoredMessagesV1({
      messages: checkpoint.messages,
      blobStore: params.blobStore,
      identityProjection: input.identityProjection,
    });
    const decision = materialized.match<
      | { readonly kind: "messages"; readonly messages: ModelMessage[] }
      | { readonly kind: "unavailable"; readonly error: Error }
    >({
      ok: (messages) => ({ kind: "messages", messages }),
      err: (error) => ({ kind: "unavailable", error }),
    });
    if (decision.kind === "unavailable") {
      logger.warn(
        "agent run previous checkpoint blob unavailable",
        formatBridgeTaggedErrorForLog(decision.error, {
          requestDeliveryId: input.entry.requestDeliveryId,
          requestId: input.entry.requestId,
          sessionId: input.entry.sessionId,
        }),
      );
      return { kind: "unavailable" };
    }
    const handle = await restorePreviousRunCheckpoint({
      entry: input.entry,
      checkpoint,
    });
    return handle
      ? { kind: "restored", checkpoint, messages: decision.messages, handle }
      : { kind: "unavailable" };
  };

  const installPreviousRunCheckpoint = (input: {
    readonly entry: Enqueued;
    readonly recovery: NonNullable<Enqueued["recovery"]>;
    readonly checkpoint: AgentRunCheckpointV1;
    readonly messages: ModelMessage[];
    readonly handle: AgentRunJournalHandle;
  }): void => {
    logger.warn("agent run checkpoint restore used previous checkpoint", {
      requestDeliveryId: input.entry.requestDeliveryId,
      requestId: input.entry.requestId,
      sessionId: input.entry.sessionId,
    });
    input.recovery.checkpointMessages = input.messages;
    input.entry.storedRecoveryCheckpoint = [...input.checkpoint.messages];
    input.entry.retainedRequestDeliveries = input.checkpoint.retainedRequestDeliveries;
    input.entry.journalHandle = input.handle;
    input.entry.corePrimaryLineage =
      input.checkpoint.corePrimaryLineage ?? input.entry.acceptedCorePrimaryLineage;
    if (input.checkpoint.loadedCatalogIds) {
      input.entry.loadedCatalogIds = [...input.checkpoint.loadedCatalogIds];
    } else {
      delete input.entry.loadedCatalogIds;
    }
    input.entry.currentTurnUserId =
      input.checkpoint.currentTurnUserId ?? input.entry.acceptedCurrentTurnUserId;
    input.entry.currentTurnMessageRef = input.checkpoint.currentTurnUserId
      ? undefined
      : input.entry.authenticatedOrigin?.messageRef;
    delete input.entry.previousRecoveryCheckpoint;
  };

  const fallBackRunCheckpointToAcceptedWork = (input: {
    readonly entry: Enqueued;
    readonly error: Error;
  }): void => {
    logger.warn(
      "agent run checkpoint restore fell back to accepted work",
      formatBridgeTaggedErrorForLog(input.error, {
        requestDeliveryId: input.entry.requestDeliveryId,
        requestId: input.entry.requestId,
        sessionId: input.entry.sessionId,
      }),
    );
    if (input.entry.requestDeliveryId) {
      resetRunJournal({
        requestDeliveryId: input.entry.requestDeliveryId,
        requestId: input.entry.requestId,
        sessionId: input.entry.sessionId,
      });
    }
    delete input.entry.recovery;
    delete input.entry.storedRecoveryCheckpoint;
    delete input.entry.previousRecoveryCheckpoint;
    delete input.entry.retainedRequestDeliveries;
    delete input.entry.journalHandle;
    delete input.entry.loadedCatalogIds;
    input.entry.corePrimaryLineage = input.entry.acceptedCorePrimaryLineage;
    input.entry.currentTurnUserId = input.entry.acceptedCurrentTurnUserId;
    input.entry.currentTurnMessageRef = input.entry.authenticatedOrigin?.messageRef;
  };

  const markRunTerminal = (
    run: NonNullable<SessionQueue["activeRun"]>,
    outcome: RequestDeliveryTerminalOutcome,
    finalReplayDeadline: number | undefined,
  ): void => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = run.requestDeliveryId;
    if (!journal || !requestDeliveryId) return;
    const owner = {
      requestDeliveryId,
      requestId: run.requestId,
      sessionId: run.sessionId,
    };
    const handle = run.journalHandle ?? openRunJournal(owner);
    if (!handle) return;
    const terminal = journal.markTerminal(handle, {
      outcome,
      ...(finalReplayDeadline === undefined ? {} : { finalReplayDeadline }),
    });
    terminal.match({
      ok: (nextHandle) => {
        run.journalHandle = nextHandle;
      },
      err: (error) => {
        logJournalReset({ ...owner, error });
        resetRunJournal(owner);
        run.journalHandle = null;
      },
    });
  };

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
    const operation = superviseDrain();
    activeDrainOperation = operation;
    void ignoreDetachedFailure(operation);

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
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
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
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
      return reconcileAcceptedProjectionFailure(projectionFailure);
    }
    if (!requestProjection) {
      if (!pendingAttempt) abandonQueueLifecycleAttempt(msg.id);
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
            };

            const requestControl = parseRequestControlFromRaw(entry.raw);

            const state =
              bySession.get(sessionId) ??
              ({
                running: false,
                agent: null,
                queue: [] as Enqueued[],
                activeRequestId: null,
                activeRun: null,
                compactedToolCallIds: new Set<string>(),
              } satisfies SessionQueue);
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
            ): void => {
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
              logger.debug(
                "dropping request message while draining",
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
              await terminalizeProjectedDelivery("abandoned", "runner-draining-drop");
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
                          ),
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
                  attempt.controlApplied = true;
                  await resumeQueueLifecycleAttempt(attempt, state);
                } else {
                  await applyToRunningAgent(
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
                  );
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
            case lilacEventTypes.CmdRequestMessage:
              return await handleCmdRequestMessage(msg);
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

  let subscriptionStopped = false;
  const stopSubscription = async () => {
    if (subscriptionStopped) return;
    subscriptionStopped = true;
    await stopStartedSubscription?.();
  };

  async function beginDrain(opts?: { deadlineMs?: number }) {
    draining = true;
    await stopSubscription();

    const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
    const startedAt = Date.now();
    const hasRunning = () => [...bySession.values()].some((state) => state.running);

    while (hasRunning() && Date.now() - startedAt < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!hasRunning()) return;

    for (const state of bySession.values()) {
      if (!state.running || !state.activeRun) continue;
      shutdownAbortRequestIds.add(state.activeRun.requestId);
      state.agent?.abort();
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    rethrowBusAgentRunnerPanic(terminalPanic);
    if (state.running) return;

    const queueDepthBefore = state.queue.length;
    const next = state.queue[0];
    if (!next) return;
    if (reservedQueueEntries.has(next)) return;
    state.queue.shift();
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
        state.queue.unshift(next);
        return signalBusAgentRunnerHostFailure(materializationError);
      }
      next.messages = materialized.match({
        ok: (value) => value,
        err: () => [],
      });
    }
    if (next.recovery && next.storedRecoveryCheckpoint) {
      const materialized = await materializeStoredMessagesV1({
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

    state.running = true;
    state.activeRequestId = next.requestId;

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
    let claudeCodeRun: MaterializedClaudeCodeRun | null = null;
    let coreNamedClaudeRuntime: CoreNamedClaudeRuntime | null = null;
    let corePrimaryClaudeRuntime: CorePrimaryClaudeRuntime | null = null;
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
    const outputPublisher = createAgentOutputPublisher({
      bus,
      headers,
      onError: reportOutputPublisherError,
      reportFatalPanic,
    });
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

      await coreNamedClaudeRuntime?.retireForRetry();
      await corePrimaryClaudeRuntime?.retireForRetry();
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
    let continuationSignalVersion = 0;
    const continuationWaiters = new Set<() => void>();
    const notifyContinuationWaiters = () => {
      continuationSignalVersion += 1;
      const current = [...continuationWaiters];
      continuationWaiters.clear();
      for (const waiter of current) waiter();
    };
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
      if (!liveParentSession) return;
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
      modelOverride: next.modelOverride,
      currentTurnUserId: next.currentTurnUserId,
      currentTurnMessageRef: next.currentTurnMessageRef,
      raw: next.raw,
      resolvedModelSpec: null,
      resolvedReasoning: undefined,
      resolvedProviderFamily: null,
      partialText: next.recovery?.partialText ?? "",
      liveParent: liveParentSession,
      claudeCodeControl: null,
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
      journalHandle: null,
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
    let customCommandMessages: ModelMessage[] = [];
    let initialMessagesEndWithInjectedTool = false;
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
    const markActiveRunTerminal = (): void => {
      if (terminalMarkerAttempted || terminalPanic || !shouldTerminalizeRequest) return;
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
            publishToolStatus: async (update) => {
              await outputPublisher.publishToolCall(update);
            },
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

            await outputPublisher.publishToolCall({
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
              await outputPublisher.publishToolCall({
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

            customCommandMessages = buildCustomCommandMessages({
              toolCallId,
              name: parsedCustomCommand.name,
              args: parsedCustomCommand.args,
              prompt: parsedCustomCommand.prompt,
              text: parsedCustomCommand.text,
              source: parsedCustomCommand.source,
              output,
            });

            await outputPublisher.publishToolCall({
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
                  ...customCommandMessages,
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
                    messages,
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
            resolvedModelRequest: workflowPolicy?.resolvedModelRequest,
          });
          const modelPlan = resolvedModelPlan.match({
            ok: (value) => () => value,
            err: (error) => () => signalBusAgentRunnerHostFailure(error),
          })();
          const initialResolvedModel = modelPlan.head;
          resolvedModelLabel = initialResolvedModel.modelId;
          resolvedProviderFamily = classifyHistoryProviderFamily({
            type: initialResolvedModel.provider,
          });
          if (state.activeRun) {
            state.activeRun.resolvedModelSpec = initialResolvedModel.spec;
            state.activeRun.resolvedReasoning = initialResolvedModel.reasoning;
            state.activeRun.resolvedProviderFamily = resolvedProviderFamily;
          }

          const skillsSection =
            runProfile === "explore"
              ? null
              : await waitForPreAgent(maybeBuildSkillsSectionForPrimary());

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
          if (runProfile === "primary" && !workflowPolicy && isHeartbeatSessionId(next.sessionId)) {
            controlCapability =
              (await params.issueHeartbeatCapability?.({
                requestId: next.requestId,
                sessionId: next.sessionId,
                requestClient: next.requestClient,
                canonicalCwd: cwd,
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
            const anthropicModel = isAnthropicModelSpec(resolved.spec);
            const anthropicPromptCachingEnabled = shouldEnableAnthropicPromptCache({
              spec: resolved.spec,
              anthropicPromptCache: resolved.anthropicPromptCache,
            });
            const reasoningDisplay =
              resolved.reasoningDisplay ??
              workflowPolicy?.resolvedModelRequest.reasoningDisplay ??
              cfg.agent.reasoningDisplay;
            const providerOptionsWithOpenAIReasoningSummary =
              withReasoningSummaryDefaultForOpenAIModels({
                reasoningDisplay,
                provider: resolved.provider,
                modelId: resolved.modelId,
                providerOptions: resolved.providerOptions,
              });
            const providerOptionsWithReasoningDisplay =
              withReasoningDisplayDefaultForAnthropicModels({
                reasoningDisplay,
                provider: resolved.provider,
                modelId: resolved.modelId,
                providerOptions: providerOptionsWithOpenAIReasoningSummary,
              });
            const providerOptionsWithPromptCacheKey =
              resolved.provider === "openai" || resolved.provider === "codex"
                ? withOpenAIPromptCacheKey(
                    providerOptionsWithReasoningDisplay,
                    toOpenAIPromptCacheKey(sessionId),
                  )
                : providerOptionsWithReasoningDisplay;
            const providerOptionsWithServerCompaction = resolved.openaiServerCompaction
              ? withOpenAIServerCompaction(providerOptionsWithPromptCacheKey)
              : providerOptionsWithPromptCacheKey;
            const providerOptionsForAgent = anthropicModel
              ? withStableAnthropicUpstreamOrder(
                  resolved.provider,
                  providerOptionsWithServerCompaction,
                )
              : providerOptionsWithServerCompaction;
            const systemPrompt = buildSystemPrompt(resolved, editingToolMode);
            const agentSystem = anthropicPromptCachingEnabled
              ? {
                  role: "system" as const,
                  content: systemPrompt,
                  providerOptions: ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
                }
              : systemPrompt;
            const experimentalDownload = buildExperimentalDownloadForAnthropicFallback({
              blobStore: params.blobStore,
              spec: resolved.spec,
              provider: resolved.provider,
              providerOptions: providerOptionsForAgent,
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
              currentTurnUserId,
              currentTurnMessageRef,
              metadata: {
                controlCapability: controlCapability ?? undefined,
                readFileDirectImageSupported: resourceProviderTarget.supportsImage,
                readFileDirectPdfSupported: resourceProviderTarget.supportsPdf,
                onActivity: (source: "tool" | "subagent") => markRunActivity(source),
                onSubagentDelegate:
                  workflowSubagentDispatcher && liveParentSession && fallbackSurfaceForDelegation
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
                  editingToolMode: runProfile === "explore" ? "none" : editingToolMode,
                  subagentDepth: subagentMeta.depth,
                  subagentConfig: {
                    enabled: subagents.enabled,
                    idleTimeoutMs: deriveSubagentIdleTimeoutMs(cfg.agent.idleTimeoutMs),
                    maxDepth: subagents.maxDepth,
                  },
                  requestContext: level1RequestContext,
                  onSelectCatalogIds: (catalogIds) => toolAuthority.select(catalogIds),
                  reportToolStatus: (update) => {
                    void publishAuxiliaryOutput("failed to publish batch tool status", () =>
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
                agentSystem,
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
          ): Promise<ModelMessage[]> =>
            await materializeStoredMessagesV1({
              messages: storedMessages,
              blobStore: params.blobStore,
              identityProjection: storedMessageIdentity,
              resourceAccess: params.resourceAccess,
              resourceTarget: resolveStoredResourceProviderTarget({
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
            nextBinding.toolset.updateActiveBatchTools(nextBinding.activeToolNames);
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

            activeBinding = nextBinding;
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
          const hasNativeModelFallback =
            activeBinding.resolved.provider !== "claude-code" && modelPlan.fallbacks.length > 0;
          const transientRetryController = createTransientModelRetryController({
            retry: cfg.agent.retry,
            logger,
            requestId: headers.request_id,
            sessionId: headers.session_id,
            modelSpec: activeBinding.resolved.spec,
            ...(hasNativeModelFallback ? { advanceModel } : {}),
          });
          const disabledServerCompactionReplayKeys = new Set<string>();
          let activeNativeServerCompactionReplayKey: string | null = null;
          const turnErrorHandler = async <ErrorCause>(
            error: ErrorCause,
            errorContext: Parameters<
              NonNullable<Parameters<typeof attachAutoCompaction>[1]["baseTurnErrorHandler"]>
            >[1],
          ) => {
            const projectedError = projectBusAgentRunnerError(error, "Model turn failed");
            const transientDecision = await transientRetryController.handler(error, errorContext);
            if (transientDecision === "retry") {
              await coreNamedClaudeRuntime?.retireForRetry();
              await corePrimaryClaudeRuntime?.retireForRetry();
              return "retry" as const;
            }
            if (
              activeNativeServerCompactionReplayKey &&
              errorContext.phase === "model-call" &&
              errorContext.retrySafety.canRetry &&
              errorContext.abortSignal?.aborted !== true
            ) {
              disabledServerCompactionReplayKeys.add(activeNativeServerCompactionReplayKey);
              logger.warn(
                "OpenAI server compaction replay failed; retrying portable summary",
                formatBridgeLogContext({
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  modelSpec: activeBinding.resolved.spec,
                  ...projectedError.details,
                  error: projectedError.message,
                }),
              );
              activeNativeServerCompactionReplayKey = null;
              return "retry" as const;
            }
            return "fail" as const;
          };
          if (activeBinding.resolved.provider === "claude-code") {
            const claudeCodeToolMapping = completeLevel1ToolMapping(activeBinding.toolset);
            const continuationStore = params.transcriptStore;
            const materializeClaude = async (
              nativeSession?: Parameters<typeof materializeClaudeCodeRunResult>[0]["nativeSession"],
            ) => {
              const options = {
                modelId: activeBinding.resolved.modelId,
                cwd: executionCwd,
                tools: claudeCodeToolMapping.tools,
                catalogMetadata: claudeCodeToolMapping.catalogMetadata,
                // Core admits no Claude built-ins; Lilac remains the only tool source.
                builtInTools: [],
                reasoning: activeBinding.resolved.reasoning,
                ...(nativeSession ? { nativeSession } : {}),
                execute: async (request) => {
                  if (!activeAgent) {
                    return signalBusAgentRunnerHostFailure(
                      new Error("Claude Code tool execution started before the agent was ready"),
                    );
                  }
                  return await activeAgent.executeExternalToolCall(request);
                },
              } satisfies Parameters<typeof materializeClaudeCodeRunResult>[0];
              let run;
              if (params.materializeClaudeCodeRun) {
                run = await params.materializeClaudeCodeRun(options);
              } else {
                const materializedResult = await materializeClaudeCodeRunResult(options);
                const materialized = materializedResult.match<
                  | {
                      readonly kind: "success";
                      readonly value: import("better-result").InferOk<typeof materializedResult>;
                    }
                  | {
                      readonly kind: "failure";
                      readonly error: import("better-result").InferErr<typeof materializedResult>;
                    }
                >({
                  ok: (value) => ({ kind: "success" as const, value }),
                  err: (error) => ({ kind: "failure" as const, error }),
                });
                run =
                  materialized.kind === "success"
                    ? materialized.value
                    : signalBusAgentRunnerHostFailure(materialized.error);
              }
              if (state.activeRun) state.activeRun.claudeCodeControl = run.control;
              return run;
            };
            const shouldPersistClaude = shouldUsePersistentCoreClaudeRuntime({
              runProfile,
              requestClient: next.requestClient,
              stableNamedContinuation,
              corePrimaryLineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
            });
            if (shouldPersistClaude && continuationStore !== undefined) {
              const canonicalCwdResult = await captureBusAgentRunnerOperation(
                "Claude execution cwd canonicalization",
                () => fs.realpath(executionCwd),
              );
              const selectCanonicalExecutionCwd = canonicalCwdResult.match<() => string>({
                ok: (canonicalExecutionCwd) => () => canonicalExecutionCwd,
                err: () => () => path.resolve(executionCwd),
              });
              const canonicalExecutionCwd = selectCanonicalExecutionCwd();
              const nativeStorageNamespace = path.resolve(
                process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homedir(), ".claude"),
              );
              const profileConfig =
                runProfile === "primary" ? null : resolveNativeSubagentProfile(cfg, runProfile);
              const executionScope = hashCoreNamedExecutionScope({
                canonicalCwd: canonicalExecutionCwd,
                providerIdentity: "core:claude-code",
                nativeStorageNamespaceIdentity: nativeStorageNamespace,
                nativeExecutableConfig: claudeCodeExecutableSettings(),
                profile: runProfile,
                safetyMode,
                profileAuthority: {
                  level1: profileConfig?.level1 ?? null,
                  level2: profileConfig?.level2 ?? null,
                  network: profileConfig?.network ?? null,
                  workspaceWrites: profileConfig?.workspaceWrites ?? null,
                  execution:
                    profileConfig === null
                      ? null
                      : coreProfileExecutionScopeAuthority(profileConfig.execution),
                  delegation: profileConfig?.delegation ?? null,
                },
                pluginAuthority: cfg.plugins ?? null,
                workflowAuthority: workflowPolicy
                  ? {
                      profile: workflowPolicy.profile,
                      cwd: workflowPolicy.cwd,
                      originClient: workflowPolicy.originSession.client,
                    }
                  : null,
                systemPolicy: {
                  base: applyBasePromptForProvider({
                    systemPrompt: workspaceSystemPrompt,
                    basePrompt: cfg.basePrompt,
                    provider: activeBinding.resolved.provider,
                  }),
                  profileOverlay: profileConfig?.promptOverlay ?? null,
                  additionalSessionPrompts,
                  skillsSection,
                },
                directToolNames: [...activeBinding.toolset.directToolNames],
                externalToolAuthority: activeBinding.toolset.catalog
                  .map((entry) => ({
                    source: entry.source,
                    sourceId: entry.sourceId,
                    stableId: entry.stableId,
                    modelName: entry.modelName,
                  }))
                  .sort((left, right) => left.stableId.localeCompare(right.stableId)),
                subagentAuthority: {
                  enabled: subagents.enabled,
                  maxDepth: subagents.maxDepth,
                  currentDepth: subagentMeta.depth,
                },
              });
              if (
                runProfile === "primary" &&
                next.requestClient === "discord" &&
                supportsCorePrimaryContinuationStore(continuationStore)
              ) {
                const createdPrimaryRuntime = createCorePrimaryClaudeRuntimeResult({
                  store: continuationStore,
                  sessionId: next.sessionId,
                  requestId: next.requestId,
                  providerId: activeBinding.resolved.provider,
                  modelSpecifier: activeBinding.resolved.spec,
                  reasoning: activeBinding.resolved.reasoning ?? "provider-default",
                  executionScopeHash: executionScope.hash,
                  executionCwd,
                  getLineage: () => state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                  projectCanonicalStoredMessages: (messages) =>
                    storedMessageIdentity.project(messages),
                  materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
                  onDiagnostic: (event, detail, error) => {
                    const fields = formatClaudeLifecycleLogFields(event, detail, error);
                    if (
                      event === "native-source-invalid" ||
                      event === "candidate-observability-lost" ||
                      event === "candidate-unpromotable" ||
                      event === "candidate-finalization-failed" ||
                      event === "canonical-publication-failed" ||
                      event === "promotion-failed" ||
                      event === "promotion-rejected"
                    ) {
                      logger.warn("core_primary_claude.lifecycle", fields);
                    } else if (event === "canonical-published" || event === "promotion") {
                      logger.info("core_primary_claude.lifecycle", fields);
                    } else {
                      logger.debug("core_primary_claude.lifecycle", fields);
                    }
                  },
                });
                corePrimaryClaudeRuntime = createdPrimaryRuntime.match({
                  ok: (value) => () => value,
                  err: (error) => () => signalBusAgentRunnerHostFailure(error),
                })();
              } else if (
                stableNamedContinuation !== null &&
                supportsCoreNamedContinuationStore(continuationStore)
              ) {
                const createdNamedRuntime = createCoreNamedClaudeRuntimeResult({
                  store: continuationStore,
                  requestClient: stableNamedContinuation.requestClient,
                  sessionId: next.sessionId,
                  requestId: next.requestId,
                  providerId: activeBinding.resolved.provider,
                  modelSpecifier: activeBinding.resolved.spec,
                  reasoning: activeBinding.resolved.reasoning ?? "provider-default",
                  executionScopeHash: executionScope.hash,
                  executionCwd,
                  sourceTranscript: seededSessionTranscript,
                  sourceMessages: seededSessionMessages,
                  getCurrentTurnMessages: () => initialMessages,
                  materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
                  onDiagnostic: (event, detail, error) => {
                    const fields = formatClaudeLifecycleLogFields(event, detail, error);
                    if (
                      event === "native-source-invalid" ||
                      event === "candidate-observability-lost" ||
                      event === "candidate-unpromotable" ||
                      event === "candidate-finalization-failed" ||
                      event === "canonical-publication-failed" ||
                      event === "promotion-failed" ||
                      event === "promotion-rejected"
                    ) {
                      logger.warn("core_named_claude.lifecycle", fields);
                    } else if (event === "canonical-published" || event === "promotion") {
                      logger.info("core_named_claude.lifecycle", fields);
                    } else {
                      logger.debug("core_named_claude.lifecycle", fields);
                    }
                  },
                });
                coreNamedClaudeRuntime = createdNamedRuntime.match({
                  ok: (value) => () => value,
                  err: (error) => () => signalBusAgentRunnerHostFailure(error),
                })();
              } else {
                claudeCodeRun = await waitForPreAgent(materializeClaude());
              }
            } else {
              claudeCodeRun = await waitForPreAgent(materializeClaude());
            }
          }

          const agentOptions: AiSdkPiAgentOptions<ToolSet> = {
            system: activeBinding.agentSystem,
            model: claudeCodeRun?.agentModel ?? activeBinding.resolved.model,
            modelSpecifier: activeBinding.resolved.spec,
            messages: next.recovery?.checkpointMessages ?? seededSessionMessages,
            tools: activeBinding.toolset.tools,
            providerOptions: activeBinding.providerOptionsForAgent,
            reasoning: activeBinding.resolved.reasoning,
            ...(hasNativeModelFallback ||
            coreNamedClaudeRuntime !== null ||
            corePrimaryClaudeRuntime !== null
              ? { streamTextMaxRetries: 0 }
              : {}),
            turnErrorHandler,
            recoveryCheckpointHandler: (messages, canonicalInputIds) => {
              const activeRun = state.activeRun;
              if (!activeRun || activeRun.requestId !== next.requestId) return;
              enqueueRunCheckpoint(activeRun, messages, canonicalInputIds, storedMessageIdentity);
            },
            beforeStep:
              activeBinding.resolved.provider !== "claude-code"
                ? async () => {
                    if (!agent) {
                      return signalBusAgentRunnerHostFailure(
                        new Error("Tool refresh started before the agent was ready"),
                      );
                    }
                    await refreshSelectedLevel1Tools({
                      target: agent,
                      toolset: activeBinding.toolset,
                      listSelectedCatalogIds,
                    });
                  }
                : undefined,
            normalizeToolResultOutput,
            normalizeSettledToolResultOutputs: normalizeToolResultOutput.normalizeSettled,
            genericOutputNormalizerBypassTools:
              activeBinding.toolset.genericOutputNormalizerBypassTools,
            aggregateOutputBudgetExemptTools:
              activeBinding.toolset.aggregateOutputBudgetExemptTools,
            experimentalDownload: activeBinding.experimentalDownload,
            sendToolsToModel: activeBinding.resolved.provider !== "claude-code",
            debug: {
              captureModelViewMessages: env.debug.contextDump.enabled,
            },
          };
          agent = params.createAgent
            ? params.createAgent(agentOptions)
            : new AiSdkPiAgent<ToolSet>(agentOptions);
          if (activeBinding.resolved.provider === "claude-code") {
            applyCompleteLevel1Tools(agent, activeBinding.toolset);
          }
          agent.setPrepareModelCall(
            coreNamedClaudeRuntime?.prepareModelCall ?? corePrimaryClaudeRuntime?.prepareModelCall,
          );
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
            const configuredServerCompactionReplayKey = activeBinding.resolved
              .openaiServerCompaction
              ? `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`
              : undefined;
            const serverCompactionReplayKey =
              configuredServerCompactionReplayKey &&
              !disabledServerCompactionReplayKeys.has(configuredServerCompactionReplayKey)
                ? configuredServerCompactionReplayKey
                : undefined;
            activeNativeServerCompactionReplayKey = null;
            if (
              configuredServerCompactionReplayKey &&
              hasMatchingOpenAIServerCompaction(messages, serverCompactionReplayKey)
            ) {
              activeNativeServerCompactionReplayKey = serverCompactionReplayKey ?? null;
            }
            const materialized =
              configuredServerCompactionReplayKey || hasOpenAIServerCompaction(messages)
                ? materializeOpenAIServerCompaction(messages, serverCompactionReplayKey)
                : messages;
            const targetFamily = classifyHistoryProviderFamily({
              type: activeBinding.resolved.provider,
            });
            let historyPrepared: readonly ModelMessage[];
            if (coreNamedClaudeRuntime) {
              historyPrepared = coreNamedClaudeRuntime.prepareHistoryView(materialized);
            } else if (corePrimaryClaudeRuntime) {
              historyPrepared = fullBudget
                ? corePrimaryClaudeRuntime.prepareFullBudgetView(
                    materialized,
                    transformContext.canonicalStartIndex,
                  )
                : corePrimaryClaudeRuntime.prepareHistoryView(materialized);
            } else {
              switch (runProfile) {
                case "primary": {
                  const lineage = state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage;
                  const historicalEnd = lineage?.currentCanonicalStart ?? 0;
                  historyPrepared = prepareCorePrimaryHistoryView({
                    canonicalMessages: materialized,
                    lineage,
                    replayHistoricalPrefix: shouldReplayCorePrimaryHistory({
                      lineage,
                      historicalEnd,
                      store: params.transcriptStore ?? {},
                      targetFamily,
                    }),
                    targetFamily,
                    modelSpecifier: activeBinding.resolved.spec,
                    canonicalStartIndex: transformContext.canonicalStartIndex,
                  });
                  break;
                }
                case "explore":
                case "general":
                case "self":
                  historyPrepared = stableNamedContinuation
                    ? prepareCoreNamedHistoryView({
                        canonicalMessages: materialized,
                        sourceMessages: seededSessionMessages,
                        currentTurnMessages: initialMessages,
                        replayHistoricalPrefix: shouldReplayCoreNamedHistory({
                          sourceTranscript: seededSessionTranscript,
                          targetFamily,
                        }),
                        targetFamily,
                        modelSpecifier: activeBinding.resolved.spec,
                      })
                    : materialized;
                  break;
                default: {
                  const _exhaustive: never = runProfile;
                  historyPrepared = _exhaustive;
                  break;
                }
              }
            }
            if (
              configuredServerCompactionReplayKey &&
              disabledServerCompactionReplayKeys.has(configuredServerCompactionReplayKey) &&
              hasMatchingOpenAIServerCompaction(messages, configuredServerCompactionReplayKey)
            ) {
              agent.replaceMessages(materializeOpenAIServerCompaction(messages, undefined), {
                reason: "compaction",
                preserveRecoveryCheckpoint: true,
              });
              disabledServerCompactionReplayKeys.delete(configuredServerCompactionReplayKey);
            }
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

            return compacted;
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
          const resolveClaudeCompactionSummaryModel = (): LanguageModel =>
            resolveCoreClaudeCompactionSummaryModel({
              run:
                claudeCodeRun ??
                coreNamedClaudeRuntime?.currentRun() ??
                corePrimaryClaudeRuntime?.currentRun() ??
                null,
              fallback: () => activeBinding.resolved.model,
              onFailure: (error) => {
                logger.warn(
                  "Claude utility model construction failed; using model fallback",
                  formatBridgeTaggedErrorForLog(error, {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    modelSpec: activeBinding.resolved.spec,
                    operation: error.operation,
                  }),
                );
              },
            });

          unsubscribeCompaction = await waitForPreAgent(
            attachAutoCompaction(agent, {
              model: activeBinding.resolved.spec,
              summaryModel:
                activeBinding.resolved.provider === "claude-code"
                  ? resolveClaudeCompactionSummaryModel
                  : "current",
              modelCapability,
              thresholdInputSource:
                activeBinding.resolved.provider === "claude-code" ? "transcript-estimate" : "usage",
              resolveCurrentModelSpecifier: () =>
                agent.state.modelSpecifier ?? activeBinding.resolved.spec,
              prepareFullModelView: toolPruneTransform,
              prepareFullBudgetView: fullBudgetTransform,
              inputEstimateFloor:
                coreNamedClaudeRuntime === null && corePrimaryClaudeRuntime === null
                  ? undefined
                  : ({ canonicalMessages, overlay, estimateMessagesTokens }) =>
                      (coreNamedClaudeRuntime ?? corePrimaryClaudeRuntime)?.inputEstimateFloor({
                        canonicalMessages,
                        overlay,
                        estimateMessagesTokens,
                      }) ?? null,
              resolveCurrentInputCanonicalStart: () =>
                (state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage)
                  ?.currentCanonicalStart ?? null,
              decorateRequestPayload: (payload) => {
                const requestPayload =
                  payload.length === 0 && (coreNamedClaudeRuntime || corePrimaryClaudeRuntime)
                    ? ([
                        {
                          role: "user",
                          content: "Continue after the completed tool call.",
                        },
                      ] satisfies ModelMessage[])
                    : [...payload];
                return activeBinding.anthropicPromptCachingEnabled
                  ? withProviderOptionsOnLastUserMessage(
                      requestPayload,
                      ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
                    )
                  : requestPayload;
              },
              baseTurnErrorHandler: turnErrorHandler,
              serverCompaction: async ({
                messages: prefix,
                portableSummary,
                context: modelContext,
                abortSignal,
              }) => {
                if (!activeBinding.resolved.openaiServerCompaction) {
                  return signalBusAgentRunnerHostFailure(
                    new Error("OpenAI server compaction is disabled for the active model"),
                  );
                }
                const compacted = await compactWithOpenAIResponsesResult({
                  model: agent.state.model,
                  replayKey: `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`,
                  portableSummary,
                  messages: prefix,
                  system: modelContext?.system ?? agent.state.system,
                  tools: modelContext?.tools,
                  providerOptions: agent.state.providerOptions,
                  reasoning: agent.state.reasoning,
                  abortSignal,
                });
                const outcome = compacted.match<
                  | {
                      readonly kind: "success";
                      readonly value: import("better-result").InferOk<typeof compacted>;
                    }
                  | {
                      readonly kind: "failure";
                      readonly error: import("better-result").InferErr<typeof compacted>;
                    }
                >({
                  ok: (value) => ({ kind: "success" as const, value }),
                  err: (error) => ({ kind: "failure" as const, error }),
                });
                return outcome.kind === "success"
                  ? outcome.value
                  : signalBusAgentRunnerHostFailure(outcome.error);
              },
              serverCompactionEnabled: () => {
                if (!activeBinding.resolved.openaiServerCompaction) return false;
                const replayKey = `${activeBinding.resolved.provider}:${activeBinding.resolved.spec}`;
                return !disabledServerCompactionReplayKeys.has(replayKey);
              },
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
            await coreNamedClaudeRuntime?.recordSuccessfulModelCall(agent.state.messages);
            await corePrimaryClaudeRuntime?.recordSuccessfulModelCall(agent.state.messages);
            removePendingSilentTurn();

            lastBoundaryModelInputMessages = context.modelInputMessages;
            const drained = await drainDeferredCompletions({
              modelInputMessages: context.modelInputMessages,
              abortSignal: context.abortSignal,
            });
            return adaptDeferredDrainToHost(drained);
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
            delta: string,
            phase: ReturnType<typeof openAIMessagePhase>,
            phaseBoundaryPrefixChars: number,
          ): void => {
            const previous = pendingNoReplyTurnOutputs.at(-1);
            if (
              previous !== undefined &&
              previous.phase === phase &&
              phaseBoundaryPrefixChars === 0
            ) {
              previous.delta += delta;
              return;
            }
            pendingNoReplyTurnOutputs.push({
              delta,
              phase,
              phaseBoundaryPrefixChars,
            });
          };
          const publishPendingNoReplyOutputs = (): void => {
            for (const output of pendingNoReplyTurnOutputs) {
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
                appendPendingNoReplyOutput(delta, phase, phaseBoundaryPrefixChars);
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
                outputPublisher.publishText(delta, phase, phaseBoundaryPrefixChars);
              }
            }

            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_end"
            ) {
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
              consumeReasoningChunkEvent(reasoningChunkState, {
                type: "end",
                chunkId,
              });
              outputPublisher.flush();
            }

            if (event.type === "tool_execution_start") {
              const startedAt = Date.now();
              toolStartMs.set(event.toolCallId, startedAt);
              currentTurnToolCallIds.add(event.toolCallId);
              state.activeRun?.activeTools.set(event.toolCallId, {
                toolName: event.toolName,
                startedAt,
              });

              if (event.toolName !== "batch") {
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
                case "batch":
                  ok = getBatchOkFromResult(event) ?? toolFailure.ok;
                  break;
                case "subagent_delegate":
                  ok = getSubagentOkFromResult(event) ?? toolFailure.ok;
                  break;
                default:
                  ok = toolFailure.ok;
                  break;
              }
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

              if (event.toolName === "batch" || deferredAccepted) {
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
            agent.appendMessages(customCommandMessages);
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
                      cfg,
                      conversationThreads: params.conversationThreads,
                      requestId: headers.request_id,
                      raw: next.raw,
                      previousMessages: agent.state.messages,
                      userMessages: mergedInitial,
                      publishToolStatus: async (update) => {
                        await outputPublisher.publishToolCall(update);
                      },
                      onError: reportAutoInjectedThreadSearchError,
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
            initialMessagesEndWithInjectedTool = autoInjectedThreadSearchMessages.length > 0;
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

          if (state.activeRun) state.activeRun.started = true;
          runIdleWatchdog?.start();

          if (parsedCustomCommand) {
            await waitForRunAtHost(agent.continue());
          } else if (initialMessagesEndWithInjectedTool) {
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

            if (!deferredWaitState?.hasOutstandingRuns) {
              break;
            }
            if (!liveParentSession) break;

            await waitForRunAtHost(
              waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
            );
            if (agent.state.isStreaming) {
              continue;
            }
          }
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

          // Keep skip-reply behavior for primary runs.
          // For subagent runs we still persist to support explicit session continuation.
          const transcriptStore = params.transcriptStore;
          if (transcriptStore && (!shouldSkipSurfaceReply || runProfile !== "primary")) {
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
                    isPrimary: runProfile === "primary",
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
                switch (runProfile) {
                  case "primary":
                    providerState = resolveCorePrimaryTranscriptProviderState({
                      targetFamily: targetProviderFamily,
                      lineage: state.activeRun?.corePrimaryLineage ?? next.corePrimaryLineage,
                      transcriptStore,
                    });
                    break;
                  case "explore":
                  case "general":
                  case "self":
                    providerState = undefined;
                    if (stableNamedContinuation && !isCancelled) {
                      const sourceProviderState =
                        seededSessionTranscript === null
                          ? "empty-history"
                          : (seededSessionTranscript.providerState ?? "unknown-populated-history");
                      providerState = advanceHistoryProviderState(
                        sourceProviderState,
                        targetProviderFamily,
                      );
                    }
                    break;
                  default: {
                    const _exhaustive: never = runProfile;
                    providerState = _exhaustive;
                    break;
                  }
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
                  // Primary runs can reconstruct context from the surface thread.
                  // Subagent runs need full per-session transcript for explicit continuation.
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
                  return;
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
            outputPublisher.publishToolCall({
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
        await Promise.all([...level1ToolsetReleases].map(releaseLevel1Toolset));
      }
      const finalReplayDeadline = outputPublisher.getFinalReplayDeadline();
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
        const removed = activeAgentRunJournal?.removeReconciled(next.requestDeliveryId);
        const removeError = removed?.match({ ok: () => null, err: (error) => error });
        if (removed && !removeError) {
          releaseRunCheckpointBlobs({
            requestDeliveryId: next.requestDeliveryId,
            requestId: next.requestId,
            sessionId: next.sessionId,
          });
        }
      }
      state.agent = null;
      state.activeRequestId = null;
      state.activeRun = null;
      state.running = false;
      cancelledByRequestId.delete(headers.request_id);
      shutdownAbortRequestIds.delete(headers.request_id);
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
            recovery: { checkpointMessages: [], partialText: "" },
            storedRecoveryCheckpoint: [...recoveryHead.checkpoint.messages],
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
    const state =
      bySession.get(work.sessionId) ??
      ({
        running: false,
        agent: null,
        queue: [] as Enqueued[],
        activeRequestId: null,
        activeRun: null,
        compactedToolCallIds: new Set<string>(),
      } satisfies SessionQueue);
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
    getActiveDrainOperation: () => activeDrainOperation,
    getTerminalCleanupOperations: () => terminalCleanupOperations,
    stop: async () => {
      stopRunnerAdmission();
      await stopSubscription();
      await stopRunCheckpointWriters();
      if (terminalCleanupCompletion) {
        let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
        const completed = await Promise.race([
          terminalCleanupCompletion.then(() => true),
          new Promise<false>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(false), TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS);
            deadlineTimer.unref?.();
          }),
        ]).finally(() => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        });
        if (!completed) {
          logger.warn("terminal agent-runner cleanup exceeded shutdown wait", {
            timeoutMs: TERMINAL_CLEANUP_SHUTDOWN_WAIT_MS,
            pendingLabels: terminalCleanupOperations.map(({ label }) => label),
          });
        }
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

function mergeQueuedControlsForRecovery(
  first: Enqueued,
  queue: Enqueued[],
  reservedQueueEntries: ReadonlySet<Enqueued>,
): {
  readonly storedMessages: readonly StoredMessageV1[];
  readonly reapplied: readonly Enqueued[];
  readonly discarded: readonly Enqueued[];
} {
  const retainedRequestDeliveryIds = new Set(
    first.retainedRequestDeliveries?.map(({ requestDeliveryId }) => requestDeliveryId),
  );
  const storedMessages: StoredMessageV1[] = [];
  const reapplied: Enqueued[] = [];
  const discarded: Enqueued[] = [];

  for (let index = 0; index < queue.length; ) {
    const entry = queue[index]!;
    const control = parseRequestControlFromRaw(entry.raw);
    const targetsRecoveredRun = entry.requestId === first.requestId || control.requiresActive;
    const isActiveControl = entry.queue !== "prompt" && !control.cancel && targetsRecoveredRun;
    if (!isActiveControl || reservedQueueEntries.has(entry)) {
      index += 1;
      continue;
    }

    const alreadyRetained =
      entry.requestDeliveryId !== undefined &&
      retainedRequestDeliveryIds.has(entry.requestDeliveryId);
    if (!alreadyRetained) {
      storedMessages.push(...entry.storedMessages);
      reapplied.push(entry);
      first.currentTurnUserId = entry.currentTurnUserId;
      first.currentTurnMessageRef = entry.currentTurnMessageRef;
    }
    discarded.push(entry);
    queue.splice(index, 1);
  }

  if (reapplied.length > 0) {
    first.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      "queued-request-coalesced",
      first.corePrimaryLineage?.currentCanonicalStart,
    );
  }

  return { storedMessages, reapplied, discarded };
}

function mergeQueuedForSameRequest(
  first: Enqueued,
  queue: Enqueued[],
  reservedQueueEntries: ReadonlySet<Enqueued>,
): {
  readonly messages: ModelMessage[];
  readonly storedMessages: StoredMessageV1[];
  readonly discarded: readonly Enqueued[];
} {
  const merged: ModelMessage[] = [...first.messages];
  const storedMessages: StoredMessageV1[] = [...first.storedMessages];
  const discarded: Enqueued[] = [];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId || reservedQueueEntries.has(next)) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    storedMessages.push(...next.storedMessages);
    first.currentTurnUserId = next.currentTurnUserId;
    first.currentTurnMessageRef = next.currentTurnMessageRef;
    discarded.push(next);
    queue.splice(i, 1);
  }

  if (discarded.length > 0) {
    first.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      "queued-request-coalesced",
      first.corePrimaryLineage?.currentCanonicalStart,
    );
  }

  return { messages: merged, storedMessages, discarded };
}

async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
  cancelledByRequestId: Set<string>,
  activeRun: SessionQueue["activeRun"],
  retainAppliedControl: (
    checkpoint:
      | { readonly kind: "canonical" }
      | { readonly kind: "queued"; readonly inputId: AgentInputQueueId }
      | { readonly kind: "pending" },
  ) => void,
) {
  activeRun?.flushOutput();
  const liveParent = activeRun?.liveParent;
  const claudeCodeControl = activeRun?.claudeCodeControl;
  const notifyWaiters = activeRun?.notifyWaiters;
  const cancel = parseRequestControlFromRaw(entry.raw).cancel;
  const providerMessages =
    !cancel && activeRun?.materializeStoredMessages
      ? await activeRun.materializeStoredMessages(entry.storedMessages)
      : entry.messages;
  const merged = mergeToSingleUserMessage(providerMessages);
  if (!cancel) {
    activeRun?.rememberStoredMessages(
      [merged],
      [mergeToSingleStoredUserMessage(entry.storedMessages)],
    );
  }
  const queueWhileIdle = (mode: "followUp" | "steer") => {
    const inputId = mode === "steer" ? agent.steer(merged) : agent.followUp(merged);
    retainAppliedControl({ kind: "queued", inputId });
    notifyWaiters?.();
  };

  const promptWhileIdle = () => {
    retainAppliedControl({ kind: "canonical" });
    void observePrompt();
    notifyWaiters?.();

    async function observePrompt(): Promise<void> {
      const prompted = await Result.tryPromise({
        try: () => agent.prompt(merged),
        catch: () => undefined,
      });
      if (prompted.match({ ok: () => false, err: () => true })) notifyWaiters?.();
    }
  };

  if (!cancel) {
    activeRun?.setCurrentTurnContext(entry.currentTurnUserId, entry.currentTurnMessageRef);
  }
  if (!cancel && activeRun?.runProfile === "primary" && activeRun.requestClient === "discord") {
    activeRun.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      entry.queue === "steer" || entry.queue === "interrupt"
        ? "steering-transform"
        : "follow-up-transform",
      agent.state.messages.length,
    );
  }

  const hasBufferedCompletions = liveParent?.snapshot().hasPendingCompletions ?? false;

  if (!agent.state.isStreaming) {
    switch (entry.queue) {
      case "steer": {
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return;
        }
        promptWhileIdle();
        return;
      }
      case "followUp":
      case "prompt": {
        if (hasBufferedCompletions) {
          queueWhileIdle("followUp");
          return;
        }
        promptWhileIdle();
        return;
      }
      case "interrupt": {
        if (cancel) {
          retainAppliedControl({ kind: "pending" });
          cancelledByRequestId.add(entry.requestId);
          await liveParent?.cancelAll("parent request aborted");
          agent.cancel();
          notifyWaiters?.();
          return;
        }
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return;
        }
        retainAppliedControl({ kind: "canonical" });
        await agent.interrupt(merged);
        notifyWaiters?.();
        return;
      }
      default: {
        const _exhaustive: never = entry.queue;
        return _exhaustive;
      }
    }
  }

  switch (entry.queue) {
    case "steer": {
      const steeringId = agent.steer(merged);
      retainAppliedControl({ kind: "queued", inputId: steeringId });
      if (merged.role === "user" && typeof merged.content === "string") {
        claudeCodeControl?.inject(merged.content, (delivered) => {
          if (delivered) agent.acknowledgeSteeringDelivery(steeringId);
        });
      }
      notifyWaiters?.();
      return;
    }
    case "followUp": {
      const followUpId = agent.followUp(merged);
      retainAppliedControl({ kind: "queued", inputId: followUpId });
      notifyWaiters?.();
      return;
    }
    case "interrupt": {
      if (cancel) {
        retainAppliedControl({ kind: "pending" });
        cancelledByRequestId.add(entry.requestId);
        await liveParent?.cancelAll("parent request aborted");
        await claudeCodeControl?.interrupt();
        agent.cancel();
        notifyWaiters?.();
        return;
      }
      const steeringId = agent.steer(merged);
      retainAppliedControl({ kind: "queued", inputId: steeringId });
      const interruptedNatively = (await claudeCodeControl?.interrupt()) ?? false;
      if (!interruptedNatively) agent.interruptQueuedSteering();
      notifyWaiters?.();
      return;
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      const followUpId = agent.followUp(merged);
      retainAppliedControl({ kind: "queued", inputId: followUpId });
      notifyWaiters?.();
      return;
    }
    default: {
      const _exhaustive: never = entry.queue;
      return _exhaustive;
    }
  }
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

export function mergeToSingleUserMessage(messages: ModelMessage[]): ModelMessage {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return { role: "user", content: "" };
  }

  const hasMultipart = userMessages.some((m) => typeof m.content !== "string");

  if (hasMultipart) {
    const parts: UserContent = [];
    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i]!;
      if (i > 0) {
        parts.push({ type: "text", text: "\n\n" });
      }

      if (typeof msg.content === "string") {
        if (msg.content.length > 0) {
          parts.push({ type: "text", text: msg.content });
        }
      } else {
        parts.push(...msg.content);
      }
    }

    return {
      role: "user",
      content: parts,
    };
  }

  // Preserve existing behavior: merge batches into one user message separated by blank lines.
  const parts: string[] = [];
  for (const m of userMessages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  return {
    role: "user",
    content: parts.join("\n\n").trim(),
  };
}

function mergeToSingleStoredUserMessage(messages: readonly StoredMessageV1[]): StoredMessageV1 {
  const userMessages = messages.filter(
    (message): message is Extract<StoredMessageV1, { readonly role: "user" }> =>
      message.role === "user",
  );
  if (userMessages.length === 0) return { role: "user", content: "" };
  const hasMultipart = userMessages.some((message) => typeof message.content !== "string");
  if (!hasMultipart) {
    return {
      role: "user",
      content: userMessages
        .flatMap((message) => (typeof message.content === "string" ? [message.content] : []))
        .join("\n\n")
        .trim(),
    };
  }

  const content: Exclude<Extract<StoredMessageV1, { readonly role: "user" }>["content"], string> =
    [];
  for (let index = 0; index < userMessages.length; index += 1) {
    const message = userMessages[index];
    if (!message) continue;
    if (index > 0) content.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") {
      if (message.content.length > 0) content.push({ type: "text", text: message.content });
      continue;
    }
    content.push(...message.content);
  }
  return { role: "user", content };
}
