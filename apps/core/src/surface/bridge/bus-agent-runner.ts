/* oxlint-disable eslint/no-control-regex */

import {
  type CallWarning,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolContent,
  type ToolSet,
  type UserContent,
} from "ai";
import type {
  CoreConfig,
  CustomCommandResult,
  ModelCapabilityInfo,
  ModelReasoningEffort,
} from "@stanley2058/lilac-utils";
import {
  CUSTOM_COMMAND_TOOL_NAME,
  discoverSkills,
  env,
  extractAiErrorLogDetails,
  findWorkspaceRoot,
  formatAvailableSkillsSection,
  getCoreConfig,
  isRecord,
  ModelCapability,
  resolveCoreConfigPath,
  createLogger,
  resolveEditingToolMode,
  fromDurableResolvedModelRequest,
  resolveModelRef,
  resolveModelSlot,
  resolveNativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
  type RequestLifecycleState,
  type RequestOrigin,
  type RequestQueueMode,
  type RequestRunPolicy,
} from "@stanley2058/lilac-event-bus";
import {
  AiSdkPiAgent,
  attachAutoCompaction,
  buildSyntheticToolCallId,
  type AiSdkPiAgentEvent,
  type NormalizeToolResultOutputFn,
  type TransformMessagesFn,
} from "@stanley2058/lilac-agent";

import fs from "node:fs/promises";
import path from "node:path";

import type { CoreToolPluginManager } from "../../plugins";
import type { ToolResultArtifactStore } from "../../artifacts/tool-result-artifact-store";
import { createAgentOutputActivityPublisher } from "../../shared/agent-output-activity";
import { createIdleTimer } from "../../shared/idle-timer";
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
import { formatToolArgsForDisplayWithSpecs } from "../../tools/tool-args-display";
import { isHeartbeatAckText, isHeartbeatSessionId } from "../../heartbeat/common";

import {
  buildHeartbeatHandoffTranscript,
  extractHeartbeatSurfaceSendHandoffs,
  HEARTBEAT_HANDOFF_SESSION_ID,
} from "../../transcript/heartbeat-handoff";
import {
  COMPACTION_CHECKPOINT_FORMAT_VERSION,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import type {
  ConversationThreadSearchResult,
  ConversationThreadToolService,
} from "../../conversation/thread-service";
import { buildSafeRecoveryCheckpoint } from "./recovery-checkpoint";
import { resolveReplyDeliveryFromFinalText } from "./reply-directive";
import { buildSystemPromptForProfile } from "./bus-agent-runner/subagent-prompt";
import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "./bus-agent-runner/tool-failure-logging";
import {
  buildExperimentalDownloadForAnthropicFallback,
  isAnthropicModelSpec,
  withStableAnthropicUpstreamOrder,
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
  parseRouterSessionModeFromRaw,
  parseSessionConfigIdFromRaw,
  parseSubagentMetaFromRaw,
  parseWorkflowRequestHintFromRaw,
  requestRawReferencesMessage,
  type AgentRunProfile,
  type ParsedSubagentMeta,
} from "./bus-agent-runner/raw";
import { latestUserText, shouldRunAutoInjectedThreadSearch } from "./bus-agent-runner/text-units";
import {
  computeTransientRetryDelayMs,
  createTransientModelRetryController,
  isRetryableTransientModelError,
} from "./bus-agent-runner/transient-retry";
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
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildHeartbeatOverlayForRequest,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
} from "./bus-agent-runner/prompt-overlays";
import { resolveSessionSafetyMode, type SessionSafetyMode } from "./bus-request-router/common";
import type { CustomCommandManager } from "../../custom-commands/manager";

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
  computeTransientRetryDelayMs,
  createTransientModelRetryController,
  isRetryableTransientModelError,
} from "./bus-agent-runner/transient-retry";
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

function supportsReadFileDirectAttachments(info: ModelCapabilityInfo | null): boolean {
  if (info?.attachment !== true) return false;
  const inputModalities = info?.modalities?.input;
  if (!inputModalities) return false;
  return inputModalities.includes("image") && inputModalities.includes("pdf");
}

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
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
  let totalBytes = 0;

  const estimateBase64Bytes = (b64: string): number => {
    // Approximate decoded bytes; good enough for bounding.
    const len = b64.length;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((len * 3) / 4) - padding;
    return Math.max(0, bytes);
  };

  const out = [...messages];

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const msg = messages[messageIndex]!;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      continue;
    }

    let nextContent: ToolContent | null = null;

    for (let i = msg.content.length - 1; i >= 0; i -= 1) {
      const part = msg.content[i];
      if (part?.type !== "tool-result") continue;

      const output = part.output;
      const outputType = output.type;
      if (outputType !== "content") continue;

      const rawValue = output["value"];
      if (!Array.isArray(rawValue)) continue;

      const value = rawValue;
      let nextValue: typeof rawValue | null = null;

      for (let j = value.length - 1; j >= 0; j -= 1) {
        const item = value[j];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;

        if (item.type !== "file") continue;

        const fileData = item.data;
        if (!fileData || typeof fileData !== "object" || Array.isArray(fileData)) continue;
        if (fileData.type !== "data" || typeof fileData.data !== "string") continue;

        const data = fileData.data;

        const bytes = estimateBase64Bytes(data);
        const tooBig = bytes > limits.maxBytesPerPart;
        const tooMuch = totalBytes + bytes > limits.maxBytesTotal;
        if (!tooBig && !tooMuch) {
          totalBytes += bytes;
          continue;
        }

        nextValue ??= value.map((v) => ({ ...v }));

        const mediaType =
          "mediaType" in item && typeof item.mediaType === "string" ? item.mediaType : "";
        const filename =
          "filename" in item && typeof item.filename === "string" ? item.filename : "";
        const detail =
          filename || mediaType ? ` (${[filename, mediaType].filter(Boolean).join(", ")})` : "";

        const instruction = mediaType.startsWith("image/")
          ? "Image exceeds the inline limit. Resize the image before reading it again."
          : "File exceeds the inline limit and must be reduced before reading it again.";
        nextValue[j] = {
          type: "text",
          text: `${instruction}${detail}`,
        };
      }

      if (!nextValue) continue;

      nextContent ??= msg.content.map((p) => ({ ...p }));
      const nextPart = nextContent[i];
      if (nextPart?.type !== "tool-result") continue;

      const nextOutput = {
        ...output,
        value: nextValue,
      };
      nextPart["output"] = nextOutput;
    }

    if (!nextContent) continue;

    out[messageIndex] = { ...msg, content: nextContent };
  }

  return out;
}

function getBatchOkFromResult(result: unknown): boolean | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
}

function getSubagentOkFromResult(result: unknown): boolean | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const v = (result as Record<string, unknown>)["ok"];
  return typeof v === "boolean" ? v : null;
}

