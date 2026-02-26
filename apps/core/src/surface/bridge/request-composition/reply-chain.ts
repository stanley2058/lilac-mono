import type { MsgRef, SurfaceMessage } from "../../types";

import { hasReplyChainPlannerProvider, type SurfaceAdapter } from "../../adapter";

import { splitByDiscordWindowOldestToNewest } from "../../discord/merge-window";

import type { DiscordAttachmentMeta, MergedChunk, ReplyChainMessage } from "./types";

const DISCORD_REFERENCE_TYPE_DEFAULT = 0;
const DISCORD_REFERENCE_TYPE_FORWARD = 1;
const DEFAULT_MENTION_BLOCK_LIMIT = 50;

function compareDiscordSnowflakeLike(a: string, b: string): number {
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

function extractDiscordAttachmentsFromList(list: readonly unknown[]): DiscordAttachmentMeta[] {
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

function getDiscordReferenceTypeFromRaw(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;

  if ("reference" in o) {
    const ref = o.reference;
    if (ref && typeof ref === "object") {
      const type = (ref as Record<string, unknown>).type;
      if (typeof type === "number") return type;
    }
  }

  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;
  const referenceType =
    discord && typeof discord.referenceType === "number" ? discord.referenceType : undefined;
  return referenceType;
}

function getForwardSnapshotMessageFromRaw(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;

  const referenceType = getDiscordReferenceTypeFromRaw(raw) ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  if (referenceType !== DISCORD_REFERENCE_TYPE_FORWARD) return null;

  const o = raw as Record<string, unknown>;
  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;

  const resolveSnapshotMessage = (value: unknown): Record<string, unknown> | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0];
    if (!first || typeof first !== "object") return null;

    const firstObj = first as Record<string, unknown>;
    const nestedMessage = firstObj.message;
    if (nestedMessage && typeof nestedMessage === "object") {
      return nestedMessage as Record<string, unknown>;
    }

    return firstObj;
  };

  return (
    resolveSnapshotMessage(o.messageSnapshots) ?? resolveSnapshotMessage(discord?.messageSnapshots)
  );
}

export function getForwardSnapshotTextFromRaw(raw: unknown): string | undefined {
  const snapshot = getForwardSnapshotMessageFromRaw(raw);
  if (!snapshot) return undefined;

  const content = typeof snapshot.content === "string" ? snapshot.content : "";
  if (content.trim().length > 0) return content;

  const embeds = Array.isArray(snapshot.embeds) ? snapshot.embeds : [];
  const descriptions = embeds
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const description = (item as Record<string, unknown>).description;
      return typeof description === "string" ? description : "";
    })
    .filter((desc) => desc.trim().length > 0);

  const fromEmbeds = descriptions.join("\n\n").trim();
  return fromEmbeds.length > 0 ? fromEmbeds : undefined;
}

function extractDiscordAttachmentsFromRaw(raw: unknown): DiscordAttachmentMeta[] {
  if (!raw || typeof raw !== "object") return [];

  const forwardSnapshot = getForwardSnapshotMessageFromRaw(raw);
  if (forwardSnapshot) {
    const snapshotAttachments =
      "attachments" in forwardSnapshot && Array.isArray(forwardSnapshot.attachments)
        ? extractDiscordAttachmentsFromList(forwardSnapshot.attachments)
        : [];
    if (snapshotAttachments.length > 0) {
      return snapshotAttachments;
    }
  }

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

  return extractDiscordAttachmentsFromList(list);
}

