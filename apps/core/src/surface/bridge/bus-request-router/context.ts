import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef, SurfaceMessage } from "../../types";

import { compareMessagePosition, normalizeGateText } from "./common";
import type { BufferedMessage } from "./gate";

export async function resolvePreviousMessageText(params: {
  adapter: SurfaceAdapter;
  input: {
    msgRef: MsgRef;
    triggerTs: number;
  };
}): Promise<string | undefined> {
  const around = await params.adapter
    .getReplyContext(params.input.msgRef, { limit: 8 })
    .catch(() => []);
  if (around.length === 0) return undefined;

  let prev: SurfaceMessage | null = null;
  for (const candidate of around) {
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
  input: {
    sessionId: string;
    replyToMessageId?: string;
  };
}): Promise<string | undefined> {
  if (!params.input.replyToMessageId) return undefined;

  const repliedTo = await params.adapter
    .readMsg({
      platform: "discord",
      channelId: params.input.sessionId,
      messageId: params.input.replyToMessageId,
    })
    .catch(() => null);

  return normalizeGateText(repliedTo?.text ?? undefined);
}

export async function resolvePreviousBatchMessageText(params: {
  adapter: SurfaceAdapter;
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
    input: {
      msgRef: oldest.msgRef,
      triggerTs: oldest.ts,
    },
  });
}
