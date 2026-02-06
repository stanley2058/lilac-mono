import { Database } from "bun:sqlite";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import {
  type SurfaceCacheBurstProvider,
  type SurfaceAdapter,
  type SurfaceBurstCacheInput,
} from "../adapter";
import type {
  DiscordMsgRef,
  DiscordSessionRef,
  SurfaceMessage,
  SurfacePlatform,
} from "../types";

const SEARCH_LIMIT_MAX = 100;

export const DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT = 50;
export const DISCORD_SEARCH_FIRST_SEARCH_HEAL_LIMIT = 300;
export const DISCORD_SEARCH_HEAL_CAP = 300;
export const DISCORD_SEARCH_HEAL_COOLDOWN_MS = 30 * 60 * 1000;

export type DiscordSearchHit = {
  ref: DiscordMsgRef;
  session: DiscordSessionRef;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  editedTs?: number;
  score: number;
};

export type DiscordSearchHealResult = {
  attempted: boolean;
  skipped: boolean;
  reason?: "cooldown";
  limit: number;
  fetched: number;
  indexed: number;
};

function normalizeFtsQuery(input: string): string | null {
  const tokens = input
    .trim()
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll("\"", "\"\"")}"`);

  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

function asDiscordSessionRef(input: {
  channelId: string;
  guildId?: string | null;
}): DiscordSessionRef {
  return {
    platform: "discord",
    channelId: input.channelId,
    guildId: input.guildId ?? undefined,
  };
}

function asDiscordMsgRef(channelId: string, messageId: string): DiscordMsgRef {
  return { platform: "discord", channelId, messageId };
}

function isDiscordMessage(msg: SurfaceMessage): msg is SurfaceMessage & {
  session: DiscordSessionRef;
  ref: DiscordMsgRef;
} {
  return msg.session.platform === "discord" && msg.ref.platform === "discord";
}

type RawSearchRow = {
  channel_id: string;
  guild_id: string | null;
  message_id: string;
  user_id: string;
  user_name: string | null;
  text: string;
  ts: number;
  edited_ts: number | null;
  score: number;
};

