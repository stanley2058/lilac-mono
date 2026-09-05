import { Result, type Result as ResultType } from "better-result";

import type { MsgRef, SurfaceMessage } from "../../types";

import type { SurfaceAdapter, SurfaceOperationResult } from "../../adapter";
import { projectDiscordMessage } from "../../discord/discord-message-projection";
export { getForwardSnapshotTextFromRaw } from "../../discord/discord-message-projection";

import { splitByDiscordWindowOldestToNewest } from "../../discord/merge-window";

import type { MergedChunk, ReplyChainMessage } from "./types";

const DEFAULT_MENTION_BLOCK_LIMIT = 50;

export type ResolveDiscordMessagesByRefs = (
  refs: readonly MsgRef[],
) => Promise<SurfaceOperationResult<SurfaceMessage[]>>;

function continueResult<T, E, ROk, RErr>(
  result: ResultType<T, E>,
  branches: { ok: (value: T) => ROk; err: (error: E) => RErr },
): ROk | RErr {
  const continuation = result.match<() => ROk | RErr>({
    ok: (value) => () => branches.ok(value),
    err: (error) => () => branches.err(error),
  });
  return continuation();
}

function compareDiscordSnowflakeLike(a: string, b: string): number {
  return Result.try({
    try: () => {
      const ai = BigInt(a);
      const bi = BigInt(b);
      if (ai < bi) return -1;
      if (ai > bi) return 1;
      return 0;
    },
    catch: () => null,
  }).match({ ok: (order) => order, err: () => a.localeCompare(b) });
}

export function toReplyChainMessage(
  msg: SurfaceMessage,
  opts?: {
    overrideText?: string;
    authorNameFallback?: string;
  },
): ReplyChainMessage {
  const projection = projectDiscordMessage(msg);
  const isChat = projection.isChat;
  let text = opts?.overrideText;
  if (text === undefined) {
    text = msg.text.trim().length > 0 ? msg.text : (projection.forwardSnapshotText ?? msg.text);
  }

  return {
    messageId: msg.ref.messageId,
    authorId: msg.userId,
    authorName: msg.userName ?? opts?.authorNameFallback ?? `user_${msg.userId}`,
    ts: msg.ts,
    text,
    attachments: projection.attachments,
    ...(isChat === undefined ? {} : { isChat }),
    replyReference: projection.replyReference ?? {},
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

  const out: R[] = [];
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
  resolveMessagesByRefs?: ResolveDiscordMessagesByRefs;
}): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
  const { adapter, refs } = input;
  if (refs.length === 0) return Result.ok([]);
  if (input.resolveMessagesByRefs) return input.resolveMessagesByRefs(refs);

  const pairs = await mapWithConcurrency({
    items: refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      return { ref, msg: await adapter.readMsg(ref) };
    },
  });

  return Result.all(pairs.map((pair) => pair.msg)).map((messages) => {
    const byKey = new Map<string, SurfaceMessage>();
    for (const msg of messages) {
      if (!msg) continue;
      const key = `${msg.ref.channelId}:${msg.ref.messageId}`;
      byKey.set(key, msg);
    }

    const out: SurfaceMessage[] = [];
    for (const ref of refs) {
      const key = `${ref.channelId}:${ref.messageId}`;
      const msg = byKey.get(key);
      if (msg) out.push(msg);
    }
    return out;
  });
}

export async function resolveMergeBlockEndingAt(
  adapter: SurfaceAdapter,
  triggerMsg: SurfaceMessage,
  opts?: {
    limit?: number;
    resolveMessagesByRefs?: ResolveDiscordMessagesByRefs;
  },
): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
  const limit = opts?.limit ?? DEFAULT_MENTION_BLOCK_LIMIT;

  const planned = await adapter.planMergeBlockEndingAt(triggerMsg.ref, { lookbackLimit: limit });
  const plannedRefs = continueResult(planned, { ok: (value) => value, err: () => [] });
  if (plannedRefs.length > 0) {
    const refs = plannedRefs.filter((r) => r.channelId === triggerMsg.ref.channelId);
    if (refs.length > 0) {
      const listed = await readMessagesByRefs({
        adapter,
        refs,
        concurrency: 8,
        resolveMessagesByRefs: opts?.resolveMessagesByRefs,
      });
      const list = continueResult(listed, { ok: (value) => value, err: () => null });
      if (list === null) return listed;

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
        return Result.ok(list);
      }
    }
  }

  const context = await adapter.getReplyContext(triggerMsg.ref, { limit });
  const ctx = continueResult(context, { ok: (value) => value, err: () => [triggerMsg] });

  const list = ctx.length > 0 ? ctx.slice() : [triggerMsg];

  if (!list.some((m) => m.ref.messageId === triggerMsg.ref.messageId)) {
    list.push(triggerMsg);
  }

  list.sort((a, b) => a.ts - b.ts);

  const triggerIndex = list.findIndex((m) => m.ref.messageId === triggerMsg.ref.messageId);
  if (triggerIndex < 0) return Result.ok([triggerMsg]);

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
      hardBreakBefore: typeof toReplyChainMessage(m).replyReference.messageId === "string",
    })),
  );
  const groupEndingAtTrigger = groups[groups.length - 1] ?? [];
  return Result.ok(groupEndingAtTrigger.map((m) => m.message));
}