function getReferenceFromRaw(raw: unknown): {
  messageId?: string;
  channelId?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;

  // Preferred (Discord API shape): reference: { messageId, channelId }
  if ("reference" in o) {
    const ref = o.reference;
    if (ref && typeof ref === "object") {
      const r = ref as Record<string, unknown>;
      const messageId = typeof r.messageId === "string" ? r.messageId : undefined;
      const channelId = typeof r.channelId === "string" ? r.channelId : undefined;
      const referenceType = typeof r.type === "number" ? r.type : DISCORD_REFERENCE_TYPE_DEFAULT;
      if (messageId && referenceType !== DISCORD_REFERENCE_TYPE_FORWARD) {
        return { messageId, channelId };
      }
    }
  }

  // Back-compat: older stored rows and adapter events.
  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;
  const referenceType =
    discord && typeof discord.referenceType === "number"
      ? discord.referenceType
      : DISCORD_REFERENCE_TYPE_DEFAULT;
  const replyToMessageId =
    discord && typeof discord.replyToMessageId === "string" ? discord.replyToMessageId : undefined;
  if (replyToMessageId && referenceType !== DISCORD_REFERENCE_TYPE_FORWARD) {
    return { messageId: replyToMessageId };
  }

  return {};
}

function hasReplyTargetInRaw(raw: unknown): boolean {
  return typeof getReferenceFromRaw(raw).messageId === "string";
}

export function toReplyChainMessage(
  msg: SurfaceMessage,
  opts?: {
    overrideText?: string;
    authorNameFallback?: string;
  },
): ReplyChainMessage {
  const text =
    opts?.overrideText !== undefined
      ? opts.overrideText
      : msg.text.trim().length > 0
        ? msg.text
        : (getForwardSnapshotTextFromRaw(msg.raw) ?? msg.text);

  return {
    messageId: msg.ref.messageId,
    authorId: msg.userId,
    authorName: msg.userName ?? opts?.authorNameFallback ?? `user_${msg.userId}`,
    ts: msg.ts,
    text,
    attachments: extractDiscordAttachmentsFromRaw(msg.raw),
    raw: msg.raw,
  };
}

function dedupeByMessageId(list: readonly ReplyChainMessage[]): ReplyChainMessage[] {
  const out: ReplyChainMessage[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    out.push(m);
  }
  return out;
}

async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  concurrency: number;
  run: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const { items, run } = input;
  const concurrency = Math.max(1, Math.floor(input.concurrency));

  const out = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;

      out[i] = await run(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return out;
}

async function readMessagesByRefs(input: {
  adapter: SurfaceAdapter;
  refs: readonly MsgRef[];
  concurrency?: number;
}): Promise<SurfaceMessage[]> {
  const { adapter, refs } = input;
  if (refs.length === 0) return [];

  const pairs = await mapWithConcurrency({
    items: refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      const msg = await adapter.readMsg(ref);
      return { ref, msg };
    },
  });

  const byKey = new Map<string, SurfaceMessage>();
  for (const pair of pairs) {
    if (!pair.msg) continue;
    const key = `${pair.msg.ref.channelId}:${pair.msg.ref.messageId}`;
    byKey.set(key, pair.msg);
  }

  const out: SurfaceMessage[] = [];
  for (const ref of refs) {
    const key = `${ref.channelId}:${ref.messageId}`;
    const msg = byKey.get(key);
    if (msg) out.push(msg);
  }

  return out;
}

