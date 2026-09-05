import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type {
  AiSdkPiAgentEvent,
  BuildEphemeralOverlay,
  CanonicalModelCallPreflight,
  DecorateRequestPayload,
  PrepareFullBudgetView,
  PrepareFullModelView,
  TransformMessagesContext,
  TurnErrorHandler,
} from "./ai-sdk-pi-agent";
import { AiSdkPiAgent } from "./ai-sdk-pi-agent";
import { isLikelyContextOverflowError } from "./context-overflow";
import {
  captureAgentOperation,
  captureAgentPromise,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "./failure-adapters";
import {
  readOpenAIServerCompactionArtifact,
  type OpenAIServerCompactionArtifact,
} from "./openai-server-compaction";
import { isOpenAICompactionPart } from "@stanley2058/lilac-utils/model-message-provider-options";
import { ModelCapability, type ModelSpecifier } from "@stanley2058/lilac-utils/model-capability";
import { type JSONObject } from "@stanley2058/lilac-utils/core-config/types";

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = resultOutcome(captureAgentOperation(() => JSON.stringify(value, null, 2)));
  if (serialized.ok) return serialized.value;
  rethrowAgentPanic(serialized.error);
  return String(value);
}

function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const suffix = "\n...[truncated for compaction]";
  // The marker must never push the result past the limit: when the budget is
  // tighter than the marker itself, an unmarked cut is the only honest option.
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

export class AutoCompactionFailed extends TaggedError("AutoCompactionFailed")<{
  readonly cause: OpaqueAgentValue;
  readonly message: string;
}> {}

function autoCompactionFailure(cause: OpaqueAgentValue, message = stringifyUnknown(cause)) {
  return new AutoCompactionFailed({ cause, message });
}

function signalAutoCompactionHost(error: AutoCompactionFailed): never {
  throw error.cause;
}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => Object.assign({}, part))
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
    if (part.type === "tool-call") ids.push(part.toolCallId);
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
    if (part.type === "tool-result") ids.push(part.toolCallId);
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
      const unresolved = new Set(toolCallIds);
      if (Array.isArray(message.content)) {
        const seenCalls = new Set<string>();
        for (const part of message.content) {
          if (part.type === "tool-call") {
            seenCalls.add(part.toolCallId);
            continue;
          }
          if (part.type !== "tool-result") continue;
          if (!seenCalls.has(part.toolCallId) || !unresolved.delete(part.toolCallId)) return false;
        }
      }
      if (unresolved.size > 0) openToolCallIds = unresolved;
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

const INLINE_MEDIA_TEXT_PLACEHOLDER = "[inline media omitted]";

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:[^,]*,/i.test(value);
}

function withoutInlineMediaPayload(value: unknown): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || isDataUrl(value)) {
    return INLINE_MEDIA_TEXT_PLACEHOLDER;
  }
  if (value instanceof URL) {
    return isDataUrl(String(value)) ? INLINE_MEDIA_TEXT_PLACEHOLDER : value;
  }
  if (typeof value === "string") {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : INLINE_MEDIA_TEXT_PLACEHOLDER;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record["type"] === "data" ? { ...record, data: INLINE_MEDIA_TEXT_PLACEHOLDER } : value;
}

function stringifyTextOnly(value: unknown, space?: number): string {
  const attempted = resultOutcome(
    captureAgentOperation(() => {
      const serialized = JSON.stringify(
        value,
        (_key, item: unknown) => {
          if (item instanceof ArrayBuffer || ArrayBuffer.isView(item) || isDataUrl(item)) {
            return INLINE_MEDIA_TEXT_PLACEHOLDER;
          }
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          const record = item as Record<string, unknown>;
          const type = record["type"];
          if (type === "Buffer") return INLINE_MEDIA_TEXT_PLACEHOLDER;
          if (type === "file-data" || type === "image-data") {
            return { ...record, data: INLINE_MEDIA_TEXT_PLACEHOLDER };
          }
          if (type === "file" || type === "reasoning-file") {
            return { ...record, data: withoutInlineMediaPayload(record["data"]) };
          }
          if (type === "image") {
            return {
              ...record,
              ...(record["data"] === undefined
                ? {}
                : { data: withoutInlineMediaPayload(record["data"]) }),
              ...(record["image"] === undefined
                ? {}
                : { image: withoutInlineMediaPayload(record["image"]) }),
            };
          }
          if (type === "file-url" || type === "image-url") {
            return {
              ...record,
              url: isDataUrl(String(record["url"])) ? INLINE_MEDIA_TEXT_PLACEHOLDER : record["url"],
            };
          }
          return item;
        },
        space,
      );
      return serialized ?? String(value);
    }),
  );
  if (attempted.ok) return attempted.value;
  rethrowAgentPanic(attempted.error);
  return "[unserializable text content omitted]";
}

function estimateMessageTokens(message: ModelMessage): number {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    return estimateTokensFromText(stringifyTextOnly(message.content));
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return estimateTokensFromText(message.content);
    }
    let text = "";
    for (const part of message.content) {
      const artifact = readOpenAIServerCompactionArtifact(part);
      if (artifact) {
        return artifact.metadata.estimatedTokens;
      }
      if (isOpenAICompactionPart(part)) continue;
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
        text += `TOOL_CALL ${toolName} id=${toolCallId} ${stringifyTextOnly(record["input"])}\n`;
        continue;
      }

      text += stringifyTextOnly(part);
    }
    return estimateTokensFromText(text);
  }

  if (message.role === "tool") {
    return estimateTokensFromText(stringifyTextOnly(message.content));
  }

  return estimateTokensFromText(stringifyTextOnly(message));
}

function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

function estimateModelInputTokens(params: {
  messages: readonly ModelMessage[];
  context: Pick<TransformMessagesContext, "system" | "tools">;
}): number {
  // Provider usage is authoritative for multimodal occupancy. This fallback is
  // intentionally text-only: image tokens are provider-specific and must never
  // be inferred from encoded bytes, dimensions, or attachment count.
  return estimateTokensFromText(
    stringifyTextOnly({
      system: params.context.system,
      messages: params.messages,
      tools: params.context.tools,
    }),
  );
}

