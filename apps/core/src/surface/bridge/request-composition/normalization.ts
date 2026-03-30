import type { ModelMessage } from "ai";

import type { TranscriptSnapshot } from "../../../transcript/transcript-store";
import { formatSurfaceMetadataLine, stripSurfaceMetadataLines } from "../surface-metadata";

export function normalizeText(text: string, _ctx: {}): string {
  return text;
}

function stripLeadingDiscordAttributionHeader(text: string): string {
  // Defensive: remove historical attribution headers that may have been echoed
  // into assistant outputs and can poison later generations.
  // This strips header lines at the start of the text and after merged separators.
  return text.replace(/(^|\n)\[discord\s+[^\n\]]*message_id=[^\n\]]*\]\n?/gu, "$1");
}

export function normalizeAssistantContextText(text: string): string {
  return stripSurfaceMetadataLines(stripLeadingDiscordAttributionHeader(text)).trimEnd();
}

function extractAssistantTextFromContent(content: ModelMessage["content"]): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const out: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    const candidate = part as Record<string, unknown>;
    const type = typeof candidate.type === "string" ? candidate.type : "";
    if (type === "tool-call" || type === "tool-result") continue;

    if (typeof candidate.text === "string") {
      out.push(candidate.text);
      continue;
    }

    if (type === "text" && typeof candidate.value === "string") {
      out.push(candidate.value);
    }
  }

  return out.length > 0 ? out.join("") : null;
}

export function buildAssistantOnlyMessageFromTranscript(
  snap: TranscriptSnapshot,
): ModelMessage | null {
  if (typeof snap.finalText === "string") {
    return {
      role: "assistant",
      content: normalizeAssistantContextText(snap.finalText),
    } satisfies ModelMessage;
  }

  for (let i = snap.messages.length - 1; i >= 0; i--) {
    const msg = snap.messages[i]!;
    if (msg.role !== "assistant") continue;

    const text = extractAssistantTextFromContent(msg.content);
    if (text === null) continue;

    return {
      role: "assistant",
      content: normalizeAssistantContextText(text),
    } satisfies ModelMessage;
  }

  return null;
}

function normalizeReactionSet(reactions: readonly string[] | undefined): string[] | undefined {
  if (!reactions || reactions.length === 0) return undefined;

  const MAX_REACTIONS = 8;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const reaction of reactions) {
    if (typeof reaction !== "string" || reaction.length === 0) continue;
    if (seen.has(reaction)) continue;
    seen.add(reaction);
    out.push(reaction);
    if (out.length >= MAX_REACTIONS) break;
  }

  return out.length > 0 ? out : undefined;
}

function formatMessageTime(messageTs: number | undefined): string | undefined {
  if (!Number.isFinite(messageTs) || messageTs === undefined || messageTs < 0) {
    return undefined;
  }

  return new Date(messageTs).toISOString();
}

export function formatDiscordAttributionHeader(params: {
  authorId: string;
  authorName: string;
  userAlias?: string;
  messageId: string;
  messageTs?: number;
  reactions?: readonly string[];
}): string {
  const reactions = normalizeReactionSet(params.reactions);
  const messageTime = formatMessageTime(params.messageTs);

  return formatSurfaceMetadataLine({
    platform: "discord",
    user_id: params.authorId,
    user_name: params.authorName || `user_${params.authorId}`,
    ...(params.userAlias ? { user_alias: params.userAlias } : {}),
    message_id: params.messageId,
    ...(messageTime ? { message_time: messageTime } : {}),
    ...(reactions ? { reactions } : {}),
  });
}
