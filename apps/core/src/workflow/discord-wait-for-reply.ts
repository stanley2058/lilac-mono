import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";

export type DiscordWaitForReplyInput = {
  channelId: string;
  messageId: string;
  fromUserId?: string;
  timeoutMs?: number;
};

export type DiscordWaitForReplyResult = {
  channelId: string;
  replyMessageId: string;
  replyUserId: string;
  replyUserName?: string;
  text: string;
  ts: number;
  raw?: unknown;
};

function getReplyToMessageId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const discord = (raw as { discord?: unknown }).discord;
  if (!discord || typeof discord !== "object") return undefined;
  const o = discord as Record<string, unknown>;
  return typeof o.replyToMessageId === "string" ? o.replyToMessageId : undefined;
}

export function matchDiscordWaitForReply(params: {
  evt: EvtAdapterMessageCreatedData;
  input: DiscordWaitForReplyInput;
}): { resolvedBy: string; result: DiscordWaitForReplyResult } | null {
  const { evt, input } = params;

  if (evt.platform !== "discord") return null;
  if (evt.channelId !== input.channelId) return null;

  const replyTo = getReplyToMessageId(evt.raw);
  if (!replyTo || replyTo !== input.messageId) return null;

  if (input.fromUserId && evt.userId !== input.fromUserId) return null;

  return {
    resolvedBy: evt.messageId,
    result: {
      channelId: evt.channelId,
      replyMessageId: evt.messageId,
      replyUserId: evt.userId,
      replyUserName: evt.userName,
      text: evt.text,
      ts: evt.ts,
      raw: evt.raw,
    },
  };
}
