import { captureError } from "../../shared/error-capture";
import { Result, TaggedError } from "better-result";
import { Database } from "bun:sqlite";
import type { BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import {
  preserveSurfacePanic,
  type SurfaceCacheBurstProvider,
  type SurfaceAdapter,
  type SurfaceBurstCacheInput,
} from "../adapter";
import { projectDiscordMessage } from "../discord/discord-message-projection";
import {
  hashIndexedDiscordAttachments,
  toIndexedDiscordAttachments,
  type DiscordIndexedAttachmentMeta,
  type DiscordAttachmentCacheAccess,
  type DiscordAttachmentCacheEntry,
  type DiscordAttachmentCacheKey,
} from "../discord/discord-attachment";
import type { DiscordMsgRef, DiscordSessionRef, SurfaceMessage, SurfacePlatform } from "../types";
import { configureSqliteConnection } from "../../shared/sqlite";

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

export type DiscordSearchIndexedMessage = {
  ref: DiscordMsgRef;
  session: DiscordSessionRef;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  editedTs?: number;
  deleted: boolean;
  updatedTs: number;
  attachments: DiscordIndexedAttachmentMeta[];
};

export type DiscordMessageCacheAccess = {
  getIndexedMessage(input: {
    channelId: string;
    messageId: string;
  }): DiscordSearchIndexedMessage | null;
  listIndexedMessagesBefore(input: {
    channelId: string;
    before: { messageId: string; ts: number };
    limit: number;
  }): DiscordSearchIndexedMessage[];
};

export type DiscordSearchMessageMutation = {
  before: DiscordSearchIndexedMessage | null;
  after: DiscordSearchIndexedMessage | null;
  changed: boolean;
};

export type DiscordSearchHealResult = {
  attempted: boolean;
  skipped: boolean;
  reason?: "cooldown";
  limit: number;
  fetched: number;
  indexed: number;
};

class DiscordSearchHealFailed extends TaggedError("DiscordSearchHealFailed")<{
  readonly message: string;
}> {}

function normalizeFtsQuery(input: string): string | null {
  const tokens = input
    .trim()
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`);

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

type RawIndexedRow = {
  channel_id: string;
  guild_id: string | null;
  message_id: string;
  user_id: string;
  user_name: string | null;
  text: string;
  ts: number;
  edited_ts: number | null;
  deleted: number;
  updated_ts: number;
  attachments_hash: string | null;
};

type RawIndexedAttachmentRow = {
  attachment_id: string | null;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  blob_ref_version: number | null;
  blob_object_id: string | null;
  blob_sha256: string | null;
  blob_byte_length: number | null;
  blob_expires_at: number | null;
  blob_cached_at: number | null;
};

function decodeCachedBlobReference(
  row: RawIndexedAttachmentRow,
): DiscordAttachmentCacheEntry | null {
  const fields = [
    row.blob_ref_version,
    row.blob_object_id,
    row.blob_sha256,
    row.blob_byte_length,
    row.blob_expires_at,
    row.blob_cached_at,
  ];
  if (fields.every((field) => field === null)) return null;
  if (typeof row.blob_cached_at !== "number" || !Number.isSafeInteger(row.blob_cached_at))
    return null;
  if (row.blob_ref_version !== 1) return null;
  if (typeof row.blob_object_id !== "string" || !/^b1_[0-9a-f]{32}$/u.test(row.blob_object_id))
    return null;
  if (typeof row.blob_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.blob_sha256)) return null;
  if (
    typeof row.blob_byte_length !== "number" ||
    !Number.isSafeInteger(row.blob_byte_length) ||
    row.blob_byte_length < 0
  )
    return null;
  if (
    row.blob_expires_at !== null &&
    (!Number.isSafeInteger(row.blob_expires_at) || row.blob_expires_at < 0)
  )
    return null;
  return {
    blob: {
      version: 1,
      objectId: row.blob_object_id,
      sha256: row.blob_sha256,
      byteLength: row.blob_byte_length,
      ...(row.blob_expires_at === null ? {} : { expiresAt: row.blob_expires_at }),
    },
    cachedAt: row.blob_cached_at,
  };
}

function asDiscordSearchIndexedMessage(
  row: RawIndexedRow,
  attachments: DiscordIndexedAttachmentMeta[],
): DiscordSearchIndexedMessage {
  return {
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
    deleted: row.deleted !== 0,
    updatedTs: row.updated_ts,
    attachments,
  };
}

export class DiscordSearchStore {
  private readonly db: Database;

  constructor(
    dbPath: string,
    private readonly options: {
      onAttachmentCachePruned?: (blob: BlobRefV1) => void;
    } = {},
  ) {
    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
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
        attachments_hash TEXT,
        PRIMARY KEY (channel_id, message_id)
      );
    `);

    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(discord_search_messages)")
      .all();
    if (!columns.some((column) => column.name === "attachments_hash")) {
      this.db.run("ALTER TABLE discord_search_messages ADD COLUMN attachments_hash TEXT;");
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS discord_search_message_attachments (
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        attachment_id TEXT,
        filename TEXT,
        mime_type TEXT,
        size INTEGER,
        blob_ref_version INTEGER,
        blob_object_id TEXT,
        blob_sha256 TEXT,
        blob_byte_length INTEGER,
        blob_expires_at INTEGER,
        blob_cached_at INTEGER,
        PRIMARY KEY (channel_id, message_id, ordinal),
        FOREIGN KEY (channel_id, message_id)
          REFERENCES discord_search_messages(channel_id, message_id)
          ON DELETE CASCADE
      );
    `);

    const attachmentColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(discord_search_message_attachments)")
      .all();
    const cacheColumns = [
      ["blob_ref_version", "INTEGER"],
      ["blob_object_id", "TEXT"],
      ["blob_sha256", "TEXT"],
      ["blob_byte_length", "INTEGER"],
      ["blob_expires_at", "INTEGER"],
      ["blob_cached_at", "INTEGER"],
    ] as const;
    for (const [name, type] of cacheColumns) {
      if (!attachmentColumns.some((column) => column.name === name)) {
        this.db.run(`ALTER TABLE discord_search_message_attachments ADD COLUMN ${name} ${type};`);
      }
    }

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
      .query<{ c: number }, []>("SELECT COUNT(1) AS c FROM discord_search_messages")
      .get();
    const ftsCountRow = this.db
      .query<{ c: number }, []>("SELECT COUNT(1) AS c FROM discord_search_messages_fts")
      .get();

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
    const prunedCacheBlobs = new Map<string, BlobRefV1>();

    const tx = this.db.transaction((input: readonly SurfaceMessage[]) => {
      for (const message of input) {
        if (!isDiscordMessage(message)) continue;
        const projection = projectDiscordMessage(message);
        const attachments = toIndexedDiscordAttachments(projection.attachments);
        const attachmentsHash = hashIndexedDiscordAttachments(attachments);
        const existingAttachmentHash = this.db
          .query<{ attachments_hash: string | null }, [string, string]>(
            `
            SELECT attachments_hash
            FROM discord_search_messages
            WHERE channel_id = ? AND message_id = ?
            `,
          )
          .get(message.session.channelId, message.ref.messageId)?.attachments_hash;

        const result = this.db.run(
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
            updated_ts,
            attachments_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel_id, message_id) DO UPDATE SET
            guild_id=excluded.guild_id,
            user_id=excluded.user_id,
            user_name=excluded.user_name,
            text=excluded.text,
            ts=excluded.ts,
            edited_ts=excluded.edited_ts,
            deleted=excluded.deleted,
            updated_ts=excluded.updated_ts,
            attachments_hash=excluded.attachments_hash
          WHERE discord_search_messages.guild_id IS NOT excluded.guild_id
             OR discord_search_messages.user_id IS NOT excluded.user_id
             OR discord_search_messages.user_name IS NOT excluded.user_name
             OR discord_search_messages.text IS NOT excluded.text
             OR discord_search_messages.ts IS NOT excluded.ts
             OR discord_search_messages.edited_ts IS NOT excluded.edited_ts
             OR discord_search_messages.deleted IS NOT excluded.deleted
             OR discord_search_messages.attachments_hash IS NOT excluded.attachments_hash;
          `,
          [
            message.session.channelId,
            message.session.guildId ?? null,
            message.ref.messageId,
            message.userId,
            message.userName ?? null,
            projection.displayText,
            message.ts,
            message.editedTs ?? null,
            message.deleted ? 1 : 0,
            now,
            attachmentsHash,
          ],
        );
        if (result.changes > 0 && existingAttachmentHash !== attachmentsHash) {
          const staleAttachmentRows = this.db
            .query<RawIndexedAttachmentRow, [string, string]>(
              `
              SELECT
                attachment_id,
                filename,
                mime_type,
                size,
                blob_ref_version,
                blob_object_id,
                blob_sha256,
                blob_byte_length,
                blob_expires_at,
                blob_cached_at
              FROM discord_search_message_attachments
              WHERE channel_id = ? AND message_id = ?
              `,
            )
            .all(message.session.channelId, message.ref.messageId);
          for (const row of staleAttachmentRows) {
            const cached = decodeCachedBlobReference(row);
            if (cached) prunedCacheBlobs.set(cached.blob.objectId, cached.blob);
          }
          this.db.run(
            "DELETE FROM discord_search_message_attachments WHERE channel_id = ? AND message_id = ?",
            [message.session.channelId, message.ref.messageId],
          );
          attachments.forEach((attachment, ordinal) => {
            this.db.run(
              `
              INSERT INTO discord_search_message_attachments (
                channel_id, message_id, ordinal, attachment_id, filename, mime_type, size
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
              [
                message.session.channelId,
                message.ref.messageId,
                ordinal,
                attachment.id ?? null,
                attachment.filename ?? null,
                attachment.mimeType ?? null,
                attachment.size ?? null,
              ],
            );
          });
        }
        // FTS trigger writes are included in SQLite's change count, but each upsert affects one message.
        wrote += result.changes > 0 ? 1 : 0;
      }
    });

    tx(messages);
    for (const blob of prunedCacheBlobs.values()) {
      this.options.onAttachmentCachePruned?.(blob);
    }
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
      .query<{ c: number }, [string]>(
        "SELECT COUNT(1) AS c FROM discord_search_messages WHERE channel_id = ?",
      )
      .get(channelId);
    return typeof row?.c === "number" ? row.c : 0;
  }

  getIndexedMessage(input: {
    channelId: string;
    messageId: string;
  }): DiscordSearchIndexedMessage | null {
    const row = this.db
      .query<RawIndexedRow, [string, string]>(
        `
        SELECT
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
          , attachments_hash
        FROM discord_search_messages
        WHERE channel_id = ? AND message_id = ?
        `,
      )
      .get(input.channelId, input.messageId);

    return row
      ? asDiscordSearchIndexedMessage(
          row,
          this.listMessageAttachments(row.channel_id, row.message_id),
        )
      : null;
  }

  listIndexedMessagesBefore(input: {
    channelId: string;
    before: { messageId: string; ts: number };
    limit: number;
  }): DiscordSearchIndexedMessage[] {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(input.limit)));
    const rows = this.db
      .query<RawIndexedRow, [string, number, number, string, number]>(
        `
        SELECT
          channel_id,
          guild_id,
          message_id,
          user_id,
          user_name,
          text,
          ts,
          edited_ts,
          deleted,
          updated_ts,
          attachments_hash
        FROM discord_search_messages
        WHERE channel_id = ?
          AND deleted = 0
          AND (ts < ? OR (ts = ? AND message_id < ?))
        ORDER BY ts DESC, message_id DESC
        LIMIT ?
        `,
      )
      .all(input.channelId, input.before.ts, input.before.ts, input.before.messageId, safeLimit);

    rows.reverse();
    return rows.map((row) =>
      asDiscordSearchIndexedMessage(
        row,
        this.listMessageAttachments(row.channel_id, row.message_id),
      ),
    );
  }

  listMessagesForDiscovery(sinceUpdatedTs?: number): DiscordSearchIndexedMessage[] {
    const rows =
      sinceUpdatedTs === undefined
        ? this.db
            .query<RawIndexedRow, []>(
              `
            SELECT
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
              , attachments_hash
            FROM discord_search_messages
            ORDER BY updated_ts ASC, channel_id ASC, message_id ASC
            `,
            )
            .all()
        : this.db
            .query<RawIndexedRow, [number]>(
              `
            SELECT
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
              , attachments_hash
            FROM discord_search_messages
            WHERE updated_ts >= ?
            ORDER BY updated_ts ASC, channel_id ASC, message_id ASC
            `,
            )
            .all(sinceUpdatedTs);

    return rows.map((row) =>
      asDiscordSearchIndexedMessage(
        row,
        this.listMessageAttachments(row.channel_id, row.message_id),
      ),
    );
  }

  listMessageAttachments(channelId: string, messageId: string): DiscordIndexedAttachmentMeta[] {
    const rows = this.db
      .query<RawIndexedAttachmentRow, [string, string]>(
        `
        SELECT
          attachment_id,
          filename,
          mime_type,
          size,
          blob_ref_version,
          blob_object_id,
          blob_sha256,
          blob_byte_length,
          blob_expires_at,
          blob_cached_at
        FROM discord_search_message_attachments
        WHERE channel_id = ? AND message_id = ?
        ORDER BY ordinal ASC
        `,
      )
      .all(channelId, messageId);
    return rows.map((row) => {
      const cache = decodeCachedBlobReference(row);
      return {
        ...(row.attachment_id ? { id: row.attachment_id } : {}),
        ...(row.filename ? { filename: row.filename } : {}),
        ...(row.mime_type ? { mimeType: row.mime_type } : {}),
        ...(row.size !== null ? { size: row.size } : {}),
        ...(cache ? { cache } : {}),
      };
    });
  }

  getAttachmentCache(input: DiscordAttachmentCacheKey): DiscordAttachmentCacheEntry | null {
    const row = this.db
      .query<RawIndexedAttachmentRow, [string, string, number, string | null]>(
        `
        SELECT
          attachment_id,
          filename,
          mime_type,
          size,
          blob_ref_version,
          blob_object_id,
          blob_sha256,
          blob_byte_length,
          blob_expires_at,
          blob_cached_at
        FROM discord_search_message_attachments
        WHERE channel_id = ?
          AND message_id = ?
          AND ordinal = ?
          AND attachment_id IS ?
        `,
      )
      .get(input.channelId, input.messageId, input.ordinal, input.attachmentId ?? null);
    return row ? decodeCachedBlobReference(row) : null;
  }

  putAttachmentCache(input: DiscordAttachmentCacheKey & DiscordAttachmentCacheEntry): void {
    this.db.run(
      `
      UPDATE discord_search_message_attachments
      SET blob_ref_version = ?,
          blob_object_id = ?,
          blob_sha256 = ?,
          blob_byte_length = ?,
          blob_expires_at = ?,
          blob_cached_at = ?
      WHERE channel_id = ?
        AND message_id = ?
        AND ordinal = ?
        AND attachment_id IS ?
      `,
      [
        input.blob.version,
        input.blob.objectId,
        input.blob.sha256,
        input.blob.byteLength,
        input.blob.expiresAt ?? null,
        input.cachedAt,
        input.channelId,
        input.messageId,
        input.ordinal,
        input.attachmentId ?? null,
      ],
    );
  }

  clearAttachmentCache(
    input: DiscordAttachmentCacheKey & { readonly expected: BlobRefV1 },
  ): BlobRefV1 | null {
    const cached = this.getAttachmentCache(input);
    if (cached?.blob.objectId !== input.expected.objectId) return null;
    const cleared = this.db.run(
      `
      UPDATE discord_search_message_attachments
      SET blob_ref_version = NULL,
          blob_object_id = NULL,
          blob_sha256 = NULL,
          blob_byte_length = NULL,
          blob_expires_at = NULL,
          blob_cached_at = NULL
      WHERE channel_id = ?
        AND message_id = ?
        AND ordinal = ?
        AND attachment_id IS ?
        AND blob_object_id = ?
      `,
      [
        input.channelId,
        input.messageId,
        input.ordinal,
        input.attachmentId ?? null,
        input.expected.objectId,
      ],
    );
    return cleared.changes > 0 ? cached.blob : null;
  }

  attachmentCacheAccess(): DiscordAttachmentCacheAccess {
    return {
      get: (input) => this.getAttachmentCache(input),
      put: (input) => this.putAttachmentCache(input),
      clear: (input) => this.clearAttachmentCache(input),
    };
  }

  searchChannel(input: { channelId: string; query: string; limit?: number }): DiscordSearchHit[] {
    const ftsQuery = normalizeFtsQuery(input.query);
    if (!ftsQuery) return [];

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 20)));

    const rows = this.db
      .query<RawSearchRow, [string, string, number]>(
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
      .all(ftsQuery, input.channelId, limit);

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

type DiscordSearchAdapter = Pick<SurfaceAdapter, "listMsg"> & Partial<SurfaceCacheBurstProvider>;

function hasBurstCache(
  adapter: DiscordSearchAdapter,
): adapter is DiscordSearchAdapter & SurfaceCacheBurstProvider {
  return typeof adapter.burstCache === "function";
}

export class DiscordSearchService {
  private readonly logger = createLogger({
    module: "surface:discord-search",
  });

  private readonly healTimestampsByChannel = new Map<string, number>();

  constructor(
    private readonly params: {
      adapter: DiscordSearchAdapter;
      store: DiscordSearchStore;
      onMessagesIndexed?: (channelId: string) => void;
    },
  ) {}

  attachmentCacheAccess(): DiscordAttachmentCacheAccess {
    return this.params.store.attachmentCacheAccess();
  }

  async onMessageCreated(message: SurfaceMessage): Promise<void> {
    if (!isDiscordMessage(message)) return;

    this.params.store.upsertMessages([message]);

    await this.maybeHealChannel({
      sessionRef: message.session,
      limit: DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT,
    });
  }

  onMessageUpdated(message: SurfaceMessage): DiscordSearchMessageMutation | null {
    if (!isDiscordMessage(message)) return null;

    const input = {
      channelId: message.session.channelId,
      messageId: message.ref.messageId,
    };
    const before = this.params.store.getIndexedMessage(input);
    const changed = this.params.store.upsertMessages([message]) > 0;
    const after = this.params.store.getIndexedMessage(input);

    return { before, after, changed };
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
  }): Promise<{
    hits: DiscordSearchHit[];
    heal: DiscordSearchHealResult | null;
  }> {
    const indexed = this.params.store.countMessagesByChannel(input.sessionRef.channelId);

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
    if (typeof lastHealTs === "number" && now - lastHealTs < DISCORD_SEARCH_HEAL_COOLDOWN_MS) {
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
      {
        const attempt = await Result.tryPromise({
          try: async () => {
            await this.params.adapter.burstCache!(cacheInput);
          },
          catch: captureError,
        });

        if (attempt.isErr()) {
          const cause = attempt.error.cause;
          preserveSurfacePanic(cause);
          // ignore cache invalidation errors
        }
      }
    }

    {
      const attempt = await Result.tryPromise({
        try: async () => {
          const messages = await this.params.adapter.listMsg(input.sessionRef, {
            limit,
          });
          return messages.match({
            err: (error) => () => {
              this.logger.error("search heal failed", {
                channelId: input.sessionRef.channelId,
                limit,
                ...formatTaggedErrorForLog(error),
              });
              return {
                attempted: true,
                skipped: false,
                limit,
                fetched: 0,
                indexed: 0,
              };
            },
            ok: (value) => () => {
              const indexed = this.params.store.upsertMessages(value);
              if (indexed > 0) this.params.onMessagesIndexed?.(input.sessionRef.channelId);
              return {
                attempted: true,
                skipped: false,
                limit,
                fetched: value.length,
                indexed,
              };
            },
          })();
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const e = attempt.error.cause;
        preserveSurfacePanic(e);
        this.logger.error("search heal failed", {
          channelId: input.sessionRef.channelId,
          limit,
          ...formatTaggedErrorForLog(
            new DiscordSearchHealFailed({
              message: "Discord search heal failed",
            }),
          ),
        });
        return {
          attempted: true,
          skipped: false,
          limit,
          fetched: 0,
          indexed: 0,
        };
      }
      return attempt.value;
    }
  }
}
