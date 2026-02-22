import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

import type {
  AiSdkPiAgentEvent,
  TransformMessagesFn,
  TransformMessagesContext,
  TurnErrorHandler,
} from "./ai-sdk-pi-agent";
import { AiSdkPiAgent } from "./ai-sdk-pi-agent";
import { isLikelyContextOverflowError } from "./context-overflow";
import { ModelCapability, type ModelSpecifier } from "@stanley2058/lilac-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

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
  const open = new Set<string>();

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === "assistant") {
      for (const id of getAssistantToolCallIds(message)) open.add(id);
      continue;
    }

    if (message.role === "tool") {
      for (const id of getToolResultToolCallIds(message)) {
        if (!open.has(id)) return false;
        open.delete(id);
      }
    }
  }

  return true;
}

function isCutBoundaryMessage(message: ModelMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

function estimateMessageTokens(message: ModelMessage): number {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    return estimateTokensFromText(stringifyUnknown(message.content));
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    let text = "";
    for (const part of message.content) {
      if (!isRecord(part)) {
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

      text += stringifyUnknown(part);
    }
    return estimateTokensFromText(text);
  }

  if (message.role === "tool") {
    return estimateTokensFromText(stringifyUnknown(message.content));
  }

  return estimateTokensFromText(stringifyUnknown(message));
}

function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

type RepairTranscriptResult = {
  messages: ModelMessage[];
  droppedOrphanToolResultParts: number;
  droppedEmptyToolMessages: number;
};

function repairTranscriptForCompaction(messages: readonly ModelMessage[]): RepairTranscriptResult {
  const repaired: ModelMessage[] = [];
  const openToolCallIds = new Set<string>();
  let droppedOrphanToolResultParts = 0;
  let droppedEmptyToolMessages = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const id of getAssistantToolCallIds(message)) {
        openToolCallIds.add(id);
      }
      repaired.push(cloneMessage(message));
      continue;
    }

    if (message.role === "tool") {
      const nextContent = [] as typeof message.content;

      for (const part of message.content) {
        const candidate = part as {
          type?: unknown;
          toolCallId?: unknown;
        };

        if (candidate.type !== "tool-result") {
          nextContent.push({ ...part });
          continue;
        }

        if (
          typeof candidate.toolCallId !== "string" ||
          !openToolCallIds.has(candidate.toolCallId)
        ) {
          droppedOrphanToolResultParts += 1;
          continue;
        }

        openToolCallIds.delete(candidate.toolCallId);
        nextContent.push({ ...part });
      }

      if (nextContent.length === 0) {
        droppedEmptyToolMessages += 1;
        continue;
      }

      repaired.push({
        ...message,
        content: nextContent,
      });
      continue;
    }

    repaired.push(cloneMessage(message));
  }

  return {
    messages: repaired,
    droppedOrphanToolResultParts,
    droppedEmptyToolMessages,
  };
}

function ensureMessagesEndNotAssistant(messages: readonly ModelMessage[]): ModelMessage[] {
  let end = messages.length;
  while (end > 0) {
    const candidate = messages[end - 1];
    if (!candidate || candidate.role !== "assistant") break;
    end -= 1;
  }

  if (end === messages.length) return cloneMessages(messages);
  return cloneMessages(messages.slice(0, end));
}

const EMERGENCY_TOOL_OUTPUT_PLACEHOLDER = "[tool output omitted by emergency compaction]";

function compactOneToolResultOutput(messages: readonly ModelMessage[]): {
  messages: ModelMessage[];
  changed: boolean;
} {
  for (let messageIndex = 1; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (message.role !== "tool") continue;

    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex];
      const candidate = part as {
        type?: unknown;
        output?: unknown;
      };
      if (candidate.type !== "tool-result") continue;

      const output = candidate.output;
      if (
        isRecord(output) &&
        output["type"] === "text" &&
        typeof output["value"] === "string" &&
        output["value"] === EMERGENCY_TOOL_OUTPUT_PLACEHOLDER
      ) {
        continue;
      }

      const next = cloneMessages(messages);
      const nextMessage = next[messageIndex];
      if (!nextMessage || nextMessage.role !== "tool") {
        return {
          messages: next,
          changed: false,
        };
      }

      const nextPart = nextMessage.content[partIndex];
      if (nextPart && typeof nextPart === "object") {
        const nextPartRecord = nextPart as Record<string, unknown>;
        nextPartRecord["output"] = {
          type: "text",
          value: EMERGENCY_TOOL_OUTPUT_PLACEHOLDER,
        };
      }

      return {
        messages: next,
        changed: true,
      };
    }
  }

  return {
    messages: cloneMessages(messages),
    changed: false,
  };
}