function resolveThresholdInputTokens(params: {
  source: "usage" | "transcript-estimate";
  usageInputTokens: number | undefined;
  messages: readonly ModelMessage[];
  modelInputEstimate?: number;
}): number | undefined {
  return params.source === "transcript-estimate"
    ? (params.modelInputEstimate ?? estimateMessagesTokens(params.messages))
    : params.usageInputTokens;
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
      const seenInlineCallIds = new Set<string>();
      for (const part of message.content) {
        if (part.type === "tool-call") {
          seenInlineCallIds.add(part.toolCallId);
        } else if (part.type === "tool-result" && seenInlineCallIds.has(part.toolCallId)) {
          matchedToolCallIds.add(part.toolCallId);
        }
      }
      for (let toolIndex = messageIndex + 1; toolIndex < toolBlockEnd; toolIndex++) {
        const toolMessage = messages[toolIndex]!;
        for (const resultId of getToolResultToolCallIds(toolMessage)) {
          if (uniqueToolCallIds.has(resultId)) matchedToolCallIds.add(resultId);
        }
      }

      const retainedToolCallIds = new Set<string>();
      const retainedResultIds = new Set<string>();
      const assistantContent = message.content.filter((part) => {
        if (part.type === "tool-call") {
          if (
            matchedToolCallIds.has(part.toolCallId) &&
            !retainedToolCallIds.has(part.toolCallId)
          ) {
            retainedToolCallIds.add(part.toolCallId);
            return true;
          }
          droppedDanglingToolCallParts += 1;
          return false;
        }
        if (part.type !== "tool-result") return true;
        if (retainedToolCallIds.has(part.toolCallId) && !retainedResultIds.has(part.toolCallId)) {
          retainedResultIds.add(part.toolCallId);
          return true;
        }
        droppedOrphanToolResultParts += 1;
        return false;
      });

      if (assistantContent.length > 0) {
        repaired.push({ ...message, content: assistantContent.map((part) => ({ ...part })) });
      } else {
        droppedEmptyAssistantMessages += 1;
      }

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

function shrinkCompactedMessagesToBudgetResult(params: {
  messages: readonly ModelMessage[];
  inputBudget: number;
  summary: string;
}): ResultType<{ messages: ModelMessage[]; summary: string }, AutoCompactionFailed> {
  const budget = Math.max(1, params.inputBudget);
  const working = repairTranscriptForCompaction(params.messages).messages;
  const estimatedTokens = estimateMessagesTokens(working);
  if (estimatedTokens <= budget) {
    return Result.ok({ messages: working, summary: params.summary });
  }

  const summaryMessage = working[0];
  const retainedSuffix = working.slice(1);
  const retainedSuffixTokens = estimateMessagesTokens(retainedSuffix);
  if (retainedSuffixTokens >= budget) {
    return Result.err(
      autoCompactionFailure(
        new Error(
          `Compaction could not fit retained bounded context within the input budget (${retainedSuffixTokens} >= ${budget} estimated tokens); no retained suffix messages were discarded.`,
        ),
      ),
    );
  }

  if (
    !summaryMessage ||
    (summaryMessage.role !== "user" && summaryMessage.role !== "assistant") ||
    typeof summaryMessage.content !== "string"
  ) {
    return Result.err(
      autoCompactionFailure(
        new Error(
          `Compaction could not fit bounded context within the input budget (${estimatedTokens} > ${budget} estimated tokens).`,
        ),
      ),
    );
  }

  const availableSummaryTokens = budget - retainedSuffixTokens;
  // Truncate the summary itself and rebuild its wrapper rather than slicing
  // the wrapped message: the summary reported (and persisted) must be exactly
  // the text the model will see, and the closing tag must survive.
  const wrapperOverhead = buildCompactionSummaryMessage("").content.length;
  const shrunkSummary = truncateText(
    params.summary,
    Math.max(1, availableSummaryTokens * 4 - wrapperOverhead),
  );
  const compacted = [buildCompactionSummaryMessage(shrunkSummary), ...retainedSuffix];
  const compactedTokens = estimateMessagesTokens(compacted);
  if (compactedTokens > budget) {
    return Result.err(
      autoCompactionFailure(
        new Error(
          `Compaction could not fit bounded context within the input budget (${compactedTokens} > ${budget} estimated tokens).`,
        ),
      ),
    );
  }
  return Result.ok({ messages: compacted, summary: shrunkSummary });
}

function shrinkCompactedMessagesToBudget(params: {
  messages: readonly ModelMessage[];
  inputBudget: number;
  summary: string;
}): { messages: ModelMessage[]; summary: string } {
  const result = resultOutcome(shrinkCompactedMessagesToBudgetResult(params));
  if (!result.ok) return signalAutoCompactionHost(result.error);
  return result.value;
}

type CompactionBoundary = {
  suffixStart: number;
};

function hasCompletedAssistantToolTurn(messages: readonly ModelMessage[], start: number): boolean {
  const message = messages[start];
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;

  const toolCallIds = getAssistantToolCallIds(message);
  if (toolCallIds.length === 0) return false;
  if (getAssistantToolCallPartCount(message) !== toolCallIds.length) return false;
  if (new Set(toolCallIds).size !== toolCallIds.length) return false;

  const unresolved = new Set(toolCallIds);
  const seenCalls = new Set<string>();
  for (const part of message.content) {
    if (part.type === "tool-call") {
      seenCalls.add(part.toolCallId);
      continue;
    }
    if (part.type !== "tool-result") continue;
    if (!seenCalls.has(part.toolCallId) || !unresolved.delete(part.toolCallId)) return false;
  }

  let end = start + 1;
  while (unresolved.size > 0) {
    const resultMessage = messages[end];
    if (!resultMessage || resultMessage.role !== "tool") return false;
    const resultIds = getToolResultToolCallIds(resultMessage);
    if (resultIds.length === 0) return false;
    for (const id of resultIds) {
      if (!unresolved.delete(id)) return false;
    }
    end += 1;
  }
  return true;
}

function isContinuableTurnStart(messages: readonly ModelMessage[], index: number): boolean {
  const message = messages[index];
  if (message?.role === "user") return !isAutoContinueMessage(message);
  return hasCompletedAssistantToolTurn(messages, index);
}

function chooseRetainedTailStart(params: {
  messages: readonly ModelMessage[];
  keepRecentTokens: number;
  keepRecentTurns: number;
  minimumStart?: number;
}): number {
  const tokenCap = Math.max(0, Math.floor(params.keepRecentTokens));
  const turnCap = Math.max(0, Math.floor(params.keepRecentTurns));
  if (params.messages.length === 0 || tokenCap === 0 || turnCap === 0) {
    return params.messages.length;
  }

  const turnStarts: number[] = [];
  for (let index = 0; index < params.messages.length; index++) {
    if (isContinuableTurnStart(params.messages, index)) turnStarts.push(index);
  }

  for (const [turnIndex, start] of turnStarts.entries()) {
    if (start < (params.minimumStart ?? 0)) continue;
    const retainedTurnCount = turnStarts.length - turnIndex;
    if (retainedTurnCount > turnCap) continue;
    if (!isValidSuffix(params.messages, start)) continue;
    if (estimateMessagesTokens(params.messages.slice(start)) > tokenCap) continue;
    return start;
  }

  // An oversized newest atomic turn is summarized in full. Never retain a
  // partial tool exchange or silently turn the hard token cap into a soft one.
  return params.messages.length;
}

function resolveCompactionBoundary(params: {
  messages: readonly ModelMessage[];
  keepRecentTokens: number;
  keepRecentTurns: number;
  forceCompaction?: boolean;
}): CompactionBoundary {
  const suffixStart = chooseRetainedTailStart(params);
  return {
    // Automatic pressure must establish a new context epoch even when the
    // complete small transcript would otherwise qualify as retained tail.
    suffixStart:
      params.forceCompaction && suffixStart === 0
        ? chooseRetainedTailStart({ ...params, minimumStart: 1 })
        : suffixStart,
  };
}

function renderMessageForSummary(message: ModelMessage): string {
  if (message.role === "user") {
    const content =
      typeof message.content === "string" ? message.content : stringifyTextOnly(message.content, 2);
    return `USER:\n${content}`;
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return `ASSISTANT:\n${message.content}`;
    }

    const lines: string[] = [];
    for (const part of message.content) {
      const artifact = readOpenAIServerCompactionArtifact(part);
      if (artifact) {
        lines.push(`[OPENAI SERVER COMPACTION]\n${artifact.metadata.portableSummary}`);
        continue;
      }
      if (isOpenAICompactionPart(part)) continue;
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
              `TOOL_CALL ${toolName} id=${toolCallId}: ${stringifyTextOnly(record["input"], 2)}`,
            );
            continue;
          }
        }
      }

      lines.push(stringifyTextOnly(part, 2));
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
              `TOOL_RESULT ${toolName} id=${toolCallId}: ${stringifyTextOnly(record["output"], 2)}`,
            );
            continue;
          }
        }
      }

      lines.push(stringifyTextOnly(part, 2));
    }

    return `TOOL:\n${lines.join("\n")}`;
  }

  return `${String((message as { role?: unknown }).role ?? "UNKNOWN").toUpperCase()}:\n${stringifyTextOnly(message, 2)}`;
}

const SUMMARY_OVERFLOW_RETRY_SCALE = 0.5;

const SUMMARY_SEGMENT_SEPARATOR = "\n\n---\n\n";

/** Pack rendered messages into bounded segments, splitting only oversized messages. */
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

  let buffered: string[] = [];
  let bufferedLength = 0;

  const flush = () => {
    if (buffered.length === 0) return;
    segments.push(buffered.join(SUMMARY_SEGMENT_SEPARATOR));
    buffered = [];
    bufferedLength = 0;
  };

  for (const message of messages) {
    const rendered = renderMessageForSummary(message);

    if (rendered.length > segmentLimit) {
      flush();
      const segmentCount = Math.ceil(rendered.length / payloadLimit);
      for (let index = 0; index < segmentCount; index++) {
        const payload = rendered.slice(index * payloadLimit, (index + 1) * payloadLimit);
        segments.push(`[message continuation ${index + 1}/${segmentCount}]\n${payload}`);
      }
      continue;
    }

    const separatorLength = buffered.length === 0 ? 0 : SUMMARY_SEGMENT_SEPARATOR.length;
    if (bufferedLength + separatorLength + rendered.length > segmentLimit) {
      flush();
      buffered.push(rendered);
      bufferedLength = rendered.length;
      continue;
    }

    buffered.push(rendered);
    bufferedLength += separatorLength + rendered.length;
  }

  flush();
  return segments;
}

