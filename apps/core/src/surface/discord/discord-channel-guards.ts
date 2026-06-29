import {
  type CacheType,
  Client,
  MessageFlags,
  MessageType,
  type Message,
  type RepliableInteraction,
} from "discord.js";
import type { CoreConfig } from "@stanley2058/lilac-utils";

export function shouldAllowMessage(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const allowedChannelIds = new Set(params.cfg.surface.discord.allowedChannelIds);
  const allowedGuildIds = new Set(params.cfg.surface.discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

export type SendableDiscordChannel = {
  send(options: unknown): Promise<unknown>;
};

export function isTextSendableChannel(ch: unknown): ch is SendableDiscordChannel {
  if (!ch || typeof ch !== "object") return false;
  if (!("send" in ch)) return false;
  const send = (ch as Record<string, unknown>)["send"];
  return typeof send === "function";
}

export async function resolveTextSendableChannel(
  client: Client,
  channelId: string,
): Promise<SendableDiscordChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return isTextSendableChannel(channel) ? channel : null;
}

export async function replyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function editOrReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
    return;
  }

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function tryReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  try {
    await replyEphemeral(interaction, content);
  } catch {
    // Best-effort interaction acknowledgements should not fail event handling.
  }
}

export async function tryEditOrReplyEphemeral(
  interaction: RepliableInteraction<CacheType>,
  content: string,
): Promise<void> {
  try {
    await editOrReplyEphemeral(interaction, content);
  } catch {
    // Best-effort interaction acknowledgements should not fail event handling.
  }
}

export function isRoutableDiscordUserMessage(msg: Message): boolean {
  if (msg.author.bot) return false;
  if (msg.system) return false;

  return msg.type === MessageType.Default || msg.type === MessageType.Reply;
}

export function hasExplicitDiscordUserMentionInContent(input: {
  content: string;
  userId: string;
}): boolean {
  return (
    input.content.includes(`<@${input.userId}>`) || input.content.includes(`<@!${input.userId}>`)
  );
}

export function isExplicitDiscordUserMention(input: {
  content: string;
  userId: string;
  hasParsedMention: boolean;
}): boolean {
  return (
    input.hasParsedMention &&
    hasExplicitDiscordUserMentionInContent({
      content: input.content,
      userId: input.userId,
    })
  );
}