function shrinkCompactedMessagesToBudget(params: {
  messages: readonly ModelMessage[];
  inputBudget: number;
  maxSteps?: number;
}): ModelMessage[] {
  const shrinkSingleMessage = (message: ModelMessage): ModelMessage => {
    const maxChars = Math.max(64, params.inputBudget * 4);

    if (message.role === "user" && typeof message.content === "string") {
      return {
        ...message,
        content: truncateText(message.content, maxChars),
      };
    }

    if (message.role === "assistant" && typeof message.content === "string") {
      return {
        ...message,
        content: truncateText(message.content, maxChars),
      };
    }

    return message;
  };

  let working = ensureMessagesEndNotAssistant(params.messages);
  working = repairTranscriptForCompaction(working).messages;

  const budget = Math.max(1, params.inputBudget);
  const maxSteps = params.maxSteps ?? Math.max(8, working.length * 4);

  for (let step = 0; step < maxSteps; step++) {
    if (estimateMessagesTokens(working) <= budget) return working;

    const lastUserIndex = (() => {
      for (let i = working.length - 1; i >= 0; i--) {
        if (working[i]?.role === "user") return i;
      }
      return -1;
    })();

    const compactedToolResult = compactOneToolResultOutput(working);
    if (compactedToolResult.changed) {
      working = ensureMessagesEndNotAssistant(
        repairTranscriptForCompaction(compactedToolResult.messages).messages,
      );
      continue;
    }

    if (working.length <= 1) {
      if (working.length === 0) return working;
      return [shrinkSingleMessage(working[0]!)];
    }

    const head = working[0];
    if (!head) return working;

    let removableIndex = -1;
    for (let i = 1; i < working.length; i++) {
      if (i === working.length - 1) continue;
      if (i === lastUserIndex) continue;
      removableIndex = i;
      break;
    }

    if (removableIndex < 0) {
      const next = cloneMessages(working);
      next[0] = shrinkSingleMessage(next[0]!);
      if (estimateMessageTokens(next[0]!) >= estimateMessageTokens(working[0]!)) {
        break;
      }
      working = ensureMessagesEndNotAssistant(repairTranscriptForCompaction(next).messages);
      continue;
    }

    const droppedOldest = [
      head,
      ...working.slice(1, removableIndex),
      ...working.slice(removableIndex + 1),
    ];
    working = ensureMessagesEndNotAssistant(repairTranscriptForCompaction(droppedOldest).messages);
  }

  if (estimateMessagesTokens(working) <= budget) return working;
  if (working.length === 0) return [];

  const lastUser = (() => {
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i]?.role === "user") return working[i]!;
    }
    return null;
  })();

  if (lastUser) {
    return [shrinkSingleMessage(lastUser)];
  }

  return [shrinkSingleMessage(working[0]!)];
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

