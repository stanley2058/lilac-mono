import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as sqliteVec from "sqlite-vec";

import type {
  ConversationThreadEmbeddingFacet,
  ConversationThreadFacetInput,
} from "./thread-embedding";

const SEARCH_LIMIT_MAX = 50;
const THREAD_DISCOVERY_GAP_MS = 60 * 60 * 1000;

export const CONVERSATION_THREAD_SUMMARY_VERSION = 2;
export const CONVERSATION_THREAD_EMBEDDING_VERSION = 1;

export type ConversationThreadKind = "discord_thread" | "inferred_channel_thread";

export type ConversationThreadRow = {
  thread_id: string;
  channel_id: string;
  guild_id: string | null;
  parent_channel_id: string | null;
  kind: ConversationThreadKind;
  start_message_id: string;
  end_message_id: string;
  start_ts: number;
  end_ts: number;
  message_count: number;
  updated_at: number;
  last_summarized_at: number | null;
  last_embedded_at: number | null;
  summary_input_hash: string | null;
  embedding_input_hash: string | null;
  summary_version: number;
  embedding_version: number;
};

export type ConversationThreadSummaryRow = {
  thread_id: string;
  title: string;
  brief: string;
  topics_json: string;
  importance: ConversationThreadImportance;
  importance_reasons_json: string;
  created_at: number;
  updated_at: number;
};

export type ConversationThreadMessage = {
  channelId: string;
  messageId: string;
  ordinal: number;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
};

export type ConversationThreadImportance = "low" | "medium" | "high";

export type ConversationThreadSummaryInput = {
  title: string;
  brief: string;
  topics: string[];
  importance?: ConversationThreadImportance;
  importanceReasons?: string[];
};

export type ConversationThreadSummary = {
  title: string;
  brief: string;
  topics: string[];
  importance: ConversationThreadImportance;
  importanceReasons: string[];
};

export type ConversationThreadSearchHit = {
  threadId: string;
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  kind: ConversationThreadKind;
  title: string;
  brief: string;
  topics: string[];
  importance: ConversationThreadImportance;
  importanceReasons: string[];
  startTs: number;
  endTs: number;
  messageCount: number;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  startMessageId: string;
  endMessageId: string;
  summarized: boolean;
  stale: boolean;
};

export type ConversationThreadSearchFilters = {
  sessionId?: string;
  participantId?: string;
  beforeTs?: number;
  afterTs?: number;
};

export type ConversationThreadSearchAllowlist = {
  channelIds: readonly string[];
  guildIds: readonly string[];
};

export type ConversationThreadReadResult = {
  thread: ConversationThreadRow;
  summary: ConversationThreadSummary | null;
  messages: ConversationThreadMessage[];
  totalMessages: number;
};

type IndexedMessageRow = {
  channel_id: string;
  guild_id: string | null;
  parent_channel_id: string | null;
  session_type: string | null;
  message_id: string;
  user_id: string;
  user_name: string | null;
  text: string;
  ts: number;
  updated_ts: number;
  is_chat: number;
  reply_to_channel_id: string | null;
  reply_to_message_id: string | null;
};

type ThreadSearchRow = ConversationThreadRow & {
  title: string;
  brief: string;
  topics_json: string;
  importance: ConversationThreadImportance;
  importance_reasons_json: string;
  lexical_score: number;
};

type ThreadSemanticSearchRow = ConversationThreadRow & {
  title: string;
  brief: string;
  topics_json: string;
  importance: ConversationThreadImportance;
  importance_reasons_json: string;
  semantic_score: number;
};

type FacetRow = {
  facet: ConversationThreadEmbeddingFacet;
  text: string;
  weight: number;
};