export class DiscordSearchStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_search_messages (
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        edited_ts INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discord_search_messages_channel_ts
      ON discord_search_messages(channel_id, ts DESC);
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS discord_search_messages_fts
      USING fts5(
        text,
        content='discord_search_messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discord_search_messages_ai
      AFTER INSERT ON discord_search_messages
      BEGIN
        INSERT INTO discord_search_messages_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discord_search_messages_ad
      AFTER DELETE ON discord_search_messages
      BEGIN
        INSERT INTO discord_search_messages_fts(discord_search_messages_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discord_search_messages_au
      AFTER UPDATE ON discord_search_messages
      BEGIN
        INSERT INTO discord_search_messages_fts(discord_search_messages_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO discord_search_messages_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    const rowCountRow = this.db
      .query("SELECT COUNT(1) AS c FROM discord_search_messages")
      .get() as { c: number };
    const ftsCountRow = this.db
      .query("SELECT COUNT(1) AS c FROM discord_search_messages_fts")
      .get() as { c: number };

    const rowCount = typeof rowCountRow?.c === "number" ? rowCountRow.c : 0;
    const ftsCount = typeof ftsCountRow?.c === "number" ? ftsCountRow.c : 0;
    if (rowCount > 0 && ftsCount === 0) {
      this.db.run(
        "INSERT INTO discord_search_messages_fts(discord_search_messages_fts) VALUES ('rebuild')",
      );
    }
  }

  upsertMessages(messages: readonly SurfaceMessage[]): number {
    const now = Date.now();
    let wrote = 0;

    const tx = this.db.transaction((input: readonly SurfaceMessage[]) => {
      for (const message of input) {
        if (!isDiscordMessage(message)) continue;

        this.db.run(
          `
          INSERT INTO discord_search_messages (
            channel_id,
            guild_id,
            message_id,
            user_id,
            user_name,
            text,
            ts,
            edited_ts,
            deleted,
            updated_ts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel_id, message_id) DO UPDATE SET
            guild_id=excluded.guild_id,
            user_id=excluded.user_id,
            user_name=excluded.user_name,
            text=excluded.text,
            ts=excluded.ts,
            edited_ts=excluded.edited_ts,
            deleted=excluded.deleted,
            updated_ts=excluded.updated_ts;
          `,
          [
            message.session.channelId,
            message.session.guildId ?? null,
            message.ref.messageId,
            message.userId,
            message.userName ?? null,
            message.text,
            message.ts,
            message.editedTs ?? null,
            message.deleted ? 1 : 0,
            now,
          ],
        );
        wrote += 1;
      }
    });

    tx(messages);
    return wrote;
  }

  markDeleted(input: { channelId: string; messageId: string }): void {
    this.db.run(
      `
      UPDATE discord_search_messages
      SET deleted = 1, updated_ts = ?
      WHERE channel_id = ? AND message_id = ?;
      `,
      [Date.now(), input.channelId, input.messageId],
    );
  }

  countMessagesByChannel(channelId: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(1) AS c FROM discord_search_messages WHERE channel_id = ?",
      )
      .get(channelId) as { c: number };
    return typeof row?.c === "number" ? row.c : 0;
  }

  searchChannel(input: {
    channelId: string;
    query: string;
    limit?: number;
  }): DiscordSearchHit[] {
    const ftsQuery = normalizeFtsQuery(input.query);
    if (!ftsQuery) return [];

    const limit = Math.min(
      SEARCH_LIMIT_MAX,
      Math.max(1, Math.floor(input.limit ?? 20)),
    );

    const rows = this.db
      .query(
        `
        SELECT
          m.channel_id,
          m.guild_id,
          m.message_id,
          m.user_id,
          m.user_name,
          m.text,
          m.ts,
          m.edited_ts,
          bm25(discord_search_messages_fts) AS score
        FROM discord_search_messages_fts
        JOIN discord_search_messages m ON m.rowid = discord_search_messages_fts.rowid
        WHERE discord_search_messages_fts MATCH ?
          AND m.channel_id = ?
          AND m.deleted = 0
        ORDER BY score ASC, m.ts DESC
        LIMIT ?
        `,
      )
      .all(ftsQuery, input.channelId, limit) as RawSearchRow[];

    return rows.map((row) => ({
      ref: asDiscordMsgRef(row.channel_id, row.message_id),
      session: asDiscordSessionRef({
        channelId: row.channel_id,
        guildId: row.guild_id,
      }),
      userId: row.user_id,
      userName: row.user_name ?? undefined,
      text: row.text,
      ts: row.ts,
      editedTs: row.edited_ts ?? undefined,
      score: row.score,
    }));
  }
}

type DiscordSearchAdapter = Pick<SurfaceAdapter, "listMsg"> &
  Partial<SurfaceCacheBurstProvider>;

function hasBurstCache(
  adapter: DiscordSearchAdapter,
): adapter is DiscordSearchAdapter & SurfaceCacheBurstProvider {
  return typeof adapter.burstCache === "function";
}

export class DiscordSearchService {
  private readonly logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "surface:discord-search",
  });

  private readonly healTimestampsByChannel = new Map<string, number>();

  constructor(
    private readonly params: {
      adapter: DiscordSearchAdapter;
      store: DiscordSearchStore;
    },
  ) {}

  async onMessageCreated(message: SurfaceMessage): Promise<void> {
    if (!isDiscordMessage(message)) return;

    this.params.store.upsertMessages([message]);

    await this.maybeHealChannel({
      sessionRef: message.session,
      limit: DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT,
    });
  }

  onMessageUpdated(message: SurfaceMessage): void {
    if (!isDiscordMessage(message)) return;
    this.params.store.upsertMessages([message]);
  }

  onMessageDeleted(input: {
    platform: SurfacePlatform;
    channelId: string;
    messageId: string;
  }): void {
    if (input.platform !== "discord") return;
    this.params.store.markDeleted({
      channelId: input.channelId,
      messageId: input.messageId,
    });
  }

  async searchSession(input: {
    sessionRef: DiscordSessionRef;
    query: string;
    limit?: number;
  }): Promise<{ hits: DiscordSearchHit[]; heal: DiscordSearchHealResult | null }> {
    const indexed = this.params.store.countMessagesByChannel(
      input.sessionRef.channelId,
    );

    let heal: DiscordSearchHealResult | null = null;
    if (indexed < DISCORD_SEARCH_FIRST_SEARCH_HEAL_LIMIT) {
      heal = await this.maybeHealChannel({
        sessionRef: input.sessionRef,
        limit: DISCORD_SEARCH_FIRST_SEARCH_HEAL_LIMIT,
      });
    }

    return {
      hits: this.params.store.searchChannel({
        channelId: input.sessionRef.channelId,
        query: input.query,
        limit: input.limit,
      }),
      heal,
    };
  }

  private async maybeHealChannel(input: {
    sessionRef: DiscordSessionRef;
    limit: number;
  }): Promise<DiscordSearchHealResult> {
    const limit = Math.min(DISCORD_SEARCH_HEAL_CAP, Math.max(1, input.limit));

    const now = Date.now();
    const lastHealTs = this.healTimestampsByChannel.get(input.sessionRef.channelId);
    if (
      typeof lastHealTs === "number" &&
      now - lastHealTs < DISCORD_SEARCH_HEAL_COOLDOWN_MS
    ) {
      return {
        attempted: false,
        skipped: true,
        reason: "cooldown",
        limit,
        fetched: 0,
        indexed: 0,
      };
    }

    this.healTimestampsByChannel.set(input.sessionRef.channelId, now);

    if (hasBurstCache(this.params.adapter)) {
      const cacheInput: SurfaceBurstCacheInput = {
        sessionRef: input.sessionRef,
        reason: "other",
      };
      try {
        await this.params.adapter.burstCache(cacheInput);
      } catch {
        // ignore cache invalidation errors
      }
    }

    try {
      const messages = await this.params.adapter.listMsg(input.sessionRef, {
        limit,
      });
      const indexed = this.params.store.upsertMessages(messages);

      return {
        attempted: true,
        skipped: false,
        limit,
        fetched: messages.length,
        indexed,
      };
    } catch (e) {
      this.logger.error(
        "search heal failed",
        { channelId: input.sessionRef.channelId, limit },
        e,
      );
      return {
        attempted: true,
        skipped: false,
        limit,
        fetched: 0,
        indexed: 0,
      };
    }
  }
}