function isDeferredSubagentAcceptedResult(result: unknown): result is {
  ok: true;
  mode: "deferred";
  status: "accepted";
  sessionName: string;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return (
    (result as Record<string, unknown>)["ok"] === true &&
    (result as Record<string, unknown>)["mode"] === "deferred" &&
    (result as Record<string, unknown>)["status"] === "accepted" &&
    typeof (result as Record<string, unknown>)["sessionName"] === "string"
  );
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

type AutoInjectedThreadSearchCandidate = AutoInjectedThreadSearchEntry & {
  score: number;
  searchIndex: number;
  rank: number;
};

type AutoInjectedThreadSearchAppendedEvent = {
  toolCallId: string;
  mode: "hybrid" | "semantic" | "lexical";
  limit: number;
  searches: readonly (readonly string[])[];
  participantFilterUserCount: number;
  entries: readonly AutoInjectedThreadSearchEntry[];
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

function compareAutoInjectedThreadSearchCandidates(
  left: AutoInjectedThreadSearchCandidate,
  right: AutoInjectedThreadSearchCandidate,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.searchIndex !== right.searchIndex) return left.searchIndex - right.searchIndex;
  return left.rank - right.rank;
}

function stripAutoInjectedThreadSearchCandidate(
  candidate: AutoInjectedThreadSearchCandidate,
): AutoInjectedThreadSearchEntry {
  return {
    threadId: candidate.threadId,
    title: candidate.title,
    ...(candidate.brief ? { brief: candidate.brief } : {}),
    ...(candidate.timeRange ? { timeRange: candidate.timeRange } : {}),
  };
}

function selectAutoInjectedThreadSearchEntries(
  groups: readonly (readonly AutoInjectedThreadSearchCandidate[])[],
  limit: number,
): AutoInjectedThreadSearchEntry[] {
  const selected: AutoInjectedThreadSearchCandidate[] = [];
  const selectedThreadIds = new Set<string>();
  const earlierGroupThreadIds = new Set<string>();

  for (const group of groups) {
    if (selected.length >= limit) break;
    const candidate = group.find(
      (item) => !selectedThreadIds.has(item.threadId) && !earlierGroupThreadIds.has(item.threadId),
    );
    for (const item of group) {
      earlierGroupThreadIds.add(item.threadId);
    }
    if (!candidate) continue;
    selected.push(candidate);
    selectedThreadIds.add(candidate.threadId);
  }

  if (selected.length < limit) {
    const remainingByThreadId = new Map<string, AutoInjectedThreadSearchCandidate>();
    for (const group of groups) {
      for (const candidate of group) {
        if (selectedThreadIds.has(candidate.threadId)) continue;
        const existing = remainingByThreadId.get(candidate.threadId);
        if (!existing || compareAutoInjectedThreadSearchCandidates(candidate, existing) < 0) {
          remainingByThreadId.set(candidate.threadId, candidate);
        }
      }
    }

    const remaining = [...remainingByThreadId.values()].sort(
      compareAutoInjectedThreadSearchCandidates,
    );
    for (const candidate of remaining) {
      if (selected.length >= limit) break;
      selected.push(candidate);
      selectedThreadIds.add(candidate.threadId);
    }
  }

  return selected.map(stripAutoInjectedThreadSearchCandidate);
}

function buildAutoInjectedThreadSearchCandidates(input: {
  search: ConversationThreadSearchResult;
  searchIndex: number;
  previouslyInjectedThreadIds: ReadonlySet<string>;
}): AutoInjectedThreadSearchCandidate[] {
  return input.search.results
    .filter((result) => !input.previouslyInjectedThreadIds.has(result.threadId))
    .map((result, index) => {
      const timeRange = result.timeRange
        ? formatInjectedThreadTimeRange(result.timeRange)
        : undefined;
      const brief = formatAutoInjectedThreadBrief(result.brief);
      return {
        threadId: result.threadId,
        title: result.title,
        ...(brief ? { brief } : {}),
        ...(timeRange ? { timeRange } : {}),
        score: result.score ?? 0,
        searchIndex: input.searchIndex,
        rank: index + 1,
      };
    });
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
  raw?: unknown;
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
  onError: (message: string, error: unknown) => void;
}): Promise<ModelMessage[]> {
  const autoInject = params.cfg.conversation.thread.autoInject;
  if (!autoInject.enabled) return [];
  if (!params.conversationThreads) return [];
  const conversationThreads = params.conversationThreads;

  const text = latestUserText(params.userMessages);
  const previouslyInjectedThreadIds = collectAutoInjectedThreadIds(params.previousMessages ?? []);
  const minTextUnits =
    previouslyInjectedThreadIds.size > 0
      ? autoInject.followUpMinTextUnits
      : autoInject.minTextUnits;
  if (!shouldRunAutoInjectedThreadSearch({ text, minTextUnits })) {
    return [];
  }

  const participantIds = autoInject.filterCurrentParticipants
    ? getParticipantUserIdsFromRaw(params.raw)
    : [];
  if (autoInject.filterCurrentParticipants && participantIds.length === 0) return [];

  const toolCallId = buildAutoInjectedThreadSearchToolCallId(params.requestId);
  const display = `${AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME} auto-injected metadata`;
  const publishToolStatusBestEffort = async (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => {
    try {
      await params.publishToolStatus(update);
    } catch (error) {
      params.onError("auto-injected thread search status publish failed; continuing", error);
    }
  };

  await publishToolStatusBestEffort({ toolCallId, status: "start", display });

  try {
    const plan = await conversationThreads.planAutoInjectSearch({ text });
    const searchRecallLimit = Math.min(50, autoInject.limit * plan.searches.length);
    const settledSearches = await Promise.allSettled(
      plan.searches.map((searchPlan) =>
        conversationThreads.search({
          query: searchPlan.queries,
          queryAboutness: searchPlan.aboutness,
          limit: searchRecallLimit,
          minScore: autoInject.minScore,
          mode: autoInject.mode,
          verbose: true,
          ...(participantIds.length > 0 ? { participantIdsAny: participantIds } : {}),
        }),
      ),
    );
    let fulfilledSearches = 0;
    const candidateGroups = settledSearches.map((result, searchIndex) => {
      if (result.status === "fulfilled") {
        fulfilledSearches += 1;
        return buildAutoInjectedThreadSearchCandidates({
          search: result.value,
          searchIndex,
          previouslyInjectedThreadIds,
        });
      }

      params.onError("auto-injected thread search failed; continuing with partial metadata", {
        searchIndex,
        error: result.reason,
      });
      return [];
    });
    if (fulfilledSearches === 0) throw new Error("all auto-injected thread searches failed");
    const entries = selectAutoInjectedThreadSearchEntries(candidateGroups, autoInject.limit);

    await publishToolStatusBestEffort({
      toolCallId,
      status: "end",
      display,
      ok: true,
    });

    if (entries.length === 0) return [];
    try {
      params.onInjected?.({
        toolCallId,
        mode: autoInject.mode,
        limit: autoInject.limit,
        searches: plan.searches.map((searchPlan) => searchPlan.queries),
        participantFilterUserCount: participantIds.length,
        entries,
      });
    } catch (error) {
      params.onError("auto-injected thread search append log failed; continuing", error);
    }
    return buildAutoInjectedThreadSearchMessages({ toolCallId, entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishToolStatusBestEffort({
      toolCallId,
      status: "end",
      display,
      ok: false,
      error: message,
    });
    params.onError("auto-injected thread search failed; continuing without metadata", error);
    return [];
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

function hasDeferredSubagentWorkflowRunId(
  messages: readonly ModelMessage[],
  workflowRunId: string,
): boolean {
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
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
    hasDeferredSubagentWorkflowRunId(messages, completion.runId) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.runId)) ||
    hasToolResult(messages, buildSubagentResultToolCallId(completion.childRequestId))
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
  const unseen = unconsumed.filter(
    (completion) => !hasDeferredSubagentWorkflowRunId(input.canonicalMessages, completion.runId),
  );

  return {
    append: unseen.flatMap(buildDeferredSubagentResultMessages),
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

    params.transcriptStore.saveRequestTranscript({
      requestId: handoffRequestId,
      sessionId: HEARTBEAT_HANDOFF_SESSION_ID,
      requestClient: params.requestClient,
      messages: handoff.messages,
      finalText: handoff.finalText,
      modelLabel: params.modelLabel,
    });
    params.transcriptStore.linkSurfaceMessagesToRequest({
      requestId: handoffRequestId,
      created: [ref],
      last: ref,
    });
  }
}

type Enqueued = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  modelOverride?: string;
  raw?: unknown;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
};

export type AgentRunnerRecoveryEntry = {
  kind: "active" | "queued";
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy?: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  modelOverride?: string;
  raw?: unknown;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
};

class RestartDrainingAbort extends Error {
  constructor() {
    super("server restarting");
    this.name = "RestartDrainingAbort";
  }
}

export class AgentIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(
      `agent idle timed out after ${idleTimeoutMs}ms without model, tool, or subagent activity`,
    );
    this.name = "AgentIdleTimeoutError";
  }
}

class PreAgentRunCancelledError extends Error {
  constructor() {
    super("cancelled before agent start");
    this.name = "PreAgentRunCancelledError";
  }
}

const AGENT_TIMEOUT_ABORT_GRACE_MS = 5_000;
const LIVE_PARENT_RECONCILE_MS = 1_000;
const SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS = 3;

export function createAgentRunIdleWatchdog(params: {
  idleTimeoutMs: number;
  onTimeout: (error: AgentIdleTimeoutError) => void;
}) {
  let timedOut = false;
  let monitoring = false;
  let rejectTimeout: ((error: AgentIdleTimeoutError) => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  void timeoutPromise.catch(() => undefined);

  const timer = createIdleTimer(params.idleTimeoutMs, () => {
    if (timedOut) return;
    timedOut = true;
    const error = new AgentIdleTimeoutError(params.idleTimeoutMs);
    params.onTimeout(error);
    rejectTimeout?.(error);
    rejectTimeout = null;
  });

  return {
    start() {
      if (timedOut) return;
      monitoring = true;
      timer.reset();
    },
    reset() {
      if (!timedOut && monitoring) timer.reset();
    },
    waitFor<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, timeoutPromise]);
    },
    pause() {
      monitoring = false;
      timer.stop();
    },
    stop() {
      monitoring = false;
      timer.stop();
      rejectTimeout = null;
    },
  };
}

function isCancelControlEntry(entry: Enqueued): boolean {
  const raw = entry.raw;
  if (!raw || typeof raw !== "object") return false;
  const v = (raw as Record<string, unknown>)["cancel"];
  return v === true;
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

async function publishAbsorbedQueuedPromptCancelled(input: {
  bus: LilacBus;
  sessionId: string;
  entries: readonly Enqueued[];
  mode: "steer" | "interrupt";
}) {
  if (input.entries.length === 0) return;

  const dedup = new Map<string, AdapterPlatform>();
  for (const entry of input.entries) {
    dedup.set(entry.requestId, entry.requestClient);
  }

  const detail =
    input.mode === "interrupt"
      ? "cancelled: absorbed into active interrupt"
      : "cancelled: absorbed into active steer";

  for (const [requestId, requestClient] of dedup) {
    await publishLifecycle({
      bus: input.bus,
      headers: {
        request_id: requestId,
        session_id: input.sessionId,
        request_client: requestClient,
      },
      state: "cancelled",
      detail,
    });
  }
}

async function maybeBuildSkillsSectionForPrimary(): Promise<string | null> {
  try {
    const workspaceRoot = findWorkspaceRoot();
    const { skills } = await discoverSkills({
      workspaceRoot,
      dataDir: env.dataDir,
    });
    return formatAvailableSkillsSection(skills);
  } catch {
    // Best-effort: never fail a run due to skill discovery.
    return null;
  }
}

export function buildPersistedHeartbeatMessages(finalText: string): ModelMessage[] {
  return [{ role: "assistant", content: finalText } satisfies ModelMessage];
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

export function resolveAgentRunModel(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestModelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  resolvedModelRequest?: WorkflowRequestPolicy["resolvedModelRequest"];
}) {
  const subagentProfileConfig =
    params.runProfile === "primary"
      ? null
      : resolveNativeSubagentProfile(params.cfg, params.runProfile);

  if (params.resolvedModelRequest) {
    return fromDurableResolvedModelRequest(params.resolvedModelRequest);
  }

  if (params.runProfile !== "primary" && params.requestModelOverride) {
    const selectedPreset = params.cfg.models.def[params.requestModelOverride];
    if (!selectedPreset || params.requestModelOverride.includes("/")) {
      throw new Error(
        `Subagent model override must be a models.def alias (got '${params.requestModelOverride}')`,
      );
    }
    if (selectedPreset.agentCanSelect !== true) {
      throw new Error(
        `Subagent model alias '${params.requestModelOverride}' is not available for agent selection`,
      );
    }
  }

  if (params.requestModelOverride) {
    return resolveModelRef(
      params.cfg,
      {
        model: params.requestModelOverride,
        reasoning: params.runProfile === "primary" ? undefined : params.reasoningOverride,
      },
      "cmd.request.message.modelOverride",
    );
  }

  if (subagentProfileConfig?.model) {
    return resolveModelRef(
      params.cfg,
      {
        model: subagentProfileConfig.model,
        reasoning: params.reasoningOverride ?? subagentProfileConfig.reasoning,
        options: subagentProfileConfig.options,
      },
      `agent.subagents.profiles.${params.runProfile}.model`,
    );
  }

  const slotResolved = resolveModelSlot(params.cfg, subagentProfileConfig?.modelSlot ?? "main");
  const reasoning = params.reasoningOverride ?? subagentProfileConfig?.reasoning;
  return reasoning ? { ...slotResolved, reasoning } : slotResolved;
}

export function assertWorkflowDispatchPolicy(
  workflowPolicy: WorkflowRequestPolicy,
  subagentMeta: ParsedSubagentMeta,
): void {
  if (workflowPolicy.profile !== subagentMeta.profile) {
    throw new Error("Workflow request profile envelope does not match the runner profile");
  }
  if ((workflowPolicy.reasoning ?? null) !== (subagentMeta.reasoning ?? null)) {
    throw new Error("Workflow request reasoning does not match the approved operation policy");
  }
}

type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
  activeRun: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    runProfile: AgentRunProfile;
    queue: RequestQueueMode;
    runPolicy: RequestRunPolicy;
    origin?: RequestOrigin;
    messages: ModelMessage[];
    modelOverride?: string;
    raw?: unknown;
    partialText: string;
    liveParent: ReturnType<WorkflowLiveParentBridge["registerParent"]> | undefined;
    notifyWaiters: () => void;
    cancel: () => void;
    started: boolean;
    startedAt: number;
    activeTools: Map<string, { toolName: string; startedAt: number }>;
  } | null;
  /** Track toolCallIds whose outputs are compacted in the model-facing view. */
  compactedToolCallIds: Set<string>;
};

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

