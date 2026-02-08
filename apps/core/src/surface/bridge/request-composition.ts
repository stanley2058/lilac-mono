import { Buffer } from "node:buffer";

import type { ModelMessage, UserContent } from "ai";
import { fileTypeFromBuffer } from "file-type/core";

import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";

import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";

import type { TranscriptStore } from "../../transcript/transcript-store";

export type RequestCompositionResult = {
  messages: ModelMessage[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
};

export type ComposeRecentChannelMessagesOpts = {
  platform: "discord";
  sessionId: string;
  botUserId: string;
  botName: string;
  limit: number;
  transcriptStore?: TranscriptStore;
  /** Optional trigger message to force-include (mention/reply). */
  triggerMsgRef?: MsgRef;
  triggerType?: "mention" | "reply";
};

export type ComposeSingleMessageOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  msgRef: MsgRef;
};

export type ComposeRequestOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  trigger: {
    type: "mention" | "reply";
    msgRef: MsgRef;
  };
  maxDepth?: number;
};

async function safeListReactions(
  adapter: SurfaceAdapter,
  msgRef: MsgRef,
): Promise<string[]> {
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

  const chain = opts.trigger.type === "mention"
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

  // Step 2: merge by Discord window rules (same author + <= 7 min).
  const merged = mergeChainByDiscordWindow(chain);

  // Phase 3: normalize to ModelMessage[] with attribution headers.
  const attState = createDiscordAttachmentState();

  const modelMessages: ModelMessage[] = [];
  const seenTranscriptRequestIds = new Set<string>();

  for (const chunk of merged) {
    const isBot = chunk.authorId === opts.botUserId;

    const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

    const reactions = await safeListReactions(adapter, {
      platform: opts.platform,
      channelId: opts.trigger.msgRef.channelId,
      messageId,
    });

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

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      messageId,
      reactions,
    });

    const mainText = `${header}\n${normalized}`.trimEnd();

    if (isBot) {
      modelMessages.push({
        role: "assistant",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    if (chunk.attachments.length === 0) {
      modelMessages.push({
        role: "user",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    const parts: UserContent = [{ type: "text", text: mainText }];
    await appendDiscordAttachmentsToUserContent(
      parts,
      chunk.attachments,
      attState,
    );

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

export async function composeRecentChannelMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRecentChannelMessagesOpts,
): Promise<RequestCompositionResult> {
  if (opts.platform !== "discord") {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  if (opts.triggerMsgRef && opts.triggerType === "mention") {
    const triggerMsg = await adapter.readMsg(opts.triggerMsgRef);
    if (triggerMsg) {
      const block = await resolveMergeBlockEndingAt(adapter, triggerMsg);
      const anchor = findEarliestReplyAnchor(block);

      if (anchor) {
        const anchored = await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
        });

        const merged = mergeChainByDiscordWindow(anchored);
        const attState = createDiscordAttachmentState();

        const modelMessages: ModelMessage[] = [];
        const seenTranscriptRequestIds = new Set<string>();

        for (const chunk of merged) {
          const isBot = chunk.authorId === opts.botUserId;
          const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

          const reactions = await safeListReactions(adapter, {
            platform: opts.platform,
            channelId: opts.sessionId,
            messageId,
          });

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
          const header = formatDiscordAttributionHeader({
            authorId: chunk.authorId,
            authorName: chunk.authorName,
            messageId,
            reactions,
          });

          const mainText = `${header}\n${normalized}`.trimEnd();

          if (isBot) {
            modelMessages.push({
              role: "assistant",
              content: mainText,
            } satisfies ModelMessage);
            continue;
          }

          if (chunk.attachments.length === 0) {
            modelMessages.push({
              role: "user",
              content: mainText,
            } satisfies ModelMessage);
            continue;
          }

          const parts: UserContent = [{ type: "text", text: mainText }];
          await appendDiscordAttachmentsToUserContent(
            parts,
            chunk.attachments,
            attState,
          );
          modelMessages.push({ role: "user", content: parts } satisfies ModelMessage);
        }

        return {
          messages: modelMessages,
          chainMessageIds: anchored.map((m) => m.messageId),
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

  const shouldApplyActiveBurstRules = Boolean(
    opts.triggerMsgRef && !opts.triggerType,
  );

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

  list.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
  });

  const triggerMsg =
    opts.triggerMsgRef
      ? list.find((m) => m.ref.messageId === opts.triggerMsgRef!.messageId) ??
        fetchedTrigger
      : null;

  const activeAnchor = shouldApplyActiveBurstRules
    ? (triggerMsg ?? (list.length > 0 ? list[list.length - 1]! : null))
    : null;

  const ACTIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const ACTIVE_MAX_GAP_MS = 2 * 60 * 60 * 1000;
  const ACTIVE_TRANSCRIPT_MAX_AGE_MS = 1 * 60 * 60 * 1000;

  let selected: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && activeAnchor) {
    const anchorTs = activeAnchor.ts;
    const anchorId = activeAnchor.ref.messageId;

    // Only include messages up to the anchor (avoid pulling in newer messages
    // that arrived after the gate decision).
    const eligible = list.filter((m) => {
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
    selected = list.slice(Math.max(0, list.length - opts.limit));
  }

  const chain: ReplyChainMessage[] = selected.map((m) => ({
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

    const anchorTsForTranscript = shouldApplyActiveBurstRules
      ? activeAnchor?.ts ?? null
      : null;
    const transcriptAgeMs =
      anchorTsForTranscript !== null ? anchorTsForTranscript - chunk.tsEnd : null;
    const allowTranscriptExpansion =
      !shouldApplyActiveBurstRules ||
      transcriptAgeMs === null ||
      transcriptAgeMs <= ACTIVE_TRANSCRIPT_MAX_AGE_MS;

    const reactions = await safeListReactions(adapter, {
      platform: opts.platform,
      channelId: opts.sessionId,
      messageId,
    });

    if (isBot && opts.transcriptStore && allowTranscriptExpansion) {
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

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      messageId,
      reactions,
    });

    const mainText = `${header}\n${normalized}`.trimEnd();

    if (isBot) {
      modelMessages.push({
        role: "assistant",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    if (chunk.attachments.length === 0) {
      modelMessages.push({
        role: "user",
        content: mainText,
      } satisfies ModelMessage);
      continue;
    }

    const parts: UserContent = [{ type: "text", text: mainText }];
    await appendDiscordAttachmentsToUserContent(
      parts,
      chunk.attachments,
      attState,
    );
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

  const text =
    m.userId !== opts.botUserId
      ? stripLeadingBotMention(m.text, opts.botUserId, opts.botName)
      : m.text;

  const header = formatDiscordAttributionHeader({
    authorId: m.userId,
    authorName: m.userName ?? `user_${m.userId}`,
    messageId: m.ref.messageId,
    reactions: await safeListReactions(adapter, m.ref),
  });

  const mainText = `${header}\n${normalizeText(text, {})}`.trimEnd();

  if (m.userId === opts.botUserId) {
    return { role: "assistant", content: mainText } satisfies ModelMessage;
  }

  const attachments = extractDiscordAttachmentsFromRaw(m.raw);
  if (attachments.length === 0) {
    return { role: "user", content: mainText } satisfies ModelMessage;
  }

  const parts: UserContent = [{ type: "text", text: mainText }];

  await appendDiscordAttachmentsToUserContent(
    parts,
    attachments,
    createDiscordAttachmentState(),
  );

  return { role: "user", content: parts } satisfies ModelMessage;
}

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

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
  if (params.filename)
    fields.push(`filename="${escapeMetadataValue(params.filename)}"`);
  if (params.mimeType)
    fields.push(`mime="${escapeMetadataValue(params.mimeType)}"`);
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

  const view =
    bytes.byteLength > MAX_TEXT_BYTES ? bytes.slice(0, MAX_TEXT_BYTES) : bytes;
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

  const clamped =
    text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const truncated = truncatedBytes || clamped.length !== text.length;
  return { text: clamped, truncatedBytes: truncated, reason: undefined };
}

function bestEffortInferMimeType(params: {
  filename?: string;
  url?: URL;
}): string | undefined {
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
    throw new Error(
      `Failed to download attachment (${res.status}): ${url.toString()}`,
    );
  }

  const ab = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: normalizeMimeType(
      res.headers.get("content-type") ?? undefined,
    ),
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
          bestEffortInferMimeType({ filename: att.filename, url }) ??
          "application/octet-stream";
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
            bestEffortInferMimeType({ filename: att.filename, url }) ??
            "application/octet-stream";
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
            bestEffortInferMimeType({ filename: att.filename, url }) ??
            "application/octet-stream";
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

const DISCORD_MERGE_WINDOW_MS = 7 * 60 * 1000;
const DEFAULT_MENTION_BLOCK_LIMIT = 50;

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
  reactions?: readonly string[];
}): string {
  const userName = sanitizeUserToken(
    params.authorName || `user_${params.authorId}`,
  );

  const reactions = formatReactionSet(params.reactions);
  const reactionsPart = reactions ? ` reactions=${reactions}` : "";

  return `[discord user_id=${params.authorId} user_name=${userName} message_id=${params.messageId}${reactionsPart}]`;
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
  const o = raw as Record<string, unknown>;

  // Preferred (Discord API shape): reference: { messageId, channelId }
  if ("reference" in o) {
    const ref = o.reference;
    if (ref && typeof ref === "object") {
      const r = ref as Record<string, unknown>;
      const messageId =
        typeof r.messageId === "string" ? r.messageId : undefined;
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
    discord && typeof discord.replyToMessageId === "string"
      ? discord.replyToMessageId
      : undefined;
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
    authorName:
      msg.userName ?? opts?.authorNameFallback ?? `user_${msg.userId}`,
    ts: msg.ts,
    text: opts?.overrideText ?? msg.text,
    attachments: extractDiscordAttachmentsFromRaw(msg.raw),
    raw: msg.raw,
  };
}

function dedupeByMessageId(
  list: readonly ReplyChainMessage[],
): ReplyChainMessage[] {
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

  const triggerIndex = list.findIndex(
    (m) => m.ref.messageId === triggerMsg.ref.messageId,
  );
  if (triggerIndex < 0) return [triggerMsg];

  const authorId = triggerMsg.userId;

  let start = triggerIndex;
  for (let i = triggerIndex; i > 0; i--) {
    const prev = list[i - 1]!;
    const cur = list[i]!;

    if (prev.userId !== authorId) break;
    if (cur.userId !== authorId) break;

    const gap = cur.ts - prev.ts;
    if (gap > DISCORD_MERGE_WINDOW_MS) break;

    start = i - 1;
  }

  return list.slice(start, triggerIndex + 1);
}

function findEarliestReplyAnchor(
  block: readonly SurfaceMessage[],
): SurfaceMessage | null {
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