export function findEarliestReplyAnchor(block: readonly SurfaceMessage[]): SurfaceMessage | null {
  for (const m of block) {
    const ref = projectDiscordMessage(m).replyReference;
    if (ref?.messageId) return m;
  }
  return null;
}

export async function findEarliestEffectiveReplyAnchor(
  adapter: SurfaceAdapter,
  block: readonly SurfaceMessage[],
): Promise<SurfaceMessage | null> {
  const directAnchor = findEarliestReplyAnchor(block);
  if (directAnchor) return directAnchor;

  const planned = await mapWithConcurrency({
    items: block,
    concurrency: 8,
    run: async (message) => {
      const result = await adapter.planReplyChain(message.ref);
      return continueResult(result, { ok: (refs) => refs.length > 1, err: () => false });
    },
  });
  return block.find((_, index) => planned[index]) ?? null;
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
    resolveMessagesByRefs?: ResolveDiscordMessagesByRefs;
  },
): Promise<SurfaceOperationResult<ReplyChainMessage[]>> {
  const maxGroupCount = opts.maxDepth ?? 20;

  const planned = await adapter.planReplyChain(opts.startMsgRef, { maxDepth: maxGroupCount });
  const plannedRefs = continueResult(planned, { ok: (value) => value, err: () => [] });
  if (plannedRefs.length > 0) {
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
          const plannedBlock = await adapter.planMergeBlockEndingAt(cursorRef, {
            lookbackLimit: DEFAULT_MENTION_BLOCK_LIMIT,
          });
          const blockRefs = continueResult(plannedBlock, {
            ok: (value) => value,
            err: () => [cursorRef],
          });

          const inChannelBlockRefs = blockRefs.filter(
            (ref) => ref.channelId === opts.trigger.msgRef.channelId,
          );

          const refsToRead = inChannelBlockRefs.length > 0 ? inChannelBlockRefs : [cursorRef];

          const messages = await readMessagesByRefs({
            adapter,
            refs: refsToRead,
            concurrency: 8,
            resolveMessagesByRefs: opts.resolveMessagesByRefs,
          });
          return continueResult(messages, {
            err: (error) => Promise.resolve(Result.err(error)),
            ok: async (messageValues) => {
              const plannedRefKeys = new Set(
                refsToRead.map((r) => `${r.channelId}:${r.messageId}`),
              );
              const resolvedRefKeys = new Set(
                messageValues.map((m) => `${m.ref.channelId}:${m.ref.messageId}`),
              );
              const allResolved =
                plannedRefKeys.size === resolvedRefKeys.size &&
                [...plannedRefKeys].every((key) => resolvedRefKeys.has(key));

              if (allResolved && messageValues.length > 0) return Result.ok(messageValues);
              const cursorResult = opts.resolveMessagesByRefs
                ? await opts
                    .resolveMessagesByRefs([cursorRef])
                    .then((resolved) => resolved.map((messages) => messages[0] ?? null))
                : await adapter.readMsg(cursorRef);
              const continueCursor = cursorResult.match<
                () => Promise<SurfaceOperationResult<SurfaceMessage[]>>
              >({
                err: (error) => async () => Result.err(error),
                ok: (cursor) => () =>
                  cursor
                    ? resolveMergeBlockEndingAt(adapter, cursor, {
                        resolveMessagesByRefs: opts.resolveMessagesByRefs,
                      })
                    : Promise.resolve(Result.ok([])),
              });
              return continueCursor();
            },
          });
        },
      });

      const plannedOutcome = continueResult(Result.all(groups), {
        err: (error) => Result.err(error),
        ok: (resolvedGroups) => {
          const flattened = resolvedGroups.flat();
          if (flattened.length === 0) return null;
          return Result.ok(dedupeByMessageId(flattened.map((m) => toReplyChainMessage(m))));
        },
      });
      if (plannedOutcome) return plannedOutcome;
    }
  }

  const groupsNewestToOldest: ReplyChainMessage[][] = [];
  const seenMessageIds = new Set<string>();
  const finish = (): SurfaceOperationResult<ReplyChainMessage[]> =>
    Result.ok(dedupeByMessageId(groupsNewestToOldest.slice().reverse().flat()));
  const walk = async (
    cursor: SurfaceMessage,
    depth: number,
  ): Promise<SurfaceOperationResult<ReplyChainMessage[]>> => {
    if (depth >= maxGroupCount || seenMessageIds.has(cursor.ref.messageId)) return finish();
    const groupResult = await resolveMergeBlockEndingAt(adapter, cursor, {
      resolveMessagesByRefs: opts.resolveMessagesByRefs,
    });
    const continueGroup = groupResult.match<
      () => Promise<SurfaceOperationResult<ReplyChainMessage[]>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (group) => async () => {
        const first = group[0];
        if (!first) return finish();
        for (const message of group) seenMessageIds.add(message.ref.messageId);
        groupsNewestToOldest.push(group.map((message) => toReplyChainMessage(message)));

        const ref = toReplyChainMessage(first).replyReference;
        if (!ref.messageId) return finish();
        if (ref.channelId && ref.channelId !== opts.trigger.msgRef.channelId) return finish();

        const nextRef = {
          platform: opts.platform,
          channelId: opts.trigger.msgRef.channelId,
          messageId: ref.messageId,
        } as const;
        const next = opts.resolveMessagesByRefs
          ? await opts
              .resolveMessagesByRefs([nextRef])
              .then((resolved) => resolved.map((messages) => messages[0] ?? null))
          : await adapter.readMsg(nextRef);
        const continueNext = next.match<() => Promise<SurfaceOperationResult<ReplyChainMessage[]>>>(
          {
            err: (error) => async () => Result.err(error),
            ok: (value) => () => (value ? walk(value, depth + 1) : Promise.resolve(finish())),
          },
        );
        return continueNext();
      },
    });
    return continueGroup();
  };

  const start = opts.resolveMessagesByRefs
    ? await opts
        .resolveMessagesByRefs([opts.startMsgRef])
        .then((resolved) => resolved.map((messages) => messages[0] ?? null))
    : await adapter.readMsg(opts.startMsgRef);
  const continueStart = start.match<() => Promise<SurfaceOperationResult<ReplyChainMessage[]>>>({
    err: (error) => async () => Result.err(error),
    ok: (value) => () => (value ? walk(value, 0) : Promise.resolve(Result.ok([]))),
  });
  return continueStart();
}