export type ConversationThreadStoreOptions = {
  surfaceDbPath?: string;
};

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sqlString(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function safeStringArrayFromJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function safeImportance(input: unknown): ConversationThreadImportance {
  return input === "low" || input === "high" || input === "medium" ? input : "medium";
}

function truncate(input: string, maxLength: number): string {
  const normalized = input.trim().replace(/\s+/gu, " ");
  return normalized.length > maxLength ? normalized.slice(0, maxLength).trimEnd() : normalized;
}

function normalizeSummary(summary: ConversationThreadSummaryInput): ConversationThreadSummary {
  return {
    title: truncate(summary.title, 120) || "Untitled conversation",
    brief: truncate(summary.brief, 1024),
    topics: summary.topics.map((topic) => truncate(topic, 80)).filter((topic) => topic.length > 0),
    importance: safeImportance(summary.importance),
    importanceReasons: (summary.importanceReasons ?? [])
      .map((reason) => truncate(reason, 180))
      .filter((reason) => reason.length > 0)
      .slice(0, 5),
  };
}

function computeThreadInputHash(messages: readonly IndexedMessageRow[]): string {
  return stableHash(
    messages
      .map((message) =>
        [message.channel_id, message.message_id, message.updated_ts, message.text].join("\u001f"),
      )
      .join("\u001e"),
  );
}

function computeSummaryHash(summary: ConversationThreadSummary): string {
  return stableHash([summary.title, summary.brief, ...summary.topics].join("\u001f"));
}

function computeFacetHash(facets: readonly ConversationThreadFacetInput[]): string {
  return stableHash(
    facets.map((facet) => [facet.facet, facet.weight, facet.text].join("\u001f")).join("\u001e"),
  );
}

function messageKey(channelId: string, messageId: string): string {
  return `${channelId}\u001f${messageId}`;
}

function groupInferredMessages(messages: readonly IndexedMessageRow[]): IndexedMessageRow[][] {
  if (messages.length === 0) return [];

  const parent = messages.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const byMessage = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    byMessage.set(messageKey(message.channel_id, message.message_id), i);
    const previous = messages[i - 1];
    if (previous && message.ts - previous.ts <= THREAD_DISCOVERY_GAP_MS) {
      union(i - 1, i);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!message.reply_to_message_id) continue;
    const replyChannelId = message.reply_to_channel_id ?? message.channel_id;
    if (replyChannelId !== message.channel_id) continue;
    const targetIndex = byMessage.get(messageKey(replyChannelId, message.reply_to_message_id));
    if (targetIndex === undefined) continue;
    union(i, targetIndex);
  }

  const groups = new Map<number, IndexedMessageRow[]>();
  for (let i = 0; i < messages.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(messages[i]!);
    else groups.set(root, [messages[i]!]);
  }

  return [...groups.values()].sort((left, right) => {
    const leftStart = left[0]!;
    const rightStart = right[0]!;
    if (leftStart.ts !== rightStart.ts) return leftStart.ts - rightStart.ts;
    return leftStart.message_id.localeCompare(rightStart.message_id);
  });
}

export type ConversationThreadSummaryWriteResult = {
  facets: ConversationThreadFacetInput[];
  embeddingInputHash: string;
};

export class ConversationThreadStore {
  private readonly db: Database;
  private readonly searchDbPath: string;
  private readonly surfaceDbPath?: string;
  private hasSurfaceDb: boolean;
  private vectorLoadError: string | null = null;
  private vectorLoaded = false;

