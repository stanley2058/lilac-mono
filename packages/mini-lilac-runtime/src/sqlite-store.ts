import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";

import type {
  MiniLilacTodo,
  MiniLilacTodoState,
  MiniLilacReasoning,
  MiniLilacCompactResult,
  MiniLilacSessionSnapshot,
  MiniLilacUIMessage,
  MiniLilacUndoResult,
  MiniLilacUpdateSessionBindingsRequest,
  MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  miniLilacControlResultSchema,
  miniLilacCompactResultSchema,
  miniLilacCompactionEventSchema,
  miniLilacMessagesSchema,
  miniLilacProviderMetadataSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSteeringChunkSchema,
  miniLilacSubagentStatusSchema,
  miniLilacTodoChunkSchema,
  miniLilacTodoStateSchema,
  miniLilacTodosSchema,
  miniLilacTranscriptResetSchema,
  miniLilacUIMessageSchema,
  miniLilacUIMessageMetadataSchema,
  miniLilacUndoResultSchema,
  miniLilacUserUIMessageSchema,
} from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";
import superjson from "superjson";
import { z } from "zod";

const sessionStatusSchema = z.enum(["idle", "streaming", "cancelling", "error"]);
const runStatusSchema = z.enum(["active", "completed", "cancelled", "error"]);
export const MINI_LILAC_DATABASE_SCHEMA_VERSION = 2;

export class MiniLilacDatabaseVersionError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = MINI_LILAC_DATABASE_SCHEMA_VERSION,
  ) {
    super(
      `Unsupported mini-lilac database version ${actualVersion}; create a fresh database for schema version ${expectedVersion}`,
    );
    this.name = "MiniLilacDatabaseVersionError";
  }
}

