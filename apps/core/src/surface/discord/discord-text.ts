import type { CoreConfig } from "@stanley2058/lilac-utils";

export function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

export type MentionLookup = (userId: string) => string | null;

export function replaceUserMentions(params: {
  text: string;
  lookupUserName: MentionLookup;
  botUserId: string;
  botName: string;
}): string {
  const { lookupUserName, botUserId, botName } = params;
  const sanitizedBot = sanitizeUserToken(botName);

  return params.text.replace(/<@!?([0-9]+)>/gu, (_m, idRaw: string) => {
    const id = String(idRaw);
    if (id === botUserId) return `@${sanitizedBot}`;
    const name = lookupUserName(id);
    if (!name) return `@user_${id}`;
    return `@${sanitizeUserToken(name)}`;
  });
}

export type RoleLookup = (guildId: string, roleId: string) => string | null;
export type ChannelLookup = (channelId: string) => string | null;

export function replaceRoleMentions(params: {
  text: string;
  guildId: string;
  lookupRoleName: RoleLookup;
}): string {
  const { guildId, lookupRoleName } = params;
  return params.text.replace(/<@&([0-9]+)>/gu, (_m, roleIdRaw: string) => {
    const roleId = String(roleIdRaw);
    const name = lookupRoleName(guildId, roleId);
    if (!name) return `@role_${roleId}`;
    return `@${sanitizeUserToken(name)}`;
  });
}

export function replaceChannelMentions(params: {
  text: string;
  lookupChannelName: ChannelLookup;
}): string {
  const { lookupChannelName } = params;
  return params.text.replace(/<#([0-9]+)>/gu, (_m, channelIdRaw: string) => {
    const channelId = String(channelIdRaw);
    const name = lookupChannelName(channelId);
    if (!name) return `#channel_${channelId}`;
    const token = sanitizeUserToken(name);
    return `#${token}`;
  });
}

export function stripLeadingBotMention(params: { text: string; botUserId: string }): string {
  const { botUserId } = params;
  // Only strip if it appears at the very start, matching Discord mention forms.
  const re = new RegExp(`^(?:<@!?${botUserId}>)(?:\\s+)?`, "u");
  return params.text.replace(re, "");
}

export function getDiscordBotNameFromConfig(cfg: CoreConfig): string {
  return cfg.surface.discord.botName;
}
