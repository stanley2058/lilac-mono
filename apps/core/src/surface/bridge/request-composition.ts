import type { ModelMessage, UserContent } from "ai";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";

import {
  isDiscordSessionDividerSurfaceMessageAnyAuthor,
  isDiscordSessionDividerSurfaceMessage,
  isDiscordSessionDividerText,
} from "../discord/discord-session-divider";

import type { TranscriptSnapshot } from "../../transcript/transcript-store";
import {
  appendDiscordAttachmentsToUserContent,
  createDiscordAttachmentState,
} from "./request-composition/attachments";
import {
  buildAssistantOnlyMessageFromTranscript,
  formatDiscordAttributionHeader,
  normalizeAssistantContextText,
  normalizeText,
} from "./request-composition/normalization";
import {
  fetchMentionThreadContext,
  fetchReplyChainFrom,
  findEarliestReplyAnchor,
  getForwardSnapshotTextFromRaw,
  mergeChainByDiscordWindow,
  resolveMergeBlockEndingAt,
  toReplyChainMessage,
} from "./request-composition/reply-chain";
import type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

export type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

function getDiscordIsChatFromRaw(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;
  if (!discord) return undefined;
  const isChat = discord["isChat"];
  return typeof isChat === "boolean" ? isChat : undefined;
}

function shouldIncludeInModelContext(msg: SurfaceMessage): boolean {
  // Listing and surface tools may include platform/system messages (e.g. Discord
  // thread-created notices). By default, do not send those to the model.
  if (msg.session.platform !== "discord") return true;

  const isChat = getDiscordIsChatFromRaw(msg.raw);
  return isChat ?? true;
}

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

function compareDiscordMsgPosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareDiscordSnowflakeLike(a.messageId, b.messageId);
}

function applyDiscordSessionDividerCutoff(params: {
  listOldestToNewest: readonly SurfaceMessage[];
  botUserId: string;
}): SurfaceMessage[] {
  const { listOldestToNewest, botUserId } = params;

  let lastDividerIndex = -1;
  for (let i = 0; i < listOldestToNewest.length; i++) {
    const m = listOldestToNewest[i]!;
    if (isDiscordSessionDividerSurfaceMessage(m, botUserId)) {
      lastDividerIndex = i;
    }
  }

  if (lastDividerIndex < 0) return [...listOldestToNewest];
  return listOldestToNewest.slice(lastDividerIndex + 1);
}

function applyDiscordSessionDividerCutoffToReplyChain(params: {
  chainOldestToNewest: readonly ReplyChainMessage[];
  botUserId: string;
}): ReplyChainMessage[] {
  const { chainOldestToNewest, botUserId } = params;

  let lastDividerIndex = -1;
  for (let i = 0; i < chainOldestToNewest.length; i++) {
    const m = chainOldestToNewest[i]!;
    if (m.authorId === botUserId && isDiscordSessionDividerText(m.text)) {
      lastDividerIndex = i;
    }
  }
  if (lastDividerIndex < 0) return [...chainOldestToNewest];
  return chainOldestToNewest.slice(lastDividerIndex + 1);
}

