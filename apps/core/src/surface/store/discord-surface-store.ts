import { Database } from "bun:sqlite";

import { dropLegacyDiscordMessageCacheTables } from "./migrations/drop-legacy-discord-message-cache-tables";
import { configureSqliteConnection } from "../../shared/sqlite";

export type DbDiscordSession = {
  channel_id: string;
  guild_id: string | null;
  parent_channel_id: string | null;
  name: string | null;
  type: "channel" | "thread" | "dm";
  updated_ts: number;
  raw_json: string | null;
};

export type DbDiscordReadState = {
  channel_id: string;
  last_read_ts: number;
  last_read_message_id: string;
};

export type DbDiscordUserName = {
  user_id: string;
  username: string | null;
  global_name: string | null;
  display_name: string | null;
  updated_ts: number;
};

export type DbDiscordChannelName = {
  channel_id: string;
  name: string | null;
  updated_ts: number;
};

export type DbDiscordRoleName = {
  guild_id: string;
  role_id: string;
  name: string | null;
  updated_ts: number;
};

export type DbDiscordMessageRelation = {
  channel_id: string;
  message_id: string;
  guild_id: string | null;
  author_id: string;
  author_name: string | null;
  ts: number;
  is_chat: number;
  reply_to_channel_id: string | null;
  reply_to_message_id: string | null;
  deleted: number;
  updated_ts: number;
};

export type DbDiscordRelayMessage = {
  nonce: string;
  channel_id: string;
  message_id: string | null;
  source_platform: string;
  source_thread_id: string;
  source_user_id: string;
  discord_user_id: string;
  mode: string;
  created_ts: number;
};

export type DbDiscordRelayResult = {
  nonce: string;
  disposition: string;
  message_id: string;
  run_id: string | null;
};

export type DbDiscordRelaySource = {
  source_platform: string;
  source_thread_id: string;
  source_user_id: string;
};

export type DiscordSessionRaw = {
  channel: {
    id: string;
    name?: string;
    guildId?: string | null;
    parentChannelId?: string | null;
  };
};

