import type { CoreConfig } from "@stanley2058/lilac-utils";

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^#+/u, "");
}

export function resolveDiscordSessionId(input: {
  sessionId: string;
  cfg: CoreConfig;
}): string {
  const raw = input.sessionId.trim();
  if (raw.length === 0) {
    throw new Error("sessionId is required");
  }

  // Channel mention: <#123>
  const mentionMatch = raw.match(/^<#[0-9]+>$/u);
  if (mentionMatch) {
    return raw.slice(2, -1);
  }

  // Raw channel id: 123
  if (/^[0-9]+$/u.test(raw)) {
    return raw;
  }

  const token = normalizeToken(raw);
  const map = input.cfg.entity?.sessions?.discord ?? {};

  const tokenLc = token.toLowerCase();
  for (const [k, channelId] of Object.entries(map)) {
    const keyLc = k.trim().replace(/^#+/u, "").toLowerCase();
    if (keyLc === tokenLc) {
      return channelId;
    }
  }

  throw new Error(
    `Unknown sessionId alias '${input.sessionId}'. Expected a raw channelId, a <#channelId> mention, or one of the configured tokens in cfg.entity.sessions.discord.`,
  );
}

export function bestEffortTokenForDiscordChannelId(input: {
  channelId: string;
  cfg: CoreConfig;
}): string | undefined {
  const map = input.cfg.entity?.sessions?.discord ?? {};
  for (const [token, cid] of Object.entries(map)) {
    if (cid === input.channelId) {
      return stripPrefix(token.trim().replace(/^#+/u, ""), "#");
    }
  }
  return undefined;
}