async function summarizePrompt(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  providerOptions?: { [x: string]: JSONObject };
  abortSignal?: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const res = streamText({
    model: options.model,
    instructions: options.system,
    messages: [{ role: "user", content: options.prompt }],
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
  });

  // Without a delta consumer, awaiting `res.text` is the cheaper path: it never
  // materializes the stream in this scope.
  if (!options.onDelta) return await res.text;

  for await (const delta of res.textStream) options.onDelta(delta);
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

/** Where a summarization request sits in the single history refinement chain. */
export type CompactionProgress = {
  readonly stage: "history";
  /** 1-based summarization request within the current pass. */
  readonly step: number;
  /** Requests planned for this pass, known once chunking has run. */
  readonly stepCount: number;
  /** 1-based reduction pass; anything above 1 means the provider rejected a larger attempt. */
  readonly pass: number;
};

export type CompactionStreamHooks = {
  /** Fires immediately before each summarization request. */
  onProgress?: (progress: CompactionProgress) => void;
  /**
   * Streams summary text as it generates. Each step rewrites the whole summary
   * rather than appending, so consumers should reset their buffer on every
   * `onProgress` and accumulate deltas until the next one.
   */
  onSummaryDelta?: (delta: string, progress: CompactionProgress) => void;
};

export type ServerCompactionFn = (params: {
  readonly messages: readonly ModelMessage[];
  readonly portableSummary: string;
  readonly context?: TransformMessagesContext;
  readonly abortSignal?: AbortSignal;
}) => Promise<OpenAIServerCompactionArtifact>;

export interface ServerCompactionErrorHandler {
  (error: OpaqueAgentValue): void;
}

type SummarizeMessagesHierarchicalOptions = {
  messages: readonly ModelMessage[];
  initialChunkTokenBudget: number;
  maxReductionPasses: number;
  initialMaxCharsPerMessage: number;
  initialMaxCharsTotal: number;
  stage: CompactionProgress["stage"];
  summarizeChunk: (
    transcriptText: string,
    previousSummary: string | null,
    abortSignal: AbortSignal | undefined,
    progress: CompactionProgress,
  ) => Promise<string>;
  onProgress?: (progress: CompactionProgress) => void;
  abortSignal?: AbortSignal;
};

async function summarizeMessagesHierarchicalResult(
  options: SummarizeMessagesHierarchicalOptions,
): Promise<ResultType<string, AutoCompactionFailed>> {
  let budget = Math.max(1, options.initialChunkTokenBudget);
  let maxCharsPerMessage = Math.max(200, options.initialMaxCharsPerMessage);
  let maxCharsTotal = Math.max(500, options.initialMaxCharsTotal);

  const maxPasses = Math.max(1, options.maxReductionPasses);
  let lastError: OpaqueAgentValue;

  for (let pass = 0; pass < maxPasses; pass++) {
    const summarized = resultOutcome(
      await captureAgentPromise(async () => {
        // Flatten up front so the request count is known before the first call.
        // Segments are still rendered per chunk, so no segment spans a chunk.
        const segments = chunkMessagesByEstimatedTokens(options.messages, budget)
          .flatMap((chunk) =>
            renderMessagesForSummarySegments(chunk, { maxCharsPerMessage, maxCharsTotal }),
          )
          .filter((segment) => segment.trim().length > 0);
        let summary: string | null = null;

        for (const [index, transcriptText] of segments.entries()) {
          // A cancel partway through a refine chain should stop at the next
          // boundary instead of running the remaining requests to completion.
          options.abortSignal?.throwIfAborted();
          const progress: CompactionProgress = {
            stage: options.stage,
            step: index + 1,
            stepCount: segments.length,
            pass: pass + 1,
          };
          options.onProgress?.(progress);
          summary = await options.summarizeChunk(
            transcriptText,
            summary,
            options.abortSignal,
            progress,
          );
        }

        return (summary ?? "").trim();
      }),
    );
    if (summarized.ok) return Result.ok(summarized.value);
    rethrowAgentPanic(summarized.error);
    lastError = summarized.error;
    if (!isLikelyContextOverflowError(summarized.error)) {
      return Result.err(autoCompactionFailure(summarized.error));
    }
    // Keep token and character budgets in lockstep.
    budget = Math.max(1, Math.floor(budget * SUMMARY_OVERFLOW_RETRY_SCALE));
    maxCharsPerMessage = Math.max(
      200,
      Math.floor(maxCharsPerMessage * SUMMARY_OVERFLOW_RETRY_SCALE),
    );
    maxCharsTotal = Math.max(500, Math.floor(maxCharsTotal * SUMMARY_OVERFLOW_RETRY_SCALE));
  }

  return Result.err(
    autoCompactionFailure(
      lastError ?? new Error("Compaction summarization failed after recursive chunk retries."),
    ),
  );
}

async function summarizeMessagesHierarchical(
  options: SummarizeMessagesHierarchicalOptions,
): Promise<string> {
  const result = resultOutcome(await summarizeMessagesHierarchicalResult(options));
  if (!result.ok) return signalAutoCompactionHost(result.error);
  return result.value;
}

const DEFAULT_THRESHOLD_FRACTION = 0.8;
const DEFAULT_KEEP_RECENT_TURNS = 2;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_KEEP_RECENT_TOKEN_FRACTION = 0.25;
// Try one summary request first; overflow retries split it as needed.
const DEFAULT_SUMMARY_CHUNK_FRACTION = 1;
const DEFAULT_SUMMARY_REDUCTION_PASSES = 6;
const DEFAULT_OVERFLOW_RECOVERY_MAX_ATTEMPTS = 2;
const DEFAULT_RESERVED_OUTPUT_FRACTION = 0.2;
const DEFAULT_RESERVED_OUTPUT_MIN_TOKENS = 1_024;
const DEFAULT_COMPACTION_MAX_PASSES = 4;
const DEFAULT_SUMMARY_MAX_CHARS_FLOOR = 2_000;

// Leave room for prompt framing and summary output.
const DEFAULT_SUMMARY_PROMPT_RESERVE_TOKENS = 8_192;
const DEFAULT_SUMMARY_PROMPT_RESERVE_FRACTION = 0.15;

function resolveRetainedTailTokenCap(inputBudget: number, configuredLimit: number): number {
  return Math.max(
    1,
    Math.min(configuredLimit, Math.floor(inputBudget * DEFAULT_KEEP_RECENT_TOKEN_FRACTION)),
  );
}

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
type PendingCompactionReason = CompactionScheduleReason;

export type CompactionSummaryModel = "current" | LanguageModel | (() => LanguageModel);

function resolveSummaryModel(
  summaryModel: CompactionSummaryModel,
  currentModel: LanguageModel,
): LanguageModel {
  if (summaryModel === "current") return currentModel;
  if (typeof summaryModel === "function") return summaryModel();
  return summaryModel;
}

type AutoCompactionObservedBudget = {
  inputBudget: number;
  safeInputBudget: number;
  reservedOutputTokens: number;
};

type AutoCompactionStartEvent = {
  spec: ModelSpecifier;
  reason: CompactionScheduleReason;
  messageCountBefore: number;
  observedInputTokens: number;
  inputTokenSource: "provider-usage" | "text-estimate";
  estimatedInputTokens: number;
  budget: AutoCompactionObservedBudget;
};

type AutoCompactionEndEvent = AutoCompactionStartEvent & {
  durationMs: number;
  messageCountAfter?: number;
  estimatedInputTokensAfter?: number;
  status: "completed" | "cancelled" | "failed";
  /** The summary the engine actually persisted after the refinement chain. */
  summary?: string;
  canonicalReplacement?: {
    mode: "local" | "server";
    originalMessageCount: number;
    originalSuffixStart: number;
    replacementMessageCount: number;
    replacementSuffixStart: number;
  };
  error?: unknown;
};

function reconcilePendingCompactionReason(params: {
  pendingReason: PendingCompactionReason | null;
  capabilityKnown: boolean;
}): PendingCompactionReason | null {
  if (!params.capabilityKnown && params.pendingReason !== "overflow") {
    return null;
  }
  return params.pendingReason;
}

export function computeInputCompactionBudget(params: {
  contextLimit: number;
  outputLimit: number;
  thresholdFraction?: number;
}): CompactionBudget {
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
const AUTO_CONTINUE_PROVIDER_OPTIONS = {
  lilac: { autoCompactionContinue: true },
} as const satisfies NonNullable<ModelMessage["providerOptions"]>;

const DEFAULT_SUMMARY_SYSTEM =
  "You are an anchored context summarization assistant for coding sessions. Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary. Output only the requested summary in markdown, do not answer the conversation, and do not mention compaction or summarization.";

const SUMMARY_TEMPLATE = [
  "Output exactly this Markdown structure and keep the section order unchanged:",
  "",
  "## Objective",
  "- [one or two brief sentences describing what the user is trying to accomplish]",
  "",
  "## Important Details",
  '- [constraints, preferences, decisions and why, exact context needed to continue, or "(none)"]',
  "",
  "## Work State",
  "### Completed",
  '- [finished work, verified facts, or changes made; otherwise "(none)"]',
  "",
  "### Active",
  '- [current work, partial changes, or investigation state; otherwise "(none)"]',
  "",
  "### Blocked",
  '- [blockers, failing commands, or unknowns; otherwise "(none)"]',
  "",
  "## Next Move",
  '1. [immediate concrete action, or "(none)"]',
  '2. [next action if known, or "(none)"]',
  "",
  "## Relevant Files",
  '- [file or directory path: why it matters, or "(none)"]',
  "",
  "Rules:",
  "- Keep every section, even when empty.",
  "- Use terse bullets rather than prose paragraphs.",
  "- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.",
  "- Preserve still-relevant details from an existing context-compaction summary.",
].join("\n");

const DEFAULT_SUMMARY_PROMPT = (prefix: string) =>
  [
    "Create a new anchored summary from the conversation history below.",
    "Recent messages may be retained verbatim after the summary, so focus on older context needed to continue.",
    "",
    SUMMARY_TEMPLATE,
    "",
    "<conversation-history>",
    prefix,
    "</conversation-history>",
  ].join("\n");

const DEFAULT_SUMMARY_UPDATE_PROMPT = (previousSummary: string, nextTranscript: string) =>
  [
    "Update the anchored summary with the new conversation history.",
    "Preserve still-true details, remove stale details, and merge in new facts.",
    "",
    "<previous-summary>",
    previousSummary,
    "</previous-summary>",
    "",
    "<new-transcript>",
    nextTranscript,
    "</new-transcript>",
    "",
    SUMMARY_TEMPLATE,
  ].join("\n");

function buildCompactionSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: [
      "<context-compaction>",
      "The conversation before this point was compacted.",
      "Treat this summary as prior conversation context, not as a new user request.",
      "",
      summary,
      "</context-compaction>",
    ].join("\n"),
  };
}

