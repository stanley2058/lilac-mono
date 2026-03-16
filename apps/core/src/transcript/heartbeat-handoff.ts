import type { ModelMessage, ToolContent } from "ai";

import { isHeartbeatSessionId } from "../heartbeat/common";

export { isHeartbeatSessionId } from "../heartbeat/common";

export const HEARTBEAT_HANDOFF_SESSION_ID = "__heartbeat__:handoff";
export const HEARTBEAT_HANDOFF_TOOL_RESULT_PLACEHOLDER = "[Heartbeat handoff tool result omitted]";

const HEARTBEAT_HANDOFF_TOOL_OUTPUT = {
  type: "text",
  value: HEARTBEAT_HANDOFF_TOOL_RESULT_PLACEHOLDER,
} satisfies Extract<ToolContent[number], { type: "tool-result" }>["output"];

const SURFACE_SEND_PATTERN = /\bsurface\.messages\.send\b/u;
const SURFACE_SEND_TEXT_PATTERN =
  /surface\.messages\.send\b[\s\S]*?(?:--text(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+)))/gu;

export type HeartbeatHandoffTranscript = {
  messages: ModelMessage[];
  finalText?: string;
};

export function buildHeartbeatHandoffTranscript(
  messages: readonly ModelMessage[],
): HeartbeatHandoffTranscript | null {
  if (messages.length === 0) return null;

  const compacted = compactHeartbeatHandoffMessages(messages);
  return {
    messages: compacted,
    finalText: extractAssistantSummary(compacted),
  };
}

export function extractHeartbeatSurfaceSendHandoffs(
  messages: readonly ModelMessage[],
): HeartbeatHandoffTranscript[] {
  const pendingTexts = new Map<string, string[]>();
  const out: HeartbeatHandoffTranscript[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "tool-call") continue;

        const toolCallId = part.toolCallId;
        if (!toolCallId) continue;

        const sendTexts = extractSurfaceSendTexts(part.toolName, part.input);
        if (sendTexts.length === 0) continue;

        pendingTexts.set(toolCallId, [...(pendingTexts.get(toolCallId) ?? []), ...sendTexts]);
      }
    }

    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type !== "tool-result") continue;

      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;

      const sendTexts = pendingTexts.get(toolCallId) ?? [];
      if (sendTexts.length === 0) continue;

      for (const sendText of sendTexts) {
        const handoff = buildHeartbeatHandoffTranscriptWithSendText(
          messages.slice(0, messageIndex + 1),
          sendText,
        );
        if (handoff) out.push(handoff);
      }

      pendingTexts.delete(toolCallId);
    }
  }

  return out;
}

function buildHeartbeatHandoffTranscriptWithSendText(
  messages: readonly ModelMessage[],
  sendText: string,
): HeartbeatHandoffTranscript | null {
  const trimmed = sendText.trim();
  const base = buildHeartbeatHandoffTranscript(messages);
  if (!base) return null;
  if (trimmed.length === 0) return base;

  return {
    messages: [...base.messages, { role: "assistant", content: trimmed } satisfies ModelMessage],
    finalText: trimmed,
  };
}

function compactHeartbeatHandoffMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (part?.type !== "tool-result") {
          return { ...part };
        }

        return {
          ...part,
          output: HEARTBEAT_HANDOFF_TOOL_OUTPUT,
        };
      }),
    } satisfies ModelMessage;
  });
}

function extractSurfaceSendTexts(toolName: string | undefined, input: unknown): string[] {
  if (toolName === "surface.messages.send") {
    const direct = extractDirectSurfaceSendText(input);
    return direct ? [direct] : [safeStringify(input)];
  }

  const batchTexts = extractBatchSurfaceSendTexts(input);
  if (batchTexts.length > 0) {
    return batchTexts;
  }

  const candidates = extractCandidateStrings(input);
  const extracted: string[] = [];

  for (const candidate of candidates) {
    if (!SURFACE_SEND_PATTERN.test(candidate)) continue;

    const matches = [...candidate.matchAll(SURFACE_SEND_TEXT_PATTERN)];
    if (matches.length === 0) {
      extracted.push(candidate);
      continue;
    }

    extracted.push(...matches.map((match) => match[1] ?? match[2] ?? match[3] ?? candidate));
  }

  if (extracted.length > 0) return extracted;

  const text = safeStringify(input);
  return SURFACE_SEND_PATTERN.test(text) ? [text] : [];
}

function extractDirectSurfaceSendText(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const text = (input as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : null;
}

function extractBatchSurfaceSendTexts(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];

  const toolCalls = (input as Record<string, unknown>)["tool_calls"];
  if (!Array.isArray(toolCalls)) return [];

  const texts: string[] = [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) continue;

    const tool = (toolCall as Record<string, unknown>)["tool"];
    if (tool !== "surface.messages.send") continue;

    const parameters = (toolCall as Record<string, unknown>)["parameters"];
    const text = extractDirectSurfaceSendText(parameters);
    if (text) {
      texts.push(text);
      continue;
    }

    texts.push(safeStringify(toolCall));
  }

  return texts;
}

function extractCandidateStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractCandidateStrings(item));

  return Object.values(value).flatMap((item) => extractCandidateStrings(item));
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function extractAssistantSummary(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;

    const text = extractAssistantText(message.content)?.trim();
    if (text) return text;
  }

  return undefined;
}

function extractAssistantText(content: ModelMessage["content"]): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool-call" || part.type === "tool-result") continue;
    if ("text" in part && typeof part.text === "string") {
      out.push(part.text);
    }
  }

  return out.length > 0 ? out.join("") : null;
}