  constructor(dbPath: string, options: ConversationThreadStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.searchDbPath = dbPath;
    this.surfaceDbPath = options.surfaceDbPath;
    this.hasSurfaceDb = this.attachSurfaceDb();
    this.loadVectorExtension();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  isVectorSearchAvailable(): boolean {
    return this.vectorLoaded;
  }

  getVectorLoadError(): string | null {
    return this.vectorLoadError;
  }

  private loadVectorExtension(): void {
    try {
      sqliteVec.load(this.db);
      this.vectorLoaded = true;
      this.vectorLoadError = null;
    } catch (e) {
      this.vectorLoaded = false;
      this.vectorLoadError = e instanceof Error ? e.message : String(e);
    }
  }

  private attachSurfaceDb(): boolean {
    const surfaceDbPath = this.surfaceDbPath;
    if (!surfaceDbPath || surfaceDbPath === this.searchDbPath) return false;
    try {
      this.db.run(`ATTACH DATABASE ${sqlString(surfaceDbPath)} AS surface`);
      if (!this.hasRequiredSurfaceTables()) {
        this.db.run("DETACH DATABASE surface");
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private hasRequiredSurfaceTables(): boolean {
    try {
      const rows = this.db
        .query(
          `
          SELECT name
          FROM surface.sqlite_master
          WHERE type = 'table'
            AND name IN ('discord_sessions', 'discord_message_relations')
          `,
        )
        .all() as Array<{ name: string }>;
      return rows.length === 2;
    } catch {
      return false;
    }
  }

  private ensureSurfaceDb(): boolean {
    if (this.hasSurfaceDb) return true;
    this.hasSurfaceDb = this.attachSurfaceDb();
    return this.hasSurfaceDb;
  }

  private tableHasColumn(tableName: "conversation_thread_summaries", columnName: string): boolean {
    const rows = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        thread_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        parent_channel_id TEXT,
        kind TEXT NOT NULL,
        start_message_id TEXT NOT NULL,
        end_message_id TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_summarized_at INTEGER,
        last_embedded_at INTEGER,
        summary_input_hash TEXT,
        embedding_input_hash TEXT,
        summary_version INTEGER NOT NULL DEFAULT ${CONVERSATION_THREAD_SUMMARY_VERSION},
        embedding_version INTEGER NOT NULL DEFAULT ${CONVERSATION_THREAD_EMBEDDING_VERSION}
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_channel_end_ts
      ON conversation_threads(channel_id, end_ts DESC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated_at
      ON conversation_threads(updated_at ASC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_messages (
        thread_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_messages_thread_ordinal
      ON conversation_thread_messages(thread_id, ordinal ASC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_summaries (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        importance TEXT NOT NULL DEFAULT 'medium',
        importance_reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    if (!this.tableHasColumn("conversation_thread_summaries", "importance")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN importance TEXT NOT NULL DEFAULT 'medium';
      `);
    }

    if (!this.tableHasColumn("conversation_thread_summaries", "importance_reasons_json")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN importance_reasons_json TEXT NOT NULL DEFAULT '[]';
      `);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_facets (
        thread_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        text TEXT NOT NULL,
        weight REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, facet)
      );
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_thread_facets_fts
      USING fts5(
        text,
        content='conversation_thread_facets',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_ai
      AFTER INSERT ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_ad
      AFTER DELETE ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(conversation_thread_facets_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_au
      AFTER UPDATE ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(conversation_thread_facets_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO conversation_thread_facets_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_embeddings (
        thread_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, facet, model_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_embeddings_model
      ON conversation_thread_embeddings(model_id, dimensions);
    `);
  }

  refreshInferredThreads(): { channels: number; threads: number; messages: number } {
    const hasSurfaceDb = this.ensureSurfaceDb();
    const metadataSelect = hasSurfaceDb
      ? `
          s.parent_channel_id AS parent_channel_id,
          s.type AS session_type,
          COALESCE(r.is_chat, 1) AS is_chat,
          r.reply_to_channel_id AS reply_to_channel_id,
          r.reply_to_message_id AS reply_to_message_id
        `
      : `
          NULL AS parent_channel_id,
          NULL AS session_type,
          1 AS is_chat,
          NULL AS reply_to_channel_id,
          NULL AS reply_to_message_id
        `;
    const metadataJoin = hasSurfaceDb
      ? `
          LEFT JOIN surface.discord_sessions s
            ON s.channel_id = m.channel_id
          LEFT JOIN surface.discord_message_relations r
            ON r.channel_id = m.channel_id
           AND r.message_id = m.message_id
        `
      : "";
    const rows = this.db
      .query(
        `
        SELECT
          m.channel_id,
          m.guild_id,
          ${metadataSelect},
          m.message_id,
          m.user_id,
          m.user_name,
          m.text,
          m.ts,
          m.updated_ts
        FROM discord_search_messages m
        ${metadataJoin}
        WHERE m.deleted = 0
          AND trim(m.text) <> ''
          AND (${hasSurfaceDb ? "r.is_chat IS NULL OR r.is_chat != 0" : "1 = 1"})
        ORDER BY m.channel_id ASC, m.ts ASC, m.message_id ASC
        `,
      )
      .all() as IndexedMessageRow[];

    const nativeByChannel = new Map<string, IndexedMessageRow[]>();
    const inferredByChannel = new Map<string, IndexedMessageRow[]>();
    for (const row of rows) {
      const isNativeThread = row.session_type === "thread" && !!row.parent_channel_id;
      const bucket = isNativeThread ? nativeByChannel : inferredByChannel;
      const list = bucket.get(row.channel_id);
      if (list) list.push(row);
      else bucket.set(row.channel_id, [row]);
    }

    let threadCount = 0;
    const activeThreadIds = new Set<string>();

    const tx = this.db.transaction(() => {
      for (const messages of nativeByChannel.values()) {
        const threadId = this.upsertDiscordThread(messages);
        activeThreadIds.add(threadId);
        threadCount += 1;
      }

      for (const messages of inferredByChannel.values()) {
        for (const group of groupInferredMessages(messages)) {
          const threadId = this.upsertInferredThread(group);
          activeThreadIds.add(threadId);
          threadCount += 1;
        }
      }

      const managedKinds = hasSurfaceDb
        ? "('inferred_channel_thread', 'discord_thread')"
        : "('inferred_channel_thread')";
      const existing = this.db
        .query(`SELECT thread_id FROM conversation_threads WHERE kind IN ${managedKinds}`)
        .all() as Array<{ thread_id: string }>;
      for (const row of existing) {
        if (activeThreadIds.has(row.thread_id)) continue;
        this.deleteThread(row.thread_id);
      }
    });

    tx();

    return {
      channels: new Set(rows.map((row) => row.channel_id)).size,
      threads: threadCount,
      messages: rows.length,
    };
  }

  private upsertInferredThread(messages: readonly IndexedMessageRow[]): string {
    const first = messages[0];
    if (!first) throw new Error("cannot upsert empty thread");
    return this.upsertThread({
      threadId: `discord:channel:${first.channel_id}:${first.message_id}`,
      kind: "inferred_channel_thread",
      parentChannelId: null,
      messages,
    });
  }

  private upsertDiscordThread(messages: readonly IndexedMessageRow[]): string {
    const first = messages[0];
    if (!first) throw new Error("cannot upsert empty Discord thread");
    return this.upsertThread({
      threadId: `discord:thread:${first.channel_id}`,
      kind: "discord_thread",
      parentChannelId: first.parent_channel_id,
      messages,
    });
  }

  private upsertThread(input: {
    threadId: string;
    kind: ConversationThreadKind;
    parentChannelId: string | null;
    messages: readonly IndexedMessageRow[];
  }): string {
    const first = input.messages[0];
    const last = input.messages.at(-1);
    if (!first || !last) throw new Error("cannot upsert empty thread");

    const now = Date.now();
    const updatedAt = Math.max(...input.messages.map((message) => message.updated_ts));
    const inputHash = computeThreadInputHash(input.messages);
    const existing = this.getThread(input.threadId);
    const hashChanged = existing?.summary_input_hash !== inputHash;

    this.db.run(
      `
      INSERT INTO conversation_threads (
        thread_id,
        channel_id,
        guild_id,
        parent_channel_id,
        kind,
        start_message_id,
        end_message_id,
        start_ts,
        end_ts,
        message_count,
        updated_at,
        last_summarized_at,
        last_embedded_at,
        summary_input_hash,
        embedding_input_hash,
        summary_version,
        embedding_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        channel_id=excluded.channel_id,
        guild_id=excluded.guild_id,
        parent_channel_id=excluded.parent_channel_id,
        kind=excluded.kind,
        start_message_id=excluded.start_message_id,
        end_message_id=excluded.end_message_id,
        start_ts=excluded.start_ts,
        end_ts=excluded.end_ts,
        message_count=excluded.message_count,
        updated_at=excluded.updated_at,
        last_summarized_at=CASE
          WHEN excluded.summary_input_hash = conversation_threads.summary_input_hash THEN conversation_threads.last_summarized_at
          ELSE NULL
        END,
        last_embedded_at=CASE
          WHEN excluded.summary_input_hash = conversation_threads.summary_input_hash THEN conversation_threads.last_embedded_at
          ELSE NULL
        END,
        summary_input_hash=excluded.summary_input_hash,
        embedding_input_hash=CASE
          WHEN excluded.summary_input_hash = conversation_threads.summary_input_hash THEN conversation_threads.embedding_input_hash
          ELSE NULL
        END,
        summary_version=excluded.summary_version,
        embedding_version=excluded.embedding_version;
      `,
      [
        input.threadId,
        first.channel_id,
        first.guild_id,
        input.parentChannelId,
        input.kind,
        first.message_id,
        last.message_id,
        first.ts,
        last.ts,
        input.messages.length,
        Math.max(updatedAt, existing?.updated_at ?? 0, hashChanged ? now : 0),
        existing?.last_summarized_at ?? null,
        existing?.last_embedded_at ?? null,
        inputHash,
        existing?.embedding_input_hash ?? null,
        CONVERSATION_THREAD_SUMMARY_VERSION,
        CONVERSATION_THREAD_EMBEDDING_VERSION,
      ],
    );

    this.db.run("DELETE FROM conversation_thread_messages WHERE thread_id = ?", [input.threadId]);
    for (let i = 0; i < input.messages.length; i++) {
      const message = input.messages[i]!;
      this.db.run(
        `
        INSERT INTO conversation_thread_messages (thread_id, channel_id, message_id, ordinal, ts)
        VALUES (?, ?, ?, ?, ?)
        `,
        [input.threadId, message.channel_id, message.message_id, i, message.ts],
      );
    }

    return input.threadId;
  }

  deleteThread(threadId: string): void {
    this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_facets WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_summaries WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_messages WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_threads WHERE thread_id = ?", [threadId]);
  }

  getThread(threadId: string): ConversationThreadRow | null {
    return this.db
      .query("SELECT * FROM conversation_threads WHERE thread_id = ?")
      .get(threadId) as ConversationThreadRow | null;
  }

  getSummary(threadId: string): ConversationThreadSummary | null {
    const row = this.db
      .query("SELECT * FROM conversation_thread_summaries WHERE thread_id = ?")
      .get(threadId) as ConversationThreadSummaryRow | null;
    if (!row) return null;
    return {
      title: row.title,
      brief: row.brief,
      topics: safeStringArrayFromJson(row.topics_json),
      importance: safeImportance(row.importance),
      importanceReasons: safeStringArrayFromJson(row.importance_reasons_json),
    };
  }

  listMessages(threadId: string, offset = 0, limit = 50): ConversationThreadMessage[] {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(
        `
        SELECT
          tm.channel_id,
          tm.message_id,
          tm.ordinal,
          m.user_id,
          m.user_name,
          m.text,
          m.ts
        FROM conversation_thread_messages tm
        JOIN discord_search_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id
        WHERE tm.thread_id = ?
          AND m.deleted = 0
        ORDER BY tm.ordinal ASC
        LIMIT ? OFFSET ?
        `,
      )
      .all(threadId, safeLimit, safeOffset) as Array<{
      channel_id: string;
      message_id: string;
      ordinal: number;
      user_id: string;
      user_name: string | null;
      text: string;
      ts: number;
    }>;

    return rows.map((row) => ({
      channelId: row.channel_id,
      messageId: row.message_id,
      ordinal: row.ordinal,
      userId: row.user_id,
      userName: row.user_name ?? undefined,
      text: row.text,
      ts: row.ts,
    }));
  }

  countThreadMessages(threadId: string): number {
    const row = this.db
      .query(
        `
        SELECT COUNT(1) AS c
        FROM conversation_thread_messages tm
        JOIN discord_search_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id
        WHERE tm.thread_id = ?
          AND m.deleted = 0
        `,
      )
      .get(threadId) as { c: number };
    return typeof row?.c === "number" ? row.c : 0;
  }

  readThread(
    threadId: string,
    offset?: number,
    limit?: number,
  ): ConversationThreadReadResult | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    return {
      thread,
      summary: this.getSummary(threadId),
      messages: this.listMessages(threadId, offset, limit),
      totalMessages: this.countThreadMessages(threadId),
    };
  }

  listEligibleForSummarization(input?: {
    now?: number;
    quietMs?: number;
    threadId?: string;
    beforeTs?: number;
    afterTs?: number;
    includeEmbeddingStale?: boolean;
  }): ConversationThreadRow[] {
    const now = input?.now ?? Date.now();
    const quietMs = input?.quietMs ?? 60 * 60 * 1000;
    const values: Array<string | number> = [now - quietMs];
    const staleClause = input?.includeEmbeddingStale
      ? `(
          t.last_summarized_at IS NULL
          OR t.last_summarized_at < t.updated_at
          OR t.summary_version != ${CONVERSATION_THREAD_SUMMARY_VERSION}
          OR (
            t.last_summarized_at IS NOT NULL
            AND (
              t.last_embedded_at IS NULL
              OR t.last_embedded_at < t.last_summarized_at
              OR t.embedding_version != ${CONVERSATION_THREAD_EMBEDDING_VERSION}
            )
          )
        )`
      : `(
          t.last_summarized_at IS NULL
          OR t.last_summarized_at < t.updated_at
          OR t.summary_version != ${CONVERSATION_THREAD_SUMMARY_VERSION}
        )`;
    const clauses = ["t.updated_at <= ?", staleClause];

    if (input?.threadId) {
      clauses.push("t.thread_id = ?");
      values.push(input.threadId);
    }
    if (input?.beforeTs !== undefined) {
      clauses.push("t.end_ts <= ?");
      values.push(input.beforeTs);
    }
    if (input?.afterTs !== undefined) {
      clauses.push("t.end_ts >= ?");
      values.push(input.afterTs);
    }

    return this.db
      .query(
        `
        SELECT t.*
        FROM conversation_threads t
        WHERE ${clauses.join(" AND ")}
        ORDER BY t.updated_at ASC, t.thread_id ASC
        `,
      )
      .all(...values) as ConversationThreadRow[];
  }

  upsertSummary(
    threadId: string,
    summaryInputHash: string,
    summary: ConversationThreadSummaryInput,
  ): ConversationThreadSummaryWriteResult {
    const normalized = normalizeSummary(summary);
    const now = Date.now();
    const topicsJson = JSON.stringify(normalized.topics);
    const importanceReasonsJson = JSON.stringify(normalized.importanceReasons);
    const embeddingHash = computeSummaryHash(normalized);
    const facets: ConversationThreadFacetInput[] = [
      {
        facet: "combined",
        text: [normalized.title, normalized.brief, normalized.topics.join("\n")].join("\n\n"),
        weight: 1,
      },
      { facet: "brief", text: normalized.brief, weight: 0.8 },
      { facet: "topics", text: normalized.topics.join("\n"), weight: 0.35 },
      { facet: "title", text: normalized.title, weight: 0.15 },
    ];

    const tx = this.db.transaction(() => {
      this.db.run(
        `
        INSERT INTO conversation_thread_summaries (
          thread_id, title, brief, topics_json, importance, importance_reasons_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          title=excluded.title,
          brief=excluded.brief,
          topics_json=excluded.topics_json,
          importance=excluded.importance,
          importance_reasons_json=excluded.importance_reasons_json,
          updated_at=excluded.updated_at
        `,
        [
          threadId,
          normalized.title,
          normalized.brief,
          topicsJson,
          normalized.importance,
          importanceReasonsJson,
          now,
          now,
        ],
      );

      this.db.run("DELETE FROM conversation_thread_facets WHERE thread_id = ?", [threadId]);
      this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [threadId]);
      for (const facet of facets) {
        if (facet.text.trim().length === 0) continue;
        this.db.run(
          `
          INSERT INTO conversation_thread_facets (thread_id, facet, text, weight, updated_at)
          VALUES (?, ?, ?, ?, ?)
          `,
          [threadId, facet.facet, facet.text, facet.weight, now],
        );
      }

      this.db.run(
        `
        UPDATE conversation_threads
        SET last_summarized_at = ?,
            last_embedded_at = NULL,
            summary_input_hash = ?,
            embedding_input_hash = NULL,
            summary_version = ?,
            embedding_version = ?
        WHERE thread_id = ?
        `,
        [
          now,
          summaryInputHash,
          CONVERSATION_THREAD_SUMMARY_VERSION,
          CONVERSATION_THREAD_EMBEDDING_VERSION,
          threadId,
        ],
      );
    });

    tx();
    const filteredFacets = facets.filter((facet) => facet.text.trim().length > 0);
    return {
      facets: filteredFacets,
      embeddingInputHash: computeFacetHash(filteredFacets) || embeddingHash,
    };
  }

  listFacets(threadId: string): ConversationThreadFacetInput[] {
    const rows = this.db
      .query(
        `
        SELECT facet, text, weight
        FROM conversation_thread_facets
        WHERE thread_id = ?
        ORDER BY weight DESC, facet ASC
        `,
      )
      .all(threadId) as FacetRow[];
    return rows.map((row) => ({
      facet: row.facet,
      text: row.text,
      weight: row.weight,
    }));
  }

  computeEmbeddingInputHash(threadId: string): string | null {
    const facets = this.listFacets(threadId);
    return facets.length > 0 ? computeFacetHash(facets) : null;
  }

  upsertEmbeddings(input: {
    threadId: string;
    embeddingInputHash: string;
    modelId: string;
    dimensions: number;
    embeddings: ReadonlyArray<{
      facet: ConversationThreadEmbeddingFacet;
      embedding: Float32Array;
    }>;
  }): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [
        input.threadId,
      ]);
      for (const item of input.embeddings) {
        this.db.run(
          `
          INSERT INTO conversation_thread_embeddings (
            thread_id, facet, model_id, dimensions, embedding, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [input.threadId, item.facet, input.modelId, input.dimensions, item.embedding, now],
        );
      }

      this.db.run(
        `
        UPDATE conversation_threads
        SET last_embedded_at = ?,
            embedding_input_hash = ?,
            embedding_version = ?
        WHERE thread_id = ?
        `,
        [now, input.embeddingInputHash, CONVERSATION_THREAD_EMBEDDING_VERSION, input.threadId],
      );
    });

    tx();
  }

  search(input: {
    query: string;
    limit?: number;
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): ConversationThreadSearchHit[] {
    const ftsQuery = normalizeFtsQuery(input.query);
    if (!ftsQuery) return [];

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 5)));
    const filter = buildSearchFilterClause(input.filters, input.allowlist);
    const rows = this.db
      .query(
        `
        SELECT
          t.*,
          s.title,
          s.brief,
          s.topics_json,
          s.importance,
          s.importance_reasons_json,
          max(fm.facet_score) AS lexical_score
        FROM (
          SELECT
            f.thread_id,
            f.weight AS facet_score
          FROM conversation_thread_facets_fts
          JOIN conversation_thread_facets f ON f.rowid = conversation_thread_facets_fts.rowid
          WHERE conversation_thread_facets_fts MATCH ?
        ) fm
        JOIN conversation_threads t ON t.thread_id = fm.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = t.thread_id
        WHERE ${filter.sql}
        GROUP BY t.thread_id
        ORDER BY lexical_score DESC, t.end_ts DESC
        LIMIT ?
        `,
      )
      .all(ftsQuery, ...filter.values, limit) as ThreadSearchRow[];

    return rows.map((row) => {
      const summarized =
        row.last_summarized_at !== null &&
        row.last_summarized_at >= row.updated_at &&
        row.summary_version === CONVERSATION_THREAD_SUMMARY_VERSION;
      const lexicalScore = row.lexical_score ?? 0;
      return {
        threadId: row.thread_id,
        channelId: row.channel_id,
        guildId: row.guild_id ?? undefined,
        parentChannelId: row.parent_channel_id ?? undefined,
        kind: row.kind,
        title: row.title,
        brief: row.brief,
        topics: safeStringArrayFromJson(row.topics_json),
        importance: safeImportance(row.importance),
        importanceReasons: safeStringArrayFromJson(row.importance_reasons_json),
        startTs: row.start_ts,
        endTs: row.end_ts,
        messageCount: row.message_count,
        score: lexicalScore,
        lexicalScore,
        semanticScore: 0,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        summarized,
        stale: !summarized,
      };
    });
  }

  searchSemantic(input: {
    embedding: Float32Array;
    modelId: string;
    dimensions: number;
    limit?: number;
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): ConversationThreadSearchHit[] {
    if (!this.vectorLoaded) return [];

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 5)));
    const filter = buildSearchFilterClause(input.filters, input.allowlist);
    const rows = this.db
      .query(
        `
        SELECT
          t.*,
          s.title,
          s.brief,
          s.topics_json,
          s.importance,
          s.importance_reasons_json,
          sum(max(0.0, 1.0 - vec_distance_cosine(e.embedding, ?)) * f.weight) AS semantic_score
        FROM conversation_thread_embeddings e
        JOIN conversation_thread_facets f
          ON f.thread_id = e.thread_id
         AND f.facet = e.facet
        JOIN conversation_threads t ON t.thread_id = e.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = t.thread_id
        WHERE e.model_id = ?
          AND e.dimensions = ?
          AND ${filter.sql}
        GROUP BY t.thread_id
        ORDER BY semantic_score DESC, t.end_ts DESC
        LIMIT ?
        `,
      )
      .all(
        input.embedding,
        input.modelId,
        input.dimensions,
        ...filter.values,
        limit,
      ) as ThreadSemanticSearchRow[];

    return rows.map((row) => {
      const summarized =
        row.last_summarized_at !== null &&
        row.last_summarized_at >= row.updated_at &&
        row.summary_version === CONVERSATION_THREAD_SUMMARY_VERSION;
      const semanticScore = row.semantic_score ?? 0;
      return {
        threadId: row.thread_id,
        channelId: row.channel_id,
        guildId: row.guild_id ?? undefined,
        parentChannelId: row.parent_channel_id ?? undefined,
        kind: row.kind,
        title: row.title,
        brief: row.brief,
        topics: safeStringArrayFromJson(row.topics_json),
        importance: safeImportance(row.importance),
        importanceReasons: safeStringArrayFromJson(row.importance_reasons_json),
        startTs: row.start_ts,
        endTs: row.end_ts,
        messageCount: row.message_count,
        score: semanticScore,
        lexicalScore: 0,
        semanticScore,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        summarized,
        stale: !summarized,
      };
    });
  }
}

function buildSearchFilterClause(
  filters?: ConversationThreadSearchFilters,
  allowlist?: ConversationThreadSearchAllowlist,
): {
  sql: string;
  values: Array<string | number>;
} {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  const channelIds = allowlist?.channelIds.filter((id) => id.trim().length > 0) ?? [];
  const guildIds = allowlist?.guildIds.filter((id) => id.trim().length > 0) ?? [];
  if (allowlist) {
    const allowClauses: string[] = [];
    if (channelIds.length > 0) {
      const placeholders = channelIds.map(() => "?").join(", ");
      allowClauses.push(`t.channel_id IN (${placeholders})`);
      allowClauses.push(`t.parent_channel_id IN (${placeholders})`);
      values.push(...channelIds, ...channelIds);
    }
    if (guildIds.length > 0) {
      const placeholders = guildIds.map(() => "?").join(", ");
      allowClauses.push(`t.guild_id IN (${placeholders})`);
      values.push(...guildIds);
    }

    clauses.push(allowClauses.length > 0 ? `(${allowClauses.join(" OR ")})` : "0 = 1");
  }

  if (filters?.sessionId) {
    clauses.push("t.channel_id = ?");
    values.push(filters.sessionId);
  }

  if (filters?.participantId) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM conversation_thread_messages tm
        JOIN discord_search_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id
        WHERE tm.thread_id = t.thread_id
          AND m.deleted = 0
          AND m.user_id = ?
      )
    `);
    values.push(filters.participantId);
  }

  if (filters?.beforeTs !== undefined) {
    clauses.push("t.end_ts <= ?");
    values.push(filters.beforeTs);
  }

  if (filters?.afterTs !== undefined) {
    clauses.push("t.end_ts >= ?");
    values.push(filters.afterTs);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1",
    values,
  };
}

function normalizeFtsQuery(input: string): string | null {
  const tokens = input
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  return tokens.length > 0 ? tokens.join(" ") : null;
}
