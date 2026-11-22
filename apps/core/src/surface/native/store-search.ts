import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import { z } from "zod";
import { CorruptPersistedFields } from "@stanley2058/lilac-utils";
import { NativeStore, nativeStoreTransaction, type NativeStoreResult } from "./store";
import type { NativeThreadRecord } from "./codec";
import { nativeFailure } from "./errors";

const searchRowSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  turnId: z.string(),
  messageId: z.string(),
  text: z.string(),
  authorId: z.string(),
  createdAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  ordinal: z.number().int(),
});
export type NativeSearchMessage = z.infer<typeof searchRowSchema>;
export type NativeSearchInput = {
  query: string;
  threadId?: string;
  limit: number;
  offset?: number;
  authorId?: string;
  afterTs?: number;
  beforeTs?: number;
  direction?: "asc" | "desc";
};

const THREAD_VISIBILITY_SQL =
  "t.deleted = 0 AND t.ephemeral IS NULL AND ((? = 'owner' AND t.thread_kind IS NULL) OR t.starter_id = ? OR (t.thread_kind IS NULL AND EXISTS(SELECT 1 FROM main.native_grants g WHERE g.thread_id = t.thread_id AND g.user_id = ?)))";

const LEGACY_MESSAGE_PROJECTION = `WITH messages AS (
  SELECT t.id AS threadId, json_extract(t.data_json,'$.value.title') AS title,
    json_extract(r.data_json,'$.value.turnId') AS turnId,
    json_extract(m.value,'$.id') AS messageId,
    COALESCE((SELECT group_concat(json_extract(p.value,'$.text'), char(10)) FROM json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='text'), '') AS text,
    COALESCE(json_extract(m.value,'$.metadata.authorId'), CASE json_extract(m.value,'$.role') WHEN 'assistant' THEN 'lilac' ELSE json_extract(t.data_json,'$.value.starterId') END) AS authorId,
    COALESCE(json_extract(m.value,'$.metadata.createdAt'), json_extract(t.data_json,'$.value.createdAt')) AS createdAt,
    row_number() OVER (PARTITION BY t.id ORDER BY r.position, CAST(m.key AS INTEGER)) - 1 AS ordinal
  FROM native_records t JOIN native_records r ON r.thread_id=t.id AND r.kind='turn'
  JOIN json_each(r.data_json,'$.value.messages') m
  WHERE t.kind='thread' AND json_extract(t.data_json,'$.value.deleted')=0 AND json_extract(t.data_json,'$.value.ephemeral') IS NULL
    AND ((?='owner' AND json_extract(t.data_json,'$.value.kind') IS NULL) OR json_extract(t.data_json,'$.value.starterId')=? OR (json_extract(t.data_json,'$.value.kind') IS NULL AND EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=t.id AND g.user_id=?)))
)`;

const AUTHOR_EXPR_SQL =
  "COALESCE(s.author_id, CASE s.role WHEN 'assistant' THEN 'lilac' ELSE t.starter_id END)";

const CREATED_AT_EXPR_SQL = "COALESCE(s.created_at, t.created_at)";

const MESSAGE_TEXT_EXTRACT_SQL =
  "COALESCE((SELECT group_concat(json_extract(p.value,'$.text'), char(10)) FROM json_each(m.value,'$.parts') p WHERE p.type = 'object' AND json_extract(p.value,'$.type')='text'), '')";

function validTurnJsonSql(dataJsonExpr: string): string {
  return `(json_valid(${dataJsonExpr}) AND NOT EXISTS (
    SELECT 1 FROM json_each(${dataJsonExpr}, '$.value.messages') m
    WHERE CASE WHEN m.type != 'object' THEN 1 ELSE EXISTS (
      SELECT 1 FROM json_each(m.value, '$.parts') p WHERE p.type != 'object'
    ) END
  ))`;
}

