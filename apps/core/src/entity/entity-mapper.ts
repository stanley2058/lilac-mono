import type { CoreConfig } from "@stanley2058/lilac-utils";

import type { DiscordSurfaceStore } from "../surface/store/discord-surface-store";

export type EntityMapper = {
  normalizeIncomingText(text: string): string;
  rewriteOutgoingText(text: string): string;
};

type Segment = { kind: "text" | "code"; value: string };

function splitMarkdownCodeSegments(input: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;

  while (pos < input.length) {
    const nextFence = input.indexOf("```", pos);
    const nextInline = input.indexOf("`", pos);

    if (nextFence === -1 && nextInline === -1) {
      out.push({ kind: "text", value: input.slice(pos) });
      break;
    }

    const fenceFirst =
      nextFence !== -1 && (nextInline === -1 || nextFence < nextInline);

    if (fenceFirst) {
      if (nextFence > pos) {
        out.push({ kind: "text", value: input.slice(pos, nextFence) });
      }

      const close = input.indexOf("```", nextFence + 3);
      if (close === -1) {
        out.push({ kind: "code", value: input.slice(nextFence) });
        break;
      }

      out.push({ kind: "code", value: input.slice(nextFence, close + 3) });
      pos = close + 3;
      continue;
    }

    // Inline code span
    if (nextInline > pos) {
      out.push({ kind: "text", value: input.slice(pos, nextInline) });
    }

    const close = input.indexOf("`", nextInline + 1);
    if (close === -1) {
      out.push({ kind: "code", value: input.slice(nextInline) });
      break;
    }

    out.push({ kind: "code", value: input.slice(nextInline, close + 1) });
    pos = close + 1;
  }

  return out;
}

