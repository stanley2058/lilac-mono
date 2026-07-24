import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

import type {
  AiSdkPiAgentEvent,
  TransformMessagesFn,
  TransformMessagesContext,
  TurnErrorHandler,
} from "./ai-sdk-pi-agent";
import { AiSdkPiAgent } from "./ai-sdk-pi-agent";
import { isLikelyContextOverflowError } from "./context-overflow";
import { ModelCapability, type JSONObject, type ModelSpecifier } from "@stanley2058/lilac-utils";

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const suffix = "\n...[truncated for compaction]";
  const kept = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, kept)}${suffix}`;
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((p) => ({ ...p }))
        : message.content,
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  return { ...message };
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(cloneMessage);
}

function getAssistantToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-call" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function getAssistantToolCallPartCount(message: ModelMessage): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.filter((part) => part.type === "tool-call").length;
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool") return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-result" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function isValidSuffix(messages: readonly ModelMessage[], startIndex: number): boolean {
  let openToolCallIds: Set<string> | null = null;

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === "assistant") {
      if (openToolCallIds) return false;

      const toolCallIds = getAssistantToolCallIds(message);
      if (getAssistantToolCallPartCount(message) !== toolCallIds.length) return false;
      if (new Set(toolCallIds).size !== toolCallIds.length) return false;
      if (toolCallIds.length > 0) openToolCallIds = new Set(toolCallIds);
      continue;
    }

    if (message.role === "tool") {
      if (!openToolCallIds) return false;

      const resultIds = getToolResultToolCallIds(message);
      if (resultIds.length === 0) return false;
      for (const id of resultIds) {
        if (!openToolCallIds.delete(id)) return false;
      }
      if (openToolCallIds.size === 0) openToolCallIds = null;
      continue;
    }

    if (openToolCallIds) return false;
  }

  return openToolCallIds === null;
}

function isCutBoundaryMessage(message: ModelMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

function stringifyForTokenEstimate(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const record = item as Record<string, unknown>;
      return record["type"] === "file" ? { ...record, data: "[inline media payload]" } : item;
    });
    return serialized ?? stringifyUnknown(value);
  } catch {
    return stringifyUnknown(value);
  }
}

function estimateMessageTokens(message: ModelMessage): number {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    return estimateTokensFromText(stringifyForTokenEstimate(message.content));
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    let text = "";
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) {
        text += stringifyUnknown(part);
        continue;
      }

      const record = part as Record<string, unknown>;

      const type = getString(record["type"]);
      if (type === "text" || type === "reasoning") {
        text += getString(record["text"]) ?? stringifyUnknown(part);
        continue;
      }

      if (type === "tool-call") {
        const toolName = getString(record["toolName"]) ?? "unknown";
        const toolCallId = getString(record["toolCallId"]) ?? "unknown";
        text += `TOOL_CALL ${toolName} id=${toolCallId} ${stringifyUnknown(record["input"])}\n`;
        continue;
      }

      text += stringifyForTokenEstimate(part);
    }
    return estimateTokensFromText(text);
  }

  if (message.role === "tool") {
    return estimateTokensFromText(stringifyForTokenEstimate(message.content));
  }

  return estimateTokensFromText(stringifyForTokenEstimate(message));
}

function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

function inlineMediaStorageBytes(messages: readonly ModelMessage[]): number {
  const seen = new WeakSet<object>();
  const dataBytes = (value: unknown): number => {
    if (typeof value === "string") return Buffer.byteLength(value, "utf8");
    if (value instanceof Uint8Array) return value.byteLength;
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    const record = value as Record<string, unknown>;
    return record["type"] === "data" ? dataBytes(record["data"]) : 0;
  };
  const visit = (value: unknown): number => {
    if (!value || typeof value !== "object") return 0;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) return value.reduce((total, item) => total + visit(item), 0);

    const record = value as Record<string, unknown>;
    if (record["type"] === "file") return dataBytes(record["data"]);
    return Object.values(record).reduce<number>((total, item) => total + visit(item), 0);
  };

  return messages.reduce((total, message) => total + visit(message), 0);
}

type RepairTranscriptResult = {
  messages: ModelMessage[];
  droppedDanglingToolCallParts: number;
  droppedOrphanToolResultParts: number;
  droppedEmptyAssistantMessages: number;
  droppedEmptyToolMessages: number;
};

function repairTranscriptForCompaction(messages: readonly ModelMessage[]): RepairTranscriptResult {
  const repaired: ModelMessage[] = [];
  let droppedDanglingToolCallParts = 0;
  let droppedOrphanToolResultParts = 0;
  let droppedEmptyAssistantMessages = 0;
  let droppedEmptyToolMessages = 0;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    const toolCallIds = getAssistantToolCallIds(message);
    const toolCallPartCount = getAssistantToolCallPartCount(message);

    if (message.role === "assistant" && Array.isArray(message.content) && toolCallPartCount > 0) {
      let toolBlockEnd = messageIndex + 1;
      while (messages[toolBlockEnd]?.role === "tool") toolBlockEnd += 1;

      const uniqueToolCallIds = new Set(toolCallIds);
      const matchedToolCallIds = new Set<string>();
      for (let toolIndex = messageIndex + 1; toolIndex < toolBlockEnd; toolIndex++) {
        const toolMessage = messages[toolIndex]!;
        for (const resultId of getToolResultToolCallIds(toolMessage)) {
          if (uniqueToolCallIds.has(resultId)) matchedToolCallIds.add(resultId);
        }
      }

      const retainedToolCallIds = new Set<string>();
      const assistantContent = message.content.filter((part) => {
        const candidate = part as { type?: unknown; toolCallId?: unknown };
        if (candidate.type !== "tool-call") return true;
        if (
          typeof candidate.toolCallId === "string" &&
          matchedToolCallIds.has(candidate.toolCallId) &&
          !retainedToolCallIds.has(candidate.toolCallId)
        ) {
          retainedToolCallIds.add(candidate.toolCallId);
          return true;
        }
        droppedDanglingToolCallParts += 1;
        return false;
      });

      if (assistantContent.length > 0) {
        repaired.push({ ...message, content: assistantContent.map((part) => ({ ...part })) });
      } else {
        droppedEmptyAssistantMessages += 1;
      }

      const retainedResultIds = new Set<string>();
      for (let toolIndex = messageIndex + 1; toolIndex < toolBlockEnd; toolIndex++) {
        const toolMessage = messages[toolIndex]!;
        if (toolMessage.role !== "tool") continue;

        let retainedResults = 0;
        const toolContent = toolMessage.content.filter((part) => {
          const candidate = part as { type?: unknown; toolCallId?: unknown };
          if (candidate.type !== "tool-result") return true;
          if (
            typeof candidate.toolCallId === "string" &&
            retainedToolCallIds.has(candidate.toolCallId) &&
            !retainedResultIds.has(candidate.toolCallId)
          ) {
            retainedResultIds.add(candidate.toolCallId);
            retainedResults += 1;
            return true;
          }
          droppedOrphanToolResultParts += 1;
          return false;
        });

        if (retainedResults > 0) {
          repaired.push({ ...toolMessage, content: toolContent.map((part) => ({ ...part })) });
        } else {
          droppedEmptyToolMessages += 1;
        }
      }

      messageIndex = toolBlockEnd - 1;
      continue;
    }

    if (message.role === "tool") {
      for (const part of message.content) {
        const candidate = part as { type?: unknown };
        if (candidate.type === "tool-result") droppedOrphanToolResultParts += 1;
      }
      droppedEmptyToolMessages += 1;
      continue;
    }

    repaired.push(cloneMessage(message));
  }

  return {
    messages: repaired,
    droppedDanglingToolCallParts,
    droppedOrphanToolResultParts,
    droppedEmptyAssistantMessages,
    droppedEmptyToolMessages,
  };
}

function shrinkCompactedMessagesToBudget(params: {
  messages: readonly ModelMessage[];
  inputBudget: number;
}): ModelMessage[] {
  const budget = Math.max(1, params.inputBudget);
  const working = repairTranscriptForCompaction(params.messages).messages;
  const estimatedTokens = estimateMessagesTokens(working);
  if (estimatedTokens <= budget) return working;

  const summaryMessage = working[0];
  const retainedSuffix = working.slice(1);
  const retainedSuffixTokens = estimateMessagesTokens(retainedSuffix);
  if (retainedSuffixTokens >= budget) {
    throw new Error(
      `Compaction could not fit retained bounded context within the input budget (${retainedSuffixTokens} >= ${budget} estimated tokens); no retained suffix messages were discarded.`,
    );
  }

  if (
    !summaryMessage ||
    (summaryMessage.role !== "user" && summaryMessage.role !== "assistant") ||
    typeof summaryMessage.content !== "string"
  ) {
    throw new Error(
      `Compaction could not fit bounded context within the input budget (${estimatedTokens} > ${budget} estimated tokens).`,
    );
  }

  const availableSummaryTokens = budget - retainedSuffixTokens;
  const shrunkSummary: ModelMessage = {
    ...summaryMessage,
    content: truncateText(summaryMessage.content, Math.max(1, availableSummaryTokens * 4)),
  };
  const compacted = [shrunkSummary, ...retainedSuffix];
  const compactedTokens = estimateMessagesTokens(compacted);
  if (compactedTokens > budget) {
    throw new Error(
      `Compaction could not fit bounded context within the input budget (${compactedTokens} > ${budget} estimated tokens).`,
    );
  }
  return compacted;
}

function chooseSuffixStartByMessageCount(
  messages: readonly ModelMessage[],
  keepLastMessages: number,
): number {
  const candidate = Math.max(0, messages.length - keepLastMessages);
  for (let start = candidate; start >= 0; start--) {
    if (!isValidSuffix(messages, start)) continue;
    const message = messages[start];
    if (!message) continue;
    if (!isCutBoundaryMessage(message)) continue;
    return start;
  }

  return 0;
}

function chooseSuffixStartByTokenBudget(
  messages: readonly ModelMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length === 0) return 0;
  if (keepRecentTokens <= 0) return 0;

  const validStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!isCutBoundaryMessage(message)) continue;
    if (!isValidSuffix(messages, i)) continue;
    validStarts.push(i);
  }
  if (validStarts.length === 0) return 0;

  let accumulated = 0;
  let target = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]!);
    if (accumulated >= keepRecentTokens) {
      target = i;
      break;
    }
  }

  if (accumulated < keepRecentTokens) {
    return 0;
  }

  for (const start of validStarts) {
    if (start >= target) return start;
  }

  return validStarts[validStarts.length - 1] ?? 0;
}

function findTurnStartIndex(messages: readonly ModelMessage[], suffixStart: number): number | null {
  for (let i = suffixStart - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return i;
  }
  return null;
}

type CompactionBoundary = {
  suffixStart: number;
  splitTurnStart: number | null;
};

function resolveCompactionBoundary(params: {
  messages: readonly ModelMessage[];
  keepRecentTokens: number;
  keepLastMessages: number;
}): CompactionBoundary {
  const tokenStart = chooseSuffixStartByTokenBudget(params.messages, params.keepRecentTokens);
  const suffixStart =
    tokenStart > 0
      ? tokenStart
      : chooseSuffixStartByMessageCount(params.messages, params.keepLastMessages);

  if (suffixStart <= 0) {
    return {
      suffixStart: 0,
      splitTurnStart: null,
    };
  }

  const cutMessage = params.messages[suffixStart];
  const splitTurnStart =
    cutMessage?.role === "assistant" ? findTurnStartIndex(params.messages, suffixStart) : null;

  return {
    suffixStart,
    splitTurnStart,
  };
}

function renderMessageForSummary(message: ModelMessage): string {
  if (message.role === "user") {
    const content =
      typeof message.content === "string" ? message.content : stringifyUnknown(message.content);
    return `USER:\n${content}`;
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return `ASSISTANT:\n${message.content}`;
    }

    const lines: string[] = [];
    for (const part of message.content) {
      if (typeof part === "object" && part !== null) {
        const record = part as Record<string, unknown>;
        const type = getString(record["type"]);

        if (type === "text" || type === "reasoning") {
          const text = getString(record["text"]);
          if (text) {
            lines.push(text);
            continue;
          }
        }

        if (type === "tool-call") {
          const toolName = getString(record["toolName"]);
          const toolCallId = getString(record["toolCallId"]);
          if (toolName && toolCallId) {
            lines.push(
              `TOOL_CALL ${toolName} id=${toolCallId}: ${stringifyUnknown(record["input"])}`,
            );
            continue;
          }
        }
      }

      lines.push(stringifyUnknown(part));
    }

    return `ASSISTANT:\n${lines.join("\n")}`;
  }

  if (message.role === "tool") {
    const lines: string[] = [];
    for (const part of message.content) {
      if (typeof part === "object" && part !== null) {
        const record = part as Record<string, unknown>;
        const type = getString(record["type"]);
        if (type === "tool-result") {
          const toolName = getString(record["toolName"]);
          const toolCallId = getString(record["toolCallId"]);
          if (toolName && toolCallId) {
            lines.push(
              `TOOL_RESULT ${toolName} id=${toolCallId}: ${stringifyUnknown(record["output"])}`,
            );
            continue;
          }
        }
      }

      lines.push(stringifyUnknown(part));
    }

    return `TOOL:\n${lines.join("\n")}`;
  }

  return `${String((message as { role?: unknown }).role ?? "UNKNOWN").toUpperCase()}:\n${stringifyUnknown(message)}`;
}

function renderMessagesForSummary(
  messages: readonly ModelMessage[],
  _options: {
    maxCharsPerMessage: number;
    maxCharsTotal: number;
  },
): string {
  const separator = "\n\n---\n\n";
  return messages.map((message) => renderMessageForSummary(message)).join(separator);
}

function renderMessagesForSummarySegments(
  messages: readonly ModelMessage[],
  options: {
    maxCharsPerMessage: number;
    maxCharsTotal: number;
  },
): string[] {
  const segmentLimit = Math.max(100, Math.min(options.maxCharsPerMessage, options.maxCharsTotal));
  const payloadLimit = Math.max(1, segmentLimit - 80);
  const segments: string[] = [];

  for (const message of messages) {
    const rendered = renderMessageForSummary(message);
    if (rendered.length <= segmentLimit) {
      segments.push(rendered);
      continue;
    }

    const segmentCount = Math.ceil(rendered.length / payloadLimit);
    for (let index = 0; index < segmentCount; index++) {
      const payload = rendered.slice(index * payloadLimit, (index + 1) * payloadLimit);
      segments.push(`[message continuation ${index + 1}/${segmentCount}]\n${payload}`);
    }
  }

  return segments;
}

async function summarizePrompt(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  providerOptions?: { [x: string]: JSONObject };
  abortSignal?: AbortSignal;
}): Promise<string> {
  const res = streamText({
    model: options.model,
    instructions: options.system,
    messages: [{ role: "user", content: options.prompt }],
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
  });

  return await res.text;
}

function chunkMessagesByEstimatedTokens(
  messages: readonly ModelMessage[],
  chunkTokenBudget: number,
): ModelMessage[][] {
  const budget = Math.max(1, chunkTokenBudget);
  const chunks: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const tokens = Math.max(1, estimateMessageTokens(message));
    if (current.length > 0 && currentTokens + tokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function summarizeMessagesHierarchical(options: {
  messages: readonly ModelMessage[];
  initialChunkTokenBudget: number;
  maxReductionPasses: number;
  initialMaxCharsPerMessage: number;
  initialMaxCharsTotal: number;
  summarizeChunk: (
    transcriptText: string,
    previousSummary: string | null,
    abortSignal?: AbortSignal,
  ) => Promise<string>;
  abortSignal?: AbortSignal;
}): Promise<string> {
  let budget = Math.max(1, options.initialChunkTokenBudget);
  let maxCharsPerMessage = Math.max(200, options.initialMaxCharsPerMessage);
  let maxCharsTotal = Math.max(500, options.initialMaxCharsTotal);

  const maxPasses = Math.max(1, options.maxReductionPasses);
  let lastError: unknown;

  for (let pass = 0; pass < maxPasses; pass++) {
    try {
      const chunks = chunkMessagesByEstimatedTokens(options.messages, budget);
      let summary: string | null = null;

      for (const chunk of chunks) {
        const transcriptSegments = renderMessagesForSummarySegments(chunk, {
          maxCharsPerMessage,
          maxCharsTotal,
        });
        for (const transcriptText of transcriptSegments) {
          if (!transcriptText.trim()) continue;
          summary = await options.summarizeChunk(transcriptText, summary, options.abortSignal);
        }
      }

      return (summary ?? "").trim();
    } catch (error) {
      lastError = error;
      if (!isLikelyContextOverflowError(error)) {
        throw error;
      }
      budget = Math.max(1, Math.floor(budget * 0.6));
      maxCharsPerMessage = Math.max(200, Math.floor(maxCharsPerMessage * 0.7));
      maxCharsTotal = Math.max(500, Math.floor(maxCharsTotal * 0.7));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Compaction summarization failed after recursive chunk retries.");
}

const DEFAULT_THRESHOLD_FRACTION = 0.8;
const DEFAULT_KEEP_LAST_MESSAGES = 30;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_SUMMARY_CHUNK_FRACTION = 0.35;
const DEFAULT_SUMMARY_REDUCTION_PASSES = 6;
const DEFAULT_OVERFLOW_RECOVERY_MAX_ATTEMPTS = 2;
const DEFAULT_RESERVED_OUTPUT_FRACTION = 0.2;
const DEFAULT_RESERVED_OUTPUT_MIN_TOKENS = 1_024;
const DEFAULT_COMPACTION_MAX_PASSES = 4;
const DEFAULT_SUMMARY_MAX_CHARS_FLOOR = 2_000;

export type CompactionBudget = {
  inputBudget: number;
  safeInputBudget: number;
  earlyInputBudget: number;
  reservedOutputTokens: number;
};

type InputCompactionBudget = CompactionBudget;

function normalizeThresholdFraction(thresholdFraction?: number): number {
  if (thresholdFraction === undefined || Number.isNaN(thresholdFraction)) {
    return DEFAULT_THRESHOLD_FRACTION;
  }
  return Math.max(0.05, Math.min(0.95, thresholdFraction));
}

type ResolvedContextWindow =
  | {
      known: true;
      spec: ModelSpecifier;
      contextLimit: number;
      outputLimit: number;
    }
  | {
      known: false;
      spec: ModelSpecifier;
      reason: "capability_unresolved" | "invalid_context_limit";
      error?: unknown;
    };

type CompactionScheduleReason = "threshold" | "overflow";

type AutoCompactionObservedBudget = {
  inputBudget: number;
  safeInputBudget: number;
  reservedOutputTokens: number;
};

type AutoCompactionStartEvent = {
  spec: ModelSpecifier;
  reason: CompactionScheduleReason;
  messageCountBefore: number;
  estimatedInputTokens: number;
  budget: AutoCompactionObservedBudget;
};

type AutoCompactionEndEvent = AutoCompactionStartEvent & {
  durationMs: number;
  messageCountAfter?: number;
  estimatedInputTokensAfter?: number;
  status: "completed" | "failed";
  error?: unknown;
};

function reconcilePendingCompactionReason(params: {
  pendingReason: CompactionScheduleReason | null;
  capabilityKnown: boolean;
}): CompactionScheduleReason | null {
  if (!params.capabilityKnown && params.pendingReason === "threshold") {
    return null;
  }
  return params.pendingReason;
}

function computeInputCompactionBudget(params: {
  contextLimit: number;
  outputLimit: number;
  thresholdFraction: number;
}): InputCompactionBudget {
  const contextLimit = Math.max(1, Math.floor(params.contextLimit));
  const boundedThreshold = normalizeThresholdFraction(params.thresholdFraction);
  const earlyInputBudget = Math.max(1, Math.floor(contextLimit * boundedThreshold));

  const reservedOutputFallback = Math.max(
    DEFAULT_RESERVED_OUTPUT_MIN_TOKENS,
    Math.floor(contextLimit * DEFAULT_RESERVED_OUTPUT_FRACTION),
  );
  const reservedOutputFromLimit =
    params.outputLimit > 0 && params.outputLimit < contextLimit
      ? Math.max(256, Math.floor(params.outputLimit))
      : 0;
  const reservedOutputTokens = Math.min(
    Math.max(1, contextLimit - 1),
    Math.max(reservedOutputFallback, reservedOutputFromLimit),
  );

  const safeInputBudget = Math.max(1, contextLimit - reservedOutputTokens);
  const inputBudget = Math.max(1, Math.min(safeInputBudget, earlyInputBudget));

  return {
    inputBudget,
    safeInputBudget,
    earlyInputBudget,
    reservedOutputTokens,
  };
}

function computeUnknownOverflowCompactionBudget(params: {
  estimatedInputTokens: number;
  lastTurnInputTokens: number | null;
  overflowAttempt: number;
}): InputCompactionBudget {
  const estimated = Math.max(1, Math.floor(params.estimatedInputTokens));
  const lastTurnTokens =
    typeof params.lastTurnInputTokens === "number" && params.lastTurnInputTokens > 0
      ? Math.floor(params.lastTurnInputTokens)
      : 0;
  const baseline = Math.max(estimated, lastTurnTokens);

  const attempt = Math.max(1, Math.floor(params.overflowAttempt));
  const reductionFactor = Math.max(0.2, 0.7 - (attempt - 1) * 0.15);
  const inputBudget = Math.max(256, Math.floor(baseline * reductionFactor));

  return {
    inputBudget,
    safeInputBudget: inputBudget,
    earlyInputBudget: inputBudget,
    reservedOutputTokens: 0,
  };
}

const AUTO_CONTINUE_AFTER_COMPACTION_TEXT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

const DEFAULT_SUMMARY_SYSTEM =
  "You are preparing a handoff summary for another coding agent. Output only the requested summary in markdown.";

const DEFAULT_SUMMARY_PROMPT = (prefix: string) =>
  [
    "Provide a detailed prompt for continuing our conversation.",
    "Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.",
    "The summary that you construct will be used so that another agent can read it and continue the work.",
    "",
    "When constructing the summary, try to stick to this template:",
    "---",
    "## Goal",
    "",
    "[What goal(s) is the user trying to accomplish?]",
    "",
    "## Instructions",
    "",
    "- [What important instructions did the user give you that are relevant]",
    "- [If there is a plan or spec, include information about it so next agent can continue using it]",
    "",
    "## Discoveries",
    "",
    "[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]",
    "",
    "## Accomplished",
    "",
    "[What work has been completed, what work is still in progress, and what work is left?]",
    "",
    "## Relevant files / directories",
    "",
    "[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]",
    "---",
    "",
    "TRANSCRIPT:",
    prefix,
  ].join("\n");

const DEFAULT_SUMMARY_UPDATE_PROMPT = (previousSummary: string, nextTranscript: string) =>
  [
    "You are updating an existing handoff summary with NEW transcript content.",
    "Preserve existing relevant context and integrate the new details.",
    "",
    "<previous-summary>",
    previousSummary,
    "</previous-summary>",
    "",
    "<new-transcript>",
    nextTranscript,
    "</new-transcript>",
    "",
    "Return one updated summary following the same markdown handoff structure as before.",
  ].join("\n");

const DEFAULT_SPLIT_TURN_PROMPT = (prefix: string) =>
  [
    "The following is the EARLY prefix of a single large turn.",
    "Summarize only the context needed to understand the later retained suffix.",
    "",
    "Use this format:",
    "## Original Request",
    "## Early Progress",
    "## Context for Suffix",
    "",
    "TRANSCRIPT:",
    prefix,
  ].join("\n");

const DEFAULT_SPLIT_TURN_UPDATE_PROMPT = (previousSummary: string, nextTranscript: string) =>
  [
    "You are updating a split-turn prefix summary with additional transcript content.",
    "Preserve details already captured and merge in new details.",
    "",
    "Maintain this output format:",
    "## Original Request",
    "## Early Progress",
    "## Context for Suffix",
    "",
    "<previous-summary>",
    previousSummary,
    "</previous-summary>",
    "",
    "<new-transcript>",
    nextTranscript,
    "</new-transcript>",
  ].join("\n");

function buildCompactionSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: [
      "<context-compaction>",
      "The conversation before this point was automatically compacted.",
      "Treat this summary as prior conversation context, not as a new user request.",
      "",
      summary,
      "</context-compaction>",
    ].join("\n"),
  };
}

type OverflowRecoveryDecision = {
  recover: boolean;
  nextAttempts: number;
  terminalError?: Error;
};

function computeOverflowRecoveryDecision(params: {
  error: unknown;
  attempts: number;
  maxAttempts: number;
  aborted: boolean;
}): OverflowRecoveryDecision {
  if (!isLikelyContextOverflowError(params.error)) {
    return {
      recover: false,
      nextAttempts: params.attempts,
    };
  }

  if (params.aborted) {
    return {
      recover: false,
      nextAttempts: params.attempts,
    };
  }

  if (params.attempts >= params.maxAttempts) {
    return {
      recover: false,
      nextAttempts: params.attempts,
      terminalError: new Error(
        `Context overflow recovery failed after ${params.maxAttempts} compaction attempt(s).`,
      ),
    };
  }

  return {
    recover: true,
    nextAttempts: params.attempts + 1,
  };
}

export type AutoCompactionOptions = {
  /** Canonical fallback model identifier in `provider/modelstring` format. */
  model: ModelSpecifier;

  /** Determines model context windows. */
  modelCapability: ModelCapability;

  /** Legacy fallback. How many trailing messages to always keep (default: 30). */
  keepLastMessages?: number;

  /** Preferred budget. Keep approximately this many recent tokens (default: 20k). */
  keepRecentTokens?: number;

  /** Compact at this fraction of the context window, clamped to 0.05-0.95 (default: 0.8). */
  thresholdFraction?: number;

  /**
   * The model used to generate summaries.
   *
   * - `current`: use the agent's current `state.model`.
   * - a model instance: use that for summarization.
   */
  summaryModel?: "current" | LanguageModel;

  /** Override summary system prompt. */
  summarySystem?: string;

  /** Builds initial summary prompt from transcript text. */
  buildSummaryPrompt?: (prefix: string) => string;

  /** Builds update prompt from previous summary + new transcript chunk. */
  buildSummaryUpdatePrompt?: (previousSummary: string, nextTranscript: string) => string;

  /** Builds split-turn prompt from split-turn prefix transcript. */
  buildSplitTurnSummaryPrompt?: (splitTurnPrefix: string) => string;

  /** Optional explicit current-model spec resolver (for mid-run model switches). */
  resolveCurrentModelSpecifier?: () =>
    | ModelSpecifier
    | null
    | undefined
    | Promise<ModelSpecifier | null | undefined>;

  /** Optional limit resolver. Numeric results use a conservative output-token fallback. */
  resolveContextLimit?: (params: {
    defaultModel: ModelSpecifier;
    currentModelSpecifier?: ModelSpecifier;
    currentModel: LanguageModel;
    modelCapability: ModelCapability;
    abortSignal?: AbortSignal;
  }) => Promise<number | { readonly context: number; readonly output: number }>;

  /** Optional base transform to run before compaction. */
  baseTransformMessages?: TransformMessagesFn;

  /** Optional base turn error handler to chain before overflow recovery logic. */
  baseTurnErrorHandler?: TurnErrorHandler;

  /** Maximum overflow recovery attempts per active run (default: 2). */
  overflowRecoveryMaxAttempts?: number;

  /** Enable/disable (default: true). */
  enabled?: boolean;

  /** Optional hook for observability when model capability is unknown. */
  onUnknownCapability?: (params: {
    spec: ModelSpecifier;
    reason: "capability_unresolved" | "invalid_context_limit";
    error?: unknown;
  }) => void;

  /** Optional hook for observability when overflow recovery retries. */
  onOverflowRecoveryAttempt?: (params: {
    spec: ModelSpecifier;
    attempt: number;
    maxAttempts: number;
  }) => void;

  /** Optional hook for observability when overflow recovery is exhausted. */
  onOverflowRecoveryExhausted?: (params: {
    spec: ModelSpecifier;
    attempts: number;
    maxAttempts: number;
  }) => void;

  /** Optional hook for observability when compaction starts. */
  onCompactionStart?: (params: AutoCompactionStartEvent) => void;

  /** Optional hook for observability when compaction completes or fails. */
  onCompactionEnd?: (params: AutoCompactionEndEvent) => void;
};

export type ManualCompactionOptions = {
  /** Idle persisted transcript to compact. The input array is not mutated. */
  messages: readonly ModelMessage[];

  /** Model currently associated with the transcript. */
  currentModel: LanguageModel;

  /** Current model context-window limit. */
  contextLimit: number;

  /** Current model output limit, used to reserve response capacity. */
  outputLimit?: number;

  /** Compact to this fraction of the context window, clamped to 0.05-0.95 (default: 0.8). */
  thresholdFraction?: number;

  /** Legacy fallback. How many trailing messages to always keep (default: 30). */
  keepLastMessages?: number;

  /** Preferred budget. Keep approximately this many recent tokens (default: 20k). */
  keepRecentTokens?: number;

  /** Summary model. `current` uses `currentModel` (default: `current`). */
  summaryModel?: "current" | LanguageModel;

  /** Provider-specific options forwarded to summary model calls. */
  providerOptions?: { [x: string]: JSONObject };

  /** Override summary system prompt. */
  summarySystem?: string;

  /** Builds initial summary prompt from transcript text. */
  buildSummaryPrompt?: (prefix: string) => string;

  /** Builds update prompt from previous summary + new transcript chunk. */
  buildSummaryUpdatePrompt?: (previousSummary: string, nextTranscript: string) => string;

  /** Builds split-turn prompt from split-turn prefix transcript. */
  buildSplitTurnSummaryPrompt?: (splitTurnPrefix: string) => string;

  abortSignal?: AbortSignal;
};

type ManualCompactionMetrics = {
  messages: ModelMessage[];
  messageCountBefore: number;
  messageCountAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  budget: CompactionBudget;
};

export type ManualCompactionResult =
  | (ManualCompactionMetrics & {
      status: "compacted";
    })
  | (ManualCompactionMetrics & {
      status: "noop";
      reason: "empty" | "no-compactable-messages";
    });

type CompactRepairedMessagesOptions = {
  messages: readonly ModelMessage[];
  budget: InputCompactionBudget;
  summaryContextLimit: number;
  model: LanguageModel;
  providerOptions?: { [x: string]: JSONObject };
  keepLastMessages: number;
  keepRecentTokens: number;
  summarySystem: string;
  buildSummaryPrompt: (prefix: string) => string;
  buildSummaryUpdatePrompt: (previousSummary: string, nextTranscript: string) => string;
  buildSplitTurnSummaryPrompt: (splitTurnPrefix: string) => string;
  abortSignal?: AbortSignal;
};

async function compactRepairedMessages(
  options: CompactRepairedMessagesOptions,
): Promise<ModelMessage[] | null> {
  const maxCompactionPasses = DEFAULT_COMPACTION_MAX_PASSES;
  let passKeepRecentTokens = Math.max(
    1,
    Math.min(options.keepRecentTokens, options.budget.inputBudget),
  );
  let passKeepLastMessages = Math.max(1, options.keepLastMessages);
  let compactedCandidate: ModelMessage[] | null = null;

  for (let pass = 0; pass < maxCompactionPasses; pass++) {
    const boundary = resolveCompactionBoundary({
      messages: options.messages,
      keepRecentTokens: passKeepRecentTokens,
      keepLastMessages: passKeepLastMessages,
    });

    const historyEnd =
      boundary.suffixStart <= 0
        ? options.messages.length
        : (boundary.splitTurnStart ?? boundary.suffixStart);
    const historyMessages = options.messages.slice(0, historyEnd);
    const splitTurnPrefixMessages =
      boundary.suffixStart > 0 && boundary.splitTurnStart !== null
        ? options.messages.slice(boundary.splitTurnStart, boundary.suffixStart)
        : [];
    const suffixMessages =
      boundary.suffixStart > 0 ? options.messages.slice(boundary.suffixStart) : [];

    if (historyMessages.length === 0 && splitTurnPrefixMessages.length === 0) {
      break;
    }

    const passScale = Math.pow(0.7, pass);
    const chunkTokenBudget = Math.max(
      1,
      Math.floor(options.summaryContextLimit * DEFAULT_SUMMARY_CHUNK_FRACTION * passScale),
    );
    const summaryMaxChars = Math.max(
      DEFAULT_SUMMARY_MAX_CHARS_FLOOR,
      Math.floor(options.budget.inputBudget * 4 * passScale),
    );

    const summarizeMainHistory = async (): Promise<string> => {
      if (historyMessages.length === 0) return "";

      const text = await summarizeMessagesHierarchical({
        messages: historyMessages,
        initialChunkTokenBudget: chunkTokenBudget,
        maxReductionPasses: DEFAULT_SUMMARY_REDUCTION_PASSES,
        initialMaxCharsPerMessage: Math.max(2_000, chunkTokenBudget * 4),
        initialMaxCharsTotal: Math.max(4_000, chunkTokenBudget * 6),
        summarizeChunk: async (transcriptText, previousSummary, abortSignal) => {
          const prompt = previousSummary
            ? options.buildSummaryUpdatePrompt(previousSummary, transcriptText)
            : options.buildSummaryPrompt(transcriptText);
          return await summarizePrompt({
            model: options.model,
            system: options.summarySystem,
            prompt,
            providerOptions: options.providerOptions,
            abortSignal,
          });
        },
        abortSignal: options.abortSignal,
      });

      return text.trim();
    };

    const summarizeSplitTurnPrefix = async (): Promise<string> => {
      if (splitTurnPrefixMessages.length === 0) return "";

      const text = await summarizeMessagesHierarchical({
        messages: splitTurnPrefixMessages,
        initialChunkTokenBudget: Math.max(1, Math.floor(chunkTokenBudget * 0.7)),
        maxReductionPasses: DEFAULT_SUMMARY_REDUCTION_PASSES,
        initialMaxCharsPerMessage: Math.max(1_500, Math.floor(chunkTokenBudget * 3)),
        initialMaxCharsTotal: Math.max(3_000, Math.floor(chunkTokenBudget * 5)),
        summarizeChunk: async (transcriptText, previousSummary, abortSignal) => {
          const prompt = previousSummary
            ? DEFAULT_SPLIT_TURN_UPDATE_PROMPT(previousSummary, transcriptText)
            : options.buildSplitTurnSummaryPrompt(transcriptText);
          return await summarizePrompt({
            model: options.model,
            system: options.summarySystem,
            prompt,
            providerOptions: options.providerOptions,
            abortSignal,
          });
        },
        abortSignal: options.abortSignal,
      });

      return text.trim();
    };

    const [historySummary, splitTurnSummary] = await Promise.all([
      summarizeMainHistory(),
      summarizeSplitTurnPrefix(),
    ]);

    const summaryParts: string[] = [];
    if (historySummary) summaryParts.push(historySummary);
    if (splitTurnSummary) {
      summaryParts.push(`**Turn Context (split turn):**\n\n${splitTurnSummary}`);
    }

    let finalSummary = summaryParts.join("\n\n---\n\n").trim();
    if (!finalSummary) {
      throw new Error("Compaction summarization returned no summary for selected transcript.");
    }

    finalSummary = truncateText(finalSummary, summaryMaxChars);
    const summaryMessage = buildCompactionSummaryMessage(finalSummary);
    const passCompacted = repairTranscriptForCompaction([
      summaryMessage,
      ...suffixMessages,
    ]).messages;
    compactedCandidate = passCompacted;

    if (estimateMessagesTokens(passCompacted) <= options.budget.inputBudget) {
      break;
    }

    passKeepRecentTokens = Math.max(1, Math.floor(passKeepRecentTokens * 0.6));
    passKeepLastMessages = Math.max(1, Math.floor(passKeepLastMessages * 0.8));
  }

  if (!compactedCandidate) return null;

  return shrinkCompactedMessagesToBudget({
    messages: compactedCandidate,
    inputBudget: options.budget.inputBudget,
  });
}

/**
 * Compact an idle persisted transcript without constructing an `AiSdkPiAgent`.
 * The input messages are never mutated; callers should persist `result.messages`.
 */
export async function compactMessages(
  options: ManualCompactionOptions,
): Promise<ManualCompactionResult> {
  const messageCountBefore = options.messages.length;
  const estimatedTokensBefore = estimateMessagesTokens(options.messages);
  const budget = computeInputCompactionBudget({
    contextLimit: options.contextLimit,
    outputLimit: options.outputLimit ?? 0,
    thresholdFraction: normalizeThresholdFraction(options.thresholdFraction),
  });
  const noop = (reason: "empty" | "no-compactable-messages"): ManualCompactionResult => {
    const messages = cloneMessages(options.messages);
    return {
      status: "noop",
      reason,
      messages,
      messageCountBefore,
      messageCountAfter: messages.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimateMessagesTokens(messages),
      budget,
    };
  };

  if (options.messages.length === 0) return noop("empty");

  const compactableMessages = repairTranscriptForCompaction(options.messages).messages;
  if (compactableMessages.length === 0) return noop("no-compactable-messages");

  const summaryModel = options.summaryModel ?? "current";
  const compacted = await compactRepairedMessages({
    messages: compactableMessages,
    budget,
    summaryContextLimit: Math.max(1, options.contextLimit),
    model: summaryModel === "current" ? options.currentModel : summaryModel,
    providerOptions: options.providerOptions,
    keepLastMessages: options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES,
    keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    summarySystem: options.summarySystem ?? DEFAULT_SUMMARY_SYSTEM,
    buildSummaryPrompt: options.buildSummaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
    buildSummaryUpdatePrompt: options.buildSummaryUpdatePrompt ?? DEFAULT_SUMMARY_UPDATE_PROMPT,
    buildSplitTurnSummaryPrompt: options.buildSplitTurnSummaryPrompt ?? DEFAULT_SPLIT_TURN_PROMPT,
    abortSignal: options.abortSignal,
  });
  if (!compacted) return noop("no-compactable-messages");

  const messages = cloneMessages(compacted);
  return {
    status: "compacted",
    messages,
    messageCountBefore,
    messageCountAfter: messages.length,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessagesTokens(messages),
    budget,
  };
}

async function resolveContextLimit(params: {
  options: AutoCompactionOptions;
  agent: AiSdkPiAgent;
  abortSignal?: AbortSignal;
}): Promise<ResolvedContextWindow> {
  const resolvedSpecRaw = params.options.resolveCurrentModelSpecifier
    ? await params.options.resolveCurrentModelSpecifier()
    : params.agent.state.modelSpecifier;
  const spec = resolvedSpecRaw ?? params.options.model;

  if (params.options.resolveContextLimit) {
    const explicitLimits = await params.options.resolveContextLimit({
      defaultModel: params.options.model,
      currentModelSpecifier: spec,
      currentModel: params.agent.state.model,
      modelCapability: params.options.modelCapability,
      abortSignal: params.abortSignal,
    });
    const contextLimit =
      typeof explicitLimits === "number" ? explicitLimits : explicitLimits.context;
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
      return {
        known: false,
        spec,
        reason: "invalid_context_limit",
      };
    }
    return {
      known: true,
      spec,
      contextLimit,
      outputLimit:
        typeof explicitLimits !== "number" &&
        Number.isFinite(explicitLimits.output) &&
        explicitLimits.output > 0
          ? explicitLimits.output
          : 0,
    };
  }

  let modelInfo:
    | {
        limit: {
          context: number;
          output: number;
        };
      }
    | undefined;
  let modelResolveError: unknown;
  try {
    modelInfo = await params.options.modelCapability.resolve(spec, {
      signal: params.abortSignal,
    });
  } catch (error) {
    modelInfo = undefined;
    modelResolveError = error;
  }
  const outputLimit = modelInfo?.limit.output ?? 0;

  if (!modelInfo) {
    return {
      known: false,
      spec,
      reason: "capability_unresolved",
      error: modelResolveError,
    };
  }

  if (!(typeof modelInfo.limit.context === "number") || modelInfo.limit.context <= 0) {
    return {
      known: false,
      spec,
      reason: "invalid_context_limit",
    };
  }

  return {
    known: true,
    spec,
    contextLimit: modelInfo.limit.context,
    outputLimit,
  };
}

export async function attachAutoCompaction(
  agent: AiSdkPiAgent,
  options: AutoCompactionOptions,
): Promise<() => void> {
  if (options.enabled === false) return () => {};

  const thresholdFraction = normalizeThresholdFraction(options.thresholdFraction);
  const keepLastMessages = options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES;
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  const summaryModel = options.summaryModel ?? "current";
  const summarySystem = options.summarySystem ?? DEFAULT_SUMMARY_SYSTEM;
  const buildSummaryPrompt = options.buildSummaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
  const buildSummaryUpdatePrompt =
    options.buildSummaryUpdatePrompt ?? DEFAULT_SUMMARY_UPDATE_PROMPT;
  const buildSplitTurnSummaryPrompt =
    options.buildSplitTurnSummaryPrompt ?? DEFAULT_SPLIT_TURN_PROMPT;
  const overflowRecoveryMaxAttempts =
    options.overflowRecoveryMaxAttempts ?? DEFAULT_OVERFLOW_RECOVERY_MAX_ATTEMPTS;

  let pendingCompactionReason: CompactionScheduleReason | null = null;
  let inCompaction = false;
  let queuedAutoContinue = false;
  let overflowRecoveryAttempts = 0;
  let lastTurnInputTokens: number | null = null;

  const seenUnknownCapabilitySpecs = new Set<string>();

  const notifyUnknownCapability = (resolved: ResolvedContextWindow) => {
    if (resolved.known) return;
    if (seenUnknownCapabilitySpecs.has(resolved.spec)) return;
    seenUnknownCapabilitySpecs.add(resolved.spec);
    options.onUnknownCapability?.({
      spec: resolved.spec,
      reason: resolved.reason,
      error: resolved.error,
    });
  };

  const scheduleCompaction = (reason: CompactionScheduleReason) => {
    if (reason === "overflow") {
      pendingCompactionReason = "overflow";
      return;
    }

    if (!pendingCompactionReason) {
      pendingCompactionReason = "threshold";
    }
  };

  const initialLimit = await resolveContextLimit({
    options,
    agent,
  });
  notifyUnknownCapability(initialLimit);
  let currentCapability = initialLimit;

  const refreshContextLimit = async (abortSignal?: AbortSignal): Promise<ResolvedContextWindow> => {
    const resolved = await resolveContextLimit({
      options,
      agent,
      abortSignal,
    });
    currentCapability = resolved;
    notifyUnknownCapability(resolved);
    return resolved;
  };

  const evaluateThresholdWithBudget = (inputTokens: number, inputBudget: number): boolean => {
    if (!(inputBudget > 0)) return false;
    return inputTokens >= inputBudget;
  };

  const resolveKnownInputBudget = (): InputCompactionBudget | null => {
    if (!currentCapability.known) return null;
    return computeInputCompactionBudget({
      contextLimit: currentCapability.contextLimit,
      outputLimit: currentCapability.outputLimit,
      thresholdFraction,
    });
  };

  const resolveActiveCompactionBudget = (params: {
    capability: ResolvedContextWindow;
    reason: CompactionScheduleReason;
    estimatedInputTokens: number;
  }): InputCompactionBudget | null => {
    if (params.capability.known) {
      const budget = computeInputCompactionBudget({
        contextLimit: params.capability.contextLimit,
        outputLimit: params.capability.outputLimit,
        thresholdFraction,
      });
      if (params.reason !== "overflow" || overflowRecoveryAttempts <= 1) return budget;

      const progressiveFactor = Math.pow(0.75, overflowRecoveryAttempts - 1);
      return {
        ...budget,
        inputBudget: Math.max(1, Math.floor(budget.inputBudget * progressiveFactor)),
      };
    }

    if (params.reason !== "overflow") {
      return null;
    }

    return computeUnknownOverflowCompactionBudget({
      estimatedInputTokens: params.estimatedInputTokens,
      lastTurnInputTokens,
      overflowAttempt: overflowRecoveryAttempts,
    });
  };

  const turnErrorHandler: TurnErrorHandler = async (error, context) => {
    if (options.baseTurnErrorHandler) {
      const baseDecision = await options.baseTurnErrorHandler(error, context);
      if (baseDecision === "retry") return "retry";
    }

    if (!context.retrySafety.canRetry) return "fail";

    const decision = computeOverflowRecoveryDecision({
      error,
      attempts: overflowRecoveryAttempts,
      maxAttempts: overflowRecoveryMaxAttempts,
      aborted: context.abortSignal?.aborted === true,
    });

    if (!decision.recover) {
      if (decision.terminalError) {
        options.onOverflowRecoveryExhausted?.({
          spec: currentCapability.spec,
          attempts: overflowRecoveryAttempts,
          maxAttempts: overflowRecoveryMaxAttempts,
        });
        throw decision.terminalError;
      }
      return "fail";
    }

    overflowRecoveryAttempts = decision.nextAttempts;
    options.onOverflowRecoveryAttempt?.({
      spec: currentCapability.spec,
      attempt: overflowRecoveryAttempts,
      maxAttempts: overflowRecoveryMaxAttempts,
    });
    scheduleCompaction("overflow");
    queuedAutoContinue = false;
    return "retry";
  };

  const unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
    if (event.type !== "turn_end") return;

    overflowRecoveryAttempts = 0;

    const inputTokens = event.usage.inputTokens;
    if (typeof inputTokens !== "number" || inputTokens <= 0) {
      lastTurnInputTokens = null;
      return;
    }

    lastTurnInputTokens = inputTokens;

    const budget = resolveKnownInputBudget();
    if (!budget) return;
    if (!evaluateThresholdWithBudget(inputTokens, budget.inputBudget)) return;

    const wasCompactionPending = pendingCompactionReason !== null;
    scheduleCompaction("threshold");

    if (event.finishReason === "tool-calls") return;
    if (wasCompactionPending || queuedAutoContinue) return;

    agent.followUp(AUTO_CONTINUE_AFTER_COMPACTION_TEXT);
    queuedAutoContinue = true;
  });

  const transformMessages: TransformMessagesFn = async (
    messages,
    context: TransformMessagesContext,
  ) => {
    const canonicalMediaBytes = inlineMediaStorageBytes(messages);
    const maybeTransformed = options.baseTransformMessages
      ? await options.baseTransformMessages(messages, context)
      : [...messages];

    const latestCapability = await refreshContextLimit(context.abortSignal);
    pendingCompactionReason = reconcilePendingCompactionReason({
      pendingReason: pendingCompactionReason,
      capabilityKnown: latestCapability.known,
    });

    if (
      latestCapability.known &&
      pendingCompactionReason === null &&
      canonicalMediaBytes > inlineMediaStorageBytes(maybeTransformed)
    ) {
      scheduleCompaction("threshold");
      // Deliver the newest retained media once before compacting omitted historical media.
      return maybeTransformed;
    }

    if (
      latestCapability.known &&
      pendingCompactionReason === null &&
      lastTurnInputTokens !== null
    ) {
      const latestBudget = computeInputCompactionBudget({
        contextLimit: latestCapability.contextLimit,
        outputLimit: latestCapability.outputLimit,
        thresholdFraction,
      });
      if (evaluateThresholdWithBudget(lastTurnInputTokens, latestBudget.inputBudget)) {
        scheduleCompaction("threshold");
      }
    }

    if (!pendingCompactionReason || inCompaction) return maybeTransformed;

    const lastMessage =
      maybeTransformed.length > 0 ? maybeTransformed[maybeTransformed.length - 1] : undefined;

    // Be conservative: compact only when context ends with user/tool.
    if (lastMessage?.role === "assistant") return maybeTransformed;

    const repairedTranscript = repairTranscriptForCompaction(maybeTransformed);
    const compactableMessages = repairedTranscript.messages;
    if (compactableMessages.length === 0) return maybeTransformed;

    const activeBudget = resolveActiveCompactionBudget({
      capability: latestCapability,
      reason: pendingCompactionReason,
      estimatedInputTokens: estimateMessagesTokens(compactableMessages),
    });
    if (!activeBudget) return maybeTransformed;

    const compactionReason = pendingCompactionReason;
    const estimatedInputTokens = estimateMessagesTokens(compactableMessages);
    const compactionStart = Date.now();
    const compactionEventBase: AutoCompactionStartEvent = {
      spec: latestCapability.spec,
      reason: compactionReason,
      messageCountBefore: compactableMessages.length,
      estimatedInputTokens,
      budget: {
        inputBudget: activeBudget.inputBudget,
        safeInputBudget: activeBudget.safeInputBudget,
        reservedOutputTokens: activeBudget.reservedOutputTokens,
      },
    };

    inCompaction = true;
    try {
      options.onCompactionStart?.(compactionEventBase);
      queuedAutoContinue = false;

      const summaryContextLimit = latestCapability.known
        ? Math.max(1, latestCapability.contextLimit)
        : Math.max(2_048, Math.floor(activeBudget.inputBudget * 1.5));
      const compacted = await compactRepairedMessages({
        messages: compactableMessages,
        budget: activeBudget,
        summaryContextLimit,
        model: summaryModel === "current" ? agent.state.model : summaryModel,
        providerOptions: agent.state.providerOptions,
        keepLastMessages,
        keepRecentTokens,
        summarySystem,
        buildSummaryPrompt,
        buildSummaryUpdatePrompt,
        buildSplitTurnSummaryPrompt,
        abortSignal: context.abortSignal,
      });

      if (!compacted) {
        throw new Error("Compaction could not select transcript content for summarization.");
      }

      agent.replaceMessages(compacted, { reason: "compaction" });

      if (latestCapability.known) {
        pendingCompactionReason =
          estimateMessagesTokens(compacted) > activeBudget.inputBudget ? "threshold" : null;
      } else {
        pendingCompactionReason = null;
      }

      const outbound = cloneMessages(compacted);
      options.onCompactionEnd?.({
        ...compactionEventBase,
        durationMs: Math.max(0, Date.now() - compactionStart),
        messageCountAfter: compacted.length,
        estimatedInputTokensAfter: estimateMessagesTokens(compacted),
        status: "completed",
      });
      return options.baseTransformMessages
        ? await options.baseTransformMessages(outbound, context)
        : outbound;
    } catch (error) {
      options.onCompactionEnd?.({
        ...compactionEventBase,
        durationMs: Math.max(0, Date.now() - compactionStart),
        status: "failed",
        error,
      });
      throw error;
    } finally {
      inCompaction = false;
    }
  };

  agent.setTransformMessages(transformMessages);
  agent.setTurnErrorHandler(turnErrorHandler);

  return () => {
    unsubscribe();
    agent.setTransformMessages(options.baseTransformMessages);
    agent.setTurnErrorHandler(options.baseTurnErrorHandler);
  };
}

export const __autoCompactionInternals = {
  buildCompactionSummaryMessage,
  computeInputCompactionBudget,
  computeUnknownOverflowCompactionBudget,
  computeOverflowRecoveryDecision,
  reconcilePendingCompactionReason,
  chunkMessagesByEstimatedTokens,
  chooseSuffixStartByMessageCount,
  chooseSuffixStartByTokenBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  inlineMediaStorageBytes,
  isValidSuffix,
  normalizeThresholdFraction,
  repairTranscriptForCompaction,
  renderMessagesForSummary,
  resolveContextLimit,
  resolveCompactionBoundary,
  shrinkCompactedMessagesToBudget,
  summarizeMessagesHierarchical,
};
