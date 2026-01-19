import type { ModelMessage, UserContent } from "ai";

import type { SurfaceAdapter } from "../adapter";
import type { MsgRef } from "../types";

export type RequestCompositionResult = {
  messages: ModelMessage[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
};

export type ComposeRequestOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  trigger: {
    type: "mention" | "reply";
    msgRef: MsgRef;
  };
  maxDepth?: number;
};

/**
 * Build request `ModelMessage[]` with reply-chain + merge-window parity.
 *
 * This intentionally uses the adapter interface so the router does not need
 * direct Discord API access.
 */
export async function composeRequestMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRequestOpts,
): Promise<RequestCompositionResult> {
  if (opts.platform !== "discord") {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  // Phase 1: fetch reply chain from the adapter store / platform.
  const chain = await fetchReplyChain(adapter, opts);

  // Phase 2: merge by Discord window rules (same author + <= 7 min).
  const merged = mergeChainByDiscordWindow(chain);

  // Phase 3: normalize to ModelMessage[] with attribution headers.
  const modelMessages = merged.map((chunk) => {
    const isBot = chunk.authorId === opts.botUserId;

    const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

    let text = chunk.text;
    if (
      opts.trigger.type === "mention" &&
      chunk.messageIds.includes(opts.trigger.msgRef.messageId)
    ) {
      text = stripLeadingBotMention(text, opts.botUserId, opts.botName);
    }

    const normalized = normalizeText(text, {
      // We currently rely on adapter text already being normalized (mentions rewritten).
      // If/when adapters expose richer raw mentions, we can do a more faithful rewrite.
    });

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      messageId,
    });

    const mainText = `${header}\n${normalized}`.trimEnd();

    if (isBot) {
      return {
        role: "assistant",
        content: mainText,
      } satisfies ModelMessage;
    }

    if (chunk.attachments.length === 0) {
      return {
        role: "user",
        content: mainText,
      } satisfies ModelMessage;
    }

    const parts: UserContent = [{ type: "text", text: mainText }];

    for (const att of chunk.attachments) {
      try {
        const url = new URL(att.url);
        const mimeType = att.mimeType;

        if (mimeType && mimeType.startsWith("image/")) {
          parts.push({
            type: "image",
            image: url,
            mediaType: mimeType,
          });
        } else {
          parts.push({
            type: "file",
            data: url,
            filename: att.filename,
            mediaType: mimeType ?? "application/octet-stream",
          });
        }
      } catch {
        // ignore invalid URL
      }
    }

    return {
      role: "user",
      content: parts,
    } satisfies ModelMessage;
  });

  return {
    messages: modelMessages,
    chainMessageIds: chain.map((m) => m.messageId),
    mergedGroups: merged.map((m) => ({
      authorId: m.authorId,
      messageIds: [...m.messageIds],
    })),
  };
}

type ReplyChainMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  text: string;
  attachments: Array<{
    url: string;
    filename?: string;
    mimeType?: string;
    size?: number;
  }>;
  raw?: unknown;
};

