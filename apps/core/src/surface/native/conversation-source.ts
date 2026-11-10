import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import { z } from "zod";
import { CorruptPersistedFields, type PersistedDataError } from "@stanley2058/lilac-utils";
import { DEFAULT_DM_CONTEXT_GAP_MS } from "@stanley2058/lilac-client-protocol";
import { decodeNativeRecord, type NativePersistedRow } from "./codec";
import { TURN_CREATED_AT, turnCompletedAtSql } from "./turn-timing";

export function installNativeConversationSource(db: Database, databasePath?: string): void {
  if (databasePath) db.run("ATTACH DATABASE ? AS native_conversation", [databasePath]);
  db.run("DROP VIEW IF EXISTS temp.native_conversation_threads");
  db.run("DROP VIEW IF EXISTS temp.native_conversation_messages");
  db.run("DROP VIEW IF EXISTS temp.native_conversation_turns");
  if (!databasePath) {
    db.run(`CREATE TEMP VIEW native_conversation_threads AS SELECT
      '' AS id, '' AS revision, 0 AS updated_at, 0 AS active, 0 AS dm WHERE 0`);
    db.run(`CREATE TEMP VIEW native_conversation_messages AS SELECT
      '' AS channel_id, '' AS message_id, '' AS user_id, '' AS user_name,
      '' AS text, 0 AS ts, 0 AS ordinal, 0 AS turn_position WHERE 0`);
    return;
  }
  db.run(`CREATE TEMP VIEW native_conversation_threads AS SELECT
    t.id, json_extract(t.data_json,'$.value.historyGeneration') || ':' ||
      COALESCE((SELECT group_concat(messages,char(0)) FROM
        (SELECT json_extract(r.data_json,'$.value.messages') AS messages
          FROM native_conversation.native_records r WHERE r.kind='turn' AND r.thread_id=t.id ORDER BY r.position)), '') AS revision,
    COALESCE((SELECT MAX(r.updated_at) FROM native_conversation.native_records r
      WHERE r.kind='turn' AND r.thread_id=t.id),t.updated_at) AS updated_at,
    json_extract(t.data_json,'$.value.activeRunId') IS NOT NULL AS active,
    COALESCE(json_extract(t.data_json,'$.value.kind')='dm',0) AS dm
    FROM native_conversation.native_records t
    WHERE t.kind='thread' AND json_extract(t.data_json,'$.value.deleted')=0
      AND json_extract(t.data_json,'$.value.ephemeral') IS NULL
      AND json_extract(t.data_json,'$.value.mutationPending')=0`);
  db.run(`CREATE TEMP VIEW native_conversation_messages AS SELECT
    t.id AS channel_id, json_extract(m.value,'$.id') AS message_id,
    COALESCE(json_extract(m.value,'$.metadata.authorId'),
      CASE json_extract(m.value,'$.role') WHEN 'assistant' THEN 'lilac'
      ELSE json_extract(t.data_json,'$.value.starterId') END) AS user_id,
    COALESCE((SELECT json_extract(u.data_json,'$.value.displayName')
      FROM native_conversation.native_records u WHERE u.kind='user' AND u.id=
      COALESCE(json_extract(m.value,'$.metadata.authorId'),
        CASE json_extract(m.value,'$.role') WHEN 'assistant' THEN 'lilac'
        ELSE json_extract(t.data_json,'$.value.starterId') END)),
      json_extract(m.value,'$.role')) AS user_name,
    COALESCE((SELECT group_concat(CASE json_extract(p.value,'$.type')
      WHEN 'text' THEN json_extract(p.value,'$.text')
      WHEN 'data-resource' THEN '[Attachment: ' || COALESCE(json_extract(p.value,'$.data.name'),'file') || ']'
      END, char(10)) FROM json_each(m.value,'$.parts') p), '') AS text,
    COALESCE(json_extract(m.value,'$.metadata.createdAt'),r.updated_at) AS ts,
    row_number() OVER (PARTITION BY t.id ORDER BY r.position,CAST(m.key AS INTEGER))-1 AS ordinal,
    r.position AS turn_position
    FROM native_conversation.native_records t
    JOIN native_conversation_threads visible ON visible.id=t.id
    JOIN native_conversation.native_records r ON r.kind='turn' AND r.thread_id=t.id
    JOIN json_each(r.data_json,'$.value.messages') m
    WHERE t.kind='thread'`);
  db.run(`CREATE TEMP VIEW native_conversation_turns AS SELECT
    t.thread_id AS channel_id, t.position,
    ${TURN_CREATED_AT} AS created_at,
    ${turnCompletedAtSql("native_conversation.native_records")} AS completed_at
    FROM native_conversation.native_records t WHERE t.kind='turn'`);
}

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const nativeThreadProjectionSchema = z.array(
  z.object({
    id: z.string().min(1),
    revision: z.string(),
    updated_at: timestamp,
    dm: z.union([z.literal(0), z.literal(1)]),
  }),
);
const nativeMessageProjectionSchema = z.array(
  z.object({
    channel_id: z.string().min(1),
    message_id: z.string().min(1),
    user_id: z.string().min(1),
    user_name: z.string().nullable(),
    text: z.string(),
    ts: timestamp,
    ordinal: z.number().int().nonnegative(),
    turn_position: z.number().int().nonnegative(),
  }),
);
const nativeTurnTimingProjectionSchema = z.array(
  z.object({
    position: z.number().int().nonnegative(),
    created_at: timestamp.nullable(),
    completed_at: timestamp.nullable(),
  }),
);
const nativeAttachmentProjectionSchema = z.array(
  z.object({
    id: z.string().min(1),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
  }),
);
function projectionFailure() {
  return new CorruptPersistedFields({
    table: "native_records",
    field: "data_json",
    recordId: "conversation-memory",
    version: 1,
    issueCode: "invalid-row-field",
    message: "Native conversation projection is invalid",
  });
}
export function decodeNativeThreadProjection(rows: unknown) {
  const parsed = nativeThreadProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function decodeNativeMessageProjection(rows: unknown) {
  const parsed = nativeMessageProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function decodeNativeTurnTimingProjection(rows: unknown) {
  const parsed = nativeTurnTimingProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function decodeNativeAttachmentProjection(rows: unknown) {
  const parsed = nativeAttachmentProjectionSchema.safeParse(rows);
  return parsed.success ? Result.ok(parsed.data) : Result.err(projectionFailure());
}
export function readNativeConversationThreads(db: Database) {
  return Result.gen(function* () {
    const rows = db
      .query<NativePersistedRow, []>(
        "SELECT format_version,data_json FROM native_conversation.native_records WHERE kind='thread'",
      )
      .all();
    yield* Result.all(rows.map((row) => decodeNativeRecord(row)));
    return decodeNativeThreadProjection(
      db.query("SELECT id,revision,updated_at,dm FROM native_conversation_threads").all(),
    );
  });
}
/** Timing of every turn, including turns without messages, for the DM context-window rule. */
export function readNativeConversationTurnTimings(db: Database, threadId: string) {
  return decodeNativeTurnTimingProjection(
    db
      .query(
        "SELECT position,created_at,completed_at FROM native_conversation_turns WHERE channel_id=? ORDER BY position",
      )
      .all(threadId),
  );
}
export function readNativeDmContextGapMs(db: Database): Result<number, PersistedDataError> {
  const row = db
    .query<NativePersistedRow, []>(
      "SELECT format_version,data_json FROM native_conversation.native_records WHERE kind='deployment' AND id='instance'",
    )
    .get();
  if (!row) return Result.ok(DEFAULT_DM_CONTEXT_GAP_MS);
  return decodeNativeRecord(row).map(({ value }) =>
    value.kind === "deployment" ? value.value.settings.dmContextGapMs : DEFAULT_DM_CONTEXT_GAP_MS,
  );
}
export function readNativeConversationMessages(db: Database, threadId: string) {
  return Result.gen(function* () {
    const rows = db
      .query<NativePersistedRow, [string]>(
        "SELECT format_version,data_json FROM native_conversation.native_records WHERE kind='turn' AND thread_id=?",
      )
      .all(threadId);
    yield* Result.all(rows.map((row) => decodeNativeRecord(row)));
    return decodeNativeMessageProjection(
      db
        .query("SELECT * FROM native_conversation_messages WHERE channel_id=? ORDER BY ordinal")
        .all(threadId),
    );
  });
}
export function readNativeConversationAttachments(
  db: Database,
  channelId: string,
  messageId: string,
): Result<z.infer<typeof nativeAttachmentProjectionSchema>, PersistedDataError> {
  return decodeNativeAttachmentProjection(
    db
      .query(`SELECT
    json_extract(p.value,'$.data.resourceId') AS id,
    json_extract(p.value,'$.data.name') AS filename,
    json_extract(p.value,'$.data.mediaType') AS mimeType,
    json_extract(p.value,'$.data.size') AS size
    FROM native_conversation.native_records r JOIN json_each(r.data_json,'$.value.messages') m
    JOIN json_each(m.value,'$.parts') p
    WHERE r.kind='turn' AND r.thread_id=? AND json_extract(m.value,'$.id')=?
      AND json_extract(p.value,'$.type')='data-resource' AND json_extract(p.value,'$.data.state')='ready'
    ORDER BY CAST(p.key AS INTEGER)`)
      .all(channelId, messageId),
  );
}
