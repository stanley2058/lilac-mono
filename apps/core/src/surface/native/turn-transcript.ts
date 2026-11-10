import { parseSurfaceMetadataLine } from "../bridge/surface-metadata";
import { parseNativeRequestId } from "./native-protocol";

type TranscriptMessage = {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string }[];
};

/** Whether `message` is the user message that opens the native turn for `requestId`. */
export function opensNativeTurn(
  message: TranscriptMessage | undefined,
  requestId: string,
): boolean {
  const target = parseNativeRequestId(requestId);
  if (!target || message?.role !== "user") return false;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") return false;
  const header = parseSurfaceMetadataLine(text.split("\n")[0] ?? "");
  return (
    header?.meta.platform === "native" &&
    header.meta.thread_id === target.threadId &&
    header.meta.message_id === target.messageId
  );
}

/**
 * Keeps a native run's own turn, starting at its opening message, or every message when that
 * opening is absent. Native history is rebuilt from these per-turn rows. Rows written before this,
 * and compaction checkpoints, start with earlier history instead.
 */
export function selectNativeTurnMessages<T extends TranscriptMessage>(
  messages: readonly T[],
  requestId: string,
): T[] {
  const start = messages.findIndex((message) => opensNativeTurn(message, requestId));
  return start < 0 ? [...messages] : messages.slice(start);
}

function messageText(message: TranscriptMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("\n");
}

function compactionSummaries(messages: readonly TranscriptMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter((text) => text.startsWith("<context-compaction>"));
}

/**
 * Selects what a native primary run persists. A run whose context holds a compaction summary that
 * its request did not carry in replaced history that earlier rows hold, so it keeps the full
 * context. That includes a compaction a recovered run inherited from its checkpoint.
 */
export function selectNativeRunMessages<T extends TranscriptMessage>(
  messages: readonly T[],
  requestId: string,
  requestMessages: readonly TranscriptMessage[],
): T[] {
  const carried = new Set(compactionSummaries(requestMessages));
  if (compactionSummaries(messages).some((summary) => !carried.has(summary))) return [...messages];
  return selectNativeTurnMessages(messages, requestId);
}