export async function fetchMentionThreadContext(
  adapter: SurfaceAdapter,
  params: {
    platform: "discord";
    botUserId: string;
    botName: string;
    triggerMsg: SurfaceMessage;
    maxDepth?: number;
    resolveMessagesByRefs?: ResolveDiscordMessagesByRefs;
  },
): Promise<SurfaceOperationResult<ReplyChainMessage[]>> {
  const blockResult = await resolveMergeBlockEndingAt(adapter, params.triggerMsg, {
    resolveMessagesByRefs: params.resolveMessagesByRefs,
  });
  const continueBlock = blockResult.match<
    () => Promise<SurfaceOperationResult<ReplyChainMessage[]>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (block) => async () => {
      const anchor = await findEarliestEffectiveReplyAnchor(adapter, block);
      const startMsgRef = anchor?.ref ?? params.triggerMsg.ref;
      const chainResult = await fetchReplyChainFrom(adapter, {
        platform: params.platform,
        botUserId: params.botUserId,
        botName: params.botName,
        trigger: { type: "mention", msgRef: params.triggerMsg.ref },
        startMsgRef,
        maxDepth: params.maxDepth,
        resolveMessagesByRefs: params.resolveMessagesByRefs,
      });
      return continueResult(chainResult, {
        err: (error) => Result.err(error),
        ok: (chain) => {
          const blockMessages = block.map((message) => toReplyChainMessage(message));
          const combined = dedupeByMessageId([...chain, ...blockMessages]);
          combined.sort((a, b) => {
            if (a.ts !== b.ts) return a.ts - b.ts;
            return a.messageId.localeCompare(b.messageId);
          });
          return Result.ok(combined);
        },
      });
    },
  });
  return continueBlock();
}

export function mergeChainByDiscordWindow(
  chainOldestToNewest: readonly ReplyChainMessage[],
  hardBreakBeforeMessageIds: ReadonlySet<string> = new Set(),
): MergedChunk[] {
  if (chainOldestToNewest.length === 0) return [];

  const groups = splitByDiscordWindowOldestToNewest(
    chainOldestToNewest.map((m) => ({
      message: m,
      authorId: m.authorId,
      ts: m.ts,
      hardBreakBefore:
        typeof m.replyReference.messageId === "string" ||
        hardBreakBeforeMessageIds.has(m.messageId),
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
