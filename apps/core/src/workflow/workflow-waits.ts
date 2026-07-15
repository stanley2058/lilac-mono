import { z } from "zod";
import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";

import type { WorkflowWait } from "./workflow-domain";

const adapterMessageSchema = z.object({
  platform: z.enum(["discord", "github", "whatsapp", "slack", "telegram", "web", "unknown"]),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  userId: z.string().min(1),
  userName: z.string().optional(),
  text: z.string(),
  ts: z.number().int().nonnegative(),
  raw: z.unknown().optional(),
});

const replyMetadataSchema = z
  .object({
    replyToMessageId: z.string().min(1).optional(),
    discord: z
      .object({ replyToMessageId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
    github: z
      .object({ replyToMessageId: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function workflowReplyMatchKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

function replyToMessageId(raw: unknown): string | null {
  const parsed = replyMetadataSchema.safeParse(raw);
  if (!parsed.success) return null;
  return (
    parsed.data.replyToMessageId ??
    parsed.data.discord?.replyToMessageId ??
    parsed.data.github?.replyToMessageId ??
    null
  );
}

export function matchWorkflowReplyWait(
  wait: WorkflowWait,
  eventInput: EvtAdapterMessageCreatedData,
): WorkflowWait["result"] | null {
  if (wait.match.kind !== "reply") return null;
  const parsed = adapterMessageSchema.safeParse(eventInput);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.ts < wait.createdAt) return null;
  if (wait.deadlineAt !== null && event.ts > wait.deadlineAt) return null;
  if (event.platform !== wait.match.platform || event.channelId !== wait.match.channelId)
    return null;
  if (wait.match.fromUserId && event.userId !== wait.match.fromUserId) return null;
  if (wait.match.messageId && replyToMessageId(event.raw) !== wait.match.messageId) return null;
  return {
    platform: event.platform,
    channelId: event.channelId,
    messageId: event.messageId,
    userId: event.userId,
    ...(event.userName ? { userName: event.userName } : {}),
    text: event.text,
    ts: event.ts,
  };
}
