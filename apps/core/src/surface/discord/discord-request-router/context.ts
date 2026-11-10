import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef, SurfaceMessage } from "../../types";
import type { TranscriptStore } from "../../../transcript/transcript-store";
import {
  buildAssistantOnlyMessageFromTranscript,
  normalizeAssistantContextText,
} from "../../bridge/request-composition/normalization";
import type { DiscordMessageCacheAccess } from "../../store/discord-search-store";

import { compareMessagePosition, normalizeGateText } from "./common";
import type { BufferedMessage } from "./gate";

export async function resolvePreviousMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  input: {
    msgRef: MsgRef;
    triggerTs: number;
  };
}): Promise<string | undefined> {
  const cached = params.messageCache?.listIndexedMessagesBefore({
    channelId: params.input.msgRef.channelId,
    before: { messageId: params.input.msgRef.messageId, ts: params.input.triggerTs },
    limit: 8,
  });
  if (cached && cached.length > 0) return normalizeGateText(cached.at(-1)?.text);

  const around = await params.adapter.getReplyContext(params.input.msgRef, { limit: 8 });
  const messages = around.match({
    err: () => [] as readonly SurfaceMessage[],
    ok: (value) => value,
  });
  if (messages.length === 0) return undefined;

  let prev: SurfaceMessage | null = null;
  for (const candidate of messages) {
    const cmp = compareMessagePosition(
      { ts: candidate.ts, messageId: candidate.ref.messageId },
      { ts: params.input.triggerTs, messageId: params.input.msgRef.messageId },
    );
    if (cmp >= 0) continue;
    if (
      !prev ||
      compareMessagePosition(
        { ts: prev.ts, messageId: prev.ref.messageId },
        { ts: candidate.ts, messageId: candidate.ref.messageId },
      ) < 0
    ) {
      prev = candidate;
    }
  }

  return normalizeGateText(prev?.text);
}

export async function resolveRepliedToMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  transcriptStore?: TranscriptStore;
  input: {
    sessionId: string;
    replyToMessageId?: string;
  };
}): Promise<string | undefined> {
  if (!params.input.replyToMessageId) return undefined;

  const cached = params.messageCache?.getIndexedMessage({
    channelId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  if (cached && !cached.deleted) return normalizeGateText(cached.text);

  const linkedText = resolveLinkedTranscriptText({
    transcriptStore: params.transcriptStore,
    sessionId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  if (linkedText !== null) return normalizeGateText(linkedText);

  const repliedTo = await params.adapter.readMsg({
    platform: "discord",
    channelId: params.input.sessionId,
    messageId: params.input.replyToMessageId,
  });
  return normalizeGateText(
    repliedTo.match({
      err: () => undefined,
      ok: (value) => value?.text,
    }),
  );
}

function resolveLinkedTranscriptText(params: {
  transcriptStore?: TranscriptStore;
  sessionId: string;
  messageId: string;
}): string | null {
  const ref = {
    platform: "discord" as const,
    channelId: params.sessionId,
    messageId: params.messageId,
  };
  // The gate needs only the final text, so read that column before decoding a whole transcript.
  const finalText = params.transcriptStore?.getSurfaceMessageFinalText?.({
    ...ref,
    requestClient: "discord",
    sessionId: params.sessionId,
  });
  const light = finalText?.match({ ok: (value) => value, err: () => undefined });
  if (light === null) return null;
  if (typeof light?.finalText === "string") return normalizeAssistantContextText(light.finalText);

  const linked = params.transcriptStore?.getTranscriptBySurfaceMessage(ref);
  const snapshot =
    linked?.match({
      ok: (value) =>
        value?.requestClient === "discord" && value.sessionId === params.sessionId ? value : null,
      err: () => null,
    }) ?? null;
  const assistant = snapshot ? buildAssistantOnlyMessageFromTranscript(snapshot) : null;
  return assistant && typeof assistant.content === "string" ? assistant.content : null;
}

export async function resolvePreviousBatchMessageText(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  messages: readonly BufferedMessage[];
}): Promise<string | undefined> {
  if (params.messages.length === 0) return undefined;

  const oldest = params.messages.reduce((best, cur) => {
    return compareMessagePosition(
      { ts: cur.ts, messageId: cur.msgRef.messageId },
      { ts: best.ts, messageId: best.msgRef.messageId },
    ) < 0
      ? cur
      : best;
  });

  return resolvePreviousMessageText({
    adapter: params.adapter,
    messageCache: params.messageCache,
    input: {
      msgRef: oldest.msgRef,
      triggerTs: oldest.ts,
    },
  });
}
