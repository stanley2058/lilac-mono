import { type ModelMessage } from "ai";
import { openAIMessagePhase } from "@stanley2058/lilac-utils";
import { resolveReplyDeliveryFromFinalText } from "../reply-directive";
import { REASONING_DETAIL_MAX_CHARS } from "./output-publisher";

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
    // One character past the relay limit is enough for the relay to mark the detail truncated.
    snapshot: { delta: chunk.slice(0, REASONING_DETAIL_MAX_CHARS + 1), seq: state.seq },
  };
}