function isCompactionSummaryMessage(message: ModelMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith("<context-compaction>\n")
  );
}

function retainServerCompactionUserMessages(
  messages: readonly ModelMessage[],
  tokenBudget: number,
): ModelMessage[] {
  let remaining = Math.max(0, Math.floor(tokenBudget));
  const retained: ModelMessage[] = [];
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role !== "user" ||
      isAutoContinueMessage(message) ||
      isCompactionSummaryMessage(message)
    ) {
      continue;
    }
    const tokens = Math.max(1, estimateMessageTokens(message));
    if (tokens > remaining) break;
    retained.push(cloneMessage(message));
    remaining -= tokens;
  }
  retained.reverse();
  return retained;
}

function buildAutoContinueMessage(): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: AUTO_CONTINUE_AFTER_COMPACTION_TEXT }],
    providerOptions: AUTO_CONTINUE_PROVIDER_OPTIONS,
  };
}

function isAutoContinueMessage(message: ModelMessage): boolean {
  const marker = message.providerOptions?.["lilac"];
  return (
    message.role === "user" &&
    typeof marker === "object" &&
    marker !== null &&
    marker["autoCompactionContinue"] === true
  );
}

function splitThresholdContinueTrailer(messages: readonly ModelMessage[]): {
  messages: readonly ModelMessage[];
  trailer: ModelMessage[];
} {
  if (!messages.some(isAutoContinueMessage)) return { messages, trailer: [] };

  const retained: ModelMessage[] = [];
  let trailer: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isAutoContinueMessage(message)) {
      retained.push(cloneMessage(message));
      continue;
    }
    if (index === messages.length - 1) trailer = [cloneMessage(message)];
    else if (messages[index + 1]?.role === "assistant") retained.push(cloneMessage(message));
  }
  return { messages: retained, trailer };
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

export type AutoCompactionInputEstimateFloor = (input: {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly preparedFullView: readonly ModelMessage[];
  readonly overlay: readonly ModelMessage[];
  readonly context: TransformMessagesContext;
  readonly ordinaryModelInputEstimate: number;
  readonly estimateMessagesTokens: (messages: readonly ModelMessage[]) => number;
}) => number | null | Promise<number | null>;

export type AutoCompactionOptions = {
  /** Canonical fallback model identifier in `provider/modelstring` format. */
  model: ModelSpecifier;

  /** Determines model context windows. */
  modelCapability: ModelCapability;

  /** Maximum continuable user/tool turns retained verbatim (default: 2). */
  keepRecentTurns?: number;

  /** Tail token ceiling; also capped at 25% of the post-compaction input budget (default: 20k). */
  keepRecentTokens?: number;

  /** Compact at this fraction of the context window, clamped to 0.05-0.95 (default: 0.8). */
  thresholdFraction?: number;

  /**
   * Source used to measure context occupancy after a model turn.
   * Agentic providers whose usage is cumulative across internal steps must use
   * `transcript-estimate` instead of treating billed usage as prompt size. The
   * runtimes currently select this exception for Claude Code runs.
   */
  thresholdInputSource?: "usage" | "transcript-estimate";

  /**
   * The model used to generate summaries.
   *
   * - `current`: use the agent's current `state.model`.
   * - a model instance: reuse it for summarization.
   * - a factory: create an isolated model for every summary request.
   */
  summaryModel?: CompactionSummaryModel;

  /** Override summary system prompt. */
  summarySystem?: string;

  /** Builds initial summary prompt from transcript text. */
  buildSummaryPrompt?: (prefix: string) => string;

  /** Builds update prompt from previous summary + new transcript chunk. */
  buildSummaryUpdatePrompt?: (previousSummary: string, nextTranscript: string) => string;

  /** Resolves the configured summary model's context window. */
  resolveSummaryContextLimit?: (params: {
    abortSignal?: AbortSignal;
  }) => Promise<number | undefined> | number | undefined;

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

  /** Builds the full provider-facing view of canonical history. */
  prepareFullModelView?: PrepareFullModelView;

  /** Builds the target-protocol-safe complete view used only for estimates and compaction. */
  prepareFullBudgetView?: PrepareFullBudgetView;

  /** Builds request-only messages included in estimates and regenerated for payloads. */
  buildEphemeralOverlay?: BuildEphemeralOverlay;

  /** Optional conservative floor for provider-native input occupancy. */
  inputEstimateFloor?: AutoCompactionInputEstimateFloor;

  /** Earliest current-input offset that compaction must retain canonically. */
  resolveCurrentInputCanonicalStart?: (canonicalMessages: readonly ModelMessage[]) => number | null;

  /** Applies provider-specific metadata only to the final selected request payload. */
  decorateRequestPayload?: DecorateRequestPayload;

  /** Optional provider-native compaction lane; local summary remains the portable fallback. */
  serverCompaction?: ServerCompactionFn;

  /** Dynamic gate used when the active model may change during a run. */
  serverCompactionEnabled?: () => boolean;

  /** Reports native-lane failure before the local compaction result is used. */
  onServerCompactionError?: ServerCompactionErrorHandler;

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
} & CompactionStreamHooks;

export type ManualCompactionOptions = {
  /** Idle persisted transcript to compact. The input array is not mutated. */
  messages: readonly ModelMessage[];

  /** Model currently associated with the transcript. */
  currentModel: LanguageModel;

  /** Current model context-window limit. */
  contextLimit: number;

  /** Context window of `summaryModel`; defaults to `contextLimit`. */
  summaryContextLimit?: number;

  /** Current model output limit, used to reserve response capacity. */
  outputLimit?: number;

  /** Compact to this fraction of the context window, clamped to 0.05-0.95 (default: 0.8). */
  thresholdFraction?: number;

  /** Maximum continuable user/tool turns retained verbatim (default: 2). */
  keepRecentTurns?: number;

  /** Tail token ceiling; also capped at 25% of the post-compaction input budget (default: 20k). */
  keepRecentTokens?: number;

  /** Summary model or per-request factory. `current` uses `currentModel` (default: `current`). */
  summaryModel?: CompactionSummaryModel;

  /** Provider-specific options forwarded to summary model calls. */
  providerOptions?: { [x: string]: JSONObject };

  /** Optional provider-native compaction lane; local summary remains the portable fallback. */
  serverCompaction?: ServerCompactionFn;

  /** Model request context supplied to the provider-native compaction lane. */
  serverCompactionContext?: TransformMessagesContext;

  /** Reports native-lane failure before the local compaction result is used. */
  onServerCompactionError?: ServerCompactionErrorHandler;

  /** Override summary system prompt. */
  summarySystem?: string;

  /** Builds initial summary prompt from transcript text. */
  buildSummaryPrompt?: (prefix: string) => string;

  /** Builds update prompt from previous summary + new transcript chunk. */
  buildSummaryUpdatePrompt?: (previousSummary: string, nextTranscript: string) => string;

  abortSignal?: AbortSignal;
} & CompactionStreamHooks;

type ManualCompactionMetrics = {
  messages: ModelMessage[];
  /** Summary text written into the transcript; absent when nothing was summarized. */
  summary?: string;
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
      reason: "empty" | "no-compactable-messages" | "already-minimal";
    });

type CompactRepairedMessagesOptions = {
  messages: readonly ModelMessage[];
  budget: InputCompactionBudget;
  summaryContextLimit: number;
  resolveModel: () => LanguageModel;
  providerOptions?: { [x: string]: JSONObject };
  keepRecentTurns: number;
  keepRecentTokens: number;
  summarySystem: string;
  buildSummaryPrompt: (prefix: string) => string;
  buildSummaryUpdatePrompt: (previousSummary: string, nextTranscript: string) => string;
  forceCompaction?: boolean;
  serverCompaction?: ServerCompactionFn;
  serverCompactionEnabled?: () => boolean;
  serverCompactionContext?: TransformMessagesContext;
  onServerCompactionError?: ServerCompactionErrorHandler;
  abortSignal?: AbortSignal;
} & CompactionStreamHooks;

type CompactRepairedMessagesResult = {
  messages: ModelMessage[];
  summary: string;
  serverMessages?: ModelMessage[];
};

