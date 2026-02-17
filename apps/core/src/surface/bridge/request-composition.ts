import { Buffer } from "node:buffer";

import type { ModelMessage, UserContent } from "ai";
import { fileTypeFromBuffer } from "file-type/core";

import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";

import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";

import {
  isDiscordSessionDividerSurfaceMessageAnyAuthor,
  isDiscordSessionDividerSurfaceMessage,
  isDiscordSessionDividerText,
} from "../discord/discord-session-divider";
import { splitByDiscordWindowOldestToNewest } from "../discord/merge-window";

import type { TranscriptSnapshot, TranscriptStore } from "../../transcript/transcript-store";

export type RequestCompositionResult = {
  messages: ModelMessage[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
};

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

export type ComposeRecentChannelMessagesOpts = {
  platform: "discord";
  sessionId: string;
  botUserId: string;
  botName: string;
  limit: number;
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
  /** Optional trigger message to force-include (mention/reply). */
  triggerMsgRef?: MsgRef;
  triggerType?: "mention" | "reply";
};

export type ComposeSingleMessageOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  msgRef: MsgRef;
  discordUserAliasById?: ReadonlyMap<string, string>;
  transformUserText?: (text: string) => string;
};

export type ComposeRequestOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
  trigger: {
    type: "mention" | "reply";
    msgRef: MsgRef;
  };
  maxDepth?: number;
};

async function safeListReactions(adapter: SurfaceAdapter, msgRef: MsgRef): Promise<string[]> {
  try {
    return await adapter.listReactions(msgRef);
  } catch {
    return [];
  }
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

  // IMPORTANT: session divider cutoff intentionally does NOT apply to explicit reply/mention
  // chains. If the user replies to (or mentions within) an assistant message after a divider,
  // they are explicitly re-opening that thread; we keep the full linked chain.
  // Divider markers are still always excluded from model context.

  // Step 2: merge by Discord window rules (same author + <= 7 min).
  const merged = mergeChainByDiscordWindow(filteredChain);

  // Phase 3: normalize to ModelMessage[] with attribution headers.
  const attState = createDiscordAttachmentState();

  const modelMessages: ModelMessage[] = [];
  const seenTranscriptRequestIds = new Set<string>();

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

    const reactions = await safeListReactions(adapter, {
      platform: opts.platform,
      channelId: opts.trigger.msgRef.channelId,
      messageId,
    });

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
    chainMessageIds: filteredChain.map((m) => m.messageId),
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

        const merged = mergeChainByDiscordWindow(anchoredNoDivider);
        const attState = createDiscordAttachmentState();

        const modelMessages: ModelMessage[] = [];
        const seenTranscriptRequestIds = new Set<string>();

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

          const reactions = await safeListReactions(adapter, {
            platform: opts.platform,
            channelId: opts.sessionId,
            messageId,
          });

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
          chainMessageIds: anchoredNoDivider.map((m) => m.messageId),
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

  const chain: ReplyChainMessage[] = selectedNoDivider.map((m) => ({
    messageId: m.ref.messageId,
    authorId: m.userId,
    authorName: m.userName ?? `user_${m.userId}`,
    ts: m.ts,
    text:
      m.userId !== opts.botUserId
        ? stripLeadingBotMention(m.text, opts.botUserId, opts.botName)
        : m.text,
    attachments: extractDiscordAttachmentsFromRaw(m.raw),
    raw: m.raw,
  }));

  const merged = mergeChainByDiscordWindow(chain);

  const attState = createDiscordAttachmentState();

  const modelMessages: ModelMessage[] = [];
  const seenTranscriptRequestIds = new Set<string>();

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

    const reactions = await safeListReactions(adapter, {
      platform: opts.platform,
      channelId: opts.sessionId,
      messageId,
    });

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

  let text =
    m.userId !== opts.botUserId
      ? stripLeadingBotMention(m.text, opts.botUserId, opts.botName)
      : m.text;

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

  const attachments = extractDiscordAttachmentsFromRaw(m.raw);
  if (attachments.length === 0) {
    return { role: "user", content: mainText } satisfies ModelMessage;
  }

  const parts: UserContent = [{ type: "text", text: mainText }];

  await appendDiscordAttachmentsToUserContent(parts, attachments, createDiscordAttachmentState());

  return { role: "user", content: parts } satisfies ModelMessage;
}

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type DiscordAttachmentState = {
  downloadedTotalBytes: number;
  // URL -> downloaded bytes + inferred mime type
  cache: Map<string, { bytes: Uint8Array; mimeType?: string }>;
};