const sessionRowSchema = z.object({
  id: z.string(),
  active_run_id: z.string().nullable(),
  cwd: z.string(),
  model: z.string(),
  profile: z.string(),
  reasoning: z.string(),
  title: z.string(),
  input_tokens: z.number().int().nonnegative().nullable(),
  context_window: z.number().int().positive().nullable(),
  status: sessionStatusSchema,
  queued_steering_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

const runRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  parent_run_id: z.string().nullable(),
  profile: z.string(),
  depth: z.number().int().nonnegative(),
  status: runStatusSchema,
  error: z.string().nullable(),
  terminal_result_json: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const chunkRowSchema = z.object({ seq: z.number().int().positive(), chunk_json: z.string() });
const jsonRowSchema = z.object({ value_json: z.string() });
const todosRowSchema = z.object({
  revision: z.number().int().nonnegative(),
  todos_json: z.string(),
});
const positionedJsonRowSchema = z.object({
  position: z.number().int().nonnegative(),
  value_json: z.string(),
});
const checkpointRowSchema = z.object({
  user_message_json: z.string(),
  model_prefix_json: z.string(),
  ui_prefix_json: z.string(),
  root_run_id: z.string(),
  replay_after_seq: z.number().int().nonnegative(),
});
const commandRowSchema = z.object({
  kind: z.string(),
  run_id: z.string().nullable(),
  request_fingerprint: z.string(),
  request_json: z.string(),
  side_effect_started: z.number().int().min(0).max(1),
  result_json: z.string().nullable(),
});

const providerMetadataFields = {
  providerMetadata: miniLilacProviderMetadataSchema.optional(),
};

const standardChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    messageId: z.string().optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("finish"),
    finishReason: z
      .enum(["stop", "length", "content-filter", "tool-calls", "error", "other"])
      .optional(),
    messageMetadata: miniLilacUIMessageMetadataSchema.optional(),
  }),
  z.strictObject({ type: z.literal("start-step") }),
  z.strictObject({ type: z.literal("finish-step") }),
  z.strictObject({ type: z.literal("text-start"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("text-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({ type: z.literal("text-end"), id: z.string(), ...providerMetadataFields }),
  z.strictObject({
    type: z.literal("reasoning-start"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    id: z.string(),
    delta: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-end"),
    id: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("custom"),
    kind: z.custom<`${string}.${string}`>(
      (value): value is `${string}.${string}` => typeof value === "string" && value.includes("."),
    ),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("reasoning-file"),
    mediaType: z.string(),
    url: z.string(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    providerExecuted: z.boolean().optional(),
    toolMetadata: z.record(z.string(), z.json()).optional(),
    dynamic: z.boolean().optional(),
    title: z.string().optional(),
    ...providerMetadataFields,
  }),
  z.strictObject({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    inputTextDelta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-input-available"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-input-error"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-available"),
    toolCallId: z.string(),
    output: z.unknown(),
    dynamic: z.boolean().optional(),
    preliminary: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-output-error"),
    toolCallId: z.string(),
    errorText: z.string(),
    dynamic: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("tool-output-denied"), toolCallId: z.string() }),
  z.strictObject({ type: z.literal("abort"), reason: z.string().optional() }),
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
  z.strictObject({
    type: z.literal("data-session"),
    id: z.string().optional(),
    data: miniLilacSessionSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("data-control"),
    id: z.string().optional(),
    data: miniLilacControlResultSchema,
  }),
  z.strictObject({
    type: z.literal("data-transcriptReset"),
    id: z.string().optional(),
    data: miniLilacTranscriptResetSchema,
  }),
  z.strictObject({
    type: z.literal("data-subagentStatus"),
    id: z.string().optional(),
    data: miniLilacSubagentStatusSchema,
  }),
  z.strictObject({
    type: z.literal("data-compaction"),
    id: z.string().optional(),
    data: miniLilacCompactionEventSchema,
  }),
  miniLilacTodoChunkSchema,
  miniLilacSteeringChunkSchema,
]);

export type StoredUIMessageChunk = z.infer<typeof standardChunkSchema>;
export type StoredRunChunk = { seq: number; chunk: StoredUIMessageChunk };

const uiMessageChunkSchema = standardChunkSchema;

const modelMessagesSchema = z.custom<ModelMessage[]>(
  (value) =>
    Array.isArray(value) &&
    value.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        ["system", "user", "assistant", "tool"].includes(String(message.role)),
    ),
  "Invalid canonical model transcript",
);

export type MiniLilacRunStatus = z.infer<typeof runStatusSchema>;

export type StoredRun = {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  profile: string;
  depth: number;
  status: MiniLilacRunStatus;
  error: string | null;
  terminalResult: unknown;
  startedAt: string;
  finishedAt: string | null;
};

export type CreateStoredSession = {
  id: string;
  cwd: string;
  model: string;
  profile: string;
  reasoning: MiniLilacReasoning;
  contextWindow?: number;
};

export type CreateStoredRun = {
  id: string;
  sessionId: string;
  parentRunId?: string;
  profile: string;
  depth: number;
};

export type BeginStoredRootRun = {
  run: CreateStoredRun;
  commandId: string;
  commandPayload: unknown;
  modelMessages: readonly ModelMessage[];
  uiMessages: readonly MiniLilacUIMessage[];
  title?: string;
};

export type StoredCommandRequest = {
  kind: string;
  runId: string | null;
  payload: unknown;
};

export type StoredSessionBindingUpdate = Pick<
  MiniLilacUpdateSessionBindingsRequest,
  "model" | "profile" | "reasoning"
> & { readonly contextWindow?: number | null };

export type FinalizeStoredRootRun = {
  runId: string;
  sessionId: string;
  runStatus: Exclude<MiniLilacRunStatus, "active">;
  sessionStatus: MiniLilacSessionSnapshot["status"];
  error?: string;
  terminalResult?: unknown;
  modelMessages: readonly ModelMessage[];
  uiMessages: readonly MiniLilacUIMessage[];
};

export type StoredUserCheckpoint = {
  message: MiniLilacUserUIMessage;
  modelPrefix: readonly ModelMessage[];
  uiPrefix: readonly MiniLilacUIMessage[];
  replayAfterSeq: number;
};

export type StoredSessionResume = {
  snapshot: MiniLilacSessionSnapshot;
  messages: MiniLilacUIMessage[];
  replayCursor: { runId: string; afterSeq: number } | null;
};

export type ReplaceTodosForRun = {
  sessionId: string;
  runId: string;
  todos: readonly MiniLilacTodo[];
};

export type ReplaceTodosForRunResult = {
  state: MiniLilacTodoState;
  storedChunk?: StoredRunChunk;
};

function serialize(value: unknown): string {
  return superjson.stringify(value);
}

function deserialize(value: string): unknown {
  return superjson.parse(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function canonicalCommandPayload(payload: unknown): { json: string; fingerprint: string } {
  const normalized: unknown = JSON.parse(JSON.stringify(payload));
  const json = JSON.stringify(canonicalJsonValue(z.json().parse(normalized)));
  const fingerprint = new Bun.CryptoHasher("sha256").update(json).digest("hex");
  return { json, fingerprint };
}

function toSnapshot(rowValue: unknown): MiniLilacSessionSnapshot {
  const row = sessionRowSchema.parse(rowValue);
  return {
    id: row.id,
    activeRunId: row.active_run_id,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    profile: row.profile,
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .parse(row.reasoning),
    title: row.title,
    inputTokens: row.input_tokens,
    contextWindow: row.context_window,
    queuedSteeringCount: row.queued_steering_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(rowValue: unknown): StoredRun {
  const row = runRowSchema.parse(rowValue);
  return {
    id: row.id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    profile: row.profile,
    depth: row.depth,
    status: row.status,
    error: row.error,
    terminalResult: row.terminal_result_json ? deserialize(row.terminal_result_json) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class MiniLilacSqliteStore {
  readonly database: Database;
  readonly filename: string;
  private closeBlockers = 0;
  private closed = false;

  constructor(filename: string) {
    this.filename = filename === ":memory:" ? filename : path.resolve(filename);
    if (this.filename !== ":memory:" && existsSync(this.filename)) {
      if (lstatSync(this.filename).isSymbolicLink()) {
        throw new Error(`Mini Lilac database path '${this.filename}' must not be a symbolic link`);
      }
    }
    this.database = new Database(this.filename, { create: true, strict: true });
    try {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.secureDatabaseFiles();
      this.initializeSchema();
      this.recoverInterruptedRuns();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private secureDatabaseFiles(): void {
    if (this.filename === ":memory:" || process.platform === "win32") return;
    for (const file of [
      this.filename,
      `${this.filename}-journal`,
      `${this.filename}-shm`,
      `${this.filename}-wal`,
    ]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  private initializeSchema(): void {
    const version = z
      .object({ user_version: z.number().int() })
      .parse(this.database.query("PRAGMA user_version").get()).user_version;
    if (version === MINI_LILAC_DATABASE_SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new MiniLilacDatabaseVersionError(version);
    }

    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          active_run_id TEXT,
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          profile TEXT NOT NULL,
          reasoning TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Mini Lilac',
          input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
          context_window INTEGER CHECK(context_window IS NULL OR context_window > 0),
          status TEXT NOT NULL CHECK(status IN ('idle', 'streaming', 'cancelling', 'error')),
          queued_steering_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_steering_count >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          profile TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK(depth >= 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'error')),
          error TEXT,
          terminal_result_json TEXT,
          undone_at TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE UNIQUE INDEX one_active_root_run_per_session
          ON runs(session_id) WHERE status = 'active' AND parent_run_id IS NULL;
        CREATE TABLE commands (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          run_id TEXT,
          request_fingerprint TEXT NOT NULL,
          request_json TEXT NOT NULL,
          side_effect_started INTEGER NOT NULL CHECK(side_effect_started IN (0, 1)),
          result_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id)
        );
        CREATE TABLE model_transcript (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY(session_id, position)
        );
        CREATE TABLE ui_messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY(session_id, position)
        );
        CREATE TABLE run_chunks (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          chunk_json TEXT NOT NULL,
          PRIMARY KEY(run_id, seq)
        );
        CREATE TABLE user_checkpoints (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ui_position INTEGER NOT NULL,
          user_message_json TEXT NOT NULL,
          model_prefix_json TEXT NOT NULL,
          ui_prefix_json TEXT NOT NULL,
          root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          replay_after_seq INTEGER NOT NULL CHECK(replay_after_seq >= 0),
          PRIMARY KEY(session_id, ui_position)
        );
        CREATE TABLE session_todos (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
          todos_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = ${MINI_LILAC_DATABASE_SCHEMA_VERSION};
      `);
    })();
  }

  private recoverInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE status = 'active'",
        )
        .run("Runtime process stopped while run was active", now);
      this.database
        .query(
          "UPDATE sessions SET status = 'error', active_run_id = NULL, queued_steering_count = 0, updated_at = ? WHERE status IN ('streaming', 'cancelling')",
        )
        .run(now);
      this.database
        .query(
          `DELETE FROM commands
           WHERE result_json IS NULL AND side_effect_started = 0`,
        )
        .run();
    })();
  }

  close(): void {
    if (this.closed) return;
    if (this.closeBlockers > 0) {
      throw new Error(
        `Cannot close Mini Lilac database while ${this.closeBlockers} runtime task(s) are active`,
      );
    }
    this.database.close();
    this.closed = true;
  }

  acquireCloseBlocker(): () => void {
    if (this.closed) throw new Error("Mini Lilac database is closed");
    this.closeBlockers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.closeBlockers = Math.max(0, this.closeBlockers - 1);
    };
  }

  createSession(input: CreateStoredSession): MiniLilacSessionSnapshot {
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO sessions
          (id, cwd, model, profile, reasoning, title, input_tokens, context_window, status, queued_steering_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Mini Lilac', NULL, ?, 'idle', 0, ?, ?)`,
      )
      .run(
        input.id,
        input.cwd,
        input.model,
        input.profile,
        input.reasoning,
        input.contextWindow ?? null,
        now,
        now,
      );
    return this.getSession(input.id);
  }

  getSession(sessionId: string): MiniLilacSessionSnapshot {
    const row = this.database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`Session '${sessionId}' was not found`);
    return toSnapshot(row);
  }

  listSessions(): MiniLilacSessionSnapshot[] {
    return this.database.query("SELECT * FROM sessions ORDER BY created_at").all().map(toSnapshot);
  }

  updateSessionState(
    sessionId: string,
    status: MiniLilacSessionSnapshot["status"],
    queuedSteeringCount: number,
    activeRunId: string | null = this.getSession(sessionId).activeRunId,
  ): MiniLilacSessionSnapshot {
    this.database
      .query(
        "UPDATE sessions SET status = ?, active_run_id = ?, queued_steering_count = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, activeRunId, queuedSteeringCount, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  updateSessionTitle(
    sessionId: string,
    expectedTitle: string,
    title: string,
  ): MiniLilacSessionSnapshot {
    this.database
      .query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
      .run(title, new Date().toISOString(), sessionId, expectedTitle);
    return this.getSession(sessionId);
  }

  updateSessionUsage(sessionId: string, inputTokens: number): MiniLilacSessionSnapshot {
    this.database
      .query("UPDATE sessions SET input_tokens = ?, updated_at = ? WHERE id = ?")
      .run(inputTokens, new Date().toISOString(), sessionId);
    return this.getSession(sessionId);
  }

  updateSessionBindings(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    bindings: StoredSessionBindingUpdate,
  ): MiniLilacSessionSnapshot {
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const previous = this.getCommandResult(sessionId, commandId, request);
      if (previous !== undefined) return miniLilacSessionSnapshotSchema.parse(previous);
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to update bindings`);
      }

      const now = new Date().toISOString();
      this.database
        .query(
          `UPDATE sessions
           SET model = ?, profile = ?, reasoning = ?,
               context_window = ?, input_tokens = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          bindings.model ?? snapshot.model,
          bindings.profile ?? snapshot.profile,
          bindings.reasoning ?? snapshot.reasoning,
          bindings.model === undefined
            ? (snapshot.contextWindow ?? null)
            : (bindings.contextWindow ?? null),
          bindings.model === undefined ? (snapshot.inputTokens ?? null) : null,
          now,
          sessionId,
        );
      const result = this.getSession(sessionId);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
          serialize(result),
          now,
        );
      return result;
    })();
  }

  createRun(input: CreateStoredRun): StoredRun {
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO runs
          (id, session_id, parent_run_id, profile, depth, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(input.id, input.sessionId, input.parentRunId ?? null, input.profile, input.depth, now);
    return this.getRun(input.id);
  }

  beginRootRun(input: BeginStoredRootRun): MiniLilacSessionSnapshot {
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    if (input.run.parentRunId !== undefined) throw new Error("beginRootRun requires a root run");
    const command = canonicalCommandPayload(input.commandPayload);
    const userMessage = miniLilacUserUIMessageSchema.parse(input.uiMessages.at(-1));
    const userModelMessage = input.modelMessages.at(-1);
    if (userModelMessage?.role !== "user") {
      throw new Error("A root run must end with its admitted model user message");
    }
    const uiPosition = input.uiMessages.length - 1;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.insertMessages(input.run.sessionId, input.modelMessages, input.uiMessages);
      this.database
        .query(
          `INSERT INTO runs
            (id, session_id, parent_run_id, profile, depth, status, started_at)
           VALUES (?, ?, NULL, ?, ?, 'active', ?)`,
        )
        .run(input.run.id, input.run.sessionId, input.run.profile, input.run.depth, now);
      this.insertUserCheckpoint(
        input.run.sessionId,
        uiPosition,
        userMessage,
        input.modelMessages.slice(0, -1),
        input.uiMessages.slice(0, -1),
        input.run.id,
        0,
      );
      this.database
        .query(
          "UPDATE sessions SET status = 'streaming', active_run_id = ?, queued_steering_count = 0, title = COALESCE(?, title), updated_at = ? WHERE id = ?",
        )
        .run(input.run.id, input.title ?? null, now, input.run.sessionId);
      const assigned = this.database
        .query(
          `UPDATE commands
           SET run_id = ?, side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = 'prompt'
             AND run_id IS NULL AND result_json IS NULL
             AND request_fingerprint = ? AND request_json = ?`,
        )
        .run(
          input.run.id,
          serialize({ runId: input.run.id }),
          input.run.sessionId,
          input.commandId,
          command.fingerprint,
          command.json,
        );
      if (assigned.changes !== 1) {
        throw new Error(`Prompt command '${input.commandId}' could not be assigned atomically`);
      }
    })();
    return this.getSession(input.run.sessionId);
  }

  getRun(runId: string): StoredRun {
    const row = this.database.query("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) throw new Error(`Run '${runId}' was not found`);
    return toRun(row);
  }

  getLatestRun(sessionId: string): StoredRun | null {
    const row = this.database
      .query(
        "SELECT * FROM runs WHERE session_id = ? AND parent_run_id IS NULL AND undone_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId);
    return row ? toRun(row) : null;
  }

  finishRun(
    runId: string,
    status: Exclude<MiniLilacRunStatus, "active">,
    options: { error?: string; terminalResult?: unknown } = {},
  ): void {
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE runs SET status = ?, error = ?, terminal_result_json = ?, finished_at = ? WHERE id = ?",
        )
        .run(
          status,
          options.error ?? null,
          options.terminalResult === undefined ? null : serialize(options.terminalResult),
          new Date().toISOString(),
          runId,
        );
      this.database.query("DELETE FROM run_chunks WHERE run_id = ?").run(runId);
    })();
  }

  finalizeRootRun(input: FinalizeStoredRootRun): MiniLilacSessionSnapshot {
    modelMessagesSchema.parse(input.modelMessages);
    miniLilacMessagesSchema.parse(input.uiMessages);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.insertMessages(input.sessionId, input.modelMessages, input.uiMessages);
      const finished = this.database
        .query(
          `UPDATE runs
           SET status = ?, error = ?, terminal_result_json = ?, finished_at = ?
           WHERE id = ? AND session_id = ? AND parent_run_id IS NULL AND status = 'active'`,
        )
        .run(
          input.runStatus,
          input.error ?? null,
          input.terminalResult === undefined ? null : serialize(input.terminalResult),
          now,
          input.runId,
          input.sessionId,
        );
      if (finished.changes !== 1) throw new Error(`Run '${input.runId}' is not active`);
      const updated = this.database
        .query(
          `UPDATE sessions
           SET status = ?, active_run_id = NULL, queued_steering_count = 0, updated_at = ?
           WHERE id = ? AND active_run_id = ?`,
        )
        .run(input.sessionStatus, now, input.sessionId, input.runId);
      if (updated.changes !== 1) {
        throw new Error(`Run '${input.runId}' is not active for session '${input.sessionId}'`);
      }
      this.database.query("DELETE FROM run_chunks WHERE run_id = ?").run(input.runId);
    })();
    return this.getSession(input.sessionId);
  }

  appendChunk(runId: string, chunk: StoredUIMessageChunk): number {
    const parsed = uiMessageChunkSchema.parse(chunk);
    const next = z
      .object({ seq: z.number().int() })
      .parse(
        this.database
          .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_chunks WHERE run_id = ?")
          .get(runId),
      ).seq;
    this.database
      .query("INSERT INTO run_chunks (run_id, seq, chunk_json) VALUES (?, ?, ?)")
      .run(runId, next, serialize(parsed));
    return next;
  }

  getChunks(runId: string, afterSeq = 0): StoredRunChunk[] {
    return this.database
      .query(
        `SELECT seq, chunk_json FROM run_chunks
         WHERE run_id = ? AND seq > ?
           AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND undone_at IS NULL)
         ORDER BY seq`,
      )
      .all(runId, afterSeq, runId)
      .map((value) => {
        const row = chunkRowSchema.parse(value);
        return { seq: row.seq, chunk: uiMessageChunkSchema.parse(deserialize(row.chunk_json)) };
      });
  }

  getTodos(sessionId: string): MiniLilacTodoState {
    const session = this.database.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' was not found`);
    const value = this.database
      .query("SELECT revision, todos_json FROM session_todos WHERE session_id = ?")
      .get(sessionId);
    if (!value) return miniLilacTodoStateSchema.parse({ revision: 0, todos: [] });
    const row = todosRowSchema.parse(value);
    return miniLilacTodoStateSchema.parse({
      revision: row.revision,
      todos: JSON.parse(row.todos_json),
    });
  }

  replaceTodosForRun(input: ReplaceTodosForRun): ReplaceTodosForRunResult {
    const todos = miniLilacTodosSchema.parse(input.todos);
    const todosJson = JSON.stringify(canonicalJsonValue(todos));

    return this.database.transaction(() => {
      const activeRun = this.database
        .query(
          `SELECT 1
           FROM sessions
           JOIN runs ON runs.id = ? AND runs.session_id = sessions.id
           WHERE sessions.id = ? AND sessions.active_run_id = runs.id
             AND runs.parent_run_id IS NULL AND runs.status = 'active'`,
        )
        .get(input.runId, input.sessionId);
      if (!activeRun) {
        throw new Error(`Run '${input.runId}' is not active for session '${input.sessionId}'`);
      }

      const current = this.getTodos(input.sessionId);
      const currentJson = JSON.stringify(canonicalJsonValue(current.todos));
      if (currentJson === todosJson) return { state: current };
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Session '${input.sessionId}' todo revision is exhausted`);
      }

      const now = new Date().toISOString();
      const updatedValue = this.database
        .query(
          `INSERT INTO session_todos (session_id, revision, todos_json, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             revision = session_todos.revision + 1,
             todos_json = excluded.todos_json,
             updated_at = excluded.updated_at
           WHERE session_todos.todos_json <> excluded.todos_json
           RETURNING revision, todos_json`,
        )
        .get(input.sessionId, todosJson, now);
      if (!updatedValue) return { state: this.getTodos(input.sessionId) };

      const updated = todosRowSchema.parse(updatedValue);
      const state = miniLilacTodoStateSchema.parse({
        revision: updated.revision,
        todos: JSON.parse(updated.todos_json),
      });
      const chunk = miniLilacTodoChunkSchema.parse({
        type: "data-todos",
        data: state,
        transient: true,
      });
      const seq = z
        .object({ seq: z.number().int().positive() })
        .parse(
          this.database
            .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_chunks WHERE run_id = ?")
            .get(input.runId),
        ).seq;
      this.database
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, input.sessionId);
      this.database
        .query("INSERT INTO run_chunks (run_id, seq, chunk_json) VALUES (?, ?, ?)")
        .run(input.runId, seq, serialize(chunk));
      return { state, storedChunk: { seq, chunk } };
    })();
  }

  replaceMessages(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): void {
    modelMessagesSchema.parse(modelMessages);
    miniLilacMessagesSchema.parse(uiMessages);
    this.database.transaction(() => this.insertMessages(sessionId, modelMessages, uiMessages))();
  }

  commitCompaction(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    modelMessages: readonly ModelMessage[],
    resultValue: MiniLilacCompactResult,
  ): MiniLilacCompactResult {
    modelMessagesSchema.parse(modelMessages);
    const result = miniLilacCompactResultSchema.parse(resultValue);
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to compact`);
      }

      if (result.status === "compacted") {
        this.insertModelMessages(sessionId, modelMessages);
        const uiMessages = this.getUiMessages(sessionId);
        uiMessages.push({
          id: `compaction:${commandId}`,
          role: "assistant",
          parts: [
            {
              type: "data-compaction",
              id: commandId,
              data: {
                source: "manual",
                reason: "manual",
                status: "completed",
                messageCountBefore: result.messageCountBefore,
                messageCountAfter: result.messageCountAfter,
                estimatedInputTokensBefore: result.estimatedInputTokensBefore,
                estimatedInputTokensAfter: result.estimatedInputTokensAfter,
              },
            },
          ],
        });
        this.insertUiMessages(sessionId, uiMessages);
        // Manual compaction is an undo barrier. New prompts create checkpoints
        // against the compacted transcript while the visible UI history remains intact.
        this.database.query("DELETE FROM user_checkpoints WHERE session_id = ?").run(sessionId);
        this.database
          .query("UPDATE sessions SET input_tokens = NULL, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), sessionId);
      }
      const saved = this.database
        .query(
          `UPDATE commands SET side_effect_started = 1, result_json = ?
           WHERE session_id = ? AND command_id = ? AND kind = ?
             AND run_id IS NULL AND request_fingerprint = ? AND request_json = ?
             AND side_effect_started = 0 AND result_json IS NULL`,
        )
        .run(
          serialize(result),
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
        );
      if (saved.changes !== 1) {
        throw new Error(`Compact command '${commandId}' could not be committed atomically`);
      }
      return result;
    })();
  }

  appendUserCheckpoints(
    sessionId: string,
    rootRunId: string,
    checkpoints: readonly StoredUserCheckpoint[],
  ): void {
    if (checkpoints.length === 0) return;
    checkpoints.forEach((checkpoint) => {
      miniLilacUserUIMessageSchema.parse(checkpoint.message);
      modelMessagesSchema.parse(checkpoint.modelPrefix);
      miniLilacMessagesSchema.parse(checkpoint.uiPrefix);
      z.number().int().nonnegative().parse(checkpoint.replayAfterSeq);
    });
    this.database.transaction(() => {
      const checkpointPosition = z
        .object({ position: z.number().int() })
        .parse(
          this.database
            .query(
              "SELECT COALESCE(MAX(ui_position), -1) + 1 AS position FROM user_checkpoints WHERE session_id = ?",
            )
            .get(sessionId),
        ).position;
      const uiMessages = this.getUiMessages(sessionId);
      checkpoints.forEach((checkpoint, index) => {
        this.insertUserCheckpoint(
          sessionId,
          checkpointPosition + index,
          checkpoint.message,
          checkpoint.modelPrefix,
          checkpoint.uiPrefix,
          rootRunId,
          checkpoint.replayAfterSeq,
        );
        uiMessages.push(checkpoint.message);
      });
      this.insertUiMessages(sessionId, uiMessages);
    })();
  }

  undoLatestUser(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): MiniLilacUndoResult {
    const command = canonicalCommandPayload(request.payload);
    return this.database.transaction(() => {
      const previous = this.getCommandResult(sessionId, commandId, request);
      if (previous !== undefined) return miniLilacUndoResultSchema.parse(previous);
      const snapshot = this.getSession(sessionId);
      const activeRunCount = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          this.database
            .query("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND status = 'active'")
            .get(sessionId),
        ).count;
      if (
        !["idle", "error"].includes(snapshot.status) ||
        snapshot.activeRunId !== null ||
        activeRunCount > 0
      ) {
        throw new Error(`Session '${sessionId}' must be quiescent to undo`);
      }

      const uiRows = this.database
        .query(
          "SELECT position, value_json FROM ui_messages WHERE session_id = ? ORDER BY position",
        )
        .all(sessionId)
        .map((value) => positionedJsonRowSchema.parse(value));
      const latestUser = uiRows.findLast(
        (row) => miniLilacUIMessageSchema.parse(deserialize(row.value_json)).role === "user",
      );
      const latestManualCompaction = uiRows.findLast((row) => {
        const message = miniLilacUIMessageSchema.parse(deserialize(row.value_json));
        return message.parts.some(
          (part) => part.type === "data-compaction" && part.data.source === "manual",
        );
      });
      if (!latestUser || (latestManualCompaction?.position ?? -1) > latestUser.position) {
        const result = miniLilacUndoResultSchema.parse({
          status: "empty",
          clientCommandId: commandId,
        });
        this.database
          .query(
            `INSERT INTO commands
              (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
             VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
          )
          .run(
            sessionId,
            commandId,
            request.kind,
            command.fingerprint,
            command.json,
            serialize(result),
            new Date().toISOString(),
          );
        return result;
      }
      const checkpointValue = this.database
        .query(
          `SELECT user_message_json, model_prefix_json, ui_prefix_json, root_run_id, replay_after_seq
           FROM user_checkpoints
           WHERE session_id = ? AND user_message_json = ?
           ORDER BY ui_position DESC LIMIT 1`,
        )
        .get(sessionId, latestUser.value_json);
      if (!checkpointValue) {
        throw new Error(
          `Session '${sessionId}' has no durable checkpoint for its latest user message`,
        );
      }
      const checkpoint = checkpointRowSchema.parse(checkpointValue);
      if (checkpoint.user_message_json !== latestUser.value_json) {
        throw new Error(
          `Session '${sessionId}' has an invalid checkpoint for its latest user message`,
        );
      }
      const message = miniLilacUserUIMessageSchema.parse(deserialize(checkpoint.user_message_json));
      const modelPrefix = modelMessagesSchema.parse(deserialize(checkpoint.model_prefix_json));
      const uiPrefix = miniLilacMessagesSchema.parse(deserialize(checkpoint.ui_prefix_json));
      const result = miniLilacUndoResultSchema.parse({
        status: "undone",
        clientCommandId: commandId,
        message,
      });

      this.database
        .query(
          `DELETE FROM user_checkpoints
           WHERE session_id = ? AND ui_position >= (
             SELECT ui_position FROM user_checkpoints
             WHERE session_id = ? AND user_message_json = ?
             ORDER BY ui_position DESC LIMIT 1
           )`,
        )
        .run(sessionId, sessionId, latestUser.value_json);
      this.insertModelMessages(sessionId, modelPrefix);
      this.insertUiMessages(sessionId, uiPrefix);
      this.database
        .query("UPDATE runs SET undone_at = ? WHERE id = ? AND session_id = ?")
        .run(new Date().toISOString(), checkpoint.root_run_id, sessionId);
      this.database.query("DELETE FROM run_chunks WHERE run_id = ?").run(checkpoint.root_run_id);
      this.database
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sessionId);
      this.database
        .query(
          `INSERT INTO commands
            (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          sessionId,
          commandId,
          request.kind,
          command.fingerprint,
          command.json,
          serialize(result),
          new Date().toISOString(),
        );
      return result;
    })();
  }

  private insertMessages(
    sessionId: string,
    modelMessages: readonly ModelMessage[],
    uiMessages: readonly MiniLilacUIMessage[],
  ): void {
    this.insertModelMessages(sessionId, modelMessages);
    this.insertUiMessages(sessionId, uiMessages);
  }

  private insertUiMessages(sessionId: string, uiMessages: readonly MiniLilacUIMessage[]): void {
    this.database.query("DELETE FROM ui_messages WHERE session_id = ?").run(sessionId);
    const insertUi = this.database.query(
      "INSERT INTO ui_messages (session_id, position, value_json) VALUES (?, ?, ?)",
    );
    uiMessages.forEach((message, position) =>
      insertUi.run(sessionId, position, serialize(message)),
    );
  }

  private insertModelMessages(sessionId: string, modelMessages: readonly ModelMessage[]): void {
    this.database.query("DELETE FROM model_transcript WHERE session_id = ?").run(sessionId);
    const insertModel = this.database.query(
      "INSERT INTO model_transcript (session_id, position, value_json) VALUES (?, ?, ?)",
    );
    modelMessages.forEach((message, position) =>
      insertModel.run(sessionId, position, serialize(message)),
    );
  }

  private insertUserCheckpoint(
    sessionId: string,
    uiPosition: number,
    message: MiniLilacUserUIMessage,
    modelPrefix: readonly ModelMessage[],
    uiPrefix: readonly MiniLilacUIMessage[],
    rootRunId: string,
    replayAfterSeq: number,
  ): void {
    this.database
      .query(
        `INSERT INTO user_checkpoints
          (session_id, ui_position, user_message_json, model_prefix_json, ui_prefix_json, root_run_id, replay_after_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        uiPosition,
        serialize(message),
        serialize(modelPrefix),
        serialize(uiPrefix),
        rootRunId,
        replayAfterSeq,
      );
  }

  getModelMessages(sessionId: string): ModelMessage[] {
    const values = this.database
      .query("SELECT value_json FROM model_transcript WHERE session_id = ? ORDER BY position")
      .all(sessionId)
      .map((value) => deserialize(jsonRowSchema.parse(value).value_json));
    return modelMessagesSchema.parse(values);
  }

  getUiMessages(sessionId: string): MiniLilacUIMessage[] {
    const values = this.database
      .query("SELECT value_json FROM ui_messages WHERE session_id = ? ORDER BY position")
      .all(sessionId)
      .map((value) => deserialize(jsonRowSchema.parse(value).value_json));
    return miniLilacMessagesSchema.parse(values);
  }

  getSessionResume(sessionId: string): StoredSessionResume {
    return this.database.transaction(() => {
      const snapshot = this.getSession(sessionId);
      if (snapshot.activeRunId === null) {
        return { snapshot, messages: this.getUiMessages(sessionId), replayCursor: null };
      }
      const value = this.database
        .query(
          `SELECT user_message_json, model_prefix_json, ui_prefix_json, root_run_id, replay_after_seq
           FROM user_checkpoints
           WHERE session_id = ? AND root_run_id = ?
           ORDER BY ui_position DESC LIMIT 1`,
        )
        .get(sessionId, snapshot.activeRunId);
      if (!value) {
        throw new Error(`Active run '${snapshot.activeRunId}' has no durable resume checkpoint`);
      }
      const checkpoint = checkpointRowSchema.parse(value);
      const message = miniLilacUserUIMessageSchema.parse(deserialize(checkpoint.user_message_json));
      const uiPrefix = miniLilacMessagesSchema.parse(deserialize(checkpoint.ui_prefix_json));
      return {
        snapshot,
        messages: [...uiPrefix, message],
        replayCursor: {
          runId: checkpoint.root_run_id,
          afterSeq: checkpoint.replay_after_seq,
        },
      };
    })();
  }

  getCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): unknown | undefined {
    const command = canonicalCommandPayload(request.payload);
    const value = this.database
      .query(
        `SELECT kind, run_id, request_fingerprint, request_json, side_effect_started, result_json
         FROM commands WHERE session_id = ? AND command_id = ?`,
      )
      .get(sessionId, commandId);
    if (!value) return undefined;
    const row = commandRowSchema.parse(value);
    if (row.kind !== request.kind) {
      throw new Error(`Command '${commandId}' was already used for '${row.kind}'`);
    }
    if (request.runId !== null && row.run_id !== request.runId) {
      throw new Error(`Command '${commandId}' was already used for a different run`);
    }
    if (row.request_fingerprint !== command.fingerprint || row.request_json !== command.json) {
      throw new Error(`Command '${commandId}' was already used with a different payload`);
    }
    if (row.result_json === null) throw new Error(`Command '${commandId}' is pending`);
    return deserialize(row.result_json);
  }

  reserveCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `INSERT INTO commands
          (session_id, command_id, kind, run_id, request_fingerprint, request_json, side_effect_started, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
        new Date().toISOString(),
      );
  }

  releaseCommand(sessionId: string, commandId: string, request: StoredCommandRequest): void {
    const command = canonicalCommandPayload(request.payload);
    this.database
      .query(
        `DELETE FROM commands
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
  }

  markCommandSideEffectStarted(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const marked = this.database
      .query(
        `UPDATE commands SET side_effect_started = 1
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 0 AND result_json IS NULL`,
      )
      .run(sessionId, commandId, request.kind, request.runId, command.fingerprint, command.json);
    if (marked.changes !== 1) {
      throw new Error(`Command '${commandId}' could not begin its side effect`);
    }
  }

  saveCommandResult(
    sessionId: string,
    commandId: string,
    request: StoredCommandRequest,
    result: unknown,
  ): void {
    const command = canonicalCommandPayload(request.payload);
    const saved = this.database
      .query(
        `UPDATE commands SET result_json = ?
         WHERE session_id = ? AND command_id = ? AND kind = ?
           AND run_id IS ? AND request_fingerprint = ? AND request_json = ?
           AND side_effect_started = 1 AND result_json IS NULL`,
      )
      .run(
        serialize(result),
        sessionId,
        commandId,
        request.kind,
        request.runId,
        command.fingerprint,
        command.json,
      );
    if (saved.changes !== 1) throw new Error(`Command '${commandId}' result could not be saved`);
  }
}