export class DiscordSurfaceStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_sessions (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT,
        parent_channel_id TEXT,
        name TEXT,
        type TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        raw_json TEXT
      );
    `);

    // Surface reads are live-fetched now; drop legacy caches to avoid stale context.
    dropLegacyDiscordMessageCacheTables(this.db);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_read_state (
        channel_id TEXT PRIMARY KEY,
        last_read_ts INTEGER NOT NULL,
        last_read_message_id TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_user_names (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        global_name TEXT,
        display_name TEXT,
        updated_ts INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_user_ids_by_username (
        username_lc TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discord_user_ids_by_username_user_id
      ON discord_user_ids_by_username(user_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_channel_names (
        channel_id TEXT PRIMARY KEY,
        name TEXT,
        updated_ts INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_role_names (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        name TEXT,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_message_relations (
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        guild_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT,
        ts INTEGER NOT NULL,
        is_chat INTEGER NOT NULL,
        reply_to_channel_id TEXT,
        reply_to_message_id TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discord_message_relations_channel_ts
      ON discord_message_relations(channel_id, ts DESC, message_id DESC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discord_message_relations_reply_target
      ON discord_message_relations(channel_id, reply_to_message_id);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discord_message_relations_cross_reply_target
      ON discord_message_relations(reply_to_channel_id, reply_to_message_id);
    `);

    // A relay row is written before its message is sent, keyed by the Discord nonce, because the
    // gateway can deliver the message before the send returns its id.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_relay_messages (
        nonce TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        source_platform TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        source_user_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_ts INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_relay_messages_message
      ON discord_relay_messages(channel_id, message_id)
      WHERE message_id IS NOT NULL;
    `);

    // What a keyed send reported, so its retry returns the same result.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_relay_results (
        nonce TEXT PRIMARY KEY,
        disposition TEXT NOT NULL,
        message_id TEXT NOT NULL,
        run_id TEXT
      );
    `);

    // Every Discord message that carries a relay's turn: the relay message itself and the output
    // its request posted afterwards.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_relay_refs (
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        relay_nonce TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (channel_id, message_id, relay_nonce)
      );
    `);
  }

  /** Records a relay before it is sent. A retry with the same nonce keeps the first row. */
  insertRelayMessage(input: {
    nonce: string;
    channelId: string;
    sourcePlatform: string;
    sourceThreadId: string;
    sourceUserId: string;
    discordUserId: string;
    mode: string;
    createdTs: number;
  }): DbDiscordRelayMessage | null {
    this.db.run(
      `
      INSERT INTO discord_relay_messages (
        nonce, channel_id, message_id, source_platform, source_thread_id, source_user_id,
        discord_user_id, mode, created_ts
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(nonce) DO NOTHING;
      `,
      [
        input.nonce,
        input.channelId,
        input.sourcePlatform,
        input.sourceThreadId,
        input.sourceUserId,
        input.discordUserId,
        input.mode,
        input.createdTs,
      ],
    );
    return this.getRelayMessageByNonce(input.nonce);
  }

  getRelayMessageByNonce(nonce: string): DbDiscordRelayMessage | null {
    return this.db
      .query<DbDiscordRelayMessage, [string]>(
        "SELECT * FROM discord_relay_messages WHERE nonce = ?",
      )
      .get(nonce);
  }

  getRelayMessageByMessageId(channelId: string, messageId: string): DbDiscordRelayMessage | null {
    return this.db
      .query<DbDiscordRelayMessage, [string, string]>(
        "SELECT * FROM discord_relay_messages WHERE channel_id = ? AND message_id = ?",
      )
      .get(channelId, messageId);
  }

  /** Binds a relay to its posted message, once, and records the message as a relay ref. */
  bindRelayMessage(input: { nonce: string; channelId: string; messageId: string; ts: number }) {
    this.db.run(
      `
      UPDATE discord_relay_messages
      SET message_id = ?
      WHERE nonce = ? AND channel_id = ? AND message_id IS NULL
      `,
      [input.messageId, input.nonce, input.channelId],
    );
    this.insertRelayRef({ ...input, kind: "relay" });
  }

  insertRelayRef(input: {
    channelId: string;
    messageId: string;
    nonce: string;
    kind: "relay" | "output";
    ts: number;
  }) {
    this.db.run(
      `
      INSERT INTO discord_relay_refs (channel_id, message_id, relay_nonce, kind, created_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, message_id, relay_nonce) DO NOTHING;
      `,
      [input.channelId, input.messageId, input.nonce, input.kind, input.ts],
    );
  }

  insertRelayResult(input: {
    nonce: string;
    disposition: string;
    messageId: string;
    runId?: string;
  }) {
    this.db.run(
      `
      INSERT INTO discord_relay_results (nonce, disposition, message_id, run_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(nonce) DO NOTHING;
      `,
      [input.nonce, input.disposition, input.messageId, input.runId ?? null],
    );
  }

  getRelayResult(nonce: string): DbDiscordRelayResult | null {
    return this.db
      .query<DbDiscordRelayResult, [string]>("SELECT * FROM discord_relay_results WHERE nonce = ?")
      .get(nonce);
  }

  /** The distinct sources of relays whose messages are in this channel. */
  listRelaySourcesForChannel(channelId: string): DbDiscordRelaySource[] {
    return this.db
      .query<DbDiscordRelaySource, [string]>(
        `
        SELECT DISTINCT m.source_platform, m.source_thread_id, m.source_user_id
        FROM discord_relay_refs r
        JOIN discord_relay_messages m ON m.nonce = r.relay_nonce
        WHERE r.channel_id = ?
        ORDER BY m.source_thread_id, m.source_user_id
        `,
      )
      .all(channelId);
  }

  upsertSession(input: {
    channelId: string;
    guildId?: string;
    parentChannelId?: string;
    name?: string;
    type: "channel" | "thread" | "dm";
    updatedTs: number;
    raw?: DiscordSessionRaw;
  }) {
    const rawJson = input.raw ? JSON.stringify(input.raw) : null;
    this.db.run(
      `
      INSERT INTO discord_sessions (
        channel_id, guild_id, parent_channel_id, name, type, updated_ts, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        guild_id=excluded.guild_id,
        parent_channel_id=excluded.parent_channel_id,
        name=excluded.name,
        type=excluded.type,
        updated_ts=excluded.updated_ts,
        raw_json=excluded.raw_json;
      `,
      [
        input.channelId,
        input.guildId ?? null,
        input.parentChannelId ?? null,
        input.name ?? null,
        input.type,
        input.updatedTs,
        rawJson,
      ],
    );
  }

  getSession(channelId: string): DbDiscordSession | null {
    return this.db
      .query<DbDiscordSession, [string]>("SELECT * FROM discord_sessions WHERE channel_id = ?")
      .get(channelId);
  }

  listSessions(limit = 500): (DbDiscordSession & { activity_ts: number })[] {
    return this.db
      .query<DbDiscordSession & { activity_ts: number }, [number]>(
        `SELECT s.*, COALESCE((SELECT MAX(r.ts) FROM discord_message_relations r
          WHERE r.channel_id = s.channel_id AND r.deleted = 0), s.updated_ts) AS activity_ts
         FROM discord_sessions s ORDER BY activity_ts DESC, s.channel_id LIMIT ?`,
      )
      .all(limit);
  }

  upsertUserName(input: {
    userId: string;
    username?: string;
    globalName?: string;
    displayName?: string;
    updatedTs: number;
  }) {
    this.db.run(
      `
      INSERT INTO discord_user_names (
        user_id, username, global_name, display_name, updated_ts
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username=excluded.username,
        global_name=excluded.global_name,
        display_name=excluded.display_name,
        updated_ts=excluded.updated_ts;
      `,
      [
        input.userId,
        input.username ?? null,
        input.globalName ?? null,
        input.displayName ?? null,
        input.updatedTs,
      ],
    );

    if (input.username) {
      const usernameLc = input.username.toLowerCase();
      this.db.run(
        `
        INSERT INTO discord_user_ids_by_username (
          username_lc, user_id, updated_ts
        ) VALUES (?, ?, ?)
        ON CONFLICT(username_lc) DO UPDATE SET
          user_id=excluded.user_id,
          updated_ts=excluded.updated_ts;
        `,
        [usernameLc, input.userId, input.updatedTs],
      );
    }
  }

  getUserIdByUsername(username: string): string | null {
    const row = this.db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM discord_user_ids_by_username WHERE username_lc = ?",
      )
      .get(username.toLowerCase());
    return row?.user_id ?? null;
  }

  getUserName(userId: string): DbDiscordUserName | null {
    return this.db
      .query<DbDiscordUserName, [string]>("SELECT * FROM discord_user_names WHERE user_id = ?")
      .get(userId);
  }

  upsertChannelName(input: { channelId: string; name?: string; updatedTs: number }) {
    this.db.run(
      `
      INSERT INTO discord_channel_names (channel_id, name, updated_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        name=excluded.name,
        updated_ts=excluded.updated_ts;
      `,
      [input.channelId, input.name ?? null, input.updatedTs],
    );
  }

  getChannelName(channelId: string): DbDiscordChannelName | null {
    return this.db
      .query<DbDiscordChannelName, [string]>(
        "SELECT * FROM discord_channel_names WHERE channel_id = ?",
      )
      .get(channelId);
  }

  upsertRoleName(input: { guildId: string; roleId: string; name?: string; updatedTs: number }) {
    this.db.run(
      `
      INSERT INTO discord_role_names (guild_id, role_id, name, updated_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, role_id) DO UPDATE SET
        name=excluded.name,
        updated_ts=excluded.updated_ts;
      `,
      [input.guildId, input.roleId, input.name ?? null, input.updatedTs],
    );
  }

  getRoleName(guildId: string, roleId: string): DbDiscordRoleName | null {
    return this.db
      .query<DbDiscordRoleName, [string, string]>(
        "SELECT * FROM discord_role_names WHERE guild_id = ? AND role_id = ?",
      )
      .get(guildId, roleId);
  }

  upsertMessageRelation(input: {
    channelId: string;
    messageId: string;
    guildId?: string;
    authorId: string;
    authorName?: string;
    ts: number;
    isChat: boolean;
    replyToChannelId?: string;
    replyToMessageId?: string;
    deleted?: boolean;
    updatedTs: number;
  }) {
    this.db.run(
      `
      INSERT INTO discord_message_relations (
        channel_id,
        message_id,
        guild_id,
        author_id,
        author_name,
        ts,
        is_chat,
        reply_to_channel_id,
        reply_to_message_id,
        deleted,
        updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        guild_id=excluded.guild_id,
        author_id=excluded.author_id,
        author_name=excluded.author_name,
        ts=excluded.ts,
        is_chat=excluded.is_chat,
        reply_to_channel_id=excluded.reply_to_channel_id,
        reply_to_message_id=excluded.reply_to_message_id,
        deleted=excluded.deleted,
        updated_ts=excluded.updated_ts;
      `,
      [
        input.channelId,
        input.messageId,
        input.guildId ?? null,
        input.authorId,
        input.authorName ?? null,
        input.ts,
        input.isChat ? 1 : 0,
        input.replyToChannelId ?? null,
        input.replyToMessageId ?? null,
        input.deleted ? 1 : 0,
        input.updatedTs,
      ],
    );
  }

  getMessageRelation(channelId: string, messageId: string): DbDiscordMessageRelation | null {
    return this.db
      .query<DbDiscordMessageRelation, [string, string]>(
        "SELECT * FROM discord_message_relations WHERE channel_id = ? AND message_id = ?",
      )
      .get(channelId, messageId);
  }

  listMessageRelationsBeforeOrAt(input: {
    channelId: string;
    messageId: string;
    limit: number;
  }): DbDiscordMessageRelation[] {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(input.limit)));

    const rows = this.db
      .query<DbDiscordMessageRelation, [string, string, number]>(
        `
        SELECT r.*
        FROM discord_message_relations r
        JOIN discord_message_relations c
          ON c.channel_id = ?
         AND c.message_id = ?
        WHERE r.channel_id = c.channel_id
          AND c.deleted = 0
          AND r.deleted = 0
          AND (
            r.ts < c.ts
            OR (r.ts = c.ts AND r.message_id <= c.message_id)
          )
        ORDER BY r.ts DESC, r.message_id DESC
        LIMIT ?
        `,
      )
      .all(input.channelId, input.messageId, safeLimit);

    rows.reverse();
    return rows;
  }

  markMessageRelationDeleted(input: { channelId: string; messageId: string; updatedTs: number }) {
    this.db.run(
      `
      UPDATE discord_message_relations
      SET deleted = 1,
          updated_ts = ?
      WHERE channel_id = ?
        AND message_id = ?
      `,
      [input.updatedTs, input.channelId, input.messageId],
    );
  }

  getOrInitReadState(channelId: string): DbDiscordReadState {
    const existing = this.db
      .query<DbDiscordReadState, [string]>("SELECT * FROM discord_read_state WHERE channel_id = ?")
      .get(channelId);

    if (existing) return existing;

    const init: DbDiscordReadState = {
      channel_id: channelId,
      last_read_ts: 0,
      last_read_message_id: "0",
    };

    this.db.run(
      "INSERT INTO discord_read_state (channel_id, last_read_ts, last_read_message_id) VALUES (?, ?, ?)",
      [init.channel_id, init.last_read_ts, init.last_read_message_id],
    );

    return init;
  }

  setReadState(input: { channelId: string; lastReadTs: number; lastReadMessageId: string }) {
    this.db.run(
      `
      INSERT INTO discord_read_state (channel_id, last_read_ts, last_read_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_read_ts=excluded.last_read_ts,
        last_read_message_id=excluded.last_read_message_id;
      `,
      [input.channelId, input.lastReadTs, input.lastReadMessageId],
    );
  }
}
