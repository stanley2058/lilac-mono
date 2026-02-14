import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";

import type { WorkflowStoreQueries } from "./workflow-store-queries";
import { matchDiscordWaitForReply } from "./discord-wait-for-reply";

function getReplyToMessageId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const discord = (raw as { discord?: unknown }).discord;
  if (!discord || typeof discord !== "object") return undefined;
  const o = discord as Record<string, unknown>;
  return typeof o.replyToMessageId === "string" ? o.replyToMessageId : undefined;
}

export async function shouldSuppressRouterForWorkflowReply(params: {
  queries: WorkflowStoreQueries;
  evt: EvtAdapterMessageCreatedData;
}): Promise<{ suppress: boolean; reason?: string }> {
  const { queries, evt } = params;
  if (evt.platform !== "discord") return { suppress: false };

  const replyToMessageId = getReplyToMessageId(evt.raw);
  if (!replyToMessageId) return { suppress: false };

  const candidates = queries.listDiscordWaitForReplyTasksByChannelIdAndMessageId(
    evt.channelId,
    replyToMessageId,
  );

  for (const task of candidates) {
    if (task.kind !== "discord.wait_for_reply") continue;
    if (!task.discordChannelId || !task.discordMessageId) continue;

    const matched = matchDiscordWaitForReply({
      evt,
      input: {
        channelId: task.discordChannelId,
        messageId: task.discordMessageId,
        fromUserId: task.discordFromUserId,
      },
    });
    if (!matched) continue;

    return {
      suppress: true,
      reason: `workflow:${task.workflowId}:${task.taskId}`,
    };
  }

  return { suppress: false };
}