type MergedChunk = {
  messageIds: string[];
  authorId: string;
  authorName: string;
  tsStart: number;
  tsEnd: number;
  text: string;
  attachments: Array<{
    url: string;
    filename?: string;
    mimeType?: string;
    size?: number;
  }>;
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripLeadingBotMention(
  text: string,
  botUserId: string,
  botName: string,
): string {
  const sanitizedBot = sanitizeUserToken(botName);
  const re = new RegExp(
    `^(?:<@!?${botUserId}>|@${escapeRegExp(sanitizedBot)})(?:\\s+)?`,
    "iu",
  );
  return text.replace(re, "");
}

function normalizeText(text: string, _ctx: {}): string {
  return text;
}

function formatDiscordAttributionHeader(params: {
  authorId: string;
  authorName: string;
  messageId: string;
}): string {
  const userName = sanitizeUserToken(
    params.authorName || `user_${params.authorId}`,
  );
  return `[discord user_id=${params.authorId} user_name=${userName} message_id=${params.messageId}]`;
}

function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

type DiscordAttachmentMeta = {
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

function extractDiscordAttachmentsFromRaw(
  raw: unknown,
): DiscordAttachmentMeta[] {
  if (!raw || typeof raw !== "object") return [];

  // We store attachments in two places depending on origin:
  // - adapter persisted raw: { attachments: [...] }
  // - adapter event raw: { discord: { attachments: [...] } }
  const o = raw as Record<string, unknown>;

  const listFromTopLevel =
    "attachments" in o && Array.isArray(o.attachments) ? o.attachments : null;

  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;

  const listFromDiscord =
    discord && "attachments" in discord && Array.isArray(discord.attachments)
      ? discord.attachments
      : null;

  const list = listFromDiscord ?? listFromTopLevel;
  if (!list) return [];

  const out: DiscordAttachmentMeta[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;

    const url = typeof a.url === "string" ? a.url : null;
    if (!url) continue;

    out.push({
      url,
      filename: typeof a.filename === "string" ? a.filename : undefined,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    });
  }

  return out;
}

function getReferenceFromRaw(raw: unknown): {
  messageId?: string;
  channelId?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  if (!("reference" in raw)) return {};
  const ref = raw.reference;
  if (!ref || typeof ref !== "object") return {};

  const messageId =
    "messageId" in ref && typeof ref.messageId === "string"
      ? ref.messageId
      : undefined;

  const channelId =
    "channelId" in ref && typeof ref.channelId === "string"
      ? ref.channelId
      : undefined;

  return { messageId, channelId };
}

async function fetchReplyChain(
  adapter: SurfaceAdapter,
  opts: ComposeRequestOpts,
): Promise<ReplyChainMessage[]> {
  const maxDepth = opts.maxDepth ?? 20;

  const chainNewestToOldest: ReplyChainMessage[] = [];

  let cur = await adapter.readMsg(opts.trigger.msgRef);
  if (!cur) return [];

  for (let depth = 0; depth < maxDepth && cur; depth++) {
    chainNewestToOldest.push({
      messageId: cur.ref.messageId,
      authorId: cur.userId,
      authorName: cur.userName ?? `user_${cur.userId}`,
      ts: cur.ts,
      text: cur.text,
      attachments: extractDiscordAttachmentsFromRaw(cur.raw),
      raw: cur.raw,
    });

    const ref = getReferenceFromRaw(cur.raw);
    if (!ref.messageId) break;

    // Stop if the reference crosses sessions.
    if (ref.channelId && ref.channelId !== opts.trigger.msgRef.channelId) break;

    cur = await adapter.readMsg({
      platform: opts.platform,
      channelId: opts.trigger.msgRef.channelId,
      messageId: ref.messageId,
    });
  }

  return chainNewestToOldest.slice().reverse();
}

function mergeChainByDiscordWindow(
  chainOldestToNewest: readonly ReplyChainMessage[],
): MergedChunk[] {
  const DISCORD_MERGE_WINDOW_MS = 7 * 60 * 1000;
  if (chainOldestToNewest.length === 0) return [];

  const out: MergedChunk[] = [];

  let cur: MergedChunk = {
    messageIds: [chainOldestToNewest[0]!.messageId],
    authorId: chainOldestToNewest[0]!.authorId,
    authorName: chainOldestToNewest[0]!.authorName,
    tsStart: chainOldestToNewest[0]!.ts,
    tsEnd: chainOldestToNewest[0]!.ts,
    text: chainOldestToNewest[0]!.text,
    attachments: [...chainOldestToNewest[0]!.attachments],
  };

  for (let i = 1; i < chainOldestToNewest.length; i++) {
    const next = chainOldestToNewest[i]!;
    const gap = next.ts - cur.tsEnd;

    const shouldMerge =
      next.authorId === cur.authorId && gap <= DISCORD_MERGE_WINDOW_MS;
    if (!shouldMerge) {
      out.push(cur);
      cur = {
        messageIds: [next.messageId],
        authorId: next.authorId,
        authorName: next.authorName,
        tsStart: next.ts,
        tsEnd: next.ts,
        text: next.text,
        attachments: [...next.attachments],
      };
      continue;
    }

    cur.messageIds.push(next.messageId);
    cur.tsEnd = next.ts;
    cur.text = `${cur.text}\n\n${next.text}`;
    cur.attachments.push(...next.attachments);
  }

  out.push(cur);
  return out;
}