async function findLastDiscordSessionDividerBefore(params: {
  adapter: SurfaceAdapter;
  channelId: string;
  botUserId: string;
  beforeMessageId: string;
  /** Optional: stop scanning once we see this message id. */
  stopAtMessageId?: string;
}): Promise<{ ts: number; messageId: string } | null> {
  const { adapter, channelId, botUserId, beforeMessageId, stopAtMessageId } = params;

  const sessionRef = { platform: "discord", channelId } as const;

  let cursor: string | undefined = beforeMessageId;
  let scanned = 0;
  const MAX_MESSAGES = 2000;
  const PAGE_SIZE = 200;

  while (cursor && scanned < MAX_MESSAGES) {
    const page = await adapter.listMsg(sessionRef, {
      limit: Math.min(PAGE_SIZE, MAX_MESSAGES - scanned),
      beforeMessageId: cursor,
    });

    if (!page || page.length === 0) return null;
    scanned += page.length;

    // listMsg order is adapter-specific; treat it as an unordered window for detection.
    let newestDivider: { ts: number; messageId: string } | null = null;
    for (const m of page) {
      if (!isDiscordSessionDividerSurfaceMessage(m, botUserId)) continue;
      const pos = { ts: m.ts, messageId: m.ref.messageId };
      if (!newestDivider || compareDiscordMsgPosition(newestDivider, pos) < 0) {
        newestDivider = pos;
      }
    }
    if (newestDivider) return newestDivider;

    if (stopAtMessageId && page.some((m) => m.ref.messageId === stopAtMessageId)) {
      return null;
    }

    // Advance cursor to the oldest message id we saw.
    let oldest = page[0]!;
    for (const m of page) {
      if (
        compareDiscordMsgPosition(
          { ts: m.ts, messageId: m.ref.messageId },
          { ts: oldest.ts, messageId: oldest.ref.messageId },
        ) < 0
      ) {
        oldest = m;
      }
    }

    // Prevent infinite loops if the adapter returns a stable page.
    if (oldest.ref.messageId === cursor) return null;
    cursor = oldest.ref.messageId;
  }

  return null;
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

async function safeListReactions(adapter: SurfaceAdapter, msgRef: MsgRef): Promise<string[]> {
  try {
    return await adapter.listReactions(msgRef);
  } catch {
    return [];
  }
}

async function getReactionsByMessageId(input: {
  adapter: SurfaceAdapter;
  refs: readonly MsgRef[];
  concurrency?: number;
}): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  if (input.refs.length === 0) return out;

  const rows = await mapWithConcurrency({
    items: input.refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      const reactions = await safeListReactions(input.adapter, ref);
      return { messageId: ref.messageId, reactions };
    },
  });

  for (const row of rows) {
    out.set(row.messageId, row.reactions);
  }

  return out;
}

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

  // Step 1: fetch reply chain from the adapter store / platform.
  // Mention triggers get merge-window parity even if messages are not linked via reply references.
  const triggerMsg = await adapter.readMsg(opts.trigger.msgRef);
  if (!triggerMsg) {
    return { messages: [], chainMessageIds: [], mergedGroups: [] };
  }

  const chain =
    opts.trigger.type === "mention"
      ? await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
          maxDepth: opts.maxDepth,
        })
      : await fetchReplyChainFrom(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          trigger: opts.trigger,
          startMsgRef: opts.trigger.msgRef,
          maxDepth: opts.maxDepth,
        });

  const filteredChain = chain.filter((m) => {
    const isChat = getDiscordIsChatFromRaw(m.raw);
    if (!(isChat ?? true)) return false;
    return !isDiscordSessionDividerText(m.text);
  });

  const transformedChain = filteredChain.map((m) => {
    if (m.authorId === opts.botUserId) return m;
    if (!opts.transformUserText) return m;
    const targetMessageId = opts.transformUserTextForMessageId ?? opts.trigger.msgRef.messageId;
    if (m.messageId !== targetMessageId) return m;

    return {
      ...m,
      text: opts.transformUserText(m.text),
    };
  });

  // IMPORTANT: session divider cutoff intentionally does NOT apply to explicit reply/mention
  // chains. If the user replies to (or mentions within) an assistant message after a divider,
  // they are explicitly re-opening that thread; we keep the full linked chain.
  // Divider markers are still always excluded from model context.

  // Step 2: merge by Discord window rules (same author + <= 7 min).
  const merged = mergeChainByDiscordWindow(transformedChain);

  // Phase 3: normalize to ModelMessage[] with attribution headers.
  const attState = createDiscordAttachmentState();

  const modelMessages: ModelMessage[] = [];
  const seenTranscriptRequestIds = new Set<string>();

  const reactionRefs = merged
    .filter((chunk) => chunk.authorId !== opts.botUserId)
    .map((chunk) => {
      const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;
      return {
        platform: opts.platform,
        channelId: opts.trigger.msgRef.channelId,
        messageId,
      } satisfies MsgRef;
    });

  const reactionsByMessageId = await getReactionsByMessageId({
    adapter,
    refs: reactionRefs,
    concurrency: 8,
  });

  for (const chunk of merged) {
    const isBot = chunk.authorId === opts.botUserId;

    const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

    if (isBot && opts.transcriptStore) {
      const snap = opts.transcriptStore.getTranscriptBySurfaceMessage({
        platform: opts.platform,
        channelId: opts.trigger.msgRef.channelId,
        messageId,
      });

      if (snap) {
        if (!seenTranscriptRequestIds.has(snap.requestId)) {
          modelMessages.push(...snap.messages);
          seenTranscriptRequestIds.add(snap.requestId);
        }
        continue;
      }
    }

    const normalized = normalizeText(chunk.text, {
      // We currently rely on adapter text already being normalized (mentions rewritten).
      // If/when adapters expose richer raw mentions, we can do a more faithful rewrite.
    });

    if (isBot) {
      modelMessages.push({
        role: "assistant",
        content: normalizeAssistantContextText(normalized),
      } satisfies ModelMessage);
      continue;
    }

    const reactions = reactionsByMessageId.get(messageId) ?? [];

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      userAlias: opts.discordUserAliasById?.get(chunk.authorId),
      messageId,
      reactions,
    });

    const mainText = `${header}\n${normalized}`.trimEnd();

    if (chunk.attachments.length === 0) {
      modelMessages.push({
        role: "user",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    const parts: UserContent = [{ type: "text", text: mainText }];
    await appendDiscordAttachmentsToUserContent(parts, chunk.attachments, attState);

    modelMessages.push({ role: "user", content: parts } satisfies ModelMessage);
  }

  return {
    messages: modelMessages,
    chainMessageIds: transformedChain.map((m) => m.messageId),
    mergedGroups: merged.map((m) => ({
      authorId: m.authorId,
      messageIds: [...m.messageIds],
    })),
  };
}

export async function composeRecentChannelMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRecentChannelMessagesOpts,
): Promise<RequestCompositionResult> {
  if (opts.platform !== "discord") {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  // Reply precedence: if the trigger is a Discord reply (even when the router
  // classified it as a "mention" trigger because it wasn't a reply-to-bot),
  // treat it as an explicit reply-chain continuation.
  //
  // IMPORTANT: this bypasses active-burst guardrails (age/gap/transcript-age).
  // A reply is a strong "continue" signal.
  if (opts.triggerMsgRef && opts.triggerType === "mention") {
    const triggerMsg = await adapter.readMsg(opts.triggerMsgRef);
    if (triggerMsg) {
      // "Merge block" = a user's short burst of consecutive messages.
      // If ANY message in the burst is a reply, treat the entire burst as a
      // continuation of that reply thread.
      const block = await resolveMergeBlockEndingAt(adapter, triggerMsg);
      const anchor = findEarliestReplyAnchor(block);
      if (anchor) {
        const anchored = await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
        });

        const oldestAnchoredMessageId = anchored[0]?.messageId;

        const divider = oldestAnchoredMessageId
          ? await findLastDiscordSessionDividerBefore({
              adapter,
              channelId: opts.sessionId,
              botUserId: opts.botUserId,
              beforeMessageId: triggerMsg.ref.messageId,
              stopAtMessageId: oldestAnchoredMessageId,
            }).catch(() => null)
          : null;

        const anchoredAfterDivider = divider
          ? anchored.filter(
              (m) => compareDiscordMsgPosition({ ts: m.ts, messageId: m.messageId }, divider) > 0,
            )
          : anchored;

        const anchoredCutChain = applyDiscordSessionDividerCutoffToReplyChain({
          chainOldestToNewest: anchoredAfterDivider,
          botUserId: opts.botUserId,
        });

        const anchoredNoDivider = anchoredCutChain.filter(
          (m) => !isDiscordSessionDividerText(m.text),
        );

        const transformedAnchored = anchoredNoDivider.map((m) => {
          if (m.authorId === opts.botUserId) return m;
          if (!opts.transformUserText) return m;
          const targetMessageId = opts.transformUserTextForMessageId ?? triggerMsg.ref.messageId;
          if (m.messageId !== targetMessageId) return m;

          return {
            ...m,
            text: opts.transformUserText(m.text),
          };
        });

        const merged = mergeChainByDiscordWindow(transformedAnchored);
        const attState = createDiscordAttachmentState();

        const modelMessages: ModelMessage[] = [];
        const seenTranscriptRequestIds = new Set<string>();

        const reactionRefs = merged
          .filter((chunk) => chunk.authorId !== opts.botUserId)
          .map((chunk) => {
            const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;
            return {
              platform: opts.platform,
              channelId: opts.sessionId,
              messageId,
            } satisfies MsgRef;
          });

        const reactionsByMessageId = await getReactionsByMessageId({
          adapter,
          refs: reactionRefs,
          concurrency: 8,
        });

        for (const chunk of merged) {
          const isBot = chunk.authorId === opts.botUserId;
          const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

          if (isBot && opts.transcriptStore) {
            const snap = opts.transcriptStore.getTranscriptBySurfaceMessage({
              platform: opts.platform,
              channelId: opts.sessionId,
              messageId,
            });
            if (snap) {
              if (!seenTranscriptRequestIds.has(snap.requestId)) {
                modelMessages.push(...snap.messages);
                seenTranscriptRequestIds.add(snap.requestId);
              }
              continue;
            }
          }

          const normalized = normalizeText(chunk.text, {});

          if (isBot) {
            modelMessages.push({
              role: "assistant",
              content: normalizeAssistantContextText(normalized),
            } satisfies ModelMessage);
            continue;
          }

          const reactions = reactionsByMessageId.get(messageId) ?? [];

          const header = formatDiscordAttributionHeader({
            authorId: chunk.authorId,
            authorName: chunk.authorName,
            userAlias: opts.discordUserAliasById?.get(chunk.authorId),
            messageId,
            reactions,
          });

          const mainText = `${header}\n${normalized}`.trimEnd();

          if (chunk.attachments.length === 0) {
            modelMessages.push({
              role: "user",
              content: mainText,
            } satisfies ModelMessage);
            continue;
          }

          const parts: UserContent = [{ type: "text", text: mainText }];
          await appendDiscordAttachmentsToUserContent(parts, chunk.attachments, attState);
          modelMessages.push({ role: "user", content: parts } satisfies ModelMessage);
        }

        return {
          messages: modelMessages,
          chainMessageIds: transformedAnchored.map((m) => m.messageId),
          mergedGroups: merged.map((m) => ({
            authorId: m.authorId,
            messageIds: [...m.messageIds],
          })),
        };
      }
    }
  }

  const sessionRef = {
    platform: "discord",
    channelId: opts.sessionId,
  } as const;

  // Active-burst rules are intended for "latest view" prompts, including
  // fresh @mentions that are not replies. They prevent stale context when a
  // channel has been idle.
  const shouldApplyActiveBurstRules = Boolean(opts.triggerMsgRef && opts.triggerType !== "reply");

  // In active-mode gate-forwarded prompts, we may need a little more history to
  // apply time-based cutoffs (age/gap) without relying on fixed "last N".
  const fetchLimit = shouldApplyActiveBurstRules
    ? Math.min(200, Math.max(opts.limit, 50))
    : opts.limit;

  const recent = await adapter.listMsg(sessionRef, { limit: fetchLimit });

  const list: typeof recent = [...recent];

  let fetchedTrigger: SurfaceMessage | null = null;

  if (opts.triggerMsgRef) {
    const exists = list.some((m) => m.ref.messageId === opts.triggerMsgRef!.messageId);
    if (!exists) {
      fetchedTrigger = await adapter.readMsg(opts.triggerMsgRef);
      if (fetchedTrigger) list.push(fetchedTrigger);
    }
  }

  list.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
  });

  // The surface layer can include Discord system/notification messages (e.g.
  // thread-created). Keep them listable via surface tools, but exclude them from
  // the default model context.
  const contextList = list.filter(shouldIncludeInModelContext);

  const triggerMsg = opts.triggerMsgRef
    ? (contextList.find((m) => m.ref.messageId === opts.triggerMsgRef!.messageId) ?? null)
    : null;

  const activeAnchor = shouldApplyActiveBurstRules
    ? (triggerMsg ?? (contextList.length > 0 ? contextList[contextList.length - 1]! : null))
    : null;

  // Divider cutoff should apply before selection rules so we never include pre-divider
  // content even if it is within the age/gap window.
  // IMPORTANT: when using an activeAnchor, only consider messages up to the anchor.
  // (Newer divider messages must not affect the historical anchor context.)
  const dividerCutContextList = (() => {
    if (shouldApplyActiveBurstRules && activeAnchor) {
      const anchorTs = activeAnchor.ts;
      const anchorId = activeAnchor.ref.messageId;
      const eligibleToAnchor = contextList.filter((m) => {
        if (m.ts < anchorTs) return true;
        if (m.ts > anchorTs) return false;
        return compareDiscordSnowflakeLike(m.ref.messageId, anchorId) <= 0;
      });

      return applyDiscordSessionDividerCutoff({
        listOldestToNewest: eligibleToAnchor,
        botUserId: opts.botUserId,
      });
    }

    return applyDiscordSessionDividerCutoff({
      listOldestToNewest: contextList,
      botUserId: opts.botUserId,
    });
  })();

  const ACTIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const ACTIVE_MAX_GAP_MS = 2 * 60 * 60 * 1000;
  const ACTIVE_TRANSCRIPT_MAX_AGE_MS = 1 * 60 * 60 * 1000;

  let selected: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && activeAnchor) {
    const anchorTs = activeAnchor.ts;
    const anchorId = activeAnchor.ref.messageId;

    // Only include messages up to the anchor (avoid pulling in newer messages
    // that arrived after the gate decision).
    const eligible = dividerCutContextList.filter((m) => {
      if (m.ts < anchorTs) return true;
      if (m.ts > anchorTs) return false;
      return compareDiscordSnowflakeLike(m.ref.messageId, anchorId) <= 0;
    });

    const anchorIndex = eligible.findIndex((m) => m.ref.messageId === anchorId);
    const startIndex = anchorIndex >= 0 ? anchorIndex : eligible.length - 1;

    const pickedNewestToOldest: SurfaceMessage[] = [];

    let prev = eligible[startIndex] ?? null;
    if (prev) pickedNewestToOldest.push(prev);

    for (let i = startIndex - 1; i >= 0 && pickedNewestToOldest.length < opts.limit; i--) {
      const cur = eligible[i]!;

      // Absolute age cutoff relative to the anchor message.
      const ageMs = anchorTs - cur.ts;
      if (ageMs > ACTIVE_MAX_AGE_MS) break;

      // Silence-gap cutoff: stop and do NOT include the message that crosses the gap.
      const gapMs = (prev?.ts ?? anchorTs) - cur.ts;
      if (gapMs > ACTIVE_MAX_GAP_MS) break;

      pickedNewestToOldest.push(cur);
      prev = cur;
    }

    selected = pickedNewestToOldest.reverse();
  } else {
    selected = dividerCutContextList.slice(Math.max(0, dividerCutContextList.length - opts.limit));
  }

  // Safety: exclude divider messages from context even if they are chat-like.
  const selectedNoDivider = selected.filter(
    (m) => !isDiscordSessionDividerSurfaceMessageAnyAuthor(m),
  );

  const chain: ReplyChainMessage[] = selectedNoDivider.map((m) => {
    const base = toReplyChainMessage(m);

    const text =
      opts.transformUserText &&
      opts.triggerMsgRef &&
      m.userId !== opts.botUserId &&
      m.ref.messageId === (opts.transformUserTextForMessageId ?? opts.triggerMsgRef.messageId)
        ? opts.transformUserText(base.text)
        : base.text;

    return {
      ...base,
      text,
    };
  });

  const merged = mergeChainByDiscordWindow(chain);

  const attState = createDiscordAttachmentState();

  const modelMessages: ModelMessage[] = [];
  const seenTranscriptRequestIds = new Set<string>();

  const reactionRefs = merged
    .filter((chunk) => chunk.authorId !== opts.botUserId)
    .map((chunk) => {
      const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;
      return {
        platform: opts.platform,
        channelId: opts.sessionId,
        messageId,
      } satisfies MsgRef;
    });

  const reactionsByMessageId = await getReactionsByMessageId({
    adapter,
    refs: reactionRefs,
    concurrency: 8,
  });

  for (const chunk of merged) {
    const isBot = chunk.authorId === opts.botUserId;
    const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

    const anchorTsForTranscript = shouldApplyActiveBurstRules ? (activeAnchor?.ts ?? null) : null;
    const transcriptAgeMs =
      anchorTsForTranscript !== null ? anchorTsForTranscript - chunk.tsEnd : null;
    const allowTranscriptExpansion =
      !shouldApplyActiveBurstRules ||
      transcriptAgeMs === null ||
      transcriptAgeMs <= ACTIVE_TRANSCRIPT_MAX_AGE_MS;

    let botTranscriptSnap: TranscriptSnapshot | null = null;
    if (isBot && opts.transcriptStore) {
      botTranscriptSnap = opts.transcriptStore.getTranscriptBySurfaceMessage({
        platform: opts.platform,
        channelId: opts.sessionId,
        messageId,
      });
    }

    if (botTranscriptSnap && !seenTranscriptRequestIds.has(botTranscriptSnap.requestId)) {
      if (allowTranscriptExpansion) {
        modelMessages.push(...botTranscriptSnap.messages);
        seenTranscriptRequestIds.add(botTranscriptSnap.requestId);
        continue;
      }

      const assistantOnly = buildAssistantOnlyMessageFromTranscript(botTranscriptSnap);
      if (assistantOnly) {
        modelMessages.push(assistantOnly);
        seenTranscriptRequestIds.add(botTranscriptSnap.requestId);
        continue;
      }
    }

    const normalized = normalizeText(chunk.text, {});

    if (isBot) {
      modelMessages.push({
        role: "assistant",
        content: normalizeAssistantContextText(normalized),
      } satisfies ModelMessage);
      continue;
    }

    const reactions = reactionsByMessageId.get(messageId) ?? [];

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      userAlias: opts.discordUserAliasById?.get(chunk.authorId),
      messageId,
      reactions,
    });

    const mainText = `${header}\n${normalized}`.trimEnd();

    if (chunk.attachments.length === 0) {
      modelMessages.push({
        role: "user",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    const parts: UserContent = [{ type: "text", text: mainText }];
    await appendDiscordAttachmentsToUserContent(parts, chunk.attachments, attState);
    modelMessages.push({ role: "user", content: parts } satisfies ModelMessage);
  }

  return {
    messages: modelMessages,
    chainMessageIds: chain.map((m) => m.messageId),
    mergedGroups: merged.map((m) => ({
      authorId: m.authorId,
      messageIds: [...m.messageIds],
    })),
  };
}

export async function composeSingleMessage(
  adapter: SurfaceAdapter,
  opts: ComposeSingleMessageOpts,
): Promise<ModelMessage | null> {
  if (opts.platform !== "discord") {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  const m = await adapter.readMsg(opts.msgRef);
  if (!m) return null;

  if (!shouldIncludeInModelContext(m)) return null;

  // Never include session divider markers in model context.
  if (isDiscordSessionDividerSurfaceMessageAnyAuthor(m)) return null;

  let text = m.text.trim().length > 0 ? m.text : (getForwardSnapshotTextFromRaw(m.raw) ?? m.text);

  if (m.userId !== opts.botUserId && opts.transformUserText) {
    text = opts.transformUserText(text);
  }

  if (m.userId === opts.botUserId) {
    return {
      role: "assistant",
      content: normalizeAssistantContextText(normalizeText(text, {})),
    } satisfies ModelMessage;
  }

  const header = formatDiscordAttributionHeader({
    authorId: m.userId,
    authorName: m.userName ?? `user_${m.userId}`,
    userAlias: opts.discordUserAliasById?.get(m.userId),
    messageId: m.ref.messageId,
    reactions: await safeListReactions(adapter, m.ref),
  });

  const mainText = `${header}\n${normalizeText(text, {})}`.trimEnd();

  const attachments = toReplyChainMessage(m).attachments;
  if (attachments.length === 0) {
    return { role: "user", content: mainText } satisfies ModelMessage;
  }

  const parts: UserContent = [{ type: "text", text: mainText }];
  await appendDiscordAttachmentsToUserContent(parts, attachments, createDiscordAttachmentState());

  return { role: "user", content: parts } satisfies ModelMessage;
}
