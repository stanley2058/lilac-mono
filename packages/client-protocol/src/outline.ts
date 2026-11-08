import { z } from "zod";
import { identitySchema, revisionSchema, type DisplayMessage } from "./replay.ts";

/** Turns scanned per outline page, so one request stays bounded on any thread length. */
export const OUTLINE_PAGE_TURNS = 256;
export const OUTLINE_PREVIEW_BATCH = 16;
export const OUTLINE_USER_PREVIEW_LENGTH = 160;
export const OUTLINE_REPLY_PREVIEW_LENGTH = 280;

export const threadOutlineInputSchema = z.strictObject({
  threadId: identitySchema,
  beforePosition: revisionSchema.optional(),
});

export const contextWindowOutlineSchema = z.strictObject({
  firstPosition: revisionSchema,
  endPosition: revisionSchema,
  startAt: revisionSchema,
  endAt: revisionSchema,
  /** Older turns outside this page may belong to the same window. */
  continues: z.literal(true).optional(),
});

export const threadOutlineSchema = z.strictObject({
  historyGeneration: revisionSchema,
  /** Turn positions a reader can jump to, oldest first. */
  positions: z.array(revisionSchema).max(OUTLINE_PAGE_TURNS),
  /** DM context windows covering this page, oldest first. */
  windows: z.array(contextWindowOutlineSchema).max(OUTLINE_PAGE_TURNS).optional(),
  /** Present when older turns exist; pass it as `beforePosition` to read them. */
  earlierBefore: revisionSchema.optional(),
});

export const outlinePreviewInputSchema = z.strictObject({
  threadId: identitySchema,
  historyGeneration: revisionSchema,
  positions: z.array(revisionSchema).min(1).max(OUTLINE_PREVIEW_BATCH),
});

export const turnPreviewSchema = z.strictObject({
  position: revisionSchema,
  user: z.string().max(OUTLINE_USER_PREVIEW_LENGTH).optional(),
  reply: z.string().max(OUTLINE_REPLY_PREVIEW_LENGTH).optional(),
});

export const outlinePreviewsSchema = z.strictObject({
  historyGeneration: revisionSchema,
  previews: z.array(turnPreviewSchema).max(OUTLINE_PREVIEW_BATCH),
});

export type ThreadOutline = z.infer<typeof threadOutlineSchema>;
export type ContextWindowOutline = z.infer<typeof contextWindowOutlineSchema>;
export type TurnPreview = z.infer<typeof turnPreviewSchema>;

function messageText(message: DisplayMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

function compact(text: string, limit: number): string | undefined {
  // Huge replies only need their opening, plus room for the markup and link URLs dropped below.
  const plain = text
    .slice(0, limit * 3 + 4096)
    // Keep link labels so citation and file links read as words instead of URLs.
    .replace(/\[([^\]\n]{1,200})\]\([^)\s]{1,4096}\)/g, "$1")
    // A preview is one run of prose, so drop block markers, fences, table rules, and emphasis.
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/gm, "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, limit - 1).trimEnd()}…`;
}

/** The asking line and the final answer of one turn, flattened for a one-glance preview. */
export function turnPreviewText(
  messages: readonly DisplayMessage[],
): Pick<TurnPreview, "user" | "reply"> {
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.filter(
    (message) => message.role === "assistant" && messageText(message).trim(),
  );
  const reply =
    assistant.findLast((message) => message.metadata?.phase === "final") ?? assistant.at(-1);
  const userText = user ? compact(messageText(user), OUTLINE_USER_PREVIEW_LENGTH) : undefined;
  const replyText = reply ? compact(messageText(reply), OUTLINE_REPLY_PREVIEW_LENGTH) : undefined;
  return {
    ...(userText ? { user: userText } : {}),
    ...(replyText ? { reply: replyText } : {}),
  };
}

/** A gap longer than the DM context gap between two turns starts a new context window. */
export function startsContextWindow(
  previousCompletedAt: number,
  nextCreatedAt: number,
  gapMs: number,
): boolean {
  return nextCreatedAt - previousCompletedAt > gapMs;
}
