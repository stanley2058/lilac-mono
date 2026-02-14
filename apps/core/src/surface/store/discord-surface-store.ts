import { Database } from "bun:sqlite";

import { dropLegacyDiscordMessageCacheTables } from "./migrations/drop-legacy-discord-message-cache-tables";

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

export class DiscordSurfaceStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
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
  }

  upsertSession(input: {
    channelId: string;
    guildId?: string;
    parentChannelId?: string;
    name?: string;
    type: "channel" | "thread" | "dm";
    updatedTs: number;
    raw?: unknown;
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
      .query("SELECT * FROM discord_sessions WHERE channel_id = ?")
      .get(channelId) as DbDiscordSession | null;
  }

  listSessions(limit = 500): DbDiscordSession[] {
    return this.db
      .query("SELECT * FROM discord_sessions ORDER BY updated_ts DESC LIMIT ?")
      .all(limit) as DbDiscordSession[];
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
      .query("SELECT user_id FROM discord_user_ids_by_username WHERE username_lc = ?")
      .get(username.toLowerCase()) as { user_id: string } | null;
    return row?.user_id ?? null;
  }

  getUserName(userId: string): DbDiscordUserName | null {
    return this.db
      .query("SELECT * FROM discord_user_names WHERE user_id = ?")
      .get(userId) as DbDiscordUserName | null;
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
      .query("SELECT * FROM discord_channel_names WHERE channel_id = ?")
      .get(channelId) as DbDiscordChannelName | null;
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
      .query("SELECT * FROM discord_role_names WHERE guild_id = ? AND role_id = ?")
      .get(guildId, roleId) as DbDiscordRoleName | null;
  }

  getOrInitReadState(channelId: string): DbDiscordReadState {
    const existing = this.db
      .query("SELECT * FROM discord_read_state WHERE channel_id = ?")
      .get(channelId) as DbDiscordReadState | null;

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