function createDiscordAttachmentState(): DiscordAttachmentState {
  return { downloadedTotalBytes: 0, cache: new Map() };
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const mt = mimeType.split(";")[0]?.trim();
  return mt && mt.length > 0 ? mt : undefined;
}

function isTextExtractableMimeType(mimeType: string | undefined): boolean {
  const mt = normalizeMimeType(mimeType);
  if (!mt) return false;
  if (mt.startsWith("text/")) return true;
  if (mt === "application/json") return true;
  if (mt === "application/javascript") return true;
  if (mt === "application/xml") return true;
  if (mt === "application/yaml") return true;
  if (mt === "application/x-yaml") return true;
  if (mt.startsWith("application/") && mt.endsWith("+json")) return true;
  return false;
}

function isPdfMimeType(mimeType: string | undefined): boolean {
  return normalizeMimeType(mimeType) === "application/pdf";
}

function isImageMimeType(mimeType: string | undefined): boolean {
  const mt = normalizeMimeType(mimeType);
  return Boolean(mt && mt.startsWith("image/"));
}

function escapeMetadataValue(s: string): string {
  // Keep the header single-line and parseable.
  return s.replace(/\s+/gu, " ").replace(/"/gu, '\\"');
}

function formatDiscordAttachmentHeader(params: {
  url: URL;
  filename?: string;
  mimeType?: string;
  size?: number;
}): string {
  const fields: string[] = [];
  if (params.filename) fields.push(`filename="${escapeMetadataValue(params.filename)}"`);
  if (params.mimeType) fields.push(`mime="${escapeMetadataValue(params.mimeType)}"`);
  if (typeof params.size === "number") fields.push(`size=${params.size}`);
  fields.push(`url="${escapeMetadataValue(params.url.toString())}"`);
  return `[discord_attachment ${fields.join(" ")}]`;
}

function decodeUtf8BestEffort(bytes: Uint8Array): {
  text?: string;
  reason?: "too_large" | "looks_binary";
  truncatedBytes: boolean;
} {
  const MAX_TEXT_BYTES = 512 * 1024;
  const MAX_TEXT_CHARS = 50_000;

  const view = bytes.byteLength > MAX_TEXT_BYTES ? bytes.slice(0, MAX_TEXT_BYTES) : bytes;
  const truncatedBytes = view.byteLength !== bytes.byteLength;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(view);

  // Basic binary guardrails even when mime says text.
  if (text.includes("\u0000")) {
    return { reason: "looks_binary", truncatedBytes, text: undefined };
  }

  const replacementCount = (text.match(/\uFFFD/gu) ?? []).length;
  if (replacementCount > 0) {
    const ratio = replacementCount / Math.max(1, text.length);
    if (ratio > 0.02) {
      return { reason: "looks_binary", truncatedBytes, text: undefined };
    }
  }

  const clamped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const truncated = truncatedBytes || clamped.length !== text.length;
  return { text: clamped, truncatedBytes: truncated, reason: undefined };
}

function bestEffortInferMimeType(params: { filename?: string; url?: URL }): string | undefined {
  if (params.filename) {
    const inferred = inferMimeTypeFromFilename(params.filename);
    if (inferred !== "application/octet-stream") return inferred;
  }

  if (params.url) {
    const path = params.url.pathname.split("/").pop();
    if (path) {
      const inferred = inferMimeTypeFromFilename(path);
      if (inferred !== "application/octet-stream") return inferred;
    }
  }

  return undefined;
}

async function downloadDiscordAttachment(url: URL): Promise<{
  bytes: Uint8Array;
  contentType?: string;
}> {
  if (!DISCORD_CDN_HOSTS.has(url.hostname)) {
    throw new Error(
      `Blocked attachment host '${url.hostname}'. Allowed: ${[...DISCORD_CDN_HOSTS].join(", ")}`,
    );
  }

  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download attachment (${res.status}): ${url.toString()}`);
  }

  const ab = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: normalizeMimeType(res.headers.get("content-type") ?? undefined),
  };
}

async function appendDiscordAttachmentsToUserContent(
  parts: Exclude<UserContent, string>,
  attachments: readonly DiscordAttachmentMeta[],
  state: DiscordAttachmentState,
): Promise<void> {
  for (const att of attachments) {
    let url: URL;
    try {
      url = new URL(att.url);
    } catch {
      continue;
    }

    const mimeType = normalizeMimeType(att.mimeType);

    // If Discord provides mime type, follow policy without sniffing.
    // - image/* => image part
    // - application/pdf => file part
    // - text-extractable => download + convert to text part
    // - everything else => do not send as a file part; include URL in text
    if (mimeType) {
      if (isImageMimeType(mimeType)) {
        parts.push({ type: "image", image: url, mediaType: mimeType });
        continue;
      }

      if (isPdfMimeType(mimeType)) {
        parts.push({
          type: "file",
          data: url,
          filename: att.filename,
          mediaType: mimeType,
        });
        continue;
      }

      if (!isTextExtractableMimeType(mimeType)) {
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(binary attachment; fetch via URL if needed)`,
        });
        continue;
      }

      // Text-extractable: download and inline content.
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment too large to inline; fetch via URL)`,
        });
        continue;
      }

      try {
        const cached = state.cache.get(url.toString());
        const downloaded = cached ? null : await downloadDiscordAttachment(url);

        const bytes = cached?.bytes ?? downloaded!.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const header = formatDiscordAttachmentHeader({
            url,
            filename: att.filename,
            mimeType,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(text attachment too large to inline; fetch via URL)`,
          });
          continue;
        }

        if (!cached) {
          const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
          if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
            const header = formatDiscordAttachmentHeader({
              url,
              filename: att.filename,
              mimeType,
              size: att.size,
            });
            parts.push({
              type: "text",
              text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
            });
            continue;
          }

          state.downloadedTotalBytes = nextTotal;
          state.cache.set(url.toString(), { bytes, mimeType });
        }

        const decoded = decodeUtf8BestEffort(bytes);
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });

        if (!decoded.text) {
          parts.push({
            type: "text",
            text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
          });
          continue;
        }

        const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
        parts.push({
          type: "text",
          text: `${header}\n${decoded.text}${suffix}`,
        });
        continue;
      } catch {
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment download failed; fetch via URL)`,
        });
        continue;
      }
    }

    // Missing mime type: decide based on inferred type first.
    const inferred = bestEffortInferMimeType({ filename: att.filename, url });
    if (isImageMimeType(inferred)) {
      parts.push({ type: "image", image: url, mediaType: inferred! });
      continue;
    }
    if (isPdfMimeType(inferred)) {
      parts.push({
        type: "file",
        data: url,
        filename: att.filename,
        mediaType: "application/pdf",
      });
      continue;
    }
    if (inferred && isTextExtractableMimeType(inferred)) {
      // Download + inline extracted text.
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: inferred,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment too large to inline; fetch via URL)`,
        });
        continue;
      }
      try {
        const cached = state.cache.get(url.toString());
        const downloaded = cached ? null : await downloadDiscordAttachment(url);

        const bytes = cached?.bytes ?? downloaded!.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const header = formatDiscordAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: inferred,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(text attachment too large to inline; fetch via URL)`,
          });
          continue;
        }

        if (!cached) {
          const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
          if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
            const header = formatDiscordAttachmentHeader({
              url,
              filename: att.filename,
              mimeType: inferred,
              size: att.size,
            });
            parts.push({
              type: "text",
              text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
            });
            continue;
          }

          state.downloadedTotalBytes = nextTotal;
          state.cache.set(url.toString(), { bytes, mimeType: inferred });
        }

        const decoded = decodeUtf8BestEffort(bytes);
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: inferred,
          size: att.size,
        });

        if (!decoded.text) {
          parts.push({
            type: "text",
            text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
          });
          continue;
        }

        const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
        parts.push({
          type: "text",
          text: `${header}\n${decoded.text}${suffix}`,
        });
        continue;
      } catch {
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: inferred,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment download failed; fetch via URL)`,
        });
        continue;
      }
    }

    // If we can infer a non-text, non-pdf, non-image type from filename, treat as binary and
    // leave a URL for the agent to fetch (don't send file part upstream).
    if (inferred && inferred !== "application/octet-stream") {
      const header = formatDiscordAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: inferred,
        size: att.size,
      });
      parts.push({
        type: "text",
        text: `${header}\n(binary attachment; fetch via URL if needed)`,
      });
      continue;
    }

    // Unknown: download once, infer, and (only) inline if it's text-extractable.
    const cached = state.cache.get(url.toString());

    let bytes: Uint8Array | undefined;
    let resolvedMimeType: string | undefined;

    if (cached) {
      bytes = cached.bytes;
      resolvedMimeType = cached.mimeType;
    } else {
      // Size pre-check if available.
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const fallback =
          bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
        if (isImageMimeType(fallback)) {
          parts.push({ type: "image", image: url, mediaType: fallback });
          continue;
        }
        if (isPdfMimeType(fallback)) {
          parts.push({
            type: "file",
            data: url,
            filename: att.filename,
            mediaType: "application/pdf",
          });
          continue;
        }

        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: fallback,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(attachment too large to download; fetch via URL)`,
        });
        continue;
      }

      try {
        const downloaded = await downloadDiscordAttachment(url);
        bytes = downloaded.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const fallback =
            bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
          if (isImageMimeType(fallback)) {
            parts.push({ type: "image", image: url, mediaType: fallback });
            continue;
          }
          if (isPdfMimeType(fallback)) {
            parts.push({
              type: "file",
              data: url,
              filename: att.filename,
              mediaType: "application/pdf",
            });
            continue;
          }

          const header = formatDiscordAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: fallback,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(attachment too large to download; fetch via URL)`,
          });
          continue;
        }

        // Track only bytes we actually downloaded in this call.
        state.downloadedTotalBytes += bytes.byteLength;
        if (state.downloadedTotalBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
          const fallback =
            bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
          if (isImageMimeType(fallback)) {
            parts.push({ type: "image", image: url, mediaType: fallback });
            continue;
          }
          if (isPdfMimeType(fallback)) {
            parts.push({
              type: "file",
              data: url,
              filename: att.filename,
              mediaType: "application/pdf",
            });
            continue;
          }

          const header = formatDiscordAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: fallback,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(attachment download skipped; total bytes too large; fetch via URL)`,
          });
          continue;
        }

        const buf = Buffer.from(bytes);
        const detected = await fileTypeFromBuffer(buf);

        resolvedMimeType =
          detected?.mime ||
          downloaded.contentType ||
          inferred ||
          bestEffortInferMimeType({ filename: att.filename, url }) ||
          "application/octet-stream";

        state.cache.set(url.toString(), { bytes, mimeType: resolvedMimeType });
      } catch {
        // Best-effort: fall back to URL-based attachment.
        const header = formatDiscordAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: inferred,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(attachment download failed; fetch via URL)`,
        });
        continue;
      }
    }

    const mt = resolvedMimeType ?? "application/octet-stream";
    if (!bytes) {
      const header = formatDiscordAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: mt,
        size: att.size,
      });
      parts.push({
        type: "text",
        text: `${header}\n(attachment unavailable; fetch via URL)`,
      });
      continue;
    }

    if (isImageMimeType(mt)) {
      parts.push({ type: "image", image: bytes, mediaType: mt });
      continue;
    }

    if (isPdfMimeType(mt)) {
      parts.push({
        type: "file",
        data: bytes,
        filename: att.filename,
        mediaType: "application/pdf",
      });
      continue;
    }

    if (isTextExtractableMimeType(mt)) {
      const decoded = decodeUtf8BestEffort(bytes);
      const header = formatDiscordAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: mt,
        size: att.size,
      });

      if (!decoded.text) {
        parts.push({
          type: "text",
          text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
        });
        continue;
      }

      const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
      parts.push({
        type: "text",
        text: `${header}\n${decoded.text}${suffix}`,
      });
      continue;
    }

    // Non-text binary: do not send as file part.
    const header = formatDiscordAttachmentHeader({
      url,
      filename: att.filename,
      mimeType: mt,
      size: att.size,
    });
    parts.push({
      type: "text",
      text: `${header}\n(binary attachment; fetch via URL if needed)`,
    });
  }
}