export async function resolveMergeBlockEndingAt(
  adapter: SurfaceAdapter,
  triggerMsg: SurfaceMessage,
  opts?: { limit?: number },
): Promise<SurfaceMessage[]> {
  const limit = opts?.limit ?? DEFAULT_MENTION_BLOCK_LIMIT;

  if (hasReplyChainPlannerProvider(adapter)) {
    const plannedRefs = await adapter
      .planMergeBlockEndingAt(triggerMsg.ref, { lookbackLimit: limit })
      .catch(() => [] as readonly MsgRef[]);

    const refs = plannedRefs.filter((r) => r.channelId === triggerMsg.ref.channelId);
    if (refs.length > 0) {
      const list = await readMessagesByRefs({
        adapter,
        refs,
        concurrency: 8,
      });

      const plannedRefKeys = new Set(refs.map((r) => `${r.channelId}:${r.messageId}`));
      const resolvedRefKeys = new Set(list.map((m) => `${m.ref.channelId}:${m.ref.messageId}`));
      const allResolved =
        plannedRefKeys.size === resolvedRefKeys.size &&
        [...plannedRefKeys].every((key) => resolvedRefKeys.has(key));

      if (!list.some((m) => m.ref.messageId === triggerMsg.ref.messageId)) {
        list.push(triggerMsg);
      }

      list.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
      });

      if (allResolved && list.length > 0) {
        return list;
      }
    }
  }

  const ctx = await adapter
    .getReplyContext(triggerMsg.ref, { limit })
    .catch(() => [] as SurfaceMessage[]);

  const list = ctx.length > 0 ? ctx.slice() : [triggerMsg];

  if (!list.some((m) => m.ref.messageId === triggerMsg.ref.messageId)) {
    list.push(triggerMsg);
  }

  list.sort((a, b) => a.ts - b.ts);

  const triggerIndex = list.findIndex((m) => m.ref.messageId === triggerMsg.ref.messageId);
  if (triggerIndex < 0) return [triggerMsg];

  const authorId = triggerMsg.userId;

  let runStart = triggerIndex;
  for (let i = triggerIndex - 1; i >= 0; i--) {
    const prev = list[i]!;
    if (prev.userId !== authorId) break;
    runStart = i;
  }

  const run = list.slice(runStart, triggerIndex + 1);
  const groups = splitByDiscordWindowOldestToNewest(
    run.map((m) => ({
      message: m,
      authorId: m.userId,
      ts: m.ts,
      hardBreakBefore: hasReplyTargetInRaw(m.raw),
    })),
  );
  const groupEndingAtTrigger = groups[groups.length - 1] ?? [];
  return groupEndingAtTrigger.map((m) => m.message);
}

export function findEarliestReplyAnchor(block: readonly SurfaceMessage[]): SurfaceMessage | null {
  for (const m of block) {
    const ref = getReferenceFromRaw(m.raw);
    if (ref.messageId) return m;
  }
  return null;
}