function quoteFtsTrigram(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function isTrigramEligible(term: string): boolean {
  if (term.includes("\0")) return false;
  return [...term].length >= 3;
}

function threadProjectionInsertSql(params: {
  idExpr: string;
  dataJsonExpr: string;
  fromClause?: string;
  whereClause: string;
}): string {
  const fromPart = params.fromClause ? ` ${params.fromClause}` : "";
  return `INSERT OR REPLACE INTO temp.native_search_threads(
      thread_id, title, deleted, ephemeral, thread_kind, starter_id, created_at
    )
    SELECT
      ${params.idExpr},
      json_extract(${params.dataJsonExpr}, '$.value.title'),
      json_extract(${params.dataJsonExpr}, '$.value.deleted'),
      json_extract(${params.dataJsonExpr}, '$.value.ephemeral'),
      json_extract(${params.dataJsonExpr}, '$.value.kind'),
      json_extract(${params.dataJsonExpr}, '$.value.starterId'),
      json_extract(${params.dataJsonExpr}, '$.value.createdAt')${fromPart}
    WHERE ${params.whereClause}`;
}

function turnProjectionInsertSql(params: {
  idExpr: string;
  threadIdExpr: string;
  positionExpr: string;
  dataJsonExpr: string;
  fromClause: string;
  whereClause?: string;
}): string {
  const wherePart = params.whereClause ? ` WHERE ${params.whereClause}` : "";
  return `INSERT INTO temp.native_search_messages(
      record_id, thread_id, turn_id, turn_position, msg_index, message_id, text, author_id, role, created_at
    )
    SELECT
      ${params.idExpr},
      ${params.threadIdExpr},
      json_extract(${params.dataJsonExpr}, '$.value.turnId'),
      ${params.positionExpr},
      CAST(m.key AS INTEGER),
      json_extract(m.value, '$.id'),
      ${MESSAGE_TEXT_EXTRACT_SQL},
      json_extract(m.value, '$.metadata.authorId'),
      json_extract(m.value, '$.role'),
      json_extract(m.value, '$.metadata.createdAt')
    ${params.fromClause}${wherePart}`;
}

function dropSearchIndexTriggers(db: Database): void {
  db.run(`
    DROP TRIGGER IF EXISTS temp.native_search_messages_ai;
    DROP TRIGGER IF EXISTS temp.native_search_messages_ad;
    DROP TRIGGER IF EXISTS temp.native_search_messages_au;
    DROP TRIGGER IF EXISTS temp.native_search_thread_ai;
    DROP TRIGGER IF EXISTS temp.native_search_thread_au;
    DROP TRIGGER IF EXISTS temp.native_search_thread_ad;
    DROP TRIGGER IF EXISTS temp.native_search_turn_ai;
    DROP TRIGGER IF EXISTS temp.native_search_turn_au;
    DROP TRIGGER IF EXISTS temp.native_search_turn_ad;
  `);
}

function createSearchIndexTriggers(db: Database): void {
  const threadInsertValid = threadProjectionInsertSql({
    idExpr: "new.id",
    dataJsonExpr: "new.data_json",
    whereClause: "new.kind = 'thread' AND json_valid(new.data_json)",
  });
  const newTurnValid = validTurnJsonSql("new.data_json");
  const turnInsertValid = turnProjectionInsertSql({
    idExpr: "r.id",
    threadIdExpr: "r.thread_id",
    positionExpr: "r.position",
    dataJsonExpr: "r.data_json",
    fromClause: `FROM (
      SELECT new.id AS id, new.thread_id AS thread_id, new.position AS position, new.data_json AS data_json
      WHERE new.kind = 'turn' AND new.thread_id IS NOT NULL AND ${newTurnValid}
    ) r
    JOIN json_each(r.data_json, '$.value.messages') m`,
    whereClause: "m.type = 'object'",
  });

  db.run(`
    CREATE TEMP TRIGGER IF NOT EXISTS native_search_messages_ai
    AFTER INSERT ON temp.native_search_messages
    BEGIN
      INSERT INTO temp.native_search_messages_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_messages_ad
    AFTER DELETE ON temp.native_search_messages
    BEGIN
      INSERT INTO temp.native_search_messages_fts(native_search_messages_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_messages_au
    AFTER UPDATE OF text ON temp.native_search_messages
    BEGIN
      INSERT INTO temp.native_search_messages_fts(native_search_messages_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
      INSERT INTO temp.native_search_messages_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_thread_ai
    AFTER INSERT ON main.native_records WHEN new.kind = 'thread'
    BEGIN
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'thread' AND record_id = new.id;
      ${threadInsertValid};
      INSERT OR REPLACE INTO temp.native_search_invalid_records(kind, record_id, thread_id)
      SELECT 'thread', new.id, new.thread_id WHERE NOT json_valid(new.data_json);
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_thread_au
    AFTER UPDATE ON main.native_records WHEN old.kind = 'thread' OR new.kind = 'thread'
    BEGIN
      DELETE FROM temp.native_search_threads WHERE thread_id = old.id;
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'thread' AND record_id = old.id;
      ${threadInsertValid};
      INSERT OR REPLACE INTO temp.native_search_invalid_records(kind, record_id, thread_id)
      SELECT 'thread', new.id, new.thread_id WHERE new.kind = 'thread' AND NOT json_valid(new.data_json);
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_thread_ad
    AFTER DELETE ON main.native_records WHEN old.kind = 'thread'
    BEGIN
      DELETE FROM temp.native_search_threads WHERE thread_id = old.id;
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'thread' AND record_id = old.id;
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_turn_ai
    AFTER INSERT ON main.native_records WHEN new.kind = 'turn'
    BEGIN
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'turn' AND record_id = new.id;
      ${turnInsertValid};
      INSERT OR REPLACE INTO temp.native_search_invalid_records(kind, record_id, thread_id)
      SELECT 'turn', new.id, new.thread_id WHERE new.thread_id IS NOT NULL AND NOT ${newTurnValid};
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_turn_au
    AFTER UPDATE ON main.native_records WHEN old.kind = 'turn' OR new.kind = 'turn'
    BEGIN
      DELETE FROM temp.native_search_messages WHERE record_id = old.id;
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'turn' AND record_id = old.id;
      ${turnInsertValid};
      INSERT OR REPLACE INTO temp.native_search_invalid_records(kind, record_id, thread_id)
      SELECT 'turn', new.id, new.thread_id WHERE new.kind = 'turn' AND new.thread_id IS NOT NULL AND NOT ${newTurnValid};
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS native_search_turn_ad
    AFTER DELETE ON main.native_records WHEN old.kind = 'turn'
    BEGIN
      DELETE FROM temp.native_search_messages WHERE record_id = old.id;
      DELETE FROM temp.native_search_invalid_records WHERE kind = 'turn' AND record_id = old.id;
    END;
  `);
}

function rebuildSearchIndex(db: Database, dataVersion: number): void {
  dropSearchIndexTriggers(db);
  const threadBackfill = threadProjectionInsertSql({
    idExpr: "id",
    dataJsonExpr: "data_json",
    fromClause: "FROM main.native_records",
    whereClause: "kind = 'thread' AND json_valid(data_json)",
  });
  const rowTurnValid = validTurnJsonSql("data_json");
  const turnBackfill = turnProjectionInsertSql({
    idExpr: "r.id",
    threadIdExpr: "r.thread_id",
    positionExpr: "r.position",
    dataJsonExpr: "r.data_json",
    fromClause: `FROM (
      SELECT id, thread_id, position, data_json
      FROM main.native_records
      WHERE kind = 'turn' AND thread_id IS NOT NULL AND ${rowTurnValid}
    ) r
    JOIN json_each(r.data_json, '$.value.messages') m`,
    whereClause: "m.type = 'object'",
  });

  db.run(`
    CREATE TEMP TABLE IF NOT EXISTS native_search_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      data_version INTEGER NOT NULL
    );
    CREATE TEMP TABLE IF NOT EXISTS native_search_invalid_records (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      thread_id TEXT,
      PRIMARY KEY(kind, record_id)
    );
    CREATE TEMP TABLE IF NOT EXISTS native_search_threads (
      thread_id TEXT PRIMARY KEY,
      title,
      deleted,
      ephemeral,
      thread_kind,
      starter_id,
      created_at
    );
    CREATE TEMP TABLE IF NOT EXISTS native_search_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id,
      turn_position INTEGER NOT NULL,
      msg_index INTEGER NOT NULL,
      message_id,
      text TEXT NOT NULL,
      author_id,
      role,
      created_at
    );
    CREATE INDEX IF NOT EXISTS temp.idx_native_search_messages_thread_ord
      ON native_search_messages(thread_id, turn_position ASC, msg_index ASC);
    CREATE INDEX IF NOT EXISTS temp.idx_native_search_messages_thread_msg
      ON native_search_messages(thread_id, message_id, turn_id);
    CREATE INDEX IF NOT EXISTS temp.idx_native_search_messages_record
      ON native_search_messages(record_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.native_search_messages_fts
      USING fts5(text, content='native_search_messages', content_rowid='id', tokenize='trigram');

    DELETE FROM temp.native_search_invalid_records;
    DELETE FROM temp.native_search_threads;
    DELETE FROM temp.native_search_messages;

    INSERT INTO temp.native_search_invalid_records(kind, record_id, thread_id)
    SELECT kind, id, thread_id
    FROM main.native_records
    WHERE (kind = 'thread' AND NOT json_valid(data_json))
       OR (kind = 'turn' AND thread_id IS NOT NULL AND NOT ${rowTurnValid});

    ${threadBackfill};
    ${turnBackfill};

    INSERT INTO temp.native_search_messages_fts(native_search_messages_fts) VALUES ('rebuild');
  `);
  createSearchIndexTriggers(db);
  db.query("INSERT OR REPLACE INTO temp.native_search_meta(id, data_version) VALUES (1, ?)").run(
    dataVersion,
  );
}

function selectSearchCandidateSource(params: {
  db: Database;
  userRole: string;
  userId: string;
  threadId?: string;
  trigramTerms: readonly string[];
}): {
  cteParts: string[];
  fromSql: string;
  extraWhereSql?: string;
  values: (string | number)[];
} {
  if (params.trigramTerms.length === 0) {
    return {
      cteParts: [],
      fromSql: "FROM temp.native_search_messages s",
      values: [],
    };
  }

  const threadIdClause = params.threadId ? " AND t.thread_id = ?" : "";
  const titleCountQuery = params.db.query<{ count: number }, (string | number)[]>(
    `SELECT COUNT(*) AS count
     FROM temp.native_search_threads t
     WHERE ${THREAD_VISIBILITY_SQL}${threadIdClause}
       AND instr(lower(t.title), lower(?)) > 0`,
  );

  const textOnlyTerms: string[] = [];
  let bestTitleFallback: { term: string; count: number } | undefined;

  for (const term of params.trigramTerms) {
    const queryValues: (string | number)[] = [params.userRole, params.userId, params.userId];
    if (params.threadId) queryValues.push(params.threadId);
    queryValues.push(term);
    const count = titleCountQuery.get(...queryValues)?.count ?? 0;
    if (count === 0) {
      textOnlyTerms.push(term);
      continue;
    }
    if (
      !bestTitleFallback ||
      count < bestTitleFallback.count ||
      (count === bestTitleFallback.count && term.length > bestTitleFallback.term.length)
    ) {
      bestTitleFallback = { term, count };
    }
  }

  if (textOnlyTerms.length > 0) {
    return {
      cteParts: [],
      fromSql:
        "FROM temp.native_search_messages_fts JOIN temp.native_search_messages s ON s.id = native_search_messages_fts.rowid",
      extraWhereSql: "native_search_messages_fts MATCH ?",
      values: [textOnlyTerms.map(quoteFtsTrigram).join(" ")],
    };
  }

  const chosen = bestTitleFallback!;
  const values: (string | number)[] = [
    quoteFtsTrigram(chosen.term),
    params.userRole,
    params.userId,
    params.userId,
  ];
  if (params.threadId) values.push(params.threadId);
  values.push(chosen.term);

  return {
    cteParts: [
      `candidate_ids(id) AS (
        SELECT rowid FROM temp.native_search_messages_fts WHERE native_search_messages_fts MATCH ?
        UNION
        SELECT s.id
        FROM temp.native_search_messages s
        JOIN temp.native_search_threads t ON t.thread_id = s.thread_id
        WHERE ${THREAD_VISIBILITY_SQL}${threadIdClause}
          AND instr(lower(t.title), lower(?)) > 0
      )`,
    ],
    fromSql: "FROM candidate_ids c JOIN temp.native_search_messages s ON s.id = c.id",
    values,
  };
}

function hasVisibleInvalidRecords(params: {
  db: Database;
  userRole: string;
  userId: string;
  threadId?: string;
}): boolean {
  const anyInvalid = params.db
    .query("SELECT 1 FROM temp.native_search_invalid_records LIMIT 1")
    .get();
  if (!anyInvalid) return false;

  if (params.threadId) {
    return (
      params.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
           FROM temp.native_search_invalid_records
           WHERE thread_id = ? OR (kind = 'thread' AND record_id = ?)
           LIMIT 1`,
        )
        .get(params.threadId, params.threadId) !== null
    );
  }

  return (
    params.db
      .query<{ found: number }, [string, string, string]>(
        `SELECT 1 AS found
         FROM temp.native_search_invalid_records inv
         WHERE inv.kind = 'thread'
            OR (inv.kind = 'turn' AND EXISTS (
              SELECT 1 FROM temp.native_search_threads t
              WHERE t.thread_id = inv.thread_id AND ${THREAD_VISIBILITY_SQL}
            ))
         LIMIT 1`,
      )
      .get(params.userRole, params.userId, params.userId) !== null
  );
}

function decodeSearchRows(rows: unknown[]): NativeStoreResult<NativeSearchMessage[]> {
  const parsed = z.array(searchRowSchema).safeParse(rows);
  if (!parsed.success)
    return Result.err(
      new CorruptPersistedFields({
        table: "native_records",
        field: "data_json",
        recordId: "search",
        version: 1,
        issueCode: "invalid-row-field",
        message: "Native search projection is invalid",
      }),
    );
  return Result.ok(parsed.data);
}

function decodeSearchCount(row: unknown): NativeStoreResult<{
  total: number;
  startMessageId: string | null;
  endMessageId: string | null;
}> {
  const parsed = z
    .object({
      total: z.number().int().nonnegative(),
      startMessageId: z.string().nullable(),
      endMessageId: z.string().nullable(),
    })
    .safeParse(row);
  if (!parsed.success)
    return Result.err(nativeFailure("sqlite", "Could not count thread messages"));
  return Result.ok(parsed.data);
}

export class NativeSearchStore {
  constructor(private readonly params: { db: Database; store: NativeStore }) {}

  private ensureSearchIndex(): void {
    const currentDataVersion =
      this.params.db.query<{ data_version: number }, []>("PRAGMA data_version").get()
        ?.data_version ?? 0;

    const metaExists =
      this.params.db
        .query(
          "SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'native_search_meta'",
        )
        .get() !== null;
    if (metaExists) {
      const storedVersion = this.params.db
        .query<{ data_version: number }, []>(
          "SELECT data_version FROM temp.native_search_meta WHERE id = 1",
        )
        .get()?.data_version;
      if (storedVersion === currentDataVersion) return;
    }

    rebuildSearchIndex(this.params.db, currentDataVersion);
  }

  private searchMessagesLegacy(params: {
    userRole: string;
    userId: string;
    terms: readonly string[];
    input: NativeSearchInput;
  }): NativeStoreResult<NativeSearchMessage[]> {
    const filters: string[] = [];
    const values: (string | number)[] = [params.userRole, params.userId, params.userId];
    for (const term of params.terms) {
      filters.push("(instr(lower(text),lower(?))>0 OR instr(lower(title),lower(?))>0)");
      values.push(term, term);
    }
    if (params.input.threadId) {
      filters.push("threadId=?");
      values.push(params.input.threadId);
    }
    if (params.input.authorId) {
      filters.push("authorId=?");
      values.push(params.input.authorId);
    }
    if (params.input.afterTs !== undefined) {
      filters.push("createdAt>=?");
      values.push(params.input.afterTs);
    }
    if (params.input.beforeTs !== undefined) {
      filters.push("createdAt<=?");
      values.push(params.input.beforeTs);
    }
    values.push(
      Math.min(500, Math.max(1, params.input.limit)),
      Math.max(0, params.input.offset ?? 0),
    );
    return decodeSearchRows(
      this.params.db
        .query(
          `${LEGACY_MESSAGE_PROJECTION} SELECT * FROM messages WHERE ${filters.join(" AND ")} ORDER BY createdAt ${params.input.direction === "asc" ? "ASC" : "DESC"}, threadId, ordinal DESC LIMIT ? OFFSET ?`,
        )
        .all(...values),
    );
  }

  private readThreadAround(params: {
    threadId: string;
    around: { turnId: string; messageId: string; ordinal: number; surrounding: number };
  }): NativeStoreResult<NativeSearchMessage[]> {
    const anchor = this.params.db
      .query<{ turn_position: number; msg_index: number }, [string, string, string]>(
        `SELECT turn_position, msg_index
         FROM temp.native_search_messages
         WHERE thread_id = ? AND message_id = ? AND turn_id = ?
         LIMIT 1`,
      )
      .get(params.threadId, params.around.messageId, params.around.turnId);
    if (!anchor) return Result.ok([]);

    const surrounding = Math.min(20, Math.max(0, Math.floor(params.around.surrounding)));
    const rows = this.params.db
      .query(
        `WITH before_rows AS (
          SELECT
            s.thread_id AS threadId,
            t.title AS title,
            s.turn_id AS turnId,
            s.message_id AS messageId,
            s.text AS text,
            ${AUTHOR_EXPR_SQL} AS authorId,
            ${CREATED_AT_EXPR_SQL} AS createdAt,
            s.turn_position,
            s.msg_index
          FROM temp.native_search_messages s
          JOIN temp.native_search_threads t ON t.thread_id = s.thread_id
          WHERE s.thread_id = ?
            AND (s.turn_position, s.msg_index) < (?, ?)
          ORDER BY s.turn_position DESC, s.msg_index DESC
          LIMIT ?
        ),
        after_rows AS (
          SELECT
            s.thread_id AS threadId,
            t.title AS title,
            s.turn_id AS turnId,
            s.message_id AS messageId,
            s.text AS text,
            ${AUTHOR_EXPR_SQL} AS authorId,
            ${CREATED_AT_EXPR_SQL} AS createdAt,
            s.turn_position,
            s.msg_index
          FROM temp.native_search_messages s
          JOIN temp.native_search_threads t ON t.thread_id = s.thread_id
          WHERE s.thread_id = ?
            AND (s.turn_position, s.msg_index) >= (?, ?)
          ORDER BY s.turn_position ASC, s.msg_index ASC
          LIMIT (? - (SELECT COUNT(*) FROM before_rows))
        ),
        win AS (
          SELECT * FROM before_rows
          UNION ALL
          SELECT * FROM after_rows
        )
        SELECT
          win.threadId,
          win.title,
          win.turnId,
          win.messageId,
          win.text,
          win.authorId,
          win.createdAt,
          MAX(0, ? - (SELECT COUNT(*) FROM before_rows)) + row_number() OVER (ORDER BY win.turn_position ASC, win.msg_index ASC) - 1 AS ordinal
        FROM win
        ORDER BY win.turn_position ASC, win.msg_index ASC`,
      )
      .all(
        params.threadId,
        anchor.turn_position,
        anchor.msg_index,
        surrounding,
        params.threadId,
        anchor.turn_position,
        anchor.msg_index,
        surrounding * 2 + 1,
        params.around.ordinal,
      );
    return decodeSearchRows(rows);
  }

  private readThreadLegacy(params: {
    thread: NativeThreadRecord;
    userRole: string;
    userId: string;
    threadId: string;
    offset?: number;
    limit?: number;
  }): NativeStoreResult<{
    thread: NativeThreadRecord;
    messages: NativeSearchMessage[];
    total: number;
    startMessageId: string | null;
    endMessageId: string | null;
  }> {
    return Result.gen(function* () {
      const args = [params.userRole, params.userId, params.userId, params.threadId];
      const messages = yield* decodeSearchRows(
        this.params.db
          .query(
            `${LEGACY_MESSAGE_PROJECTION} SELECT * FROM messages WHERE threadId=? ORDER BY ordinal LIMIT ? OFFSET ?`,
          )
          .all(
            ...args,
            Math.min(200, Math.max(1, params.limit ?? 50)),
            Math.max(0, params.offset ?? 0),
          ),
      );
      const bounds = yield* decodeSearchCount(
        this.params.db
          .query(
            `${LEGACY_MESSAGE_PROJECTION} SELECT count(*) AS total, (SELECT messageId FROM messages WHERE threadId=? ORDER BY ordinal LIMIT 1) AS startMessageId, (SELECT messageId FROM messages WHERE threadId=? ORDER BY ordinal DESC LIMIT 1) AS endMessageId FROM messages WHERE threadId=?`,
          )
          .get(...args.slice(0, 3), params.threadId, params.threadId, params.threadId),
      );
      return Result.ok({ thread: params.thread, messages, ...bounds });
    }, this);
  }

  searchMessages(
    userId: string,
    input: NativeSearchInput,
  ): NativeStoreResult<NativeSearchMessage[]> {
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const user = yield* this.params.store.getUser(userId);
        if (user.role === "service")
          return Result.err(
            nativeFailure("forbidden", "Service users cannot browse conversations"),
          );
        if (input.threadId) yield* this.params.store.authorizeThread(userId, input.threadId);
        const terms = input.query.trim().split(/\s+/u).filter(Boolean).slice(0, 32);
        if (terms.length === 0)
          return Result.err(nativeFailure("invalid", "Search query is required"));

        this.ensureSearchIndex();
        if (
          hasVisibleInvalidRecords({
            db: this.params.db,
            userRole: user.role,
            userId: user.id,
            threadId: input.threadId,
          })
        ) {
          return this.searchMessagesLegacy({ userRole: user.role, userId: user.id, terms, input });
        }

        const trigramTerms = terms.filter(isTrigramEligible);
        const source = selectSearchCandidateSource({
          db: this.params.db,
          userRole: user.role,
          userId: user.id,
          threadId: input.threadId,
          trigramTerms,
        });

        const filters: string[] = [];
        const values: (string | number)[] = [...source.values];
        if (source.extraWhereSql) filters.push(source.extraWhereSql);
        filters.push(THREAD_VISIBILITY_SQL);
        values.push(user.role, user.id, user.id);

        if (input.threadId) {
          filters.push("s.thread_id = ?");
          values.push(input.threadId);
        }
        if (input.authorId) {
          filters.push(`${AUTHOR_EXPR_SQL} = ?`);
          values.push(input.authorId);
        }
        if (input.afterTs !== undefined) {
          filters.push(`${CREATED_AT_EXPR_SQL} >= ?`);
          values.push(input.afterTs);
        }
        if (input.beforeTs !== undefined) {
          filters.push(`${CREATED_AT_EXPR_SQL} <= ?`);
          values.push(input.beforeTs);
        }
        for (const term of terms) {
          filters.push("(instr(lower(s.text),lower(?))>0 OR instr(lower(t.title),lower(?))>0)");
          values.push(term, term);
        }
        values.push(Math.min(500, Math.max(1, input.limit)), Math.max(0, input.offset ?? 0));

        const directionSql = input.direction === "asc" ? "ASC" : "DESC";
        const cteSections = [
          ...source.cteParts,
          `matched AS (
            SELECT
              s.id AS rowId,
              s.thread_id AS threadId,
              t.title AS title,
              s.turn_id AS turnId,
              s.message_id AS messageId,
              s.text AS text,
              ${AUTHOR_EXPR_SQL} AS authorId,
              ${CREATED_AT_EXPR_SQL} AS createdAt,
              s.turn_position,
              s.msg_index
            ${source.fromSql}
            JOIN temp.native_search_threads t ON t.thread_id = s.thread_id
            WHERE ${filters.join(" AND ")}
            ORDER BY createdAt ${directionSql}, threadId, s.turn_position DESC, s.msg_index DESC
            LIMIT ? OFFSET ?
          )`,
          `thread_ordinals AS (
            SELECT
              id,
              row_number() OVER (PARTITION BY thread_id ORDER BY turn_position ASC, msg_index ASC) - 1 AS ordinal
            FROM temp.native_search_messages
            WHERE thread_id IN (SELECT DISTINCT threadId FROM matched)
          )`,
        ];
        const rows = this.params.db
          .query(
            `WITH ${cteSections.join(", ")}
            SELECT
              matched.threadId,
              matched.title,
              matched.turnId,
              matched.messageId,
              matched.text,
              matched.authorId,
              matched.createdAt,
              thread_ordinals.ordinal AS ordinal
            FROM matched
            JOIN thread_ordinals ON thread_ordinals.id = matched.rowId
            ORDER BY matched.createdAt ${directionSql}, matched.threadId, matched.turn_position DESC, matched.msg_index DESC`,
          )
          .all(...values);
        return decodeSearchRows(rows);
      }, this),
    );
  }

  readThread(
    userId: string,
    threadId: string,
    input: {
      offset?: number;
      limit?: number;
      around?: { turnId: string; messageId: string; ordinal: number; surrounding: number };
      skipBounds?: boolean;
    } = {},
  ): NativeStoreResult<{
    thread: NativeThreadRecord;
    messages: NativeSearchMessage[];
    total: number;
    startMessageId: string | null;
    endMessageId: string | null;
  }> {
    return nativeStoreTransaction(this.params.db, () =>
      Result.gen(function* () {
        const thread = yield* this.params.store.authorizeThread(userId, threadId);
        const user = yield* this.params.store.getUser(userId);
        this.ensureSearchIndex();

        if (
          hasVisibleInvalidRecords({
            db: this.params.db,
            userRole: user.role,
            userId: user.id,
            threadId,
          })
        ) {
          return this.readThreadLegacy({
            thread,
            userRole: user.role,
            userId: user.id,
            threadId,
            offset: input.offset,
            limit: input.limit,
          });
        }

        const visibleThread = this.params.db
          .query<{ found: number }, [string, string, string, string]>(
            `SELECT 1 AS found FROM temp.native_search_threads t WHERE t.thread_id = ? AND ${THREAD_VISIBILITY_SQL} LIMIT 1`,
          )
          .get(threadId, user.role, user.id, user.id);

        if (!visibleThread) {
          return Result.ok({
            thread,
            messages: [],
            total: 0,
            startMessageId: null,
            endMessageId: null,
          });
        }

        const messages = input.around
          ? yield* this.readThreadAround({ threadId, around: input.around })
          : yield* decodeSearchRows(
              this.params.db
                .query(
                  `SELECT
                    page.threadId,
                    page.title,
                    page.turnId,
                    page.messageId,
                    page.text,
                    page.authorId,
                    page.createdAt,
                    ? + row_number() OVER () - 1 AS ordinal
                  FROM (
                    SELECT
                      s.thread_id AS threadId,
                      t.title AS title,
                      s.turn_id AS turnId,
                      s.message_id AS messageId,
                      s.text AS text,
                      ${AUTHOR_EXPR_SQL} AS authorId,
                      ${CREATED_AT_EXPR_SQL} AS createdAt
                    FROM temp.native_search_messages s
                    JOIN temp.native_search_threads t ON t.thread_id = s.thread_id
                    WHERE s.thread_id = ?
                    ORDER BY s.turn_position ASC, s.msg_index ASC
                    LIMIT ? OFFSET ?
                  ) page`,
                )
                .all(
                  Math.max(0, input.offset ?? 0),
                  threadId,
                  Math.min(200, Math.max(1, input.limit ?? 50)),
                  Math.max(0, input.offset ?? 0),
                ),
            );

        if (input.skipBounds) {
          return Result.ok({
            thread,
            messages,
            total: 0,
            startMessageId: null,
            endMessageId: null,
          });
        }

        const bounds = yield* decodeSearchCount(
          this.params.db
            .query(
              `SELECT
                (SELECT COUNT(*) FROM temp.native_search_messages WHERE thread_id = ?) AS total,
                (SELECT message_id FROM temp.native_search_messages WHERE thread_id = ? ORDER BY turn_position ASC, msg_index ASC LIMIT 1) AS startMessageId,
                (SELECT message_id FROM temp.native_search_messages WHERE thread_id = ? ORDER BY turn_position DESC, msg_index DESC LIMIT 1) AS endMessageId`,
            )
            .get(threadId, threadId, threadId),
        );
        return Result.ok({ thread, messages, ...bounds });
      }, this),
    );
  }
}