function sanitizeToken(raw: string): string {
  return raw.replace(/\s+/gu, "_").replace(/^[@#]+/u, "");
}

type DiscordEntityConfig = {
  userByUsernameLc: Map<string, { canonical: string; userId: string }>;
  userById: Map<string, { canonical: string; userId: string }>;
  channelIdByTokenLc: Map<string, { canonical: string; channelId: string }>;
  tokenByChannelId: Map<string, { canonical: string; channelId: string }>;
};

function buildDiscordEntityConfig(cfg: CoreConfig): DiscordEntityConfig {
  const userByUsernameLc = new Map<
    string,
    { canonical: string; userId: string }
  >();
  const userById = new Map<string, { canonical: string; userId: string }>();

  const users = cfg.entity?.users ?? {};

  for (const [canonical, rec] of Object.entries(users)) {
    const userId = rec.discord;
    userByUsernameLc.set(canonical.toLowerCase(), { canonical, userId });
    userById.set(userId, { canonical, userId });
  }

  const channelIdByTokenLc = new Map<
    string,
    { canonical: string; channelId: string }
  >();
  const tokenByChannelId = new Map<
    string,
    { canonical: string; channelId: string }
  >();

  const tokens = cfg.entity?.sessions.discord ?? {};

  for (const [token, channelId] of Object.entries(tokens)) {
    channelIdByTokenLc.set(token.toLowerCase(), {
      canonical: token,
      channelId,
    });
    tokenByChannelId.set(channelId, { canonical: token, channelId });
  }

  return {
    userByUsernameLc,
    userById,
    channelIdByTokenLc,
    tokenByChannelId,
  };
}

export function createDiscordEntityMapper(deps: {
  cfg: CoreConfig;
  store: DiscordSurfaceStore;
}): EntityMapper {
  const cfgIndex = buildDiscordEntityConfig(deps.cfg);

  // Best-effort caches to keep DB calls off hot paths.
  const cachedUserIdByUsernameLc = new Map<string, string>();
  const cachedCanonicalUserById = new Map<string, string>();
  const cachedTokenByChannelId = new Map<string, string>();

  function resolveUserIdByUsername(usernameRaw: string): string | null {
    const username = sanitizeToken(usernameRaw);
    const lc = username.toLowerCase();

    const fromCfg = cfgIndex.userByUsernameLc.get(lc);
    if (fromCfg) return fromCfg.userId;

    const cached = cachedUserIdByUsernameLc.get(lc);
    if (cached) return cached;

    const fromDb = deps.store.getUserIdByUsername(username);
    if (!fromDb) return null;

    cachedUserIdByUsernameLc.set(lc, fromDb);
    return fromDb;
  }

  function resolveCanonicalUsernameByUserId(userId: string): string | null {
    const cfgUser = cfgIndex.userById.get(userId);
    if (cfgUser) return cfgUser.canonical;

    const cached = cachedCanonicalUserById.get(userId);
    if (cached) return cached;

    const row = deps.store.getUserName(userId);
    const raw = row?.username ?? row?.global_name ?? row?.display_name;
    if (!raw) return null;

    const canonical = sanitizeToken(raw);
    cachedCanonicalUserById.set(userId, canonical);
    return canonical;
  }

  function resolveChannelIdByToken(tokenRaw: string): string | null {
    const token = sanitizeToken(tokenRaw);
    const lc = token.toLowerCase();
    return cfgIndex.channelIdByTokenLc.get(lc)?.channelId ?? null;
  }

  function resolveCanonicalTokenByChannelId(channelId: string): string | null {
    const cfgToken = cfgIndex.tokenByChannelId.get(channelId);
    if (cfgToken) return cfgToken.canonical;

    const cached = cachedTokenByChannelId.get(channelId);
    if (cached) return cached;

    const row = deps.store.getChannelName(channelId);
    const raw = row?.name;
    if (!raw) return null;

    const canonical = sanitizeToken(raw);
    cachedTokenByChannelId.set(channelId, canonical);
    return canonical;
  }

  function mapTextSegments(
    input: string,
    fn: (text: string) => string,
  ): string {
    const segments = splitMarkdownCodeSegments(input);
    return segments
      .map((s) => {
        if (s.kind === "code") return s.value;
        return fn(s.value);
      })
      .join("");
  }

  function rewriteOutgoingText(text: string): string {
    return mapTextSegments(text, (seg) => {
      // Users: @username
      const withUsers = seg.replace(
        /(^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/gu,
        (m, prefix: string, username: string) => {
          const id = resolveUserIdByUsername(username);
          if (!id) return m;
          return `${prefix}<@${id}>`;
        },
      );

      // Sessions/channels: #token (allow hyphens, dots)
      return withUsers.replace(
        /(^|[^A-Za-z0-9_])#([A-Za-z0-9_][A-Za-z0-9_.-]*)/gu,
        (m, prefix: string, token: string) => {
          const id = resolveChannelIdByToken(token);
          if (!id) return m;
          return `${prefix}<#${id}>`;
        },
      );
    });
  }

  function normalizeIncomingText(text: string): string {
    return mapTextSegments(text, (seg) => {
      // Users: <@id> / <@!id>
      const withUsers = seg.replace(/<@!?([0-9]+)>/gu, (_m, idRaw: string) => {
        const id = String(idRaw);
        const canonical = resolveCanonicalUsernameByUserId(id);
        return `@${canonical ?? `user_${id}`}`;
      });

      // Channels: <#id>
      return withUsers.replace(/<#([0-9]+)>/gu, (_m, idRaw: string) => {
        const id = String(idRaw);
        const canonical = resolveCanonicalTokenByChannelId(id);
        return `#${canonical ?? `channel_${id}`}`;
      });
    });
  }

  // Warm caches with config so case-insensitive matches don't hit DB.
  for (const [lc, v] of cfgIndex.userByUsernameLc) {
    cachedUserIdByUsernameLc.set(lc, v.userId);
  }
  for (const [userId, v] of cfgIndex.userById) {
    cachedCanonicalUserById.set(userId, v.canonical);
  }
  for (const [channelId, v] of cfgIndex.tokenByChannelId) {
    cachedTokenByChannelId.set(channelId, v.canonical);
  }

  return { normalizeIncomingText, rewriteOutgoingText };
}
