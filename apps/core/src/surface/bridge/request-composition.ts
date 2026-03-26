import type { ModelMessage, UserContent } from "ai";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";

import {
  parseLeadingContinueDirective,
  stripLeadingContinueDirective,
} from "./bus-request-router/common";
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

function applyUserTextTransformToReplyChainMessage(input: {
  message: ReplyChainMessage;
  transformUserText?: (text: string) => string;
  shouldTransform: boolean;
}): ReplyChainMessage {
  const { message, transformUserText, shouldTransform } = input;
  if (!shouldTransform || !transformUserText) return message;

  const text = transformUserText(message.text);

  return {
    ...message,
    text,
  };
}

function toReplyChainMessageForModelContext(input: {
  message: SurfaceMessage;
  botUserId: string;
  triggerMessageId?: string;
  transformUserText?: (text: string) => string;
}): ReplyChainMessage {
  const base = toReplyChainMessage(input.message);
  return applyUserTextTransformToReplyChainMessage({
    message: base,
    transformUserText: input.transformUserText,
    shouldTransform:
      input.message.userId !== input.botUserId &&
      typeof input.triggerMessageId === "string" &&
      input.message.ref.messageId === input.triggerMessageId,
  });
}

function getSurfaceMessageContextText(message: SurfaceMessage): string {
  return message.text.trim().length > 0
    ? message.text
    : (getForwardSnapshotTextFromRaw(message.raw) ?? message.text);
}

function stripContinueDirectiveFromReplyChainMessage(input: {
  message: ReplyChainMessage;
  botUserId: string;
  botMentionNames: readonly string[];
}): ReplyChainMessage {
  if (input.message.authorId === input.botUserId) return input.message;

  const stripped = stripLeadingContinueDirective({
    text: input.message.text,
    botNames: input.botMentionNames,
  });
  if (stripped === input.message.text) return input.message;

  return {
    ...input.message,
    text: stripped,
  };
}