async function compactRepairedMessages(
  options: CompactRepairedMessagesOptions,
): Promise<ResultType<CompactRepairedMessagesResult | null, AutoCompactionFailed>> {
  const maxCompactionPasses = DEFAULT_COMPACTION_MAX_PASSES;
  let passKeepRecentTokens = resolveRetainedTailTokenCap(
    options.budget.inputBudget,
    options.keepRecentTokens,
  );
  let compactedCandidate: ModelMessage[] | null = null;
  let persistedSummary = "";
  let serverCompactionMessages: readonly ModelMessage[] | null = null;

  for (let pass = 0; pass < maxCompactionPasses; pass++) {
    const boundary = resolveCompactionBoundary({
      messages: options.messages,
      keepRecentTokens: passKeepRecentTokens,
      keepRecentTurns: options.keepRecentTurns,
      forceCompaction: options.forceCompaction,
    });

    const historyMessages = options.messages.slice(0, boundary.suffixStart);
    const suffixMessages = options.messages.slice(boundary.suffixStart);

    if (historyMessages.length === 0) {
      break;
    }

    const passScale = Math.pow(0.7, pass);
    const summaryPromptReserve = Math.min(
      DEFAULT_SUMMARY_PROMPT_RESERVE_TOKENS,
      Math.floor(options.summaryContextLimit * DEFAULT_SUMMARY_PROMPT_RESERVE_FRACTION),
    );
    const chunkTokenBudget = Math.max(
      1,
      Math.floor(
        (options.summaryContextLimit - summaryPromptReserve) *
          DEFAULT_SUMMARY_CHUNK_FRACTION *
          passScale,
      ),
    );
    const summaryMaxChars = Math.max(
      DEFAULT_SUMMARY_MAX_CHARS_FLOOR,
      Math.floor(options.budget.inputBudget * 4 * passScale),
    );

    const summarizedResult = await summarizeMessagesHierarchicalResult({
      messages: historyMessages,
      initialChunkTokenBudget: chunkTokenBudget,
      maxReductionPasses: DEFAULT_SUMMARY_REDUCTION_PASSES,
      initialMaxCharsPerMessage: Math.max(2_000, chunkTokenBudget * 4),
      initialMaxCharsTotal: Math.max(4_000, chunkTokenBudget * 6),
      stage: "history",
      summarizeChunk: async (transcriptText, previousSummary, abortSignal, progress) => {
        const prompt = previousSummary
          ? options.buildSummaryUpdatePrompt(previousSummary, transcriptText)
          : options.buildSummaryPrompt(transcriptText);
        return await summarizePrompt({
          model: options.resolveModel(),
          system: options.summarySystem,
          prompt,
          providerOptions: options.providerOptions,
          abortSignal,
          onDelta: options.onSummaryDelta
            ? (delta) => options.onSummaryDelta?.(delta, progress)
            : undefined,
        });
      },
      onProgress: options.onProgress,
      abortSignal: options.abortSignal,
    });
    const summarizedOutcome = summarizedResult.match<
      { type: "ok"; value: string } | { type: "error"; error: AutoCompactionFailed }
    >({
      ok: (value) => ({ type: "ok" as const, value }),
      err: (error) => ({ type: "error" as const, error }),
    });
    if (summarizedOutcome.type === "error") return Result.err(summarizedOutcome.error);
    let finalSummary = summarizedOutcome.value.trim();
    if (!finalSummary) {
      return Result.err(
        autoCompactionFailure(
          new Error("Compaction summarization returned no summary for selected transcript."),
        ),
      );
    }

    finalSummary = truncateText(finalSummary, summaryMaxChars);
    persistedSummary = finalSummary;
    const summaryMessage = buildCompactionSummaryMessage(finalSummary);
    const passCompacted = repairTranscriptForCompaction([
      summaryMessage,
      ...suffixMessages,
    ]).messages;
    compactedCandidate = passCompacted;
    serverCompactionMessages = historyMessages;

    if (estimateMessagesTokens(passCompacted) <= options.budget.inputBudget) {
      break;
    }

    passKeepRecentTokens = Math.max(1, Math.floor(passKeepRecentTokens * 0.6));
  }

  if (!compactedCandidate) return Result.ok(null);

  // Final shrinking can truncate the summary; report the post-shrink text so
  // the persisted summary never diverges from the committed model context.
  const localCompactionResult = shrinkCompactedMessagesToBudgetResult({
    messages: compactedCandidate,
    inputBudget: options.budget.inputBudget,
    summary: persistedSummary,
  });
  const localCompactionOutcome = localCompactionResult.match<
    | { type: "ok"; value: { messages: ModelMessage[]; summary: string } }
    | { type: "error"; error: AutoCompactionFailed }
  >({
    ok: (value) => ({ type: "ok" as const, value }),
    err: (error) => ({ type: "error" as const, error }),
  });
  if (localCompactionOutcome.type === "error") return Result.err(localCompactionOutcome.error);
  const localCompaction = localCompactionOutcome.value;

  if (
    !options.serverCompaction ||
    !serverCompactionMessages ||
    options.serverCompactionEnabled?.() === false
  ) {
    return Result.ok(localCompaction);
  }

  const serverCompacted = resultOutcome(
    await captureAgentPromise(() =>
      options.serverCompaction!({
        messages: serverCompactionMessages,
        portableSummary: localCompaction.summary,
        context: options.serverCompactionContext,
        abortSignal: options.abortSignal,
      }),
    ),
  );
  if (serverCompacted.ok) {
    const artifact = serverCompacted.value;
    const retainedUserBudget = resolveRetainedTailTokenCap(
      options.budget.inputBudget,
      options.keepRecentTokens,
    );
    const retainedUsers = retainServerCompactionUserMessages(
      serverCompactionMessages,
      retainedUserBudget,
    );
    const suffix = localCompaction.messages.slice(1);
    let nativeMessages: ModelMessage[] = [
      ...retainedUsers,
      { role: "assistant", content: [artifact.part] },
      ...suffix,
    ];
    while (
      retainedUsers.length > 0 &&
      estimateMessagesTokens(nativeMessages) > options.budget.inputBudget
    ) {
      retainedUsers.shift();
      nativeMessages = [
        ...retainedUsers,
        { role: "assistant", content: [artifact.part] },
        ...suffix,
      ];
    }
    return Result.ok(
      estimateMessagesTokens(nativeMessages) <= options.budget.inputBudget
        ? { ...localCompaction, serverMessages: nativeMessages }
        : localCompaction,
    );
  }
  const error = serverCompacted.error;
  rethrowAgentPanic(error);
  if (options.abortSignal?.aborted === true) {
    return Result.err(autoCompactionFailure(error));
  }
  options.onServerCompactionError?.(error);
  return Result.ok(localCompaction);
}

/**
 * Whether a thrown value is an abort rather than a genuine failure.
 *
 * `AbortSignal.throwIfAborted()` and the AI SDK both surface aborts as an error
 * named `AbortError`, but neither is an instance of a shared class, so the name
 * is the only portable discriminator.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Provider options for summarization calls.
 *
 * Summarization reads only the response text, so reasoning summaries are
 * generated and thrown away. The auto path forwards the agent's turn options
 * wholesale, which for a codex session requests `reasoningSummary: "detailed"`
 * on every summarization request; strip it so both paths agree and neither pays
 * for output nobody reads.
 */
export function buildSummaryProviderOptions(
  providerOptions: { [x: string]: JSONObject } | undefined,
): { [x: string]: JSONObject } | undefined {
  if (!providerOptions) return undefined;
  const entries = Object.entries(providerOptions).map(([provider, settings]) => {
    if (!("reasoningSummary" in settings)) return [provider, settings] as const;
    const { reasoningSummary: _dropped, ...rest } = settings;
    return [provider, rest] as const;
  });
  return Object.fromEntries(entries);
}

