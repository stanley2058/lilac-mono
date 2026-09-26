import type {
  ConversationReference,
  DisplayMessage,
  ReplayCheckpoint,
} from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { NativeStoreResult } from "./store";
import { nativeFailure } from "./errors";

export type ReferencePage = {
  title: string;
  messages: DisplayMessage[];
  messageFound: boolean;
  nextCursor?: string;
  nextAfter?: string;
  checkpoint?: ReplayCheckpoint;
  sourceUrl?: string;
  anchorMessageId?: string;
};
export type ReadReferencePage = (cursor?: string) => Promise<NativeStoreResult<ReferencePage>>;

export function matchesReferenceMessage(message: DisplayMessage, id: string): boolean {
  return message.id === id || message.metadata?.reference?.messageId === id;
}

export async function readReferenceRange(
  read: ReadReferencePage,
  range: NonNullable<ConversationReference["range"]>,
  cursor?: string,
  direction: "before" | "after" = "before",
): Promise<NativeStoreResult<ReferencePage>> {
  return Result.gen(async function* () {
    let page = yield* Result.await(read());
    const header = { title: page.title, checkpoint: page.checkpoint, sourceUrl: page.sourceUrl };
    const selected: DisplayMessage[] = [];
    let foundEnd = false;
    let foundCursor = !cursor;
    let eligible = 0;
    const seenCursors = new Set<string>();
    while (true) {
      for (const message of page.messages.toReversed()) {
        if (!foundEnd) {
          foundEnd = matchesReferenceMessage(message, range.endMessageId);
          if (!foundEnd) continue;
        }
        const isCursor = cursor !== undefined && message.id === cursor;
        const include = !isCursor && (direction === "after" ? !foundCursor : foundCursor);
        if (isCursor) foundCursor = true;
        if (include) {
          eligible++;
          if (direction === "after" || selected.length < 101) selected.push(message);
          if (selected.length > 101) selected.shift();
        }
        if (!matchesReferenceMessage(message, range.startMessageId)) continue;
        if (!foundCursor)
          return Result.err(nativeFailure("not-found", "Range cursor is unavailable"));
        const messages =
          direction === "after"
            ? selected.toReversed().slice(0, 100)
            : selected.slice(0, 100).reverse();
        return Result.ok({
          ...header,
          messages,
          messageFound: true,
          nextCursor: direction === "before" && eligible > 100 ? messages[0]?.id : undefined,
          nextAfter: direction === "after" && eligible > 100 ? messages.at(-1)?.id : undefined,
        });
      }
      if (!page.nextCursor || seenCursors.has(page.nextCursor))
        return Result.err(
          nativeFailure("not-found", "Range endpoints are unavailable or out of order"),
        );
      seenCursors.add(page.nextCursor);
      page = yield* Result.await(read(page.nextCursor));
    }
  });
}

export const REFERENCE_PREVIEW_BUDGET = 12_000;

function quoted(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function messageText(message: DisplayMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type !== "data-resource") return [];
      const resource = part.data;
      const handle = /^r1_[a-f0-9]{32}$/.test(resource.resourceId)
        ? ` | resource://${resource.resourceId}`
        : "";
      return [
        `[Attachment: ${resource.name} | ${resource.mediaType}${handle} | contents not included${resource.state !== "ready" ? ` | ${resource.state}` : ""}]`,
      ];
    })
    .join("\n");
}

function formatMessage(
  message: DisplayMessage,
  target: ConversationReference,
  limit?: number,
): string {
  const metadata = message.metadata;
  const time =
    metadata?.createdAt === undefined ? "" : `${new Date(metadata.createdAt).toISOString()} `;
  const sourceId = metadata?.reference?.messageId;
  const idLabel = target.surface === "native" ? "messageId" : "displayMessageId";
  const header = quoted(
    `[${time}${metadata?.authorDisplayName ?? message.role}]\n${idLabel}: ${message.id}${sourceId ? `\nsourceMessageId: ${sourceId}` : ""}\n`,
  );
  const body = quoted(messageText(message));
  if (limit === undefined || header.length + body.length <= limit) return header + body;
  const marker = "[Beginning of message omitted]\n";
  if (header.length + marker.length >= limit)
    return "[Message omitted: insufficient preview budget.]";
  const available = limit - header.length - marker.length;
  return header + marker + body.slice(body.length - available);
}

export async function renderReferencePreview(
  read: ReadReferencePage,
  target: ConversationReference,
  source: string,
  budget: number,
): Promise<NativeStoreResult<string>> {
  return Result.gen(async function* () {
    let page = yield* Result.await(read());
    if (!page.messageFound) return Result.err(nativeFailure("not-found", "Message is unavailable"));
    const scope = target.range ? "range" : "session";
    const header = `<conversation_reference>\nsource: ${quoted(source)}\nscope: ${target.messageId ? "message" : scope}\ntitle: ${quoted(page.title)}\nretrieval: ${quoted(JSON.stringify({ client: target.surface, sessionId: target.sessionId }))}\n`;
    const footer = "\n</conversation_reference>";
    const warning =
      "[Preview truncated: older messages or the beginning of the oldest included message omitted.]\n";
    if (header.length + footer.length + warning.length + 128 > budget)
      return Result.ok("[Preview omitted: insufficient shared character budget.]");
    const available = Math.max(0, budget - header.length - footer.length - warning.length);
    const messages: string[] = [];
    let remaining = available;
    let truncated = false;
    const seenCursors = new Set<string>();
    while (true) {
      const candidates = target.messageId
        ? page.messages.filter(
            (message) =>
              matchesReferenceMessage(message, target.messageId!) ||
              message.id === page.anchorMessageId,
          )
        : page.messages;
      for (const message of candidates.toReversed()) {
        if (!messageText(message)) continue;
        const text = formatMessage(message, target);
        const cost = text.length + (messages.length ? 2 : 0);
        if (cost <= remaining) {
          messages.unshift(text);
          remaining -= cost;
          continue;
        }
        // Preserve the latest text even when one message exceeds the entire preview budget.
        if (!messages.length && remaining > 0)
          messages.unshift(formatMessage(message, target, remaining));
        truncated = true;
        break;
      }
      if (target.messageId || truncated || !page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        truncated = true;
        break;
      }
      seenCursors.add(page.nextCursor);
      page = yield* Result.await(read(page.nextCursor));
    }
    if (!messages.length && !truncated)
      return Result.ok(`${header}[No visible messages.]${footer}`);
    return Result.ok(`${header}${truncated ? warning : ""}${messages.join("\n\n")}${footer}`);
  });
}