function findLatestVisibleContinueDirective(input: {
  selected: readonly SurfaceMessage[];
  selectedStartIndex: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): { absoluteIndex: number; count: number } | null {
  for (let i = input.selected.length - 1; i >= 0; i--) {
    const message = input.selected[i]!;
    if (message.userId === input.botUserId) continue;

    const count = parseLeadingContinueDirective({
      text: getSurfaceMessageContextText(message),
      botNames: input.botMentionNames,
    });
    if (count === undefined) continue;

    return {
      absoluteIndex: input.selectedStartIndex + i,
      count,
    };
  }

  return null;
}

async function listRecentMessagesEndingAt(params: {
  adapter: SurfaceAdapter;
  sessionId: string;
  anchor: SurfaceMessage;
  maxPreviousMessages: number;
  previousMessageTargets?: readonly number[];
  shouldContinue?: (input: {
    collected: readonly SurfaceMessage[];
    exhausted: boolean;
    fetchedPreviousMessages: number;
  }) => boolean;
}): Promise<SurfaceMessage[]> {
  const sessionRef = {
    platform: "discord",
    channelId: params.sessionId,
  } as const;

  const previousMessageTargets = (() => {
    const requested = params.previousMessageTargets ?? [params.maxPreviousMessages];
    const normalized = requested
      .map((target) => Math.min(params.maxPreviousMessages, Math.max(0, Math.floor(target))))
      .filter((target, index, list) => target > 0 && list.indexOf(target) === index)
      .sort((a, b) => a - b);

    if (
      normalized.length === 0 ||
      normalized[normalized.length - 1] !== params.maxPreviousMessages
    ) {
      normalized.push(params.maxPreviousMessages);
    }

    return normalized;
  })();

  const seen = new Set<string>([params.anchor.ref.messageId]);
  const collected: SurfaceMessage[] = [params.anchor];
  let cursor: string | undefined = params.anchor.ref.messageId;
  let remaining = Math.max(0, params.maxPreviousMessages);
  let fetchedPreviousMessages = 0;
  let exhausted = false;

  const getSortedCollected = () =>
    collected
      .slice()
      .sort((a, b) =>
        compareDiscordMsgPosition(
          { ts: a.ts, messageId: a.ref.messageId },
          { ts: b.ts, messageId: b.ref.messageId },
        ),
      );

  for (const target of previousMessageTargets) {
    while (cursor && fetchedPreviousMessages < target && remaining > 0) {
      const page = await params.adapter.listMsg(sessionRef, {
        limit: Math.min(100, remaining, target - fetchedPreviousMessages),
        beforeMessageId: cursor,
      });
      if (!page || page.length === 0) {
        exhausted = true;
        cursor = undefined;
        break;
      }

      let oldestInPage: SurfaceMessage | null = null;
      let addedAny = false;

      for (const message of page) {
        if (message.session.channelId !== params.sessionId) continue;
        if (seen.has(message.ref.messageId)) continue;
        seen.add(message.ref.messageId);
        collected.push(message);
        addedAny = true;
        fetchedPreviousMessages += 1;
        remaining -= 1;

        if (
          !oldestInPage ||
          compareDiscordMsgPosition(
            { ts: message.ts, messageId: message.ref.messageId },
            { ts: oldestInPage.ts, messageId: oldestInPage.ref.messageId },
          ) < 0
        ) {
          oldestInPage = message;
        }

        if (remaining <= 0 || fetchedPreviousMessages >= target) break;
      }

      if (!addedAny || !oldestInPage) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      if (oldestInPage.ref.messageId === cursor) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      cursor = oldestInPage.ref.messageId;
    }

    if (
      params.shouldContinue &&
      !params.shouldContinue({
        collected: getSortedCollected(),
        exhausted,
        fetchedPreviousMessages,
      })
    ) {
      return getSortedCollected();
    }

    if (exhausted || remaining <= 0) break;
  }

  return getSortedCollected();
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

const ACTIVE_BURST_HISTORY_CAP = 200;
const ACTIVE_BURST_HISTORY_TARGETS = [16, 48, 112, ACTIVE_BURST_HISTORY_CAP] as const;
const ACTIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const ACTIVE_MAX_GAP_MS = 2 * 60 * 60 * 1000;
const ACTIVE_TRANSCRIPT_MAX_AGE_MS = 1 * 60 * 60 * 1000;

type ActiveBurstSelection = {
  selected: SurfaceMessage[];
  dividerBoundaryReached: boolean;
  hitAgeCutoff: boolean;
  hitGapCutoff: boolean;
  hasVisibleContinue: boolean;
  unresolvedContinue: boolean;
};

function filterMessagesUpToAnchor(input: {
  list: readonly SurfaceMessage[];
  anchor: SurfaceMessage;
}): SurfaceMessage[] {
  const anchorTs = input.anchor.ts;
  const anchorId = input.anchor.ref.messageId;

  return input.list.filter((message) => {
    if (message.ts < anchorTs) return true;
    if (message.ts > anchorTs) return false;
    return compareDiscordSnowflakeLike(message.ref.messageId, anchorId) <= 0;
  });
}

function selectActiveBurstMessages(input: {
  contextList: readonly SurfaceMessage[];
  activeAnchor: SurfaceMessage;
  limit: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): ActiveBurstSelection {
  const eligibleToAnchor = filterMessagesUpToAnchor({
    list: input.contextList,
    anchor: input.activeAnchor,
  });

  const eligible = applyDiscordSessionDividerCutoff({
    listOldestToNewest: eligibleToAnchor,
    botUserId: input.botUserId,
  });

  const dividerBoundaryReached = eligible.length !== eligibleToAnchor.length;
  const anchorId = input.activeAnchor.ref.messageId;
  const anchorTs = input.activeAnchor.ts;
  const anchorIndex = eligible.findIndex((message) => message.ref.messageId === anchorId);
  const startIndex = anchorIndex >= 0 ? anchorIndex : eligible.length - 1;

  if (startIndex < 0) {
    return {
      selected: [],
      dividerBoundaryReached,
      hitAgeCutoff: false,
      hitGapCutoff: false,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  const pickedNewestToOldest: SurfaceMessage[] = [];
  let hitAgeCutoff = false;
  let hitGapCutoff = false;

  let prev = eligible[startIndex] ?? null;
  if (prev) pickedNewestToOldest.push(prev);

  for (let i = startIndex - 1; i >= 0 && pickedNewestToOldest.length < input.limit; i--) {
    const cur = eligible[i]!;

    const ageMs = anchorTs - cur.ts;
    if (ageMs > ACTIVE_MAX_AGE_MS) {
      hitAgeCutoff = true;
      break;
    }

    const gapMs = (prev?.ts ?? anchorTs) - cur.ts;
    if (gapMs > ACTIVE_MAX_GAP_MS) {
      hitGapCutoff = true;
      break;
    }

    pickedNewestToOldest.push(cur);
    prev = cur;
  }

  const provisionalSelected = pickedNewestToOldest.reverse();
  const provisionalStartIndex = Math.max(0, startIndex - (provisionalSelected.length - 1));
  const latestVisibleContinue = findLatestVisibleContinueDirective({
    selected: provisionalSelected,
    selectedStartIndex: provisionalStartIndex,
    botUserId: input.botUserId,
    botMentionNames: input.botMentionNames,
  });

  if (!latestVisibleContinue) {
    return {
      selected: provisionalSelected,
      dividerBoundaryReached,
      hitAgeCutoff,
      hitGapCutoff,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  const desiredFloorIndex = latestVisibleContinue.absoluteIndex - latestVisibleContinue.count;
  const floorIndex = Math.max(0, desiredFloorIndex);

  return {
    selected: eligible.slice(floorIndex, startIndex + 1),
    dividerBoundaryReached,
    hitAgeCutoff,
    hitGapCutoff,
    hasVisibleContinue: true,
    unresolvedContinue: desiredFloorIndex < 0,
  };
}

function shouldContinueLoadingActiveBurstHistory(input: {
  selection: ActiveBurstSelection;
  exhausted: boolean;
  limit: number;
}): boolean {
  if (input.exhausted) return false;
  if (input.selection.dividerBoundaryReached) return false;
  if (input.selection.unresolvedContinue) return true;
  if (input.selection.hasVisibleContinue) return false;
  if (input.selection.selected.length >= input.limit) return false;
  if (input.selection.hitAgeCutoff || input.selection.hitGapCutoff) return false;
  return true;
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
    const targetMessageId = opts.transformUserTextForMessageId ?? opts.trigger.msgRef.messageId;
    const transformed = applyUserTextTransformToReplyChainMessage({
      message: m,
      transformUserText: opts.transformUserText,
      shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: [opts.botName],
    });
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
      messageTs: chunk.tsEnd,
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
          const targetMessageId = opts.transformUserTextForMessageId ?? triggerMsg.ref.messageId;
          const transformed = applyUserTextTransformToReplyChainMessage({
            message: m,
            transformUserText: opts.transformUserText,
            shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
          });

          return stripContinueDirectiveFromReplyChainMessage({
            message: transformed,
            botUserId: opts.botUserId,
            botMentionNames: opts.botMentionNames ?? [opts.botName],
          });
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
            messageTs: chunk.tsEnd,
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
  const continueDirectiveBotNames = opts.botMentionNames ?? [opts.botName];

  // Active-burst rules are intended for "latest view" prompts, including
  // fresh @mentions that are not replies. They prevent stale context when a
  // channel has been idle.
  const shouldApplyActiveBurstRules = Boolean(opts.triggerMsgRef && opts.triggerType !== "reply");

  let orderedList: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && opts.triggerMsgRef) {
    const triggerMsg = await adapter.readMsg(opts.triggerMsgRef);
    orderedList = triggerMsg
      ? await listRecentMessagesEndingAt({
          adapter,
          sessionId: opts.sessionId,
          anchor: triggerMsg,
          maxPreviousMessages: ACTIVE_BURST_HISTORY_CAP,
          previousMessageTargets: ACTIVE_BURST_HISTORY_TARGETS,
          shouldContinue: ({ collected, exhausted }) => {
            const activeContextList = collected.filter(shouldIncludeInModelContext);
            const activeTriggerMsg =
              activeContextList.find(
                (message) => message.ref.messageId === opts.triggerMsgRef!.messageId,
              ) ?? null;
            const activeAnchor =
              activeTriggerMsg ??
              (activeContextList.length > 0
                ? activeContextList[activeContextList.length - 1]!
                : null);

            if (!activeAnchor) return !exhausted;

            return shouldContinueLoadingActiveBurstHistory({
              selection: selectActiveBurstMessages({
                contextList: activeContextList,
                activeAnchor,
                limit: opts.limit,
                botUserId: opts.botUserId,
                botMentionNames: continueDirectiveBotNames,
              }),
              exhausted,
              limit: opts.limit,
            });
          },
        })
      : [];
  } else {
    orderedList = [...(await adapter.listMsg(sessionRef, { limit: opts.limit }))];

    if (opts.triggerMsgRef) {
      const exists = orderedList.some((m) => m.ref.messageId === opts.triggerMsgRef!.messageId);
      if (!exists) {
        const fetchedTrigger = await adapter.readMsg(opts.triggerMsgRef);
        if (fetchedTrigger) orderedList.push(fetchedTrigger);
      }
    }

    orderedList.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
    });
  }

  // The surface layer can include Discord system/notification messages (e.g.
  // thread-created). Keep them listable via surface tools, but exclude them from
  // the default model context.
  const contextList = orderedList.filter(shouldIncludeInModelContext);

  const triggerMsg = opts.triggerMsgRef
    ? (contextList.find((m) => m.ref.messageId === opts.triggerMsgRef!.messageId) ?? null)
    : null;

  const activeAnchor = shouldApplyActiveBurstRules
    ? (triggerMsg ?? (contextList.length > 0 ? contextList[contextList.length - 1]! : null))
    : null;

  const dividerCutContextList =
    shouldApplyActiveBurstRules && activeAnchor
      ? applyDiscordSessionDividerCutoff({
          listOldestToNewest: filterMessagesUpToAnchor({
            list: contextList,
            anchor: activeAnchor,
          }),
          botUserId: opts.botUserId,
        })
      : applyDiscordSessionDividerCutoff({
          listOldestToNewest: contextList,
          botUserId: opts.botUserId,
        });

  let selected: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && activeAnchor) {
    selected = selectActiveBurstMessages({
      contextList,
      activeAnchor,
      limit: opts.limit,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    }).selected;
  } else {
    selected = dividerCutContextList.slice(Math.max(0, dividerCutContextList.length - opts.limit));
  }

  // Safety: exclude divider messages from context even if they are chat-like.
  const selectedNoDivider = selected.filter(
    (m) => !isDiscordSessionDividerSurfaceMessageAnyAuthor(m),
  );

  const chain: ReplyChainMessage[] = selectedNoDivider.map((m) => {
    const transformed = toReplyChainMessageForModelContext({
      message: m,
      botUserId: opts.botUserId,
      triggerMessageId: opts.triggerMsgRef
        ? (opts.transformUserTextForMessageId ?? opts.triggerMsgRef.messageId)
        : undefined,
      transformUserText: opts.transformUserText,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    });
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
      messageTs: chunk.tsEnd,
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
  const contentTransform = m.userId !== opts.botUserId ? opts.transformUserText : undefined;

  if (contentTransform) {
    text = contentTransform(text);
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
    messageTs: m.ts,
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