function pickSummaryContextLimit(params: {
  summaryContextLimit: number | undefined;
  fallbackContextLimit: number;
}): number {
  const summaryLimit = params.summaryContextLimit;
  if (typeof summaryLimit === "number" && Number.isFinite(summaryLimit) && summaryLimit > 0) {
    return Math.max(1, Math.floor(summaryLimit));
  }
  return Math.max(1, Math.floor(params.fallbackContextLimit));
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
  const noop = (
    reason: "empty" | "no-compactable-messages" | "already-minimal",
  ): ManualCompactionResult => {
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
  const compactedResult = await compactRepairedMessages({
    messages: compactableMessages,
    budget,
    summaryContextLimit: pickSummaryContextLimit({
      summaryContextLimit: options.summaryContextLimit,
      fallbackContextLimit: options.contextLimit,
    }),
    resolveModel: () => resolveSummaryModel(summaryModel, options.currentModel),
    providerOptions: buildSummaryProviderOptions(options.providerOptions),
    serverCompaction: options.serverCompaction,
    serverCompactionContext: options.serverCompactionContext,
    onServerCompactionError: options.onServerCompactionError,
    keepRecentTurns: options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
    keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    summarySystem: options.summarySystem ?? DEFAULT_SUMMARY_SYSTEM,
    buildSummaryPrompt: options.buildSummaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
    buildSummaryUpdatePrompt: options.buildSummaryUpdatePrompt ?? DEFAULT_SUMMARY_UPDATE_PROMPT,
    abortSignal: options.abortSignal,
    onProgress: options.onProgress,
    onSummaryDelta: options.onSummaryDelta,
  });
  const compactedOutcome = resultOutcome(compactedResult);
  if (!compactedOutcome.ok) return signalAutoCompactionHost(compactedOutcome.error);
  const compacted = compactedOutcome.value;
  if (!compacted) return noop("already-minimal");

  const messages = cloneMessages(compacted.messages);
  return {
    status: "compacted",
    messages,
    summary: compacted.summary,
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

  const resolvedModel = resultOutcome(
    await captureAgentPromise(() =>
      params.options.modelCapability.resolve(spec, {
        signal: params.abortSignal,
      }),
    ),
  );
  if (!resolvedModel.ok) rethrowAgentPanic(resolvedModel.error);
  const modelInfo = resolvedModel.ok ? resolvedModel.value : undefined;
  const modelResolveError = resolvedModel.ok ? undefined : resolvedModel.error;
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

async function chooseCanonicalRetainedTailStart(params: {
  canonicalMessages: readonly ModelMessage[];
  prepareFullModelView: PrepareFullModelView;
  context: TransformMessagesContext;
  keepRecentTokens: number;
  keepRecentTurns: number;
  minimumStart?: number;
  canonicalStartIndex?: number;
}): Promise<number> {
  const tokenCap = Math.max(0, Math.floor(params.keepRecentTokens));
  const turnCap = Math.max(0, Math.floor(params.keepRecentTurns));
  if (params.canonicalMessages.length === 0 || tokenCap === 0 || turnCap === 0) {
    return params.canonicalMessages.length;
  }

  const turnStarts: number[] = [];
  for (let index = 0; index < params.canonicalMessages.length; index += 1) {
    if (isContinuableTurnStart(params.canonicalMessages, index)) turnStarts.push(index);
  }

  for (const [turnIndex, start] of turnStarts.entries()) {
    if (start < (params.minimumStart ?? 0)) continue;
    if (turnStarts.length - turnIndex > turnCap) continue;
    if (!isValidSuffix(params.canonicalMessages, start)) continue;
    const preparedSuffix = await params.prepareFullModelView(
      params.canonicalMessages.slice(start),
      {
        ...params.context,
        canonicalStartIndex: (params.canonicalStartIndex ?? 0) + start,
      },
    );
    if (estimateMessagesTokens(preparedSuffix) <= tokenCap) return start;
  }

  return params.canonicalMessages.length;
}

type CompactCanonicalMessagesResult = {
  readonly canonicalMessages: ModelMessage[];
  readonly preparedMessages: ModelMessage[];
  readonly summary: string;
  readonly usesServerCompaction: boolean;
  readonly originalCanonicalSuffixStart: number;
};

async function compactCanonicalMessages(options: {
  canonicalMessages: readonly ModelMessage[];
  prepareFullModelView: PrepareFullModelView;
  overlay: readonly ModelMessage[];
  context: TransformMessagesContext;
  budget: InputCompactionBudget;
  summaryContextLimit: number;
  resolveModel: () => LanguageModel;
  providerOptions?: { [x: string]: JSONObject };
  keepRecentTurns: number;
  keepRecentTokens: number;
  summarySystem: string;
  buildSummaryPrompt: (prefix: string) => string;
  buildSummaryUpdatePrompt: (previousSummary: string, nextTranscript: string) => string;
  forceCompaction: boolean;
  serverCompaction?: ServerCompactionFn;
  serverCompactionEnabled?: () => boolean;
  onServerCompactionError?: (error: unknown) => void;
  abortSignal?: AbortSignal;
  onProgress?: CompactionStreamHooks["onProgress"];
  onSummaryDelta?: CompactionStreamHooks["onSummaryDelta"];
  maximumCanonicalSuffixStart?: number;
}): Promise<ResultType<CompactCanonicalMessagesResult | null, AutoCompactionFailed>> {
  const overlayTokens = estimateMessagesTokens(options.overlay);
  if (overlayTokens >= options.budget.inputBudget) {
    return Result.err(
      autoCompactionFailure(new Error("Ephemeral overlay exceeds the compaction input budget.")),
    );
  }

  let retainedTokenCap = Math.min(
    resolveRetainedTailTokenCap(options.budget.inputBudget, options.keepRecentTokens),
    options.budget.inputBudget - overlayTokens,
  );

  for (let pass = 0; pass < DEFAULT_COMPACTION_MAX_PASSES; pass += 1) {
    let suffixStart = await chooseCanonicalRetainedTailStart({
      canonicalMessages: options.canonicalMessages,
      prepareFullModelView: options.prepareFullModelView,
      context: options.context,
      keepRecentTokens: retainedTokenCap,
      keepRecentTurns: options.keepRecentTurns,
    });
    if (options.forceCompaction && suffixStart === 0) {
      suffixStart = await chooseCanonicalRetainedTailStart({
        canonicalMessages: options.canonicalMessages,
        prepareFullModelView: options.prepareFullModelView,
        context: options.context,
        keepRecentTokens: retainedTokenCap,
        keepRecentTurns: options.keepRecentTurns,
        minimumStart: 1,
      });
    }
    if (
      options.maximumCanonicalSuffixStart !== undefined &&
      suffixStart > options.maximumCanonicalSuffixStart
    ) {
      suffixStart = options.maximumCanonicalSuffixStart;
    }
    if (suffixStart === 0) return Result.ok(null);

    const canonicalPrefix = options.canonicalMessages.slice(0, suffixStart);
    const canonicalSuffix = options.canonicalMessages.slice(suffixStart);
    const transformedPrefix = repairTranscriptForCompaction(
      await options.prepareFullModelView(canonicalPrefix, {
        ...options.context,
        canonicalStartIndex: 0,
      }),
    ).messages;
    if (transformedPrefix.length === 0) return Result.ok(null);
    const transformedSuffix = await options.prepareFullModelView(canonicalSuffix, {
      ...options.context,
      canonicalStartIndex: suffixStart,
    });
    const suffixAndOverlayTokens = estimateMessagesTokens([
      ...transformedSuffix,
      ...options.overlay,
    ]);
    if (suffixAndOverlayTokens >= options.budget.inputBudget) {
      retainedTokenCap = Math.max(0, Math.floor(retainedTokenCap * 0.6));
      continue;
    }

    const prefixBudget: InputCompactionBudget = {
      ...options.budget,
      inputBudget: options.budget.inputBudget - suffixAndOverlayTokens,
    };
    const compactedPrefixOutcome = resultOutcome(
      await compactRepairedMessages({
        messages: transformedPrefix,
        budget: prefixBudget,
        summaryContextLimit: options.summaryContextLimit,
        resolveModel: options.resolveModel,
        providerOptions: options.providerOptions,
        keepRecentTurns: 0,
        keepRecentTokens: 0,
        summarySystem: options.summarySystem,
        buildSummaryPrompt: options.buildSummaryPrompt,
        buildSummaryUpdatePrompt: options.buildSummaryUpdatePrompt,
        forceCompaction: true,
        serverCompaction: options.serverCompaction,
        serverCompactionEnabled: options.serverCompactionEnabled,
        serverCompactionContext: options.context,
        onServerCompactionError: options.onServerCompactionError,
        abortSignal: options.abortSignal,
        onProgress: options.onProgress,
        onSummaryDelta: options.onSummaryDelta,
      }),
    );
    if (!compactedPrefixOutcome.ok) return Result.err(compactedPrefixOutcome.error);
    const compactedPrefix = compactedPrefixOutcome.value;
    if (!compactedPrefix) return Result.ok(null);

    const summaryMessage = buildCompactionSummaryMessage(compactedPrefix.summary);
    const canonicalMessages = [summaryMessage, ...cloneMessages(canonicalSuffix)];
    const localPrepared = [summaryMessage, ...transformedSuffix];
    const preparedMessages = compactedPrefix.serverMessages
      ? [...compactedPrefix.serverMessages, ...transformedSuffix]
      : localPrepared;
    const estimate = estimateModelInputTokens({
      messages: [...preparedMessages, ...options.overlay],
      context: options.context,
    });
    if (estimate <= options.budget.inputBudget) {
      return Result.ok({
        canonicalMessages,
        preparedMessages,
        summary: compactedPrefix.summary,
        usesServerCompaction: compactedPrefix.serverMessages !== undefined,
        originalCanonicalSuffixStart: suffixStart,
      });
    }
    retainedTokenCap = Math.max(0, Math.floor(retainedTokenCap * 0.6));
  }

  return Result.err(
    autoCompactionFailure(
      new Error("Compaction could not fit the canonical summary and untouched suffix."),
    ),
  );
}

export async function attachAutoCompaction(
  agent: AiSdkPiAgent,
  options: AutoCompactionOptions,
): Promise<() => void> {
  if (options.enabled === false) return () => {};

  const thresholdFraction = normalizeThresholdFraction(options.thresholdFraction);
  const thresholdInputSource = options.thresholdInputSource ?? "usage";
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  const summaryModel = options.summaryModel ?? "current";
  const summarySystem = options.summarySystem ?? DEFAULT_SUMMARY_SYSTEM;
  const buildSummaryPrompt = options.buildSummaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
  const buildSummaryUpdatePrompt =
    options.buildSummaryUpdatePrompt ?? DEFAULT_SUMMARY_UPDATE_PROMPT;
  const overflowRecoveryMaxAttempts =
    options.overflowRecoveryMaxAttempts ?? DEFAULT_OVERFLOW_RECOVERY_MAX_ATTEMPTS;

  let pendingCompactionReason: PendingCompactionReason | null = null;
  let inCompaction = false;
  let overflowRecoveryAttempts = 0;
  let lengthCompactionScheduled = false;
  let lastTurnInputTokens: number | null = null;
  let lastModelInputEstimate: number | null = null;

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

  const scheduleCompaction = (reason: PendingCompactionReason) => {
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
  const restoredLastMessage = agent.state.messages[agent.state.messages.length - 1];
  if (restoredLastMessage && isAutoContinueMessage(restoredLastMessage)) {
    scheduleCompaction("threshold");
  }

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
        return signalAutoCompactionHost(autoCompactionFailure(decision.terminalError));
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
    return "retry";
  };

  const unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
    if (event.type === "agent_start") {
      lengthCompactionScheduled = false;
      return;
    }
    if (event.type !== "turn_end") return;

    overflowRecoveryAttempts = 0;

    if (event.finishReason === "length") {
      if (!lengthCompactionScheduled) {
        lengthCompactionScheduled = true;
        scheduleCompaction("overflow");
      }
      return;
    }

    const inputTokens = resolveThresholdInputTokens({
      source: thresholdInputSource,
      usageInputTokens: event.usage.inputTokens,
      messages: agent.state.messages,
      modelInputEstimate: lastModelInputEstimate ?? undefined,
    });
    if (typeof inputTokens !== "number" || inputTokens <= 0) {
      lastTurnInputTokens = null;
      return;
    }

    lastTurnInputTokens = inputTokens;

    const budget = resolveKnownInputBudget();
    if (!budget) return;
    if (!evaluateThresholdWithBudget(inputTokens, budget.inputBudget)) return;
    // A terminal turn should end normally. The next inbound request performs
    // an estimate-based preflight; overflow recovery remains the final guard.
    if (event.finishReason !== "tool-calls") return;
    scheduleCompaction("threshold");
  });

  const prepareBase: PrepareFullModelView = options.prepareFullModelView ?? cloneMessages;
  const prepareBudgetBase: PrepareFullBudgetView = options.prepareFullBudgetView ?? prepareBase;
  let nativeCompactionView:
    | {
        canonicalPrefix: ModelMessage[];
        preparedPrefix: ModelMessage[];
      }
    | undefined;
  const hasCanonicalPrefix = (
    messages: readonly ModelMessage[],
    prefix: readonly ModelMessage[],
  ): boolean =>
    prefix.length <= messages.length &&
    prefix.every(
      (message, index) => stringifyUnknown(message) === stringifyUnknown(messages[index]),
    );

  const prepareCachedModelView = async (
    messages: readonly ModelMessage[],
    context: TransformMessagesContext,
    prepare: PrepareFullModelView,
  ): Promise<ModelMessage[]> => {
    if (
      nativeCompactionView &&
      options.serverCompactionEnabled?.() !== false &&
      hasCanonicalPrefix(messages, nativeCompactionView.canonicalPrefix)
    ) {
      const cachedView = [
        ...cloneMessages(nativeCompactionView.preparedPrefix),
        ...cloneMessages(messages.slice(nativeCompactionView.canonicalPrefix.length)),
      ];
      // Replay preparation owns current-key activation and lowers artifacts
      // that are incompatible with the active target to their portable summary.
      return await prepare(cachedView, context);
    }
    return await prepare(messages, context);
  };
  const preparePreparedModelView: PrepareFullBudgetView = (messages, context) =>
    prepareCachedModelView(messages, context, prepareBudgetBase);
  const preparePayloadModelView: PrepareFullModelView = (messages, context) =>
    prepareCachedModelView(messages, context, prepareBase);

  const resolveInputEstimate = async (input: {
    readonly canonicalMessages: readonly ModelMessage[];
    readonly preparedFullView: readonly ModelMessage[];
    readonly overlay: readonly ModelMessage[];
    readonly context: TransformMessagesContext;
  }): Promise<
    ResultType<
      {
        readonly ordinary: number;
        readonly floor: number | null;
        readonly effective: number;
      },
      AutoCompactionFailed
    >
  > => {
    const ordinary = estimateModelInputTokens({
      messages: [...input.preparedFullView, ...input.overlay],
      context: input.context,
    });
    if (!options.inputEstimateFloor) {
      return Result.ok({ ordinary, floor: null, effective: ordinary });
    }
    const floor = await options.inputEstimateFloor({
      ...input,
      ordinaryModelInputEstimate: ordinary,
      estimateMessagesTokens,
    });
    if (floor === null) return Result.ok({ ordinary, floor: null, effective: ordinary });
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
      return Result.err(
        autoCompactionFailure(
          new TypeError(
            "Auto-compaction input estimate floor must return null or a finite non-negative number",
          ),
        ),
      );
    }
    return Result.ok({ ordinary, floor, effective: Math.max(ordinary, floor) });
  };

  const canonicalModelCallPreflight: CanonicalModelCallPreflight = async (messages, context) => {
    const canonicalSeparated = splitThresholdContinueTrailer(messages);
    const canonicalMessages = [...canonicalSeparated.messages, ...canonicalSeparated.trailer];
    if (canonicalMessages.length !== messages.length) {
      agent.replaceMessages(canonicalMessages, {
        reason: "replace",
        preserveRecoveryCheckpoint: true,
      });
    }

    const canonicalReference = agent.state.messages;
    const maybeTransformed = await preparePreparedModelView(canonicalMessages, context);
    // Provider rejection recovery may intentionally repair canonical server-compaction artifacts.
    // Let the agent refresh from that repaired canonical state before making further decisions.
    if (agent.state.messages !== canonicalReference) return;
    const overlay = options.buildEphemeralOverlay
      ? await options.buildEphemeralOverlay(context)
      : [];
    const fullBudgetView = [...maybeTransformed, ...overlay];
    // Model-view transforms may omit media for transport safety. That is not
    // evidence of token pressure: only provider usage, text fallback estimates,
    // or an actual context overflow may schedule transcript compaction.
    const inputEstimateResult = await resolveInputEstimate({
      canonicalMessages,
      preparedFullView: maybeTransformed,
      overlay,
      context,
    });
    const inputEstimateOutcome = resultOutcome(inputEstimateResult);
    if (!inputEstimateOutcome.ok) return signalAutoCompactionHost(inputEstimateOutcome.error);
    const inputEstimate = inputEstimateOutcome.value;
    const modelInputEstimate = inputEstimate.effective;
    lastModelInputEstimate = modelInputEstimate;
    const providerInputTokens = thresholdInputSource === "usage" ? lastTurnInputTokens : null;
    let observedInputTokens = modelInputEstimate;
    if (providerInputTokens !== null) {
      observedInputTokens =
        inputEstimate.floor === null
          ? providerInputTokens
          : Math.max(providerInputTokens, inputEstimate.effective);
    }
    const inputTokenSource =
      providerInputTokens === null ||
      (inputEstimate.floor !== null && inputEstimate.effective > providerInputTokens)
        ? "text-estimate"
        : "provider-usage";

    const latestCapability = await refreshContextLimit(context.abortSignal);
    pendingCompactionReason = reconcilePendingCompactionReason({
      pendingReason: pendingCompactionReason,
      capabilityKnown: latestCapability.known,
    });

    if (latestCapability.known) {
      const latestBudget = computeInputCompactionBudget({
        contextLimit: latestCapability.contextLimit,
        outputLimit: latestCapability.outputLimit,
        thresholdFraction,
      });
      if (
        pendingCompactionReason === "threshold" &&
        !evaluateThresholdWithBudget(observedInputTokens, latestBudget.inputBudget)
      ) {
        pendingCompactionReason = null;
      }

      if (
        pendingCompactionReason === null &&
        evaluateThresholdWithBudget(observedInputTokens, latestBudget.inputBudget)
      ) {
        scheduleCompaction("threshold");
      }
    }

    if (!pendingCompactionReason || inCompaction) return;

    const lastMessage =
      maybeTransformed.length > 0 ? maybeTransformed[maybeTransformed.length - 1] : undefined;

    // Be conservative: compact only when context ends with user/tool.
    if (lastMessage?.role === "assistant") return;

    const separated = canonicalSeparated;
    const compactableMessages = separated.messages;
    if (compactableMessages.length === 0) return;

    const pendingReason = pendingCompactionReason;
    const estimatedFullViewTokens = estimateMessagesTokens(fullBudgetView);
    const floorAwareFullViewTokens =
      inputEstimate.floor === null ? estimatedFullViewTokens : inputEstimate.effective;
    const activeBudget = resolveActiveCompactionBudget({
      capability: latestCapability,
      reason: pendingReason,
      estimatedInputTokens: floorAwareFullViewTokens,
    });
    if (!activeBudget) return;

    if (pendingReason === "threshold") {
      const retainedTailTokenCap = resolveRetainedTailTokenCap(
        activeBudget.inputBudget,
        keepRecentTokens,
      );
      const boundary = await chooseCanonicalRetainedTailStart({
        canonicalMessages: compactableMessages,
        prepareFullModelView: prepareBudgetBase,
        context,
        keepRecentTokens: retainedTailTokenCap,
        keepRecentTurns,
      });
      if (boundary === 0) {
        pendingCompactionReason = null;
        return;
      }
    }

    const estimatedInputTokens = floorAwareFullViewTokens;
    const eventObservedInputTokens =
      pendingReason === "overflow" ? modelInputEstimate : observedInputTokens;
    const eventInputTokenSource = pendingReason === "overflow" ? "text-estimate" : inputTokenSource;
    const compactionStart = Date.now();
    const compactionEventBase: AutoCompactionStartEvent = {
      spec: latestCapability.spec,
      reason: pendingReason,
      messageCountBefore: compactableMessages.length,
      observedInputTokens: eventObservedInputTokens,
      inputTokenSource: eventInputTokenSource,
      estimatedInputTokens,
      budget: {
        inputBudget: activeBudget.inputBudget,
        safeInputBudget: activeBudget.safeInputBudget,
        reservedOutputTokens: activeBudget.reservedOutputTokens,
      },
    };

    inCompaction = true;
    const compactedAttempt = resultOutcome(
      await captureAgentPromise(async () => {
        options.onCompactionStart?.(compactionEventBase);

        const preparedTrailer = await prepareBudgetBase(separated.trailer, {
          ...context,
          canonicalStartIndex: separated.messages.length,
        });
        const trailerTokens = estimateMessagesTokens(preparedTrailer);
        if (trailerTokens >= activeBudget.inputBudget) {
          return signalAutoCompactionHost(
            autoCompactionFailure(
              new Error("Compaction continuation trailer exceeds the input budget."),
            ),
          );
        }
        const contentBudget = {
          ...activeBudget,
          inputBudget: activeBudget.inputBudget - trailerTokens,
        };

        const summaryContextLimit = pickSummaryContextLimit({
          summaryContextLimit: await options.resolveSummaryContextLimit?.({
            abortSignal: context.abortSignal,
          }),
          fallbackContextLimit: latestCapability.known
            ? latestCapability.contextLimit
            : Math.max(2_048, Math.floor(activeBudget.inputBudget * 1.5)),
        });
        const compactionResult = await compactCanonicalMessages({
          canonicalMessages: compactableMessages,
          prepareFullModelView: prepareBudgetBase,
          overlay,
          context,
          budget: contentBudget,
          summaryContextLimit,
          resolveModel: () => resolveSummaryModel(summaryModel, agent.state.model),
          providerOptions: buildSummaryProviderOptions(agent.state.providerOptions),
          serverCompaction: options.serverCompaction,
          serverCompactionEnabled: options.serverCompactionEnabled,
          onServerCompactionError: options.onServerCompactionError,
          keepRecentTurns,
          keepRecentTokens,
          summarySystem,
          buildSummaryPrompt,
          buildSummaryUpdatePrompt,
          forceCompaction: pendingReason === "overflow",
          onProgress: options.onProgress,
          onSummaryDelta: options.onSummaryDelta,
          abortSignal: context.abortSignal,
          maximumCanonicalSuffixStart: (() => {
            const currentStart = options.resolveCurrentInputCanonicalStart?.(canonicalMessages);
            if (currentStart === null || currentStart === undefined) return undefined;
            if (
              !Number.isSafeInteger(currentStart) ||
              currentStart < 0 ||
              currentStart > canonicalMessages.length
            ) {
              return signalAutoCompactionHost(
                autoCompactionFailure(
                  new RangeError(
                    "Current-input canonical start is outside the compaction transcript",
                  ),
                ),
              );
            }
            return Math.min(currentStart, compactableMessages.length);
          })(),
        });
        const compactionResultOutcome = resultOutcome(compactionResult);
        if (!compactionResultOutcome.ok) {
          return signalAutoCompactionHost(compactionResultOutcome.error);
        }
        const compactionOutcome = compactionResultOutcome.value;

        if (!compactionOutcome)
          return signalAutoCompactionHost(
            autoCompactionFailure(
              new Error("Compaction could not select transcript content for summarization."),
            ),
          );
        const compacted = [...compactionOutcome.canonicalMessages, ...separated.trailer];
        const preparedCompacted = [...compactionOutcome.preparedMessages, ...preparedTrailer];
        nativeCompactionView = compactionOutcome.usesServerCompaction
          ? {
              canonicalPrefix: cloneMessages(compacted),
              preparedPrefix: cloneMessages(preparedCompacted),
            }
          : undefined;

        agent.replaceMessages(compacted, { reason: "compaction" });

        const refreshedOverlay = options.buildEphemeralOverlay
          ? await options.buildEphemeralOverlay(context)
          : [];
        const refreshedFullView = [...preparedCompacted, ...refreshedOverlay];
        const refreshedInputEstimateResult = await resolveInputEstimate({
          canonicalMessages: compacted,
          preparedFullView: preparedCompacted,
          overlay: refreshedOverlay,
          context,
        });
        const refreshedInputEstimateOutcome = resultOutcome(refreshedInputEstimateResult);
        if (!refreshedInputEstimateOutcome.ok) {
          return signalAutoCompactionHost(refreshedInputEstimateOutcome.error);
        }
        const refreshedInputEstimate = refreshedInputEstimateOutcome.value;
        lastModelInputEstimate = refreshedInputEstimate.effective;
        if (latestCapability.known) {
          pendingCompactionReason =
            refreshedInputEstimate.effective > activeBudget.inputBudget ? "threshold" : null;
        } else {
          pendingCompactionReason = null;
        }

        const refreshedMessageEstimate = estimateMessagesTokens(refreshedFullView);
        const refreshedEventEstimate =
          refreshedInputEstimate.floor === null
            ? refreshedMessageEstimate
            : refreshedInputEstimate.effective;
        options.onCompactionEnd?.({
          ...compactionEventBase,
          durationMs: Math.max(0, Date.now() - compactionStart),
          messageCountAfter: compacted.length,
          estimatedInputTokensAfter: refreshedEventEstimate,
          status: "completed",
          summary: compactionOutcome.summary,
          canonicalReplacement: {
            mode: compactionOutcome.usesServerCompaction ? "server" : "local",
            originalMessageCount: canonicalMessages.length,
            originalSuffixStart: compactionOutcome.originalCanonicalSuffixStart,
            replacementMessageCount: compacted.length,
            replacementSuffixStart: 1,
          },
        });
      }),
    );
    inCompaction = false;
    if (!compactedAttempt.ok) {
      const error = compactedAttempt.error;
      rethrowAgentPanic(error);
      // An aborted turn is a deliberate stop, not a compaction defect; reporting
      // it as `failed` would surface a scary error line for an ordinary cancel.
      const cancelled = context.abortSignal?.aborted === true;
      const durationMs = Math.max(0, Date.now() - compactionStart);
      if (cancelled) {
        options.onCompactionEnd?.({
          ...compactionEventBase,
          durationMs,
          status: "cancelled",
        });
      } else {
        options.onCompactionEnd?.({
          ...compactionEventBase,
          durationMs,
          status: "failed",
          error,
        });
      }
      throw error;
    }
    return;
  };

  agent.setPrepareFullModelView(preparePayloadModelView);
  agent.setPrepareFullBudgetView(preparePreparedModelView);
  agent.setCanonicalModelCallPreflight(canonicalModelCallPreflight);
  agent.setBuildEphemeralOverlay(options.buildEphemeralOverlay);
  agent.setDecorateRequestPayload(options.decorateRequestPayload);
  agent.setTurnErrorHandler(turnErrorHandler);

  return () => {
    unsubscribe();
    agent.setPrepareFullModelView(options.prepareFullModelView);
    agent.setPrepareFullBudgetView(options.prepareFullBudgetView);
    agent.setCanonicalModelCallPreflight(undefined);
    agent.setBuildEphemeralOverlay(options.buildEphemeralOverlay);
    agent.setDecorateRequestPayload(options.decorateRequestPayload);
    agent.setTurnErrorHandler(options.baseTurnErrorHandler);
  };
}

export const __autoCompactionInternals = {
  buildAutoContinueMessage,
  buildCompactionSummaryMessage,
  computeInputCompactionBudget,
  computeUnknownOverflowCompactionBudget,
  computeOverflowRecoveryDecision,
  reconcilePendingCompactionReason,
  chooseRetainedTailStart,
  hasCompletedAssistantToolTurn,
  estimateMessageTokens,
  estimateMessagesTokens,
  isValidSuffix,
  normalizeThresholdFraction,
  repairTranscriptForCompaction,
  renderMessagesForSummarySegments,
  retainServerCompactionUserMessages,
  resolveThresholdInputTokens,
  resolveContextLimit,
  resolveRetainedTailTokenCap,
  resolveCompactionBoundary,
  shrinkCompactedMessagesToBudget,
  splitThresholdContinueTrailer,
  summarizeMessagesHierarchical,
};