export async function startBusAgentRunner(params: {
  bus: LilacBus;
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
  resolveParentChannelId?: (sessionId: string) => string | null | undefined;
  issueControlCapability?: (input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    profile: AgentRunProfile;
    canonicalCwd: string;
    safetyMode: SessionSafetyMode;
    expiresAt: number;
    principal?: { platform: "discord" | "github"; userId: string };
  }) =>
    | {
        capability: string;
        principal: { platform: "discord" | "github"; userId: string } | null;
      }
    | Promise<{
        capability: string;
        principal: { platform: "discord" | "github"; userId: string } | null;
      }>;
  issueHeartbeatCapability?: (input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    canonicalCwd: string;
    expiresAt: number;
  }) => string | Promise<string>;
  expireControlCapability?: (requestId: string) => void;
}) {
  const { bus, subscriptionId } = params;

  const logger = createLogger({
    module: "bus-agent-runner",
  });

  let cfg = params.config ?? (await getCoreConfig());
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    try {
      cfg = await getCoreConfig();

      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", {
          path: "core-config.yaml",
        });
      }

      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== msg) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: msg,
        });
      }

      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = msg;
    }
  }
  const cwd = params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();
  const workflowRunnerOwnerId = `agent-runner:${process.pid}:${crypto.randomUUID()}`;

  const bySession = new Map<string, SessionQueue>();
  const cancelledByRequestId = new Set<string>();
  const restartAbortRequestIds = new Set<string>();
  const forcedRecoveryByRequestId = new Map<string, AgentRunnerRecoveryEntry>();
  let draining = false;

  const sub = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "work",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "begin" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) {
        await ctx.commit();
        return;
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client ?? "unknown";
      if (!requestId || !sessionId) {
        throw new Error("cmd.request.message missing required headers.request_id/session_id");
      }

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          if (shouldWarn) {
            logger.warn("perf.bus_lag", {
              stage: "cmd.request->agent_runner",
              lagMs,
              requestId,
              sessionId,
              requestClient,
              queue: msg.data.queue,
            });
          } else {
            logger.info("perf.bus_lag", {
              stage: "cmd.request->agent_runner",
              lagMs,
              requestId,
              sessionId,
              requestClient,
              queue: msg.data.queue,
            });
          }
        }
      }

      logger.debug("cmd.request.message received", {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        runPolicy: msg.data.runPolicy ?? "normal",
        originKind: msg.data.origin?.kind,
        modelOverride: msg.data.modelOverride,
        messageCount: msg.data.messages.length,
      });

      // reload config opportunistically (mtime cached in getCoreConfig).
      // If reload fails, keep using the last known good config.
      await reloadCoreConfigIfNeeded();

      const entry: Enqueued = {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        runPolicy: msg.data.runPolicy ?? "normal",
        origin: msg.data.origin,
        messages: msg.data.messages,
        modelOverride: msg.data.modelOverride,
        raw: msg.data.raw,
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
        logger.info("agent.queue.transition", {
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
        });
      };

      if (
        !requestControl.cancel &&
        shouldCancelRunPolicyRequest({ runPolicy: entry.runPolicy, sessionId, states: bySession })
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
        await ctx.commit();
        return;
      }

      if (draining) {
        logger.info("dropping request message while draining", {
          requestId,
          sessionId,
          queue: msg.data.queue,
        });
        logQueueTransition({
          action: "drop",
          queueDepthBefore: state.queue.length,
          queueDepthAfter: state.queue.length,
          reason: "draining",
        });
        await ctx.commit();
        return;
      }

      const dropCancelNoTarget = async (reason: string) => {
        logger.info("dropping cancel request with no target", {
          requestId,
          sessionId,
          queue: entry.queue,
          activeRequestId: state.activeRequestId,
          reason,
        });
        logQueueTransition({
          action: "drop",
          queueDepthBefore: state.queue.length,
          queueDepthAfter: state.queue.length,
          reason,
        });
        await ctx.commit();
      };

      if (requestControl.cancel && requestControl.cancelQueued) {
        const removed = new Map<string, AdapterPlatform>();

        const removedByRequestId = removeQueuedEntries(
          state.queue,
          (queued) => queued.requestId === requestId,
        );
        for (const queued of removedByRequestId) {
          removed.set(queued.requestId, queued.requestClient);
        }

        const targetMessageId = requestControl.targetMessageId;
        if (targetMessageId) {
          const removedByMessage = removeQueuedEntries(state.queue, (queued) =>
            requestRawReferencesMessage(queued.raw, targetMessageId),
          );
          for (const queued of removedByMessage) {
            removed.set(queued.requestId, queued.requestClient);
          }
        }

        if (removed.size > 0) {
          for (const [cancelledRequestId, cancelledRequestClient] of removed) {
            await publishLifecycle({
              bus,
              headers: {
                request_id: cancelledRequestId,
                session_id: sessionId,
                request_client: cancelledRequestClient,
              },
              state: "cancelled",
              detail: "cancelled while queued",
            });
          }

          logger.info("queued request cancelled", {
            requestId,
            sessionId,
            cancelledRequestIds: [...removed.keys()],
            queueDepth: state.queue.length,
          });
          logQueueTransition({
            action: "cancel_queued",
            queueDepthBefore: state.queue.length + removed.size,
            queueDepthAfter: state.queue.length,
            reason: "cancel_queued",
          });

          if (!state.running) {
            drainSessionQueue(sessionId, state).catch((e: unknown) => {
              logger.error("drainSessionQueue failed", { sessionId, requestId }, e);
            });
          }

          await ctx.commit();
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
          await ctx.commit();
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
          logger.info("dropping request message (requires active run)", {
            requestId,
            sessionId,
            queue: entry.queue,
          });
          logQueueTransition({
            action: "drop",
            queueDepthBefore: state.queue.length,
            queueDepthAfter: state.queue.length,
            reason: "requires_active_without_run",
          });
          await ctx.commit();
          return;
        }

        const queueDepthBefore = state.queue.length;
        state.queue.push(entry);
        logQueueTransition({
          action: "enqueue",
          queueDepthBefore,
          queueDepthAfter: state.queue.length,
          reason: "start_when_idle",
        });
        drainSessionQueue(sessionId, state).catch((e: unknown) => {
          logger.error("drainSessionQueue failed", { sessionId, requestId }, e);
        });
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
          await ctx.commit();
          return;
        }

        // If the message is intended for the currently active request, apply immediately.
        if (state.activeRequestId && state.activeRequestId === requestId && state.agent) {
          const queueDepthBefore = state.queue.length;
          const shouldAbsorbBufferedPrompts =
            (entry.queue === "steer" || entry.queue === "interrupt") &&
            !isCancelControlEntry(entry);

          const bufferedPrompts = shouldAbsorbBufferedPrompts
            ? collectBufferedPromptEntriesForActiveRequest({
                queue: state.queue,
                activeRequestId: requestId,
              })
            : [];

          const mergedEntry =
            bufferedPrompts.length > 0
              ? ({
                  ...entry,
                  messages: [
                    ...bufferedPrompts.flatMap((queuedPrompt) => queuedPrompt.messages),
                    ...entry.messages,
                  ],
                } satisfies Enqueued)
              : entry;

          await applyToRunningAgent(
            state.agent,
            mergedEntry,
            cancelledByRequestId,
            state.activeRun,
          );

          if (bufferedPrompts.length > 0) {
            const absorbMode: "steer" | "interrupt" =
              entry.queue === "interrupt" ? "interrupt" : "steer";
            removeQueuedEntriesByReference(state.queue, bufferedPrompts);
            await publishAbsorbedQueuedPromptCancelled({
              bus,
              sessionId,
              entries: bufferedPrompts,
              mode: absorbMode,
            });
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
            logger.info("dropping request message (requires active request id)", {
              requestId,
              sessionId,
              activeRequestId: state.activeRequestId,
              queue: entry.queue,
            });
            logQueueTransition({
              action: "drop",
              queueDepthBefore: state.queue.length,
              queueDepthAfter: state.queue.length,
              reason: "requires_active_different_request_id",
            });
            await ctx.commit();
            return;
          }

          // No parallel runs: queue prompt messages for later.
          const queueDepthBefore = state.queue.length;
          state.queue.push(entry);

          await publishLifecycle({
            bus,
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
            state: "queued",
            detail: "queued behind active request",
          });

          logger.info("request queued behind active run", {
            requestId,
            sessionId,
            activeRequestId: state.activeRequestId,
            queueDepth: state.queue.length,
          });
          logQueueTransition({
            action: "enqueue",
            queueDepthBefore,
            queueDepthAfter: state.queue.length,
            reason: "queued_behind_active",
          });
        }
      }

      await ctx.commit();
    },
  );

  let subscriptionStopped = false;
  const stopSubscription = async () => {
    if (subscriptionStopped) return;
    subscriptionStopped = true;
    await sub.stop();
  };

  function buildActiveRecoveryEntry(state: SessionQueue): AgentRunnerRecoveryEntry | null {
    if (!state.running || !state.activeRun) return null;

    if (!state.agent) {
      return {
        kind: "active",
        requestId: state.activeRun.requestId,
        sessionId: state.activeRun.sessionId,
        requestClient: state.activeRun.requestClient,
        queue: "prompt",
        runPolicy: state.activeRun.runPolicy,
        origin: state.activeRun.origin,
        messages: state.activeRun.messages,
        ...(state.activeRun.modelOverride ? { modelOverride: state.activeRun.modelOverride } : {}),
        raw: state.activeRun.raw,
      };
    }

    const checkpointMessages = buildSafeRecoveryCheckpoint(
      state.agent.state.messages,
      "server restarted",
    );

    return {
      kind: "active",
      requestId: state.activeRun.requestId,
      sessionId: state.activeRun.sessionId,
      requestClient: state.activeRun.requestClient,
      queue: "prompt",
      runPolicy: state.activeRun.runPolicy,
      origin: state.activeRun.origin,
      messages: [],
      ...(state.activeRun.modelOverride ? { modelOverride: state.activeRun.modelOverride } : {}),
      raw: state.activeRun.raw,
      recovery: {
        checkpointMessages,
        partialText: state.activeRun.partialText,
      },
    };
  }

  async function beginDrain(opts?: { deadlineMs?: number }) {
    draining = true;
    await stopSubscription();

    const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
    const startedAt = Date.now();

    const hasRunning = () => [...bySession.values()].some((s) => s.running);

    while (hasRunning() && Date.now() - startedAt < deadlineMs) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!hasRunning()) return;

    for (const state of bySession.values()) {
      if (!state.running || !state.activeRun) continue;

      const recovery = buildActiveRecoveryEntry(state);
      if (recovery) {
        forcedRecoveryByRequestId.set(recovery.requestId, recovery);
        restartAbortRequestIds.add(recovery.requestId);
      }

      state.agent?.abort();
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  function snapshotRecoverables(): AgentRunnerRecoveryEntry[] {
    const out: AgentRunnerRecoveryEntry[] = [];
    const seenActive = new Set<string>();

    for (const forced of forcedRecoveryByRequestId.values()) {
      out.push(forced);
      seenActive.add(forced.requestId);
    }

    for (const state of bySession.values()) {
      const active = buildActiveRecoveryEntry(state);
      if (active && !seenActive.has(active.requestId)) {
        out.push(active);
        seenActive.add(active.requestId);
      }

      for (const queued of state.queue) {
        out.push({
          kind: "queued",
          requestId: queued.requestId,
          sessionId: queued.sessionId,
          requestClient: queued.requestClient,
          queue: queued.queue,
          runPolicy: queued.runPolicy,
          origin: queued.origin,
          messages: queued.messages,
          ...(queued.modelOverride ? { modelOverride: queued.modelOverride } : {}),
          raw: queued.raw,
        });
      }
    }

    return out;
  }

  function restoreRecoverables(entries: readonly AgentRunnerRecoveryEntry[]) {
    if (entries.length === 0) return;

    for (const entry of entries) {
      const state =
        bySession.get(entry.sessionId) ??
        ({
          running: false,
          agent: null,
          queue: [] as Enqueued[],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        } satisfies SessionQueue);
      bySession.set(entry.sessionId, state);

      state.queue.push({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        requestClient: entry.requestClient,
        queue: entry.queue,
        runPolicy: entry.runPolicy ?? "normal",
        origin: entry.origin,
        messages: entry.messages,
        modelOverride: entry.modelOverride,
        raw: entry.raw,
        recovery: entry.recovery,
      });

      if (!state.running) {
        drainSessionQueue(entry.sessionId, state).catch((e: unknown) => {
          logger.error("drainSessionQueue failed", { sessionId: entry.sessionId }, e);
        });
      }
    }
  }

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    if (state.running) return;

    const queueDepthBefore = state.queue.length;
    const next = state.queue.shift();
    if (!next) return;

    logger.info("agent.queue.transition", {
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
    let activeRunOperation: Promise<unknown> | null = null;
    let customCommandAbortController: AbortController | null = null;
    let activeCustomCommandTool: { toolCallId: string; display: string } | null = null;
    let rejectPreAgentCancellation: ((error: PreAgentRunCancelledError) => void) | null = null;
    const preAgentCancellationPromise = new Promise<never>((_, reject) => {
      rejectPreAgentCancellation = reject;
    });
    void preAgentCancellationPromise.catch(() => undefined);
    let unsubscribe = () => {};
    let unsubscribeCompaction = () => {};

    const headers: {
      request_id: string;
      session_id: string;
      request_client: AdapterPlatform;
      workflow_dispatch_epoch?: string;
      router_session_mode?: "mention" | "active";
    } = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
      ...(workflowDispatchEpoch ? { workflow_dispatch_epoch: workflowDispatchEpoch } : {}),
      ...(routerSessionMode ? { router_session_mode: routerSessionMode } : {}),
    };
    const publishCurrentLifecycle = async (input: {
      state: RequestLifecycleState;
      detail?: string;
      output?: string;
      usage?: WorkflowUsage;
    }): Promise<void> => {
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
          throw new Error("Workflow terminal receipt persistence lost its fenced dispatch claim");
        }
      }
      await publishLifecycle({ bus, headers, ...input });
    };
    const publishAgentActivity = createAgentOutputActivityPublisher({
      bus,
      headers,
      onError: (error) => {
        logger.debug("agent activity publish failed", {
          requestId: next.requestId,
          sessionId: next.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const runIdleWatchdog =
      runProfile === "primary"
        ? createAgentRunIdleWatchdog({
            idleTimeoutMs: cfg.agent.idleTimeoutMs,
            onTimeout: () => {
              logger.warn("agent run idle timeout", {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                idleTimeoutMs: cfg.agent.idleTimeoutMs,
              });
              customCommandAbortController?.abort();
              activeAgent?.abort();
            },
          })
        : null;
    const waitForRun = <T>(promise: Promise<T>): Promise<T> => {
      let tracked: Promise<T>;
      tracked = promise.finally(() => {
        if (activeRunOperation === tracked) activeRunOperation = null;
      });
      activeRunOperation = tracked;
      return runIdleWatchdog ? runIdleWatchdog.waitFor(tracked) : tracked;
    };
    const getActiveRunOperation = (): Promise<unknown> | null => activeRunOperation;
    const waitForPreAgent = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, preAgentCancellationPromise]);
    const markRunActivity = (source: "model" | "tool" | "subagent") => {
      publishAgentActivity(source);
      runIdleWatchdog?.reset();
    };

    const normalizeToolResultOutput: NormalizeToolResultOutputFn = createToolResultOutputNormalizer(
      {
        artifacts: params.toolResultArtifacts,
        owner: {
          requestId: next.requestId,
          sessionId: next.sessionId,
        },
        getOutputConfig: () => cfg.tools.output,
      },
    );

    const liveParentSession = params.workflowLiveParentBridge?.registerParent({
      parentRequestId: next.requestId,
      onActivity: () => markRunActivity("subagent"),
      recoverSynchronousDeliveries: next.recovery !== undefined,
    });
    await liveParentSession?.ready;
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
      try {
        await Promise.race([
          liveParentSession.waitForSignalSince(liveParentSignalVersion, controller.signal),
          waitForContinuationSignalSince(continuationVersion, controller.signal),
          Bun.sleep(LIVE_PARENT_RECONCILE_MS),
        ]);
      } finally {
        controller.abort();
      }
    };

    state.activeRun = {
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      runProfile,
      queue: next.queue,
      runPolicy: next.runPolicy,
      origin: next.origin,
      messages: next.messages,
      modelOverride: next.modelOverride,
      raw: next.raw,
      partialText: next.recovery?.partialText ?? "",
      liveParent: liveParentSession,
      notifyWaiters: notifyContinuationWaiters,
      cancel: () => {
        cancelledByRequestId.add(headers.request_id);
        customCommandAbortController?.abort();
        rejectPreAgentCancellation?.(new PreAgentRunCancelledError());
        rejectPreAgentCancellation = null;
      },
      started: false,
      startedAt: runStartedAt,
      activeTools: new Map(),
    };

    let initialMessages: ModelMessage[] = [];
    const parsedCustomCommand = next.recovery ? null : parseCustomCommandFromRaw(next.raw);
    let customCommandMessages: ModelMessage[] = [];
    let initialMessagesEndWithInjectedTool = false;
    let responseStartIndex = 0;
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
    try {
      const looksLikeWorkflowRequest =
        next.requestId.startsWith("wfr:") || next.sessionId.startsWith("workflow:");
      if (workflowHint || looksLikeWorkflowRequest) {
        if (!workflowHint || !params.durableWorkflowStore) {
          throw new Error("Workflow request is missing server-issued dispatch authority");
        }
        const authorized = params.durableWorkflowStore.authorizeWorkflowRequest({
          requestId: next.requestId,
          sessionId: next.sessionId,
          platform: next.requestClient,
          now: Date.now(),
        });
        if (
          !authorized ||
          authorized.policy.runId !== workflowHint.runId ||
          authorized.policy.operationId !== workflowHint.operationId ||
          authorized.policy.dispatchEpoch !== workflowHint.dispatchEpoch
        ) {
          throw new Error("Workflow request dispatch authority is invalid or inactive");
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
          throw new Error("Workflow request dispatch is owned by another live runner");
        }
        workflowRequestClaimed = true;
        workflowPolicy = authorized.policy;
        trustedFallbackSurface =
          authorized.policy.originSession.sessionId &&
          (authorized.policy.originSession.client === "discord" ||
            authorized.policy.originSession.client === "github") &&
          authorized.policy.originSession.userId
            ? {
                platform: authorized.policy.originSession.client,
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
        }, 5_000);
        workflowClaimTimer.unref?.();
      }
      if (workflowPolicy) assertWorkflowDispatchPolicy(workflowPolicy, subagentMeta);
      const maxSubagentDepth = subagents.maxDepth;
      if (subagentMeta.depth > maxSubagentDepth) {
        const detail = `subagent depth ${subagentMeta.depth} exceeds maxDepth=${maxSubagentDepth}`;
        await publishCurrentLifecycle({
          state: "failed",
          detail,
          output: `Error: ${detail}`,
        });
        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          { finalText: `Error: ${detail}` },
          { headers },
        );
        return;
      }

      await publishCurrentLifecycle({
        state: "running",
        detail: next.recovery
          ? "resumed after server restart"
          : next.queue !== "prompt"
            ? `coerced queue=${next.queue} to prompt (no active run)`
            : undefined,
      });
      await bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers });

      if (parsedCustomCommand) {
        const toolCallId = buildCustomCommandToolCallId(next.requestId, parsedCustomCommand.name);
        const display = `${CUSTOM_COMMAND_TOOL_NAME} ${parsedCustomCommand.text}`;
        activeCustomCommandTool = { toolCallId, display };

        await bus.publish(
          lilacEventTypes.EvtAgentOutputToolCall,
          {
            toolCallId,
            status: "start",
            display,
          },
          { headers },
        );

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
          try {
            if (cancelledByRequestId.has(headers.request_id)) {
              throw new PreAgentRunCancelledError();
            }
            customCommandAbortController = new AbortController();
            runIdleWatchdog?.start();
            output = await waitForPreAgent(
              waitForRun(
                params.customCommands.execute({
                  command,
                  args: parsedCustomCommand.args,
                  context: {
                    cwd,
                    dataDir: env.dataDir,
                    commandDir: command.dir,
                    commandName: command.def.name,
                    requestId: next.requestId,
                    sessionId: next.sessionId,
                    abortSignal: customCommandAbortController.signal,
                    reportActivity: () => markRunActivity("tool"),
                  },
                }),
              ),
            );
          } catch (error) {
            if (
              error instanceof AgentIdleTimeoutError ||
              error instanceof PreAgentRunCancelledError
            ) {
              throw error;
            }
            customError = error instanceof Error ? error.message : String(error);
          } finally {
            runIdleWatchdog?.pause();
            customCommandAbortController = null;
          }
        }

        const customCancelled = cancelledByRequestId.has(headers.request_id);

        if (customCancelled) {
          const finalText = "Cancelled.";
          await bus.publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId,
              status: "end",
              display,
              ok: false,
              error: "cancelled by interrupt",
            },
            { headers },
          );
          activeCustomCommandTool = null;
          await publishCurrentLifecycle({
            state: "cancelled",
            detail: "cancelled by interrupt",
            output: finalText,
          });
          await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, { finalText }, { headers });
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

        await bus.publish(
          lilacEventTypes.EvtAgentOutputToolCall,
          {
            toolCallId,
            status: "end",
            display,
            ok: !customError,
            error: customError ?? undefined,
          },
          { headers },
        );
        activeCustomCommandTool = null;

        if (customError) {
          const finalText = buildCustomCommandFailureFinalText({
            commandText: parsedCustomCommand.text,
            normalizedOutput: output,
          });
          resolvedModelLabel = CUSTOM_COMMAND_TOOL_NAME;

          if (params.transcriptStore) {
            try {
              params.transcriptStore.saveRequestTranscript({
                requestId: headers.request_id,
                sessionId: headers.session_id,
                requestClient: headers.request_client,
                messages: [
                  ...customCommandMessages,
                  { role: "assistant", content: finalText } satisfies ModelMessage,
                ],
                finalText,
                modelLabel: resolvedModelLabel,
              });
            } catch (error) {
              logger.error(
                "failed to persist transcript after custom command error",
                { requestId: headers.request_id, sessionId: headers.session_id },
                error,
              );
            }
          }

          await publishCurrentLifecycle({
            state: "failed",
            detail: customError,
            output: finalText,
          });
          await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, { finalText }, { headers });

          logger.warn("custom command failed", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            commandName: parsedCustomCommand.name,
            error: customError,
          });
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
        throw new Error("Workflow request model does not match the approved operation policy");
      }
      const resolved = resolveAgentRunModel({
        cfg,
        runProfile,
        requestModelOverride,
        reasoningOverride: subagentMeta.reasoning,
        resolvedModelRequest: workflowPolicy?.resolvedModelRequest,
      });
      resolvedModelLabel = resolved.modelId;
      try {
        modelCapabilityInfo = await waitForPreAgent(modelCapability.resolve(resolved.spec));
        if (modelCapabilityInfo.cost) {
          costEstimateStatus = "estimated";
        } else {
          costEstimateReason = "model_cost_missing";
        }
      } catch (error) {
        if (error instanceof PreAgentRunCancelledError) throw error;
        costEstimateReason =
          error instanceof Error
            ? `capability_resolve_failed:${error.message}`
            : `capability_resolve_failed:${String(error)}`;
      }

      const editingToolMode = resolveEditingToolMode({
        provider: resolved.provider,
        modelId: resolved.modelId,
      });
      const activeEditingToolMode = editingToolMode;

      const anthropicModel = isAnthropicModelSpec(resolved.spec);
      const anthropicPromptCachingEnabled = shouldEnableAnthropicPromptCache({
        spec: resolved.spec,
        anthropicPromptCache: resolved.anthropicPromptCache,
      });

      // Improve prompt caching stability by providing a session-scoped cache key.
      // This helps when many requests share a large common prefix (e.g. a long system prompt).
      // Also, when reasoning display is enabled, request detailed reasoning summaries
      // for OpenAI-backed models (including gateway/openrouter openai/* model IDs).
      const providerOptionsWithOpenAIReasoningSummary = withReasoningSummaryDefaultForOpenAIModels({
        reasoningDisplay:
          workflowPolicy?.resolvedModelRequest.reasoningDisplay ?? cfg.agent.reasoningDisplay,
        provider: resolved.provider,
        modelId: resolved.modelId,
        providerOptions: resolved.providerOptions,
      });

      // Newer Anthropic models can default to omitting thinking text unless
      // anthropic.thinking.display="summarized" is set. When the user wants a
      // reasoning lane and has thinking enabled, request summarized thinking text.
      const providerOptionsWithReasoningDisplay = withReasoningDisplayDefaultForAnthropicModels({
        reasoningDisplay:
          workflowPolicy?.resolvedModelRequest.reasoningDisplay ?? cfg.agent.reasoningDisplay,
        provider: resolved.provider,
        modelId: resolved.modelId,
        providerOptions: providerOptionsWithOpenAIReasoningSummary,
      });

      // Prompt cache key only applies for direct OpenAI/Codex providers.
      const providerOptionsWithPromptCacheKey = (() => {
        const provider = resolved.provider;
        const supports = provider === "openai" || provider === "codex";
        if (!supports) return providerOptionsWithReasoningDisplay;

        const base = providerOptionsWithReasoningDisplay ?? {};
        const existingOpenAI = (base["openai"] ?? {}) as Record<string, unknown>;

        return {
          ...base,
          openai: {
            ...existingOpenAI,
            promptCacheKey: toOpenAIPromptCacheKey(sessionId),
          },
        };
      })();

      const providerOptionsForAgent = anthropicModel
        ? withStableAnthropicUpstreamOrder(resolved.provider, providerOptionsWithPromptCacheKey)
        : providerOptionsWithPromptCacheKey;
      const experimentalDownloadForAgent = buildExperimentalDownloadForAnthropicFallback({
        spec: resolved.spec,
        provider: resolved.provider,
        providerOptions: providerOptionsForAgent,
      });

      const baseSystemPrompt = buildSystemPromptForProfile({
        baseSystemPrompt: cfg.agent.systemPrompt,
        profile: runProfile,
        profileConfig:
          runProfile === "primary" ? undefined : resolveNativeSubagentProfile(cfg, runProfile),
        activeEditingTool: runProfile === "explore" ? null : activeEditingToolMode,
        exploreOverlay: subagents.profiles.explore.promptOverlay,
        generalOverlay: subagents.profiles.general.promptOverlay,
        selfOverlay: subagents.profiles.self.promptOverlay,
        skillsSection:
          runProfile === "explore"
            ? null
            : await waitForPreAgent(maybeBuildSkillsSectionForPrimary()),
      });

      const baseSystemPromptWithAliases = appendConfiguredAliasPromptBlock({
        baseSystemPrompt,
        cfg,
        coreConfigPath: resolveCoreConfigPath(),
      });

      const sessionConfigId = parseSessionConfigIdFromRaw(next.raw) ?? sessionId;
      const parentChannelResolution =
        next.requestClient === "discord" ? params.resolveParentChannelId?.(sessionId) : null;
      const parentChannelId = parentChannelResolution ?? undefined;
      const safetyMode: SessionSafetyMode =
        next.requestClient === "discord" && parentChannelResolution === undefined
          ? "restricted"
          : resolveSessionSafetyMode(cfg, sessionId, parentChannelId);
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
          throw new Error("Heartbeat request is missing server-issued Level-2 authority");
        }
      } else if (
        workflowPolicy ||
        next.requestClient === "discord" ||
        next.requestClient === "github"
      ) {
        const capabilityPrincipal = trustedFallbackSurface
          ? {
              platform: trustedFallbackSurface.platform,
              userId: trustedFallbackSurface.userId,
            }
          : undefined;
        const issuedControl = await params.issueControlCapability?.({
          requestId: next.requestId,
          sessionId: next.sessionId,
          requestClient: next.requestClient,
          profile: runProfile,
          canonicalCwd: workflowPolicy?.cwd ?? cwd,
          safetyMode,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
          ...(capabilityPrincipal ? { principal: capabilityPrincipal } : {}),
        });
        if (!issuedControl) {
          throw new Error(
            "Native profile request is missing server-issued Level-2 control authority",
          );
        }
        controlCapability = issuedControl.capability;
        if (issuedControl.principal) {
          trustedFallbackSurface = {
            platform: issuedControl.principal.platform,
            sessionId: next.sessionId,
            userId: issuedControl.principal.userId,
          };
        }
      }

      const additionalSessionPrompts = await waitForPreAgent(
        resolveSessionAdditionalPrompts({
          entries: cfg.surface.router.sessionModes[sessionConfigId]?.additionalPrompts,
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

      const systemPromptWithSessionMemo = appendAdditionalSessionMemoBlock(
        baseSystemPromptWithAliases,
        additionalSessionPrompts,
      );

      const heartbeatOverlay = buildHeartbeatOverlayForRequest({
        cfg,
        requestId: next.requestId,
        sessionId: next.sessionId,
        runProfile,
        nowMs: Date.now(),
      });

      const systemPromptWithHeartbeatOverlay =
        heartbeatOverlay && heartbeatOverlay.trim().length > 0
          ? `${systemPromptWithSessionMemo}\n\n${heartbeatOverlay}`
          : systemPromptWithSessionMemo;

      const autoInjectedThreadSearchOverlay = buildAutoInjectedThreadSearchOverlay({
        cfg,
        runProfile,
      });

      const systemPromptWithAutoInjectedThreadSearchOverlay =
        autoInjectedThreadSearchOverlay && autoInjectedThreadSearchOverlay.trim().length > 0
          ? `${systemPromptWithHeartbeatOverlay}\n\n${autoInjectedThreadSearchOverlay}`
          : systemPromptWithHeartbeatOverlay;

      const surfaceMetadataOverlay = buildSurfaceMetadataOverlay(next.messages);

      const systemPromptWithSurfaceMetadataOverlay =
        surfaceMetadataOverlay && surfaceMetadataOverlay.trim().length > 0
          ? `${systemPromptWithAutoInjectedThreadSearchOverlay}\n\n${surfaceMetadataOverlay}`
          : systemPromptWithAutoInjectedThreadSearchOverlay;

      const restrictedSessionOverlay =
        safetyMode === "restricted"
          ? buildRestrictedSessionOverlay({ sessionId: next.sessionId })
          : null;

      const systemPromptWithSafetyOverlay = restrictedSessionOverlay
        ? `${systemPromptWithSurfaceMetadataOverlay}\n\n${restrictedSessionOverlay}`
        : systemPromptWithSurfaceMetadataOverlay;

      const systemPrompt = maybeAppendResponseCommentaryPrompt({
        baseSystemPrompt: systemPromptWithSafetyOverlay,
        provider: resolved.provider,
        responseCommentary: resolved.responseCommentary,
      });

      let seededSessionMessages: ModelMessage[] = [];
      if (!next.recovery && runProfile !== "primary" && params.transcriptStore) {
        try {
          const latest = params.transcriptStore.getLatestTranscriptBySession?.({
            sessionId: next.sessionId,
          });
          if (latest && latest.messages.length > 0) {
            seededSessionMessages = latest.messages;
            logger.info("subagent continuation seeded from transcript", {
              requestId: next.requestId,
              sessionId: next.sessionId,
              fromRequestId: latest.requestId,
              messagesSeeded: latest.messages.length,
            });
          }
        } catch (e) {
          logger.warn(
            "failed to load subagent continuation transcript",
            {
              requestId: next.requestId,
              sessionId: next.sessionId,
            },
            e,
          );
        }
      }

      logger.info("agent run starting", {
        requestId: next.requestId,
        sessionId: next.sessionId,
        requestClient: next.requestClient,
        runProfile,
        subagentDepth: subagentMeta.depth,
        sessionConfigId,
        safetyMode,
        requestModelOverride,
        model: resolved.spec,
        responseCommentary: resolved.responseCommentary === true,
        editingToolMode: runProfile === "explore" ? "none" : activeEditingToolMode,
        isRecoveryResume: Boolean(next.recovery),
        messageCount: next.messages.length,
        recoveryCheckpointMessageCount: next.recovery?.checkpointMessages.length ?? 0,
        queuedForSession: state.queue.length,
      });

      const fallbackSurfaceForDelegation = trustedFallbackSurface;
      const executionCwd = workflowPolicy?.cwd ?? cwd;
      const {
        tools,
        specs: level1ToolSpecs,
        genericOutputNormalizerBypassTools,
      } = await waitForPreAgent(
        params.pluginManager.buildLevel1Toolset({
          cwd: executionCwd,
          runProfile,
          editingToolMode: runProfile === "explore" ? "none" : activeEditingToolMode,
          subagentDepth: subagentMeta.depth,
          subagentConfig: {
            enabled: subagents.enabled,
            idleTimeoutMs: subagents.idleTimeoutMs,
            maxDepth: subagents.maxDepth,
          },
          requestContext: {
            requestId: next.requestId,
            sessionId: next.sessionId,
            requestClient: next.requestClient,
            subagentDepth: subagentMeta.depth,
            subagentProfile: runProfile,
            safetyMode,
            metadata: {
              controlCapability: controlCapability ?? undefined,
              readFileDirectAttachmentSupported:
                supportsReadFileDirectAttachments(modelCapabilityInfo),
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
          },
          reportToolStatus: (update) => {
            bus
              .publish(lilacEventTypes.EvtAgentOutputToolCall, update, {
                headers,
              })
              .catch((e: unknown) => {
                logger.error(
                  "failed to publish batch tool status",
                  {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    toolCallId: update.toolCallId,
                  },
                  e,
                );
              });
          },
        }),
      );
      const agentSystem = anthropicPromptCachingEnabled
        ? {
            role: "system" as const,
            content: systemPrompt,
            providerOptions: ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
          }
        : systemPrompt;
      let transientRetryOutputStarted = false;
      const transientRetryController = createTransientModelRetryController({
        retry: cfg.agent.retry,
        logger,
        requestId: headers.request_id,
        sessionId: headers.session_id,
        modelSpec: resolved.spec,
        hasStartedOutput: () => transientRetryOutputStarted,
      });

      const agent = new AiSdkPiAgent<ToolSet>({
        system: agentSystem,
        model: resolved.model,
        modelSpecifier: resolved.spec,
        messages: next.recovery?.checkpointMessages ?? seededSessionMessages,
        tools,
        providerOptions: providerOptionsForAgent,
        reasoning: resolved.reasoning,
        turnErrorHandler: transientRetryController.handler,
        normalizeToolResultOutput,
        genericOutputNormalizerBypassTools,
        experimentalDownload: experimentalDownloadForAgent,
        debug: {
          captureModelViewMessages: env.debug.contextDump.enabled,
        },
      });
      activeAgent = agent;

      agent.setContext({
        sessionId: next.sessionId,
        requestId: next.requestId,
        requestClient: next.requestClient,
        subagentDepth: subagentMeta.depth,
        subagentProfile: runProfile,
        safetyMode,
      });

      // Drain all buffered messages at boundaries (better UX in chat surfaces).
      agent.setFollowUpMode("all");
      agent.setSteeringMode("all");

      const toolPruneTransform: TransformMessagesFn = async (messages) => {
        // First, remove pathological binary blobs from the *model-facing* view.
        const scrubbed = scrubLargeBinaryForModelView(messages, {
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
            logger.info("agent.historical_result_pruned", {
              requestId: next.requestId,
              sessionId: next.sessionId,
              compactedToolCallCount: state.compactedToolCallIds.size,
              estimatedPrunedTokens,
            });
          }
        }

        const compacted = cfg.tools.historicalResultPruning.enabled
          ? applyToolOutputCompactionView({
              messages: scrubbed,
              compactedToolCallIds: state.compactedToolCallIds,
            })
          : scrubbed;

        if (!anthropicPromptCachingEnabled) return compacted;
        return withProviderOptionsOnLastUserMessage(
          compacted,
          ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
        );
      };

      let autoCompactionSeq = 0;
      let activeAutoCompactionToolCallId: string | null = null;
      let autoCompactionPublishChain = Promise.resolve();
      const publishAutoCompactionToolStatus = (update: {
        toolCallId: string;
        status: "start" | "end";
        display: string;
        ok?: boolean;
        error?: string;
      }) => {
        const publishOne = async () => {
          try {
            await bus.publish(lilacEventTypes.EvtAgentOutputToolCall, update, {
              headers,
            });
          } catch (e: unknown) {
            logger.error(
              "failed to publish auto-compaction tool status",
              {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                toolCallId: update.toolCallId,
                status: update.status,
              },
              e,
            );
          }
        };

        autoCompactionPublishChain = autoCompactionPublishChain.then(publishOne, publishOne);
      };

      unsubscribeCompaction = await waitForPreAgent(
        attachAutoCompaction(agent, {
          model: resolved.spec,
          modelCapability,
          resolveCurrentModelSpecifier: () => agent.state.modelSpecifier ?? resolved.spec,
          baseTransformMessages: toolPruneTransform,
          baseTurnErrorHandler: transientRetryController.handler,
          onUnknownCapability: ({ spec, reason, error }) => {
            logger.warn(
              "auto-compaction capability unknown; disabling threshold compaction",
              {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                modelSpec: spec,
                reason,
              },
              error,
            );
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
            estimatedOutputTokens,
            durationMs,
            status,
            error,
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
              estimatedOutputTokens,
            };
            if (status === "completed") {
              completedCompactionCount += 1;
              logger.info("auto-compaction end", payload);
              return;
            }
            logger.warn(
              "auto-compaction end",
              { ...payload, ...extractAiErrorLogDetails(error) },
              error,
            );
          },
        }),
      );

      const publishedDeferredCompletionRunIds = new Set<string>();
      let lastBoundaryModelInputMessages: readonly ModelMessage[] = [];
      const drainDeferredCompletions = async (input: {
        modelInputMessages: readonly ModelMessage[];
        abortSignal?: AbortSignal;
      }): Promise<{ append: ModelMessage[]; forceNextTurn: boolean }> => {
        if (!liveParentSession) {
          return { append: [], forceNextTurn: false };
        }

        const pendingIdentities = liveParentSession.listPendingIdentities();
        const consumedBeforeMaterialization = pendingIdentities
          .filter((identity) =>
            hasConsumedDeferredSubagentResult(input.modelInputMessages, identity),
          )
          .map((identity) => identity.runId);
        if (consumedBeforeMaterialization.length > 0) {
          await liveParentSession.acknowledge(consumedBeforeMaterialization);
        }
        if (input.abortSignal?.aborted) return { append: [], forceNextTurn: false };

        let settled: Awaited<ReturnType<typeof liveParentSession.listPendingSettledAsync>>;
        try {
          settled = await liveParentSession.listPendingSettledAsync();
        } catch (error) {
          logger.warn(
            "workflow subagent completion query failed; delivery remains pending",
            { requestId: headers.request_id, sessionId: headers.session_id },
            error,
          );
          return { append: [], forceNextTurn: false };
        }

        if (input.abortSignal?.aborted) return { append: [], forceNextTurn: false };

        const completions: WorkflowLiveParentCompletion[] = [];
        for (const result of settled) {
          let completion: WorkflowLiveParentCompletion | null = null;
          let materializationError: unknown;
          if (result.loaded) {
            try {
              completion = {
                ...result.completion,
                finalText: await normalizeSubagentFinalText({
                  normalize: normalizeToolResultOutput,
                  finalText: result.completion.finalText,
                  toolCallId: buildSubagentResultToolCallId(result.completion.runId),
                }),
              };
            } catch (error) {
              materializationError = error;
            }
          } else {
            materializationError = result.error;
          }

          if (completion) {
            liveParentSession.clearMaterializationFailure(completion.runId);
            completions.push(completion);
            continue;
          }

          const identity = result.loaded ? result.completion : result.identity;
          const errorMessage =
            materializationError instanceof Error
              ? materializationError.message
              : String(materializationError);
          const attempts = liveParentSession.recordMaterializationFailure(
            identity.runId,
            errorMessage,
          );
          logger.warn(
            "workflow subagent completion materialization failed",
            {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              runId: identity.runId,
              attempts,
              maxAttempts: SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS,
            },
            materializationError,
          );
          if (attempts === null || attempts < SUBAGENT_RESULT_MATERIALIZATION_ATTEMPTS) continue;

          completions.push({
            ...identity,
            status: "failed",
            ok: false,
            finalText: "",
            detail: `subagent result delivery failed after ${attempts} attempts: ${errorMessage}`,
          });
        }

        const plan = planDeferredSubagentBoundary({
          canonicalMessages: agent.state.messages,
          modelInputMessages: input.modelInputMessages,
          completions,
        });

        for (const completion of completions) {
          if (publishedDeferredCompletionRunIds.has(completion.runId)) continue;
          try {
            await bus.publish(
              lilacEventTypes.EvtAgentOutputToolCall,
              {
                toolCallId: completion.parentToolCallId,
                status: "end",
                display: buildDeferredSubagentDisplay(completion),
                ok: completion.ok,
                error: completion.ok
                  ? undefined
                  : (completion.detail ?? `subagent ${completion.status}`),
              },
              { headers },
            );
            publishedDeferredCompletionRunIds.add(completion.runId);
          } catch (error) {
            logger.warn(
              "workflow subagent completion publish failed",
              { runId: completion.runId },
              error,
            );
          }
        }

        if (plan.consumedRunIds.length > 0 && !input.abortSignal?.aborted) {
          await liveParentSession.acknowledge(plan.consumedRunIds);
        }

        return { append: plan.append, forceNextTurn: plan.forceNextTurn };
      };
      agent.setTurnBoundaryHandler(async (context) => {
        lastBoundaryModelInputMessages = context.modelInputMessages;
        return await drainDeferredCompletions({
          modelInputMessages: context.modelInputMessages,
          abortSignal: context.abortSignal,
        });
      });

      state.agent = agent;

      let finalText = "";
      const assistantTextPartBoundaryState = createAssistantTextPartBoundaryState(
        next.recovery?.partialText,
      );
      const reasoningChunkById = new Map<string, string>();
      let reasoningChunkSeq = 0;

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
            modelSpec: resolved.spec,
            modelId: resolved.modelId,
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

        try {
          await fs.mkdir(contextDumpDir, { recursive: true });
          await fs.writeFile(filePath, debugJsonStringify(payload), "utf8");
          logger.debug("context dump wrote", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            filePath,
          });
        } catch (e: unknown) {
          logger.warn(
            "context dump failed",
            {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              filePath,
            },
            e,
          );
        }
      };

      const estimateUsageCostUsd = (usage: LanguageModelUsage | undefined): number | undefined => {
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

        if (event.type === "turn_end") {
          transientRetryController.reset();
          transientRetryOutputStarted = false;

          turnEndCount++;
          runStats.lastTurnFinishReason = event.finishReason;
          runStats.lastTurnEndAt = Date.now();

          const roundEstimatedCostUsd = estimateUsageCostUsd(event.usage);
          if (roundEstimatedCostUsd !== undefined) {
            roundEstimatedCostUsdTotal = (roundEstimatedCostUsdTotal ?? 0) + roundEstimatedCostUsd;
            roundEstimatedCostCount += 1;
          }

          logger.info("agent.round.stats", {
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
            costEstimateStatus:
              roundEstimatedCostUsd !== undefined ? "estimated" : costEstimateStatus,
            costEstimateReason:
              roundEstimatedCostUsd === undefined ? costEstimateReason : undefined,
          });

          // Fire-and-forget debug dump; do not block the run.
          void dumpContextAfterTurn(event);
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

        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
          markAssistantTextPartStarted(
            assistantTextPartBoundaryState,
            event.assistantMessageEvent.id,
          );
        }

        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          runStats.firstTextDeltaAt ??= Date.now();

          const delta = consumeAssistantTextDelta({
            state: assistantTextPartBoundaryState,
            finalText,
            recoveryPartialText: next.recovery?.partialText,
            partId: event.assistantMessageEvent.id,
            delta: event.assistantMessageEvent.delta,
          });

          if (delta.length > 0) {
            transientRetryOutputStarted = true;
          }

          finalText += delta;
          if (state.activeRun && state.activeRun.requestId === next.requestId) {
            state.activeRun.partialText += delta;
          }

          bus
            .publish(lilacEventTypes.EvtAgentOutputDeltaText, { delta }, { headers })
            .catch((e: unknown) => {
              logger.error(
                "failed to publish output delta",
                { requestId: headers.request_id, sessionId: headers.session_id },
                e,
              );
            });
        }

        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
          markAssistantTextPartEnded(
            assistantTextPartBoundaryState,
            event.assistantMessageEvent.id,
          );
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_start"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          if (!reasoningChunkById.has(chunkId)) {
            reasoningChunkById.set(chunkId, "");
          }

          bus
            .publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, { delta: "" }, { headers })
            .catch((e: unknown) => {
              logger.error(
                "failed to publish reasoning start",
                { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                e,
              );
            });
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_delta"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          const delta = event.assistantMessageEvent.delta;
          if (delta.length > 0) {
            transientRetryOutputStarted = true;
          }

          if (!reasoningChunkById.has(chunkId)) {
            reasoningChunkById.set(chunkId, "");

            bus
              .publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, { delta: "" }, { headers })
              .catch((e: unknown) => {
                logger.error(
                  "failed to publish implicit reasoning start",
                  { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                  e,
                );
              });
          }

          const prev = reasoningChunkById.get(chunkId) ?? "";
          reasoningChunkById.set(chunkId, `${prev}${delta}`);
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_end"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          const chunk = reasoningChunkById.get(chunkId) ?? "";
          reasoningChunkById.delete(chunkId);

          if (chunk.trim().length === 0) {
            return;
          }

          reasoningChunkSeq += 1;

          bus
            .publish(
              lilacEventTypes.EvtAgentOutputDeltaReasoning,
              { delta: chunk, seq: reasoningChunkSeq },
              { headers },
            )
            .catch((e: unknown) => {
              logger.error(
                "failed to publish reasoning chunk",
                { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                e,
              );
            });
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "toolcall_start"
        ) {
          transientRetryOutputStarted = true;
        }

        if (event.type === "tool_execution_start") {
          const startedAt = Date.now();
          toolStartMs.set(event.toolCallId, startedAt);
          state.activeRun?.activeTools.set(event.toolCallId, {
            toolName: event.toolName,
            startedAt,
          });

          if (event.toolName !== "batch") {
            bus
              .publish(
                lilacEventTypes.EvtAgentOutputToolCall,
                {
                  toolCallId: event.toolCallId,
                  status: "start",
                  display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, event.args, level1ToolSpecs)}`,
                },
                { headers },
              )
              .catch((e: unknown) => {
                logger.error(
                  "failed to publish tool start",
                  {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                  },
                  e,
                );
              });
          }
        }

        if (event.type === "tool_execution_end") {
          state.activeRun?.activeTools.delete(event.toolCallId);
          const started = toolStartMs.get(event.toolCallId);
          const toolDurationMs = started ? Date.now() - started : undefined;
          const toolFailure = summarizeToolFailure({
            toolName: event.toolName,
            isError: event.isError,
            result: event.result,
            toolSpecs: level1ToolSpecs,
          });
          const deferredAccepted =
            event.toolName === "subagent_delegate" &&
            isDeferredSubagentAcceptedResult(event.result);

          const ok =
            event.toolName === "batch"
              ? (getBatchOkFromResult(event.result) ?? toolFailure.ok)
              : event.toolName === "subagent_delegate"
                ? (getSubagentOkFromResult(event.result) ?? toolFailure.ok)
                : toolFailure.ok;
          const interruptedForRestart = restartAbortRequestIds.has(headers.request_id);
          const toolFailureError = toolFailure.error ?? "tool failed";

          if (!ok) {
            logger.warn("tool call failed", {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              durationMs: toolDurationMs,
              failureKind: toolFailure.failureKind ?? "soft",
              error: interruptedForRestart ? "server restarted" : toolFailureError,
              argsPreview: formatToolLogPreview({
                toolName: event.toolName,
                value: event.args,
              }),
              resultPreview: formatToolLogPreview({
                toolName: event.toolName,
                value: event.result,
              }),
            });
          }

          logger.debug("tool finished", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ok,
            deferredAccepted,
            durationMs: toolDurationMs,
            failureKind: ok ? undefined : (toolFailure.failureKind ?? "soft"),
          });

          if (event.toolName === "batch" || deferredAccepted) {
            return;
          }

          bus
            .publish(
              lilacEventTypes.EvtAgentOutputToolCall,
              {
                toolCallId: event.toolCallId,
                status: "end",
                display: `${event.toolName}${formatToolArgsForDisplayWithSpecs(event.toolName, event.args, level1ToolSpecs)}`,
                ok,
                error: ok
                  ? undefined
                  : interruptedForRestart
                    ? "server restarted"
                    : toolFailureError,
              },
              { headers },
            )
            .catch((e: unknown) => {
              logger.error(
                "failed to publish tool end",
                {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                },
                e,
              );
            });
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
        initialMessages = [buildResumePrompt(next.recovery.partialText)];
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
        const mergedInitial = mergeQueuedForSameRequest(next, state.queue);
        const control = parseRequestControlFromRaw(next.raw);
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
                    await bus.publish(lilacEventTypes.EvtAgentOutputToolCall, update, { headers });
                  },
                  onError: (message, error) => {
                    logger.warn(
                      message,
                      {
                        requestId: headers.request_id,
                        sessionId: headers.session_id,
                        ...extractAiErrorLogDetails(error),
                      },
                      error,
                    );
                  },
                  onInjected: (event) => {
                    logger.info("conversation.thread.auto_inject.appended", {
                      requestId: headers.request_id,
                      sessionId: headers.session_id,
                      toolCallId: event.toolCallId,
                      mode: event.mode,
                      limit: event.limit,
                      searchCount: event.searches.length,
                      queryCount: event.searches.reduce((sum, queries) => sum + queries.length, 0),
                      searches: event.searches,
                      participantFilterUserCount: event.participantFilterUserCount,
                      appendedCount: event.entries.length,
                      entries: event.entries,
                    });
                  },
                }),
              )
            : [];
        initialMessages = [...mergedInitial, ...autoInjectedThreadSearchMessages];
        initialMessagesEndWithInjectedTool = autoInjectedThreadSearchMessages.length > 0;
        responseStartIndex = agent.state.messages.length + initialMessages.length;
      }

      if (cancelledByRequestId.has(headers.request_id)) {
        const finalText = "Cancelled.";
        await publishCurrentLifecycle({
          state: "cancelled",
          detail: "cancelled by interrupt",
          output: finalText,
        });
        await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, { finalText }, { headers });
        return;
      }

      if (state.activeRun) state.activeRun.started = true;
      runIdleWatchdog?.start();

      if (parsedCustomCommand) {
        await waitForRun(agent.continue());
      } else if (initialMessagesEndWithInjectedTool) {
        agent.appendMessages(initialMessages);
        await waitForRun(agent.continue());
      } else {
        await waitForRun(agent.prompt(initialMessages));
      }

      while (true) {
        await waitForRun(agent.waitForIdle());

        if (restartAbortRequestIds.delete(headers.request_id)) {
          throw new RestartDrainingAbort();
        }

        const continuationWaitVersion = continuationSignalVersion;
        const deferredWaitState = liveParentSession?.snapshot();

        if (liveParentSession && deferredWaitState?.hasPendingCompletions) {
          const decision = await drainDeferredCompletions({
            modelInputMessages: lastBoundaryModelInputMessages,
          });
          if (decision.append.length > 0) agent.appendMessages(decision.append);
          if (cancelledByRequestId.has(headers.request_id)) break;
          if (decision.append.length > 0 || decision.forceNextTurn) {
            await waitForRun(agent.continue());
          } else if (liveParentSession.snapshot().hasPendingCompletions) {
            await waitForRun(
              waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
            );
          }
          continue;
        }

        if (!deferredWaitState?.hasOutstandingRuns) {
          break;
        }
        if (!liveParentSession) break;

        await waitForRun(
          waitForDeferredWake(deferredWaitState.signalVersion, continuationWaitVersion),
        );
        if (agent.state.isStreaming) {
          continue;
        }
      }
      runIdleWatchdog?.stop();

      const isCancelled = cancelledByRequestId.has(headers.request_id);
      if (isCancelled && !finalText) {
        finalText = "Cancelled.";
      }

      const isHeartbeatAckOnly =
        isHeartbeatSessionId(headers.session_id) && isHeartbeatAckText(finalText);
      const delivery = resolveReplyDeliveryFromFinalText(finalText);
      if (!isCancelled && delivery !== "skip" && !isHeartbeatAckOnly && finalText.length === 0) {
        throw new Error(
          buildNoAssistantTextError({
            provider: resolved.provider,
            modelId: resolved.modelId,
            finishReason: runStats.lastTurnFinishReason,
            warningSummary: summarizeCallWarnings(streamWarnings) ?? undefined,
          }),
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
      if (params.transcriptStore && (!shouldSkipSurfaceReply || runProfile !== "primary")) {
        try {
          const finalMessagesForPersistence = runStats.finalMessages ?? agent.state.messages;
          const checkpointMeta = resolveCompactionCheckpointMeta({
            runSucceeded: true,
            isPrimary: runProfile === "primary",
            isCancelled,
            shouldSkipSurfaceReply,
            completedCompactionCount,
          });
          const isCompactionCheckpoint = checkpointMeta !== undefined;
          const persistedMessages = (() => {
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

          params.transcriptStore.saveRequestTranscript({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            requestClient: headers.request_client,
            // Primary runs can reconstruct context from the surface thread.
            // Subagent runs need full per-session transcript for explicit continuation.
            messages: persistedMessages,
            finalText,
            modelLabel: resolvedModelLabel,
            contextMeta: checkpointMeta,
          });
          if (isCompactionCheckpoint) {
            logger.info("compaction checkpoint persisted", {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              messageCount: persistedMessages.length,
              compactionCount: completedCompactionCount,
              formatVersion: COMPACTION_CHECKPOINT_FORMAT_VERSION,
            });
          }
        } catch (e) {
          logger.error(
            "failed to persist transcript",
            { requestId: headers.request_id, sessionId: headers.session_id },
            e,
          );
        }
      }

      // Build stats in the js-llmcord-ish one-liner format.
      const endAt = runStats.lastTurnEndAt ?? Date.now();
      const ttftMs = runStats.firstTextDeltaAt ? runStats.firstTextDeltaAt - runStartedAt : null;
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

      if (params.transcriptStore && isHeartbeatSessionId(headers.session_id)) {
        try {
          persistHeartbeatSurfaceHandoffs({
            logger,
            transcriptStore: params.transcriptStore,
            requestId: headers.request_id,
            requestClient: headers.request_client,
            sessionId: headers.session_id,
            modelLabel: resolvedModelLabel,
            responseMessages,
          });
        } catch (e) {
          logger.error(
            "failed to persist heartbeat handoff transcripts",
            { requestId: headers.request_id, sessionId: headers.session_id },
            e,
          );
        }
      }

      const icLine = buildInputCompositionLine({
        system: systemPromptToText(agent.state.system),
        initialMessages,
        responseMessages,
        tools: agent.state.tools,
      });

      const modelLabel = resolved.modelId;
      const statsLine = buildStatsLine({
        modelLabel,
        usage: runStats.totalUsage,
        ttftMs,
        tps,
        icLine,
      });

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

      const estimatedCostUsdFromTotalUsage = estimateUsageCostUsd(runStats.totalUsage);
      const estimatedCostUsdTotal = estimatedCostUsdFromTotalUsage ?? roundEstimatedCostUsdTotal;
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

      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
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
        { headers },
      );

      logger.info(statsLine, {
        requestId: headers.request_id,
        sessionId: headers.session_id,
        turns: turnEndCount,
        estimatedCostUsd: estimatedCostUsdTotal,
        costEstimateStatus: resolvedCostEstimateStatus,
        costEstimateReason: resolvedCostEstimateReason,
        estimatedCostTurnCoverage:
          turnEndCount > 0 ? roundEstimatedCostCount / turnEndCount : undefined,
      });

      logger.info("agent run resolved", {
        requestId: headers.request_id,
        sessionId: headers.session_id,
        durationMs: Date.now() - runStartedAt,
        finalTextChars: finalText.length,
        turns: turnEndCount,
        estimatedCostUsd: estimatedCostUsdTotal,
        costEstimateStatus: resolvedCostEstimateStatus,
        costEstimateReason: resolvedCostEstimateReason,
      });
    } catch (e) {
      runIdleWatchdog?.stop();

      if (activeCustomCommandTool) {
        const { toolCallId, display } = activeCustomCommandTool;
        activeCustomCommandTool = null;
        await bus
          .publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId,
              status: "end",
              display,
              ok: false,
              error:
                e instanceof PreAgentRunCancelledError
                  ? "cancelled by interrupt"
                  : e instanceof Error
                    ? e.message
                    : String(e),
            },
            { headers },
          )
          .catch(() => undefined);
      }

      const timedOutOperation = getActiveRunOperation();
      if (
        (e instanceof AgentIdleTimeoutError || e instanceof PreAgentRunCancelledError) &&
        timedOutOperation
      ) {
        const settled = await Promise.race([
          timedOutOperation.then(
            () => true,
            () => true,
          ),
          Bun.sleep(AGENT_TIMEOUT_ABORT_GRACE_MS).then(() => false),
        ]);
        if (!settled) {
          logger.warn("agent operation did not settle after cancellation grace period", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            reason: e instanceof AgentIdleTimeoutError ? "idle_timeout" : "cancelled",
            abortGraceMs: AGENT_TIMEOUT_ABORT_GRACE_MS,
          });
        }
      }

      if (e instanceof RestartDrainingAbort) {
        preserveWorkflowClaim = true;
        if (workflowHint) {
          params.durableWorkflowStore?.releaseWorkflowRequestClaim(
            next.requestId,
            workflowRunnerOwnerId,
            Date.now(),
          );
        }
        logger.info("agent run interrupted for graceful restart", {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          durationMs: Date.now() - runStartedAt,
        });
        return;
      }

      if (e instanceof PreAgentRunCancelledError) {
        await liveParentSession?.cancelAll("parent request cancelled").catch(() => undefined);
        const finalText = "Cancelled.";
        await publishCurrentLifecycle({
          state: "cancelled",
          detail: "cancelled by interrupt",
          output: finalText,
        });
        await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, { finalText }, { headers });
        return;
      }

      const rawMsg = formatUnknownErrorForDisplay(e);
      const msg = maybeAppendWarningSummaryToUnclearError(
        rawMsg,
        summarizeCallWarnings(streamWarnings),
      );

      if (params.transcriptStore) {
        try {
          const finalMessagesForPersistence =
            runStats.finalMessages ?? activeAgent?.state.messages ?? [];
          const responseMessages = finalMessagesForPersistence.slice(responseStartIndex);
          const persistedMessages = (() => {
            if (isHeartbeatSessionId(headers.session_id)) {
              return buildPersistedHeartbeatMessages(`Error: ${msg}`);
            }

            return runProfile === "primary" ? responseMessages : finalMessagesForPersistence;
          })();

          params.transcriptStore.saveRequestTranscript({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            requestClient: headers.request_client,
            messages: persistedMessages,
            finalText: `Error: ${msg}`,
            modelLabel: resolvedModelLabel,
          });
        } catch (err) {
          logger.error(
            "failed to persist transcript after error",
            { requestId: headers.request_id, sessionId: headers.session_id },
            err,
          );
        }
      }

      await liveParentSession?.cancelAll(`parent run failed: ${msg}`).catch((err: unknown) => {
        logger.warn(
          "failed to cancel deferred subagents after parent failure",
          { requestId: headers.request_id, sessionId: headers.session_id },
          err,
        );
      });

      if (params.transcriptStore && isHeartbeatSessionId(headers.session_id)) {
        try {
          const finalMessagesForPersistence =
            runStats.finalMessages ?? activeAgent?.state.messages ?? [];
          const responseMessages = finalMessagesForPersistence.slice(responseStartIndex);

          persistHeartbeatSurfaceHandoffs({
            logger,
            transcriptStore: params.transcriptStore,
            requestId: headers.request_id,
            requestClient: headers.request_client,
            sessionId: headers.session_id,
            modelLabel: resolvedModelLabel,
            responseMessages,
          });
        } catch (err) {
          logger.error(
            "failed to persist heartbeat handoff transcripts after error",
            { requestId: headers.request_id, sessionId: headers.session_id },
            err,
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
      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: `Error: ${msg}` },
        { headers },
      );

      logger.error(
        "agent run failed",
        {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          durationMs: Date.now() - runStartedAt,
          model: resolvedModelLabel,
          ...extractAiErrorLogDetails(e),
        },
        e,
      );
    } finally {
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
      await liveParentSession?.close();
      state.agent = null;
      state.activeRequestId = null;
      state.activeRun = null;
      state.running = false;
      cancelledByRequestId.delete(headers.request_id);
      restartAbortRequestIds.delete(headers.request_id);
      drainSessionQueue(sessionId, state).catch((e: unknown) => {
        logger.error("drainSessionQueue failed", { sessionId }, e);
      });
    }
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
      active.push({
        requestId: run.requestId,
        requestClient: run.requestClient,
        runProfile: run.runProfile,
        phase: tools.length > 0 ? "tool" : run.started ? "model" : "preparing",
        runAgeMs: Math.max(0, now - run.startedAt),
        tools,
      });
    }
    return active;
  }

  return {
    beginDrain,
    getActiveLevel1Work,
    snapshotRecoverables,
    restoreRecoverables,
    stop: async () => {
      await stopSubscription();
      bySession.clear();
      forcedRecoveryByRequestId.clear();
      restartAbortRequestIds.clear();
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
  await params.bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state: params.state, detail: params.detail, ts: Date.now() },
    { headers: params.headers },
  );
}

function mergeQueuedForSameRequest(first: Enqueued, queue: Enqueued[]): ModelMessage[] {
  const merged: ModelMessage[] = [...first.messages];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    queue.splice(i, 1);
  }

  return merged;
}

function removeQueuedEntries(
  queue: Enqueued[],
  shouldRemove: (entry: Enqueued) => boolean,
): Enqueued[] {
  const removed: Enqueued[] = [];

  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (!shouldRemove(next)) {
      i += 1;
      continue;
    }

    removed.push(next);
    queue.splice(i, 1);
  }

  return removed;
}

async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
  cancelledByRequestId: Set<string>,
  activeRun: SessionQueue["activeRun"],
) {
  const merged = mergeToSingleUserMessage(entry.messages);
  const liveParent = activeRun?.liveParent;
  const notifyWaiters = activeRun?.notifyWaiters;
  const queueWhileIdle = (mode: "followUp" | "steer") => {
    if (mode === "steer") {
      agent.steer(merged);
    } else {
      agent.followUp(merged);
    }
    notifyWaiters?.();
  };

  const promptWhileIdle = () => {
    void agent.prompt(merged).catch(() => {
      notifyWaiters?.();
    });
    notifyWaiters?.();
  };

  const cancel = (() => {
    const raw = entry.raw;
    if (!raw || typeof raw !== "object") return false;
    const v = (raw as Record<string, unknown>)["cancel"];
    return v === true;
  })();

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
          cancelledByRequestId.add(entry.requestId);
          await liveParent?.cancelAll("parent request aborted");
          agent.abort();
          notifyWaiters?.();
          return;
        }
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return;
        }
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
      agent.steer(merged);
      notifyWaiters?.();
      return;
    }
    case "followUp": {
      agent.followUp(merged);
      notifyWaiters?.();
      return;
    }
    case "interrupt": {
      if (cancel) {
        cancelledByRequestId.add(entry.requestId);
        await liveParent?.cancelAll("parent request aborted");
        agent.abort();
        notifyWaiters?.();
        return;
      }
      await agent.interrupt(merged);
      notifyWaiters?.();
      return;
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      agent.followUp(merged);
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