export type ReplyChainMessage = {
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

const DEFAULT_MENTION_BLOCK_LIMIT = 50;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripLeadingBotMention(text: string, botUserId: string, botName: string): string {
  const sanitizedBot = sanitizeUserToken(botName);
  const re = new RegExp(`^(?:<@!?${botUserId}>|@${escapeRegExp(sanitizedBot)})(?:\\s+)?`, "iu");
  return text.replace(re, "");
}

function normalizeText(text: string, _ctx: {}): string {
  return text;
}

function stripLeadingDiscordAttributionHeader(text: string): string {
  // Defensive: remove historical attribution headers that may have been echoed
  // into assistant outputs and can poison later generations.
  // This strips header lines at the start of the text and after merged separators.
  return text.replace(/(^|\n)\[discord\s+[^\n\]]*message_id=[^\n\]]*\]\n?/gu, "$1");
}

function normalizeAssistantContextText(text: string): string {
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

function buildAssistantOnlyMessageFromTranscript(snap: TranscriptSnapshot): ModelMessage | null {
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

function formatDiscordAttributionHeader(params: {
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

type DiscordAttachmentMeta = {
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

function extractDiscordAttachmentsFromRaw(raw: unknown): DiscordAttachmentMeta[] {
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
  const o = raw as Record<string, unknown>;

  // Preferred (Discord API shape): reference: { messageId, channelId }
  if ("reference" in o) {
    const ref = o.reference;
    if (ref && typeof ref === "object") {
      const r = ref as Record<string, unknown>;
      const messageId = typeof r.messageId === "string" ? r.messageId : undefined;
      const channelId = typeof r.channelId === "string" ? r.channelId : undefined;
      if (messageId) return { messageId, channelId };
    }
  }

  // Back-compat: older stored rows and adapter events.
  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;
  const replyToMessageId =
    discord && typeof discord.replyToMessageId === "string" ? discord.replyToMessageId : undefined;
  if (replyToMessageId) return { messageId: replyToMessageId };

  return {};
}

function toReplyChainMessage(
  msg: SurfaceMessage,
  opts?: {
    overrideText?: string;
    authorNameFallback?: string;
  },
): ReplyChainMessage {
  return {
    messageId: msg.ref.messageId,
    authorId: msg.userId,
    authorName: msg.userName ?? opts?.authorNameFallback ?? `user_${msg.userId}`,
    ts: msg.ts,
    text: opts?.overrideText ?? msg.text,
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

async function resolveMergeBlockEndingAt(
  adapter: SurfaceAdapter,
  triggerMsg: SurfaceMessage,
  opts?: { limit?: number },
): Promise<SurfaceMessage[]> {
  const limit = opts?.limit ?? DEFAULT_MENTION_BLOCK_LIMIT;

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
    })),
  );
  const groupEndingAtTrigger = groups[groups.length - 1] ?? [];
  return groupEndingAtTrigger.map((m) => m.message);
}

function findEarliestReplyAnchor(block: readonly SurfaceMessage[]): SurfaceMessage | null {
  for (const m of block) {
    const ref = getReferenceFromRaw(m.raw);
    if (ref.messageId) return m;
  }
  return null;
}

async function fetchReplyChainFrom(
  adapter: SurfaceAdapter,
  opts: {
    platform: "discord";
    botUserId: string;
    botName: string;
    trigger: { type: "mention" | "reply"; msgRef: MsgRef };
    startMsgRef: MsgRef;
    maxDepth?: number;
  },
): Promise<ReplyChainMessage[]> {
  const maxDepth = opts.maxDepth ?? 20;

  const chainNewestToOldest: ReplyChainMessage[] = [];

  let cur = await adapter.readMsg(opts.startMsgRef);
  if (!cur) return [];

  for (let depth = 0; depth < maxDepth && cur; depth++) {
    const overrideText =
      cur.userId !== opts.botUserId
        ? stripLeadingBotMention(cur.text, opts.botUserId, opts.botName)
        : undefined;

    chainNewestToOldest.push(toReplyChainMessage(cur, { overrideText }));

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

async function fetchMentionThreadContext(
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
    const overrideText =
      m.userId !== params.botUserId
        ? stripLeadingBotMention(m.text, params.botUserId, params.botName)
        : undefined;
    return toReplyChainMessage(m, { overrideText });
  });

  const combined = dedupeByMessageId([...chain, ...blockMessages]);

  combined.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // Stable-ish tie-breaker.
    return a.messageId.localeCompare(b.messageId);
  });

  return combined;
}

function mergeChainByDiscordWindow(
  chainOldestToNewest: readonly ReplyChainMessage[],
): MergedChunk[] {
  if (chainOldestToNewest.length === 0) return [];

  const groups = splitByDiscordWindowOldestToNewest(chainOldestToNewest);

  return groups.map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;

    return {
      messageIds: group.map((m) => m.messageId),
      authorId: first.authorId,
      authorName: first.authorName,
      tsStart: first.ts,
      tsEnd: last.ts,
      text: group.map((m) => m.text).join("\n\n"),
      attachments: group.flatMap((m) => m.attachments),
    };
  });
}