function renderMessageForSummary(
  message: ModelMessage,
  options: {
    maxCharsPerMessage: number;
  },
): string {
  if (message.role === "user") {
    const content =
      typeof message.content === "string" ? message.content : stringifyUnknown(message.content);
    return truncateText(`USER:\n${content}`, options.maxCharsPerMessage);
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return truncateText(`ASSISTANT:\n${message.content}`, options.maxCharsPerMessage);
    }

    const lines: string[] = [];
    for (const part of message.content) {
      if (isRecord(part)) {
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

    return truncateText(`ASSISTANT:\n${lines.join("\n")}`, options.maxCharsPerMessage);
  }

  if (message.role === "tool") {
    const lines: string[] = [];
    for (const part of message.content) {
      if (isRecord(part)) {
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

    return truncateText(`TOOL:\n${lines.join("\n")}`, options.maxCharsPerMessage);
  }

  return truncateText(
    `${String((message as { role?: unknown }).role ?? "UNKNOWN").toUpperCase()}:\n${stringifyUnknown(message)}`,
    options.maxCharsPerMessage,
  );
}

function renderMessagesForSummary(
  messages: readonly ModelMessage[],
  options: {
    maxCharsPerMessage: number;
    maxCharsTotal: number;
  },
): string {
  const parts: string[] = [];
  let chars = 0;
  const separator = "\n\n---\n\n";

  for (const message of messages) {
    const rendered = renderMessageForSummary(message, {
      maxCharsPerMessage: options.maxCharsPerMessage,
    });
    if (!rendered) continue;

    const next = parts.length === 0 ? rendered : `${separator}${rendered}`;
    if (chars + next.length <= options.maxCharsTotal) {
      parts.push(rendered);
      chars += next.length;
      continue;
    }

    const remaining = options.maxCharsTotal - chars;
    if (remaining <= 0) break;
    const clipped = truncateText(next, remaining);
    if (clipped.trim().length > 0) {
      if (parts.length === 0) {
        parts.push(clipped);
      } else {
        parts.push(clipped.slice(separator.length));
      }
    }
    break;
  }

  return parts.join(separator);
}

async function summarizePrompt(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const res = streamText({
    model: options.model,
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
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
        const transcriptText = renderMessagesForSummary(chunk, {
          maxCharsPerMessage,
          maxCharsTotal,
        });
        if (!transcriptText.trim()) continue;

        summary = await options.summarizeChunk(transcriptText, summary, options.abortSignal);
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

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function renderDeterministicFallbackSummary(options: {
  title: string;
  messages: readonly ModelMessage[];
  maxCharsTotal: number;
}): string {
  const rendered = renderMessagesForSummary(options.messages, {
    maxCharsPerMessage: Math.max(400, Math.floor(options.maxCharsTotal / 4)),
    maxCharsTotal: Math.max(500, options.maxCharsTotal),
  }).trim();

  if (!rendered) {
    return `${options.title}\n\nNo transcript excerpt available.`;
  }

  return `${options.title}\n\n${rendered}`;
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

type InputCompactionBudget = {
  inputBudget: number;
  safeInputBudget: number;
  earlyInputBudget: number;
  reservedOutputTokens: number;
};

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
  const boundedThreshold = Math.max(0.05, Math.min(0.95, params.thresholdFraction));
  const earlyInputBudget = Math.max(1, Math.floor(contextLimit * boundedThreshold));

  const reservedOutputFromLimit =
    params.outputLimit > 0 ? Math.max(256, Math.floor(params.outputLimit)) : 0;
  const reservedOutputFallback = Math.max(
    DEFAULT_RESERVED_OUTPUT_MIN_TOKENS,
    Math.floor(contextLimit * DEFAULT_RESERVED_OUTPUT_FRACTION),
  );
  const reservedOutputTokens = Math.min(
    Math.max(1, contextLimit - 1),
    reservedOutputFromLimit > 0 ? reservedOutputFromLimit : reservedOutputFallback,
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

  /** Optional context-limit resolver. Defaults to `modelCapability.resolve(spec).limit.context`. */
  resolveContextLimit?: (params: {
    defaultModel: ModelSpecifier;
    currentModelSpecifier?: ModelSpecifier;
    currentModel: LanguageModel;
    modelCapability: ModelCapability;
    abortSignal?: AbortSignal;
  }) => Promise<number>;

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
};

async function resolveContextLimit(params: {
  options: AutoCompactionOptions;
  agent: AiSdkPiAgent;
  abortSignal?: AbortSignal;
}): Promise<ResolvedContextWindow> {
  const resolvedSpecRaw = params.options.resolveCurrentModelSpecifier
    ? await params.options.resolveCurrentModelSpecifier()
    : params.agent.state.modelSpecifier;
  const spec = resolvedSpecRaw ?? params.options.model;

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

  if (params.options.resolveContextLimit) {
    const contextLimit = await params.options.resolveContextLimit({
      defaultModel: params.options.model,
      currentModelSpecifier: spec,
      currentModel: params.agent.state.model,
      modelCapability: params.options.modelCapability,
      abortSignal: params.abortSignal,
    });
    if (!(typeof contextLimit === "number") || contextLimit <= 0) {
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
      outputLimit,
    };
  }

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

  const thresholdFraction = DEFAULT_THRESHOLD_FRACTION;
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
      return computeInputCompactionBudget({
        contextLimit: params.capability.contextLimit,
        outputLimit: params.capability.outputLimit,
        thresholdFraction,
      });
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

    inCompaction = true;
    try {
      queuedAutoContinue = false;

      const modelToUse = summaryModel === "current" ? agent.state.model : summaryModel;
      const summaryContextLimit = latestCapability.known
        ? Math.max(1, latestCapability.contextLimit)
        : Math.max(2_048, Math.floor(activeBudget.inputBudget * 1.5));
      const maxCompactionPasses = DEFAULT_COMPACTION_MAX_PASSES;
      let passKeepRecentTokens = Math.max(1, Math.min(keepRecentTokens, activeBudget.inputBudget));
      let passKeepLastMessages = Math.max(1, keepLastMessages);
      let compactedCandidate: ModelMessage[] | null = null;

      for (let pass = 0; pass < maxCompactionPasses; pass++) {
        const boundary = resolveCompactionBoundary({
          messages: compactableMessages,
          keepRecentTokens: passKeepRecentTokens,
          keepLastMessages: passKeepLastMessages,
        });

        if (boundary.suffixStart <= 0) break;

        const historyEnd = boundary.splitTurnStart ?? boundary.suffixStart;
        const historyMessages = compactableMessages.slice(0, historyEnd);
        const splitTurnPrefixMessages =
          boundary.splitTurnStart !== null
            ? compactableMessages.slice(boundary.splitTurnStart, boundary.suffixStart)
            : [];
        const suffixMessages = compactableMessages.slice(boundary.suffixStart);

        if (historyMessages.length === 0 && splitTurnPrefixMessages.length === 0) {
          break;
        }

        const passScale = Math.pow(0.7, pass);
        const chunkTokenBudget = Math.max(
          1,
          Math.floor(summaryContextLimit * DEFAULT_SUMMARY_CHUNK_FRACTION * passScale),
        );
        const summaryMaxChars = Math.max(
          DEFAULT_SUMMARY_MAX_CHARS_FLOOR,
          Math.floor(activeBudget.inputBudget * 4 * passScale),
        );

        const summarizeMainHistory = async (): Promise<string> => {
          if (historyMessages.length === 0) return "";

          try {
            const text = await summarizeMessagesHierarchical({
              messages: historyMessages,
              initialChunkTokenBudget: chunkTokenBudget,
              maxReductionPasses: DEFAULT_SUMMARY_REDUCTION_PASSES,
              initialMaxCharsPerMessage: Math.max(2_000, chunkTokenBudget * 4),
              initialMaxCharsTotal: Math.max(4_000, chunkTokenBudget * 6),
              summarizeChunk: async (transcriptText, previousSummary, abortSignal) => {
                const prompt = previousSummary
                  ? buildSummaryUpdatePrompt(previousSummary, transcriptText)
                  : buildSummaryPrompt(transcriptText);
                return await summarizePrompt({
                  model: modelToUse,
                  system: summarySystem,
                  prompt,
                  abortSignal,
                });
              },
              abortSignal: context.abortSignal,
            });

            return text.trim();
          } catch (error) {
            if (context.abortSignal?.aborted || isAbortLikeError(error)) throw error;
            return renderDeterministicFallbackSummary({
              title: "## History",
              messages: historyMessages,
              maxCharsTotal: summaryMaxChars,
            });
          }
        };

        const summarizeSplitTurnPrefix = async (): Promise<string> => {
          if (splitTurnPrefixMessages.length === 0) return "";

          try {
            const text = await summarizeMessagesHierarchical({
              messages: splitTurnPrefixMessages,
              initialChunkTokenBudget: Math.max(1, Math.floor(chunkTokenBudget * 0.7)),
              maxReductionPasses: DEFAULT_SUMMARY_REDUCTION_PASSES,
              initialMaxCharsPerMessage: Math.max(1_500, Math.floor(chunkTokenBudget * 3)),
              initialMaxCharsTotal: Math.max(3_000, Math.floor(chunkTokenBudget * 5)),
              summarizeChunk: async (transcriptText, previousSummary, abortSignal) => {
                const prompt = previousSummary
                  ? DEFAULT_SPLIT_TURN_UPDATE_PROMPT(previousSummary, transcriptText)
                  : buildSplitTurnSummaryPrompt(transcriptText);
                return await summarizePrompt({
                  model: modelToUse,
                  system: summarySystem,
                  prompt,
                  abortSignal,
                });
              },
              abortSignal: context.abortSignal,
            });

            return text.trim();
          } catch (error) {
            if (context.abortSignal?.aborted || isAbortLikeError(error)) throw error;
            return renderDeterministicFallbackSummary({
              title: "## Turn Prefix",
              messages: splitTurnPrefixMessages,
              maxCharsTotal: Math.max(1_000, Math.floor(summaryMaxChars * 0.7)),
            });
          }
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
          finalSummary = renderDeterministicFallbackSummary({
            title: "## History",
            messages: historyMessages,
            maxCharsTotal: summaryMaxChars,
          });
        }

        finalSummary = truncateText(finalSummary, summaryMaxChars);

        const summaryMessage: ModelMessage = {
          role: "user",
          content: `<summary>\n${finalSummary}\n</summary>`,
        };

        const passCompacted = repairTranscriptForCompaction([
          summaryMessage,
          ...suffixMessages,
        ]).messages;
        const passEstimatedTokens = estimateMessagesTokens(passCompacted);
        compactedCandidate = passCompacted;

        if (passEstimatedTokens <= activeBudget.inputBudget) {
          break;
        }

        passKeepRecentTokens = Math.max(1, Math.floor(passKeepRecentTokens * 0.6));
        passKeepLastMessages = Math.max(1, Math.floor(passKeepLastMessages * 0.8));
      }

      if (!compactedCandidate) {
        const emergencySummaryChars = Math.max(
          DEFAULT_SUMMARY_MAX_CHARS_FLOOR,
          activeBudget.inputBudget * 4,
        );
        const emergencySummary = truncateText(
          renderDeterministicFallbackSummary({
            title: "## History",
            messages: compactableMessages,
            maxCharsTotal: emergencySummaryChars,
          }),
          emergencySummaryChars,
        );

        compactedCandidate = [
          {
            role: "user",
            content: `<summary>\n${emergencySummary}\n</summary>`,
          },
        ];
      }

      const compacted = shrinkCompactedMessagesToBudget({
        messages: compactedCandidate,
        inputBudget: activeBudget.inputBudget,
      });

      agent.replaceMessages(compacted, { reason: "compaction" });

      if (latestCapability.known) {
        pendingCompactionReason =
          estimateMessagesTokens(compacted) > activeBudget.inputBudget ? "threshold" : null;
      } else {
        pendingCompactionReason = null;
      }

      const outbound = cloneMessages(compacted);
      return options.baseTransformMessages
        ? await options.baseTransformMessages(outbound, context)
        : outbound;
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
  computeInputCompactionBudget,
  computeUnknownOverflowCompactionBudget,
  computeOverflowRecoveryDecision,
  reconcilePendingCompactionReason,
  chunkMessagesByEstimatedTokens,
  chooseSuffixStartByMessageCount,
  chooseSuffixStartByTokenBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  repairTranscriptForCompaction,
  renderMessagesForSummary,
  resolveCompactionBoundary,
  shrinkCompactedMessagesToBudget,
  summarizeMessagesHierarchical,
};
