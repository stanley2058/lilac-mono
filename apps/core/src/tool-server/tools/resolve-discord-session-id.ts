import type { CoreConfig } from "@stanley2058/lilac-utils";

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^#+/u, "");
}

export function resolveDiscordSessionId(input: { sessionId: string; cfg: CoreConfig }): string {
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

  // Common Discord session key shape used by other components.
  // Accept silently to keep the surface tool ergonomics forgiving.
  const sessionKeyMatch = raw.match(/^discord:channel:([0-9]+)$/u);
  if (sessionKeyMatch) {
    return sessionKeyMatch[1]!;
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

  if (raw.startsWith("req:")) {
    throw new Error(
      `Invalid --session-id '${input.sessionId}': that looks like a requestId. ` +
        "Pass a Discord channel id (e.g. '1462714189553598555') or omit --session-id to use the active session.",
    );
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
