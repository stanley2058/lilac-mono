import type { WorkflowTaskRecord } from "./types";
import type { DiscordWaitForReplyInput } from "./discord-wait-for-reply";

function isDiscordWaitForReplyInput(x: unknown): x is DiscordWaitForReplyInput {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.channelId === "string" && typeof o.messageId === "string";
}

export function indexFieldsForTask(params: {
  kind: string;
  input?: unknown;
}): Pick<
  WorkflowTaskRecord,
  "discordChannelId" | "discordMessageId" | "discordFromUserId" | "timeoutAt"
> {
  if (params.kind === "discord.wait_for_reply" && isDiscordWaitForReplyInput(params.input)) {
    const input = params.input;
    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
    return {
      discordChannelId: input.channelId,
      discordMessageId: input.messageId,
      discordFromUserId: input.fromUserId,
      timeoutAt: timeoutMs ? Date.now() + timeoutMs : undefined,
    };
  }

  return {};
}