export async function fetchReplyChainFrom(
  adapter: SurfaceAdapter,
  opts: {
    platform: "discord";
    botUserId: string;
    botName: string;
    trigger: { type: "mention" | "reply"; msgRef: MsgRef };
    startMsgRef: MsgRef;
    /** Maximum number of merged Discord UI groups to traverse. */
    maxDepth?: number;
  },
): Promise<ReplyChainMessage[]> {
  const maxGroupCount = opts.maxDepth ?? 20;

  if (hasReplyChainPlannerProvider(adapter)) {
    const plannedRefs = await adapter
      .planReplyChain(opts.startMsgRef, { maxDepth: maxGroupCount })
      .catch(() => [] as readonly MsgRef[]);

    const inSessionRefs: MsgRef[] = [];
    for (const ref of plannedRefs) {
      if (ref.channelId !== opts.trigger.msgRef.channelId) break;
      inSessionRefs.push(ref);
    }

    if (inSessionRefs.length > 0) {
      const groups = await mapWithConcurrency({
        items: inSessionRefs,
        concurrency: 4,
        run: async (cursorRef) => {
          const blockRefs = await adapter
            .planMergeBlockEndingAt(cursorRef, {
              lookbackLimit: DEFAULT_MENTION_BLOCK_LIMIT,
            })
            .catch(() => [cursorRef] as readonly MsgRef[]);

          const inChannelBlockRefs = blockRefs.filter(
            (ref) => ref.channelId === opts.trigger.msgRef.channelId,
          );

          const refsToRead = inChannelBlockRefs.length > 0 ? inChannelBlockRefs : [cursorRef];

          const messages = await readMessagesByRefs({
            adapter,
            refs: refsToRead,
            concurrency: 8,
          });

          const plannedRefKeys = new Set(refsToRead.map((r) => `${r.channelId}:${r.messageId}`));
          const resolvedRefKeys = new Set(
            messages.map((m) => `${m.ref.channelId}:${m.ref.messageId}`),
          );
          const allResolved =
            plannedRefKeys.size === resolvedRefKeys.size &&
            [...plannedRefKeys].every((key) => resolvedRefKeys.has(key));

          if (allResolved && messages.length > 0) return messages;

          const cursor = await adapter.readMsg(cursorRef);
          if (!cursor) return [];

          return await resolveMergeBlockEndingAt(adapter, cursor).catch(() => [cursor]);
        },
      });

      const flattened = groups.flat();
      if (flattened.length > 0) {
        flattened.sort((a, b) => {
          if (a.ts !== b.ts) return a.ts - b.ts;
          return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
        });

        return dedupeByMessageId(flattened.map((m) => toReplyChainMessage(m)));
      }
    }
  }

  const groupsNewestToOldest: ReplyChainMessage[][] = [];
  const seenMessageIds = new Set<string>();

  let cur = await adapter.readMsg(opts.startMsgRef);
  if (!cur) return [];

  for (let depth = 0; depth < maxGroupCount && cur; depth++) {
    const cursor = cur;

    if (seenMessageIds.has(cursor.ref.messageId)) break;

    const group = await resolveMergeBlockEndingAt(adapter, cursor).catch(() => [cursor]);
    if (group.length === 0) break;

    for (const m of group) {
      seenMessageIds.add(m.ref.messageId);
    }

    groupsNewestToOldest.push(group.map((m) => toReplyChainMessage(m)));

    const first = group[0]!;
    const ref = getReferenceFromRaw(first.raw);
    if (!ref.messageId) break;

    // Stop if the reference crosses sessions.
    if (ref.channelId && ref.channelId !== opts.trigger.msgRef.channelId) break;

    cur = await adapter.readMsg({
      platform: opts.platform,
      channelId: opts.trigger.msgRef.channelId,
      messageId: ref.messageId,
    });
  }

  return dedupeByMessageId(groupsNewestToOldest.slice().reverse().flat());
}

export async function fetchMentionThreadContext(
  adapter: SurfaceAdapter,
  params: {
    platform: "discord";
    botUserId: string;
    botName: string;
    triggerMsg: SurfaceMessage;
    maxDepth?: number;
  },
): Promise<ReplyChainMessage[]> {
  const block = await resolveMergeBlockEndingAt(adapter, params.triggerMsg);
  const anchor = findEarliestReplyAnchor(block);

  const startMsgRef = anchor?.ref ?? params.triggerMsg.ref;

  const chain = await fetchReplyChainFrom(adapter, {
    platform: params.platform,
    botUserId: params.botUserId,
    botName: params.botName,
    trigger: { type: "mention", msgRef: params.triggerMsg.ref },
    startMsgRef,
    maxDepth: params.maxDepth,
  });

  const blockMessages = block.map((m) => {
    return toReplyChainMessage(m);
  });

  const combined = dedupeByMessageId([...chain, ...blockMessages]);

  combined.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // Stable-ish tie-breaker.
    return a.messageId.localeCompare(b.messageId);
  });

  return combined;
}

export function mergeChainByDiscordWindow(
  chainOldestToNewest: readonly ReplyChainMessage[],
): MergedChunk[] {
  if (chainOldestToNewest.length === 0) return [];

  const groups = splitByDiscordWindowOldestToNewest(
    chainOldestToNewest.map((m) => ({
      message: m,
      authorId: m.authorId,
      ts: m.ts,
      hardBreakBefore: hasReplyTargetInRaw(m.raw),
    })),
  );

  return groups.map((group) => {
    const messages = group.map((m) => m.message);
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;

    return {
      messageIds: messages.map((m) => m.messageId),
      authorId: first.authorId,
      authorName: first.authorName,
      tsStart: first.ts,
      tsEnd: last.ts,
      text: messages.map((m) => m.text).join("\n\n"),
      attachments: messages.flatMap((m) => m.attachments),
    };
  });
}
