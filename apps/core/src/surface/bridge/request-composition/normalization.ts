import type { ModelMessage } from "ai";

import type { TranscriptSnapshot } from "../../../transcript/transcript-store";

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
  return stripLeadingDiscordAttributionHeader(text).trimEnd();
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

export function formatDiscordAttributionHeader(params: {
  authorId: string;
  authorName: string;
  userAlias?: string;
  messageId: string;
  reactions?: readonly string[];
}): string {
  const userName = sanitizeUserToken(params.authorName || `user_${params.authorId}`);
  const userAlias = params.userAlias ? sanitizeUserToken(params.userAlias) : "";

  const reactions = formatReactionSet(params.reactions);
  const aliasPart = userAlias ? ` user_alias=${userAlias}` : "";
  const reactionsPart = reactions ? ` reactions=${reactions}` : "";

  return `[discord user_id=${params.authorId} user_name=${userName}${aliasPart} message_id=${params.messageId}${reactionsPart}]`;
}

function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

function sanitizeReactionToken(reaction: string): string {
  // Keep the header single-line and parseable. Discord custom emoji toString() can include
  // angle brackets; keep them, but strip whitespace and closing brackets.
  return reaction.replace(/\s+/gu, "_").replace(/\]/gu, "");
}

function formatReactionSet(reactions: readonly string[] | undefined): string | null {
  if (!reactions || reactions.length === 0) return null;

  const MAX_REACTIONS = 8;

  const uniq: string[] = [];
  const seen = new Set<string>();

  for (const r of reactions) {
    if (typeof r !== "string") continue;
    const s = sanitizeReactionToken(r);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
    if (uniq.length >= MAX_REACTIONS) break;
  }

  return uniq.length > 0 ? uniq.join(",") : null;
}
