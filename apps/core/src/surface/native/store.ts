import type { ModelReasoning } from "@stanley2058/lilac-client-protocol";
import { isNativeServiceMessage } from "./message-ownership";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  NativeQuestion,
  NativeDeploymentSettings,
  SidebarPreferences,
  NativeRpcInputs,
  NativeRpcOutputs,
  DisplayMessage,
  Hydration,
  NativeInput,
  NativeInputReceipt,
  NativeThread,
  NativeUser as DisplayUser,
  Participant,
  QueuedInput,
  TurnPage,
  LiveUpdate,
  ReadyTurnSlot,
  ReplayCheckpoint,
  ReplayReply,
  TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import {
  classifyBunSqliteError,
  runBunSqliteTransaction,
  type PersistedDataError,
  type DurableResolvedModelRequest,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import type { NativeOutputProjectionState } from "./output-projection-codec";
import { configureSqliteConnection } from "../../shared/sqlite";
import { nativeThreadCapabilities, type NativeThreadGrant } from "./authority";
import {
  decodeNativeRecord,
  type NativeSendGroup,
  type NativeHtmlPreviewRecord,
  type NativeInputRecord,
  type NativeMutationResult,
  type NativePersistedRow,
  type NativeRecord,
  type NativeThreadRecord,
  type NativeAgentStreamRecord,
  type NativeUploadRecord,
  type NativeUser,
} from "./codec";
import { nativeUserDisplay } from "./identity";
import { nativeFailure, type NativeStoreFailure } from "./errors";

export type NativeStoreError = NativeStoreFailure | PersistedDataError;
export type NativeStoreResult<T> = ResultType<T, NativeStoreError>;
const REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REPLAY_BYTE_CAP = 128 * 1024 * 1024;
const WINDOW_BYTES = 224 * 1024;
const encoder = new TextEncoder();
const sidebarActivity = `COALESCE((SELECT MAX(a.updated_at) FROM native_records a WHERE a.thread_id=r.id AND a.kind IN ('turn','input')),json_extract(r.data_json,'$.value.createdAt'))`;

type OutputConversation = NativeThreadRecord | NativeAgentStreamRecord;
type ReplayConversation = Pick<
  OutputConversation,
  "id" | "historyGeneration" | "revision" | "updatedAt"
>;

type StoredRow = NativePersistedRow & { id: string; position: number };

function nativeSqliteFailure(cause: Error): NativeStoreFailure | undefined {
  const classified = classifyBunSqliteError(cause);
  if (!classified) return undefined;
  return nativeFailure("sqlite", `Native store SQLite failure: ${classified.code}`);
}

export function nativeStoreTransaction<T>(
  db: Database,
  operation: () => NativeStoreResult<T>,
): NativeStoreResult<T> {
  return runBunSqliteTransaction(db, operation, nativeSqliteFailure);
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function htmlPreviewKey(turnId: string, path: string): string {
  return fingerprint({ kind: "html-preview", turnId, path });
}

function commandKey(actorId: string, commandId: string): string {
  return fingerprint({ actorId, commandId });
}

function inputReceipt(input: NativeInputRecord): NativeInputReceipt {
  return {
    inputId: input.id,
    messageId: input.messageId,
    turnId: input.turnId,
    state: input.state,
    runId: input.runId,
  };
}

function nativeTextParts(text: string): DisplayMessage["parts"] {
  const parts: DisplayMessage["parts"] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 8192);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    parts.push({ type: "text", text: text.slice(offset, end) });
    offset = end;
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

function nullableAuthority<T>(result: NativeStoreResult<T>): NativeStoreResult<T | null> {
  return result.tryRecover((error) => {
    if (
      error._tag === "NativeStoreFailure" &&
      (error.code === "forbidden" || error.code === "not-found")
    )
      return Result.ok(null);
    return Result.err(error);
  });
}

const CANONICAL_INPUT_FILTER =
  "json_extract(i.data_json,'$.value.completedAt') IS NOT NULL AND json_extract(i.data_json,'$.value.mode')!='steer' AND json_extract(i.data_json,'$.value.state') IN ('admitted','canceled') AND EXISTS(SELECT 1 FROM native_records t WHERE t.kind='turn' AND t.id=json_extract(i.data_json,'$.value.turnId'))";

export class NativeStore {
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly pendingNotifications = new Set<string>();
  private notificationScheduled = false;
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeChanges(listener: (threadId: string) => void): () => void {
    return this.subscribe(listener);
  }
  notifyDisplayChanged(threadId: string): void {
    this.notify(threadId);
  }

  private notify(threadId: string): void {
    this.pendingNotifications.add(threadId);
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      const changed = [...this.pendingNotifications];
      this.pendingNotifications.clear();
      for (const id of changed) for (const listener of this.listeners) listener(id);
    });
  }

  initialize(): NativeStoreResult<void> {
    configureSqliteConnection(this.db);
    this.db.run("PRAGMA foreign_keys = ON");
    return nativeStoreTransaction(this.db, () => {
      const version =
        this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (version > 7)
        return Result.err(
          nativeFailure("invalid", "Native store version is newer than this build"),
        );
      this.db
        .run(`CREATE TABLE IF NOT EXISTS native_records (kind TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT, position INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, format_version INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE UNIQUE INDEX IF NOT EXISTS native_dm_user ON native_records(json_extract(data_json,'$.value.starterId')) WHERE kind='thread' AND json_extract(data_json,'$.value.kind')='dm';
        CREATE INDEX IF NOT EXISTS native_input_delivery ON native_records(json_extract(data_json,'$.value.deliveryId')) WHERE kind='input';
        CREATE INDEX IF NOT EXISTS native_input_request ON native_records(json_extract(data_json,'$.value.requestId')) WHERE kind='input';
        CREATE INDEX IF NOT EXISTS native_pending_inputs ON native_records(thread_id,position) WHERE kind='input' AND json_extract(data_json,'$.value.completedAt') IS NULL AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted');
        CREATE INDEX IF NOT EXISTS native_input_created ON native_records(thread_id,json_extract(data_json,'$.value.createdAt'),position) WHERE kind='input';
        CREATE INDEX IF NOT EXISTS native_records_thread_position ON native_records(kind,thread_id,position);
        CREATE INDEX IF NOT EXISTS native_records_updated ON native_records(kind,updated_at DESC,id);
        CREATE INDEX IF NOT EXISTS native_records_activity ON native_records(thread_id,kind,updated_at DESC);
        CREATE TABLE IF NOT EXISTS native_user_identity (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS native_single_owner ON native_user_identity(role) WHERE role = 'owner';
        CREATE TABLE IF NOT EXISTS native_surface_read (thread_id TEXT NOT NULL,reader_id TEXT NOT NULL,position INTEGER NOT NULL,message_index INTEGER NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(thread_id,reader_id));
        CREATE TABLE IF NOT EXISTS native_grants (thread_id TEXT NOT NULL,user_id TEXT NOT NULL,grant_mode TEXT NOT NULL CHECK(grant_mode IN ('read','edit')),PRIMARY KEY(thread_id,user_id));
        CREATE TABLE IF NOT EXISTS native_changes (thread_id TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,created_at INTEGER NOT NULL,byte_size INTEGER NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,format_version INTEGER NOT NULL DEFAULT 1,data_json TEXT,PRIMARY KEY(thread_id,revision));
        CREATE INDEX IF NOT EXISTS native_changes_age ON native_changes(created_at);
        CREATE TABLE IF NOT EXISTS native_projection_receipts (event_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS native_user_preferences (user_id TEXT PRIMARY KEY,auto_settle_days INTEGER NOT NULL DEFAULT 3 CHECK(auto_settle_days IN (1,3,5,7,30)));
        CREATE TABLE IF NOT EXISTS native_thread_preferences (user_id TEXT NOT NULL,thread_id TEXT NOT NULL,section TEXT NOT NULL CHECK(section IN ('pinned','active','settled')),position INTEGER NOT NULL,last_activity INTEGER NOT NULL,touched_at INTEGER NOT NULL,PRIMARY KEY(user_id,thread_id));
        CREATE INDEX IF NOT EXISTS native_thread_preferences_order ON native_thread_preferences(user_id,section,position,thread_id);
        CREATE TABLE IF NOT EXISTS native_push_keys (id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,private_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS native_push_subscriptions (endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,completion INTEGER NOT NULL,failure INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS native_model_favorites (user_id TEXT NOT NULL,model_id TEXT NOT NULL,PRIMARY KEY(user_id,model_id));
        PRAGMA user_version = 7;`);
      return Result.ok(undefined);
    });
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }

  private readRecord(
    kind: NativeRecord["kind"],
    id: string,
  ): NativeStoreResult<NativeRecord | null> {
    const row = this.db
      .query<StoredRow, [string, string]>(
        "SELECT id,position,format_version,data_json FROM native_records WHERE kind=? AND id=?",
      )
      .get(kind, id);
    if (!row) return Result.ok(null);
    return decodeNativeRecord(row).map((decoded) => decoded.value);
  }

  private readRows(sql: string, params: (string | number)[]): NativeStoreResult<NativeRecord[]> {
    const rows = this.db.query<StoredRow, (string | number)[]>(sql).all(...params);
    return Result.all(rows.map((row) => decodeNativeRecord(row))).map((decoded) =>
      decoded.map((record) => record.value),
    );
  }

  private writeRecord(id: string, record: NativeRecord, threadId?: string, position = 0): void {
    this.db
      .query(
        "INSERT INTO native_records(kind,id,thread_id,position,updated_at,format_version,data_json) VALUES(?,?,?,?,?,1,?) ON CONFLICT(kind,id) DO UPDATE SET thread_id=excluded.thread_id,position=excluded.position,updated_at=excluded.updated_at,data_json=excluded.data_json",
      )
      .run(record.kind, id, threadId ?? null, position, this.now(), JSON.stringify(record));
  }

  initializeDeployment(settings: NativeDeploymentSettings): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const existing = yield* this.readRecord("deployment", "instance");
        if (existing) return Result.ok();
        this.writeRecord("instance", { kind: "deployment", value: { settings, revision: 0 } });
        return Result.ok();
      }, this),
    );
  }

  getDeployment(): NativeStoreResult<NativeRpcOutputs["config"]["readDeployment"]> {
    return nativeStoreTransaction(this.db, () =>
      this.readRecord("deployment", "instance").andThen((record) =>
        record?.kind === "deployment"
          ? Result.ok(record.value)
          : Result.err(nativeFailure("not-found", "Deployment settings are unavailable")),
      ),
    );
  }

  readDeployment(actorId: string): NativeStoreResult<NativeRpcOutputs["config"]["readDeployment"]> {
    return this.requireOwner(actorId).andThen(() => this.getDeployment());
  }

  setDeployment(
    actorId: string,
    input: NativeRpcInputs["config"]["setDeployment"],
  ): NativeStoreResult<NativeRpcOutputs["config"]["readDeployment"]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.requireOwner(actorId);
        const current = yield* this.getDeployment();
        if (input.expectedRevision !== current.revision)
          return Result.err(
            nativeFailure("conflict", "Deployment settings changed since they were loaded"),
          );
        if (fingerprint(current.settings) === fingerprint(input.settings))
          return Result.ok(current);
        const value = {
          settings: {
            ...input.settings,
            dmContextGapMs: input.settings.dmContextGapMs ?? current.settings.dmContextGapMs,
            dmTimestampGapMs: input.settings.dmTimestampGapMs ?? current.settings.dmTimestampGapMs,
          },
          revision: current.revision + 1,
        };
        this.writeRecord("instance", { kind: "deployment", value });
        return Result.ok(value);
      }, this),
    );
  }

  getUser(id: string): NativeStoreResult<NativeUser> {
    return nativeStoreTransaction(this.db, () =>
      this.readRecord("user", id).andThen((record) =>
        record?.kind === "user"
          ? Result.ok(record.value)
          : Result.err(nativeFailure("not-found", "Native user is unavailable")),
      ),
    );
  }

  findUserByProviderId(providerId: string): NativeStoreResult<NativeUser | null> {
    return nativeStoreTransaction(this.db, () => {
      const row = this.db
        .query<{ id: string }, [string]>("SELECT id FROM native_user_identity WHERE provider_id=?")
        .get(providerId);
      if (!row) return Result.ok(null);
      return this.getUser(row.id);
    });
  }

  upsertUser(user: NativeUser): NativeStoreResult<NativeUser> {
    return nativeStoreTransaction(this.db, () => {
      this.db
        .query(
          "INSERT INTO native_user_identity(id,provider_id,role) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,role=excluded.role",
        )
        .run(user.id, user.providerId, user.role);
      this.writeRecord(user.id, { kind: "user", value: user });
      this.notify("");
      return Result.ok(user);
    });
  }

  setUserProfile(
    actorId: string,
    input: {
      displayName?: string;
      avatar?: NativeUser["avatar"] | null;
      providerAvatarUrl?: string | null;
    },
  ): NativeStoreResult<NativeUser> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const current = yield* this.getUser(actorId);
        if (current.role === "service")
          return Result.err(nativeFailure("forbidden", "Service profiles cannot be edited here"));
        if (
          input.displayName !== undefined &&
          (!input.displayName.trim() || input.displayName.length > 256)
        )
          return Result.err(
            nativeFailure("invalid", "Display name must contain 1 to 256 characters"),
          );
        const { avatar: oldAvatar, providerAvatarUrl: oldProviderAvatarUrl, ...base } = current;
        const avatar = input.avatar === undefined ? oldAvatar : input.avatar;
        const providerAvatarUrl =
          input.providerAvatarUrl === undefined ? oldProviderAvatarUrl : input.providerAvatarUrl;
        const next = {
          ...base,
          displayName: input.displayName?.trim() ?? current.displayName,
          ...(avatar ? { avatar } : {}),
          ...(providerAvatarUrl ? { providerAvatarUrl } : {}),
        };
        if (
          next.displayName === current.displayName &&
          (avatar ?? null) === (oldAvatar ?? null) &&
          (providerAvatarUrl ?? null) === (oldProviderAvatarUrl ?? null)
        )
          return Result.ok(current);
        return this.upsertUser(next);
      }, this),
    );
  }

  setAgentIdentity(
    actorId: string,
    input: {
      displayName?: string;
      avatar?: NativeUser["avatar"] | null;
      discordUserId?: string | null;
    },
  ): NativeStoreResult<NativeUser> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.requireOwner(actorId);
        if (
          input.displayName !== undefined &&
          (!input.displayName.trim() || input.displayName.length > 256)
        )
          return Result.err(
            nativeFailure("invalid", "Agent name must contain 1 to 256 characters"),
          );
        if (input.discordUserId != null && !/^[0-9]{1,20}$/.test(input.discordUserId))
          return Result.err(
            nativeFailure("invalid", "Discord user ID must contain 1 to 20 digits"),
          );
        const current = yield* this.getUser("lilac");
        const { avatar: previousAvatar, discordUserId: previousDiscordId, ...base } = current;
        const avatar = input.avatar === undefined ? previousAvatar : input.avatar;
        const discordUserId =
          input.discordUserId === undefined ? previousDiscordId : input.discordUserId;
        return this.upsertUser({
          ...base,
          displayName: input.displayName ?? current.displayName,
          ...(discordUserId ? { discordUserId } : {}),
          ...(avatar ? { avatar } : {}),
        });
      }, this),
    );
  }

  setToolMode(
    actorId: string,
    userId: string,
    toolMode: NativeUser["toolMode"],
  ): NativeStoreResult<NativeUser> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.requireOwner(actorId);
        const user = yield* this.getUser(userId);
        const next = { ...user, toolMode };
        yield* this.upsertUser(next);
        return Result.ok(next);
      }, this),
    );
  }

  requireOwner(actorId: string): NativeStoreResult<NativeUser> {
    return this.getUser(actorId).andThen((user) =>
      user.role === "owner"
        ? Result.ok(user)
        : Result.err(nativeFailure("forbidden", "Only the owner can perform this operation")),
    );
  }

  getThreadRecord(threadId: string): NativeStoreResult<NativeThreadRecord> {
    return nativeStoreTransaction(this.db, () =>
      this.readRecord("thread", threadId).andThen((record) =>
        record?.kind === "thread"
          ? Result.ok(record.value)
          : Result.err(nativeFailure("not-found", "Thread is unavailable")),
      ),
    );
  }

  ensureAgentStream(input: {
    taskTitle?: string;
    titlePrompt?: string;
    parentThreadId: string;
    parentRequestId: string;
    runId: string;
    requestId: string;
    messages: DisplayMessage[];
    state: ReadyTurnSlot["state"];
    startedAt: number;
  }): NativeStoreResult<NativeAgentStreamRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const id = `agent_${fingerprint({ runId: input.runId }).slice(0, 48)}`;
        const existing = yield* this.readRecord("agent-stream", id);
        if (existing?.kind === "agent-stream") {
          const turn = yield* this.readRecord("turn", existing.value.turnId);
          if (turn?.kind !== "turn" || turn.value.messages.length || !input.messages.length)
            return Result.ok(existing.value);
          this.writeRecord(
            turn.value.turnId,
            { ...turn, value: { ...turn.value, messages: input.messages } },
            id,
          );
          return Result.ok(this.bump(existing.value, "reset", turn.value.turnId));
        }
        const value: NativeAgentStreamRecord = {
          id,
          state: input.state === "pending" || !input.state ? "running" : input.state,
          title: "Thinking…",
          taskTitle: input.taskTitle ?? input.titlePrompt?.replace(/\s+/g, " ").slice(0, 80),
          titlePrompt: input.taskTitle ? undefined : input.titlePrompt?.slice(0, 8000),
          parentThreadId: input.parentThreadId,
          parentRequestId: input.parentRequestId,
          runId: input.runId,
          requestId: input.requestId,
          turnId: randomUUID(),
          historyGeneration: 0,
          revision: 0,
          updatedAt: this.now(),
          deleted: false,
          mutationPending: false,
        };
        this.writeRecord(id, { kind: "agent-stream", value }, input.parentThreadId);
        const slot: ReadyTurnSlot = {
          kind: "ready",
          slotId: value.turnId,
          turnId: value.turnId,
          position: 0,
          state: input.state,
          startedAt: input.startedAt,
          messages: input.messages,
        };
        this.writeRecord(slot.turnId, { kind: "turn", value: slot }, id);
        return Result.ok(this.bump(value, "turn", slot.turnId));
      }, this),
    );
  }

  findAgentStream(runId: string): NativeStoreResult<NativeAgentStreamRecord | null> {
    const id = `agent_${fingerprint({ runId }).slice(0, 48)}`;
    return this.readRecord("agent-stream", id).map((record) =>
      record?.kind === "agent-stream" && !record.value.deleted ? record.value : null,
    );
  }

  settleAgentStream(stream: NativeAgentStreamRecord, state: "complete" | "failed" | "canceled") {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const turn = yield* this.readRecord("turn", stream.turnId);
        if (turn?.kind !== "turn" || turn.value.state === state) return Result.ok(undefined);
        const settledAt = this.now();
        return this.projectTurn(
          stream.id,
          stream.historyGeneration,
          `agent_state_${stream.id}_${state}`,
          stream.turnId,
          (slot) =>
            Result.ok({
              slot: { ...slot, state, settledAt },
              changes: [
                {
                  kind: "turn-state",
                  turnId: slot.turnId,
                  position: slot.position,
                  state,
                  settledAt,
                },
              ],
            }),
        );
      }, this),
    );
  }

  beginAgentOutput(streamId: string, requestId: string) {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const conversation = yield* this.getOutputConversation(streamId);
        if (!("parentThreadId" in conversation))
          return Result.err(nativeFailure("invalid", "Expected an agent stream"));
        const next = {
          ...conversation,
          requestId,
          attemptId: randomUUID(),
          previousAttemptId: conversation.attemptId,
        };
        this.writeRecord(next.id, { kind: "agent-stream", value: next }, next.parentThreadId);
        return Result.ok({
          threadId: next.id,
          parentThreadId: next.parentThreadId,
          turnId: next.turnId,
          generation: next.historyGeneration,
          attemptId: next.attemptId,
          previousAttemptId: next.previousAttemptId,
        });
      }, this),
    );
  }

  private getOutputConversation(id: string): NativeStoreResult<OutputConversation> {
    return Result.gen(function* () {
      const thread = yield* this.readRecord("thread", id);
      if (thread?.kind === "thread") return Result.ok(thread.value);
      const record = yield* this.readRecord("agent-stream", id);
      if (record?.kind !== "agent-stream")
        return Result.err(nativeFailure("not-found", "Display stream is unavailable"));
      const stream = record.value;
      if (stream.deleted)
        return Result.err(nativeFailure("stale", "Agent stream belongs to discarded history"));
      const parent = yield* this.getThreadRecord(stream.parentThreadId);
      const requests = yield* this.listCanonicalRequestIds(parent.id);
      if (parent.deleted || !requests.includes(stream.parentRequestId))
        return Result.err(nativeFailure("stale", "Agent stream belongs to discarded history"));
      return Result.ok(stream);
    }, this);
  }

  getDisplayThread(id: string): NativeStoreResult<NativeThreadRecord> {
    return this.getOutputConversation(id).andThen((conversation) =>
      "parentThreadId" in conversation
        ? this.getThreadRecord(conversation.parentThreadId)
        : Result.ok(conversation),
    );
  }

  private authorizeAgentStream(actorId: string, parentThreadId: string, streamId: string) {
    return Result.gen(function* () {
      yield* this.authorizeThread(actorId, parentThreadId);
      const stream = yield* this.getOutputConversation(streamId);
      if (!("parentThreadId" in stream) || stream.parentThreadId !== parentThreadId)
        return Result.err(nativeFailure("forbidden", "Agent stream belongs to another thread"));
      return Result.ok(stream);
    }, this);
  }

  syncAgentStream(
    actorId: string,
    parentThreadId: string,
    streamId: string,
    checkpoint?: ReplayCheckpoint,
  ) {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeAgentStream(actorId, parentThreadId, streamId).andThen((stream) =>
        this.replay(stream, checkpoint),
      ),
    );
  }

  hydrateAgentStream(
    actorId: string,
    parentThreadId: string,
    streamId: string,
    input: Parameters<NativeStore["hydrate"]>[1],
  ) {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeAgentStream(actorId, parentThreadId, streamId).andThen((stream) =>
        this.hydrateConversation(stream, input),
      ),
    );
  }

  pageAgentStream(
    actorId: string,
    parentThreadId: string,
    streamId: string,
    input: Parameters<NativeStore["turnPage"]>[1],
  ) {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeAgentStream(actorId, parentThreadId, streamId).andThen((stream) =>
        this.pageConversation(stream, input),
      ),
    );
  }

  authorizeThread(
    actorId: string,
    threadId: string,
    edit = false,
  ): NativeStoreResult<NativeThreadRecord> {
    return Result.gen(function* () {
      const user = yield* this.getUser(actorId);
      const thread = yield* this.getThreadRecord(threadId);
      const grant = this.db
        .query<{ grant_mode: NativeThreadGrant }, [string, string]>(
          "SELECT grant_mode FROM native_grants WHERE thread_id=? AND user_id=?",
        )
        .get(threadId, actorId)?.grant_mode;
      const capability = nativeThreadCapabilities(user, thread, grant);
      if (!capability.read || (edit && !capability.edit))
        return Result.err(nativeFailure("forbidden", "Thread access is denied"));
      return Result.ok(thread);
    }, this);
  }

  private displayStatus(
    user: NativeUser,
    thread: NativeThreadRecord,
  ): NativeStoreResult<Pick<NativeThread, "displayStatus" | "workingSince">> {
    // The sidebar needs turn state and the read frontier, never transcript bodies.
    const row = this.db
      .query<
        NativePersistedRow & { last_message_index: number; first_created_at: number | null },
        [string]
      >(
        `SELECT format_version,json_object('kind','turn','value',json_set(json_extract(data_json,'$.value'),'$.messages',json('[]'))) AS data_json,json_array_length(data_json,'$.value.messages')-1 AS last_message_index,json_extract(data_json,'$.value.messages[0].metadata.createdAt') AS first_created_at FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position DESC LIMIT 1`,
      )
      .get(thread.id);
    if (!row) return Result.ok({ displayStatus: thread.activeRunId ? "working" : "idle" });
    const db = this.db;
    // A run that is still going stays "working" so push and browser notifications see one run end.
    const awaitsAnswer = !thread.activeRunId && this.awaitsAnswer(user.id, thread);
    return Result.gen(function* () {
      const { value: record } = yield* decodeNativeRecord(row);
      if (record.kind !== "turn")
        return Result.err(nativeFailure("invalid", "Thread display projection is not a turn"));
      const turn = record.value;
      if (thread.activeRunId || turn.state === "running")
        return Result.ok({
          displayStatus: "working" as const,
          workingSince: turn.startedAt ?? row.first_created_at ?? undefined,
        });
      if (awaitsAnswer) return Result.ok({ displayStatus: "input" as const });
      if (turn.state === "failed") return Result.ok({ displayStatus: "error" as const });
      if (turn.state !== "complete") return Result.ok({ displayStatus: "idle" as const });
      const read = db
        .query<{ position: number; message_index: number }, [string, string, number]>(
          "SELECT position,message_index FROM native_surface_read WHERE thread_id=? AND reader_id=? AND generation=?",
        )
        .get(thread.id, user.id, thread.historyGeneration);
      const checked =
        read !== null &&
        (read.position > turn.position ||
          (read.position === turn.position && read.message_index >= row.last_message_index));
      return Result.ok({ displayStatus: checked ? ("idle" as const) : ("completed" as const) });
    });
  }

  /** A question in the current history still waits for this user's answer. */
  private awaitsAnswer(userId: string, thread: NativeThreadRecord): boolean {
    // instr skips JSON parsing for turns that never asked a question.
    return !!this.db
      .query<{ found: number }, [string, string, number]>(
        "SELECT 1 AS found FROM native_records r WHERE r.kind='turn' AND r.thread_id=? AND instr(r.data_json,'\"data-question\"')>0 AND EXISTS(SELECT 1 FROM json_each(r.data_json,'$.value.messages') m, json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='data-question' AND json_extract(p.value,'$.data.view.state')='pending' AND json_extract(p.value,'$.data.respondentId')=? AND json_extract(p.value,'$.data.historyGeneration')=?) LIMIT 1",
      )
      .get(thread.id, userId, thread.historyGeneration);
  }

  private capabilities(user: NativeUser, thread: NativeThreadRecord): NativeThread["capabilities"] {
    const grant = this.db
      .query<{ grant_mode: NativeThreadGrant }, [string, string]>(
        "SELECT grant_mode FROM native_grants WHERE thread_id=? AND user_id=?",
      )
      .get(thread.id, user.id)?.grant_mode;
    return nativeThreadCapabilities(user, thread, grant);
  }

  private summary(user: NativeUser, thread: NativeThreadRecord): NativeStoreResult<NativeThread> {
    return Result.gen(function* () {
      const starter = yield* this.getUser(thread.starterId);
      const status = yield* this.displayStatus(user, thread);
      return Result.ok({
        id: thread.id,
        kind: thread.kind,
        title: thread.title,
        starterId: thread.starterId,
        starterDisplayName: starter.displayName,
        starterAvatarUrl: nativeUserDisplay(starter).avatarUrl,
        ...status,
        archived: thread.archived,
        updatedAt: thread.updatedAt,
        revision: thread.revision,
        modelId: thread.modelId,
        reasoning: thread.reasoning,
        activeRunId: thread.activeRunId,
        capabilities: this.capabilities(user, thread),
        preview: thread.kind === "dm" ? this.latestTextPreview(thread.id) : undefined,
      });
    }, this);
  }

  private latestTextPreview(threadId: string): NativeThread["preview"] {
    // DMs never end, so read only the newest turns instead of the whole transcript.
    const row = this.db
      .query<{ role: "user" | "assistant"; text: string }, [string]>(
        `SELECT json_extract(m.value,'$.role') AS role,(SELECT group_concat(json_extract(p.value,'$.text'),' ' ORDER BY p.key) FROM json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='text') AS text FROM (SELECT position,data_json FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position DESC LIMIT 4) r,json_each(r.data_json,'$.value.messages') m WHERE json_extract(m.value,'$.role') IN ('user','assistant') AND EXISTS(SELECT 1 FROM json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='text' AND trim(json_extract(p.value,'$.text'))<>'') ORDER BY r.position DESC,m.key DESC LIMIT 1`,
      )
      .get(threadId);
    if (!row) return undefined;
    const text = [...row.text.replace(/\s+/gu, " ").trim()].slice(0, 160).join("");
    return { role: row.role, text };
  }

  getThread(actorId: string, threadId: string): NativeStoreResult<NativeThread> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId);
        const user = yield* this.getUser(actorId);
        return this.summary(user, thread);
      }, this),
    );
  }

  notificationOrigin(actorId: string, threadId: string) {
    return Result.gen(function* () {
      const thread = yield* this.authorizeThread(actorId, threadId);
      const row = this.db
        .query<{ turn_id: string; input_id: string | null }, [string]>(
          "SELECT id AS turn_id,json_extract(data_json,'$.value.messages[0].metadata.inputId') AS input_id FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position DESC LIMIT 1",
        )
        .get(threadId);
      if (!row?.input_id) return Result.ok(undefined);
      const input = yield* this.getInput(row.input_id);
      if (
        input.threadId !== threadId ||
        input.turnId !== row.turn_id ||
        input.historyGeneration !== thread.historyGeneration
      )
        return Result.ok(undefined);
      return Result.ok({
        turnId: row.turn_id,
        generation: thread.historyGeneration,
        userId: input.initiatingUserId,
        deviceId: input.deviceId,
      });
    }, this);
  }

  notificationContent(actorId: string, threadId: string) {
    return Result.gen(function* () {
      const thread = yield* this.getThread(actorId, threadId);
      const row = this.db
        .query<{ text: string | null }, [string]>(
          `SELECT (SELECT group_concat(json_extract(p.value,'$.text'),' ' ORDER BY p.key) FROM json_each(m.value,'$.parts') p WHERE json_extract(p.value,'$.type')='text') AS text FROM (SELECT data_json FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position DESC LIMIT 1) r,json_each(r.data_json,'$.value.messages') m WHERE json_extract(m.value,'$.role')='assistant' AND COALESCE(json_extract(m.value,'$.metadata.phase'),'final')='final' ORDER BY m.key DESC LIMIT 1`,
        )
        .get(threadId);
      const preview = (row?.text ?? "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_#~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const body = thread.displayStatus === "error" ? "Run failed" : preview || "Response finished";
      return Result.ok({
        threadId,
        title: `Lilac · ${thread.title || "Untitled thread"}`,
        body: body.slice(0, 200).replace(/[\uD800-\uDBFF]$/, ""),
        tag: `lilac:${threadId}:${thread.revision}`,
      });
    }, this);
  }

  listThreads(
    actorId: string,
    options: {
      limit?: number;
      before?: number;
      cursor?: string;
      archived?: boolean;
      excludeSettled?: boolean;
      query?: string;
    } = {},
  ): NativeStoreResult<NativeThread[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        if (options.excludeSettled) yield* this.reconcileSidebarPreferences(user);
        const limit = Math.min(100, Math.max(1, options.limit ?? 50));
        const cursorSeparator = options.cursor?.indexOf("_") ?? -1;
        const cursorTime =
          cursorSeparator > 0
            ? Number(options.cursor?.slice(0, cursorSeparator))
            : (options.before ?? Number.MAX_SAFE_INTEGER);
        const cursorId =
          cursorSeparator > 0 ? (options.cursor?.slice(cursorSeparator + 1) ?? "") : "";
        if (!Number.isSafeInteger(cursorTime) || cursorTime < 0)
          return Result.err(nativeFailure("invalid", "Thread cursor is invalid"));
        const records = yield* this.readRows(
          `SELECT r.* FROM native_records r WHERE r.kind='thread' AND (r.updated_at < ? OR (r.updated_at = ? AND r.id > ?)) AND ( ? = 'owner' OR json_extract(r.data_json,'$.value.starterId') = ? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=r.id AND g.user_id=?)) AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL AND json_extract(r.data_json,'$.value.kind') IS NULL AND json_extract(r.data_json,'$.value.archived')=? AND json_extract(r.data_json,'$.value.title') LIKE ? ESCAPE '\\' AND (?=0 OR NOT EXISTS(SELECT 1 FROM native_thread_preferences p WHERE p.user_id=? AND p.thread_id=r.id AND p.section='settled')) ORDER BY r.updated_at DESC,r.id LIMIT ?`,
          [
            cursorTime,
            cursorTime,
            cursorId,
            user.role,
            actorId,
            actorId,
            options.archived ? 1 : 0,
            `%${(options.query ?? "").replace(/[\\%_]/g, "\\$&")}%`,
            options.excludeSettled ? 1 : 0,
            actorId,
            limit,
          ],
        );
        const threads = yield* Result.all(
          records.flatMap((record) =>
            record.kind === "thread" ? [this.summary(user, record.value)] : [],
          ),
        );
        return Result.ok(threads.filter((thread) => thread.capabilities.read));
      }, this),
    );
  }

  getModelFavorites(actorId: string): NativeStoreResult<string[]> {
    return nativeStoreTransaction(this.db, () =>
      this.getUser(actorId).map(() =>
        this.db
          .query<{ modelId: string }, [string]>(
            "SELECT model_id AS modelId FROM native_model_favorites WHERE user_id=? ORDER BY rowid",
          )
          .all(actorId)
          .map((row) => row.modelId),
      ),
    );
  }

  setModelFavorite(
    actorId: string,
    modelId: string,
    favorite: boolean,
  ): NativeStoreResult<string[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const current = yield* this.getModelFavorites(actorId);
        if (favorite && !current.includes(modelId) && current.length >= 100)
          return Result.err(nativeFailure("invalid", "Favorite limit reached"));
        if (favorite)
          this.db
            .query("INSERT OR IGNORE INTO native_model_favorites(user_id,model_id) VALUES(?,?)")
            .run(actorId, modelId);
        if (!favorite)
          this.db
            .query("DELETE FROM native_model_favorites WHERE user_id=? AND model_id=?")
            .run(actorId, modelId);
        return this.getModelFavorites(actorId);
      }, this),
    );
  }

  getSidebarPreferences(actorId: string): NativeStoreResult<SidebarPreferences> {
    return nativeStoreTransaction(this.db, () =>
      this.getUser(actorId).map(() => ({
        autoSettleDays:
          this.db
            .query<{ days: SidebarPreferences["autoSettleDays"] }, [string]>(
              "SELECT auto_settle_days AS days FROM native_user_preferences WHERE user_id=?",
            )
            .get(actorId)?.days ?? 3,
      })),
    );
  }

  configureSidebar(
    actorId: string,
    preferences: SidebarPreferences,
  ): NativeStoreResult<SidebarPreferences> {
    return nativeStoreTransaction(this.db, () =>
      this.getUser(actorId).map(() => {
        this.db
          .query(
            "INSERT INTO native_user_preferences(user_id,auto_settle_days) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET auto_settle_days=excluded.auto_settle_days",
          )
          .run(actorId, preferences.autoSettleDays);
        return preferences;
      }),
    );
  }

  isSidebarThreadSettled(actorId: string, threadId: string): NativeStoreResult<boolean> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        yield* this.reconcileSidebarPreferences(user, threadId);
        const row = this.db
          .query<{ section: string }, [string, string]>(
            "SELECT section FROM native_thread_preferences WHERE user_id=? AND thread_id=?",
          )
          .get(actorId, threadId);
        return Result.ok(row?.section === "settled");
      }, this),
    );
  }

  private reconcileSidebarPreferences(
    user: NativeUser,
    threadId?: string,
  ): NativeStoreResult<void> {
    return this.getSidebarPreferences(user.id).map((preferences) =>
      this.reconcileSidebar(user, preferences.autoSettleDays, threadId),
    );
  }

  private reconcileSidebar(user: NativeUser, days: number, threadId?: string): void {
    const now = this.now();
    const recordFilter = threadId ? " AND r.id=?" : "";
    const preferenceFilter = threadId ? " AND thread_id=?" : "";
    const threadParams = threadId ? [threadId] : [];
    this.db
      .query(`INSERT OR IGNORE INTO native_thread_preferences(user_id,thread_id,section,position,last_activity,touched_at)
      SELECT ?,r.id,'active',MIN(COALESCE((SELECT MIN(p.position) FROM native_thread_preferences p WHERE p.user_id=? AND p.section='active'),0),-json_extract(r.data_json,'$.value.createdAt'))-1,${sidebarActivity},0
      FROM native_records r WHERE r.kind='thread' AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL AND json_extract(r.data_json,'$.value.kind') IS NULL
      AND (?='owner' OR json_extract(r.data_json,'$.value.starterId')=? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=r.id AND g.user_id=?))
      AND NOT EXISTS(SELECT 1 FROM native_thread_preferences p WHERE p.user_id=? AND p.thread_id=r.id)${recordFilter}`)
      .run(user.id, user.id, user.role, user.id, user.id, user.id, ...threadParams);
    const activity = `(SELECT ${sidebarActivity} FROM native_records r WHERE r.kind='thread' AND r.id=native_thread_preferences.thread_id)`;
    this.db
      .query(
        `UPDATE native_thread_preferences SET section='active',position=COALESCE((SELECT MIN(position)-1 FROM native_thread_preferences WHERE user_id=? AND section='active'),0),touched_at=${activity} WHERE user_id=? AND section='settled' AND last_activity < ${activity}${preferenceFilter}`,
      )
      .run(user.id, user.id, ...threadParams);
    this.db
      .query(
        `UPDATE native_thread_preferences SET last_activity=${activity} WHERE user_id=? AND last_activity < ${activity}${preferenceFilter}`,
      )
      .run(user.id, ...threadParams);
    this.db
      .query(
        `UPDATE native_thread_preferences SET section='settled',position=-last_activity WHERE user_id=? AND section='active' AND MAX(last_activity,touched_at)<=? AND NOT EXISTS(SELECT 1 FROM native_records r WHERE r.kind='thread' AND r.id=native_thread_preferences.thread_id AND json_extract(r.data_json,'$.value.activeRunId') IS NOT NULL)${preferenceFilter}`,
      )
      .run(user.id, now - days * 86_400_000, ...threadParams);
  }

  listSidebar(
    actorId: string,
    input: NativeRpcInputs["sidebar"]["list"],
  ): NativeStoreResult<NativeRpcOutputs["sidebar"]["list"]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        const preferences = yield* this.getSidebarPreferences(actorId);
        this.reconcileSidebar(user, preferences.autoSettleDays);
        const separator = input.cursor?.indexOf("_") ?? -1;
        const position = input.cursor
          ? Number(input.cursor.slice(0, separator))
          : Number.MIN_SAFE_INTEGER;
        const cursorId = input.cursor?.slice(separator + 1) ?? "";
        if (input.cursor && (separator < 1 || !Number.isSafeInteger(position) || !cursorId))
          return Result.err(nativeFailure("invalid", "Sidebar cursor is invalid"));
        const predicate = `FROM native_thread_preferences p JOIN native_records r ON r.kind='thread' AND r.id=p.thread_id
        WHERE p.user_id=? AND p.section=? AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL AND json_extract(r.data_json,'$.value.kind') IS NULL AND json_extract(r.data_json,'$.value.archived')=0
        AND (?='owner' OR json_extract(r.data_json,'$.value.starterId')=? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=r.id AND g.user_id=?))`;
        const params = [actorId, input.section, user.role, actorId, actorId];
        const total =
          this.db
            .query<{ total: number }, string[]>(`SELECT COUNT(*) AS total ${predicate}`)
            .get(...params)?.total ?? 0;
        if (input.limit === 0) return Result.ok({ items: [], total });
        const rows = this.db
          .query<{ thread_id: string; position: number }, (string | number)[]>(
            `SELECT p.thread_id,p.position ${predicate} AND (p.position>? OR (p.position=? AND p.thread_id>?)) ORDER BY p.position,p.thread_id LIMIT ?`,
          )
          .all(...params, position, position, cursorId, (input.limit ?? 30) + 1);
        const page = rows.slice(0, input.limit ?? 30);
        const items = yield* Result.all(page.map((row) => this.getThread(actorId, row.thread_id)));
        const last = page.at(-1);
        return Result.ok({
          items,
          total,
          nextCursor:
            rows.length > page.length && last ? `${last.position}_${last.thread_id}` : undefined,
        });
      }, this),
    );
  }

  moveSidebarThread(
    actorId: string,
    input: NativeRpcInputs["sidebar"]["move"],
  ): NativeStoreResult<{ ok: true }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        const thread = yield* this.authorizeThread(actorId, input.threadId);
        if (thread.kind === "dm")
          return Result.err(nativeFailure("forbidden", "The DM has a fixed sidebar position"));
        if (thread.archived)
          return Result.err(nativeFailure("invalid", "Archived conversations cannot be moved"));
        if (input.beforeId === input.threadId || input.afterId === input.threadId)
          return Result.ok({ ok: true as const });
        const preferences = yield* this.getSidebarPreferences(actorId);
        this.reconcileSidebar(user, preferences.autoSettleDays);
        this.db
          .query(`WITH ranks AS MATERIALIZED (
          SELECT thread_id,ROW_NUMBER() OVER(ORDER BY position,thread_id) AS rank
          FROM native_thread_preferences WHERE user_id=? AND section=?
        ) UPDATE native_thread_preferences SET position=(SELECT rank FROM ranks WHERE ranks.thread_id=native_thread_preferences.thread_id)
          WHERE user_id=? AND section=?`)
          .run(actorId, input.section, actorId, input.section);
        let position: number;
        const neighborId = input.beforeId ?? input.afterId;
        if (neighborId) {
          yield* this.authorizeThread(actorId, neighborId);
          const before = this.db
            .query<{ position: number }, [string, string, string]>(
              "SELECT position FROM native_thread_preferences WHERE user_id=? AND thread_id=? AND section=?",
            )
            .get(actorId, neighborId, input.section);
          if (!before)
            return Result.err(nativeFailure("conflict", "Drop target has moved. Try again."));
          position = before.position + (input.afterId ? 1 : 0);
          this.db
            .query(
              "UPDATE native_thread_preferences SET position=position+1 WHERE user_id=? AND section=? AND position>=?",
            )
            .run(actorId, input.section, position);
        } else if (input.atStart) {
          position =
            (this.db
              .query<{ position: number | null }, [string, string]>(
                "SELECT MIN(position) AS position FROM native_thread_preferences WHERE user_id=? AND section=?",
              )
              .get(actorId, input.section)?.position ?? -this.now()) - 1;
        } else {
          position =
            (this.db
              .query<{ position: number | null }, [string, string]>(
                "SELECT MAX(position) AS position FROM native_thread_preferences WHERE user_id=? AND section=?",
              )
              .get(actorId, input.section)?.position ?? -this.now()) + 1;
        }
        this.db
          .query(
            "UPDATE native_thread_preferences SET section=?,position=?,touched_at=CASE WHEN section=? THEN touched_at ELSE ? END WHERE user_id=? AND thread_id=?",
          )
          .run(input.section, position, input.section, this.now(), actorId, input.threadId);
        return Result.ok({ ok: true as const });
      }, this),
    );
  }

  private command(
    actorId: string,
    commandId: string,
    payload: object,
    run: () => NativeStoreResult<NativeMutationResult>,
  ): NativeStoreResult<NativeMutationResult> {
    return Result.gen(function* () {
      const key = commandKey(actorId, commandId);
      const hash = fingerprint(payload);
      const existing = yield* this.readRecord("command", key);
      if (existing?.kind === "command") {
        if (existing.value.fingerprint !== hash)
          return Result.err(
            nativeFailure("conflict", "Command ID was already used with different content"),
          );
        return Result.ok(existing.value.result);
      }
      const result = yield* run();
      this.writeRecord(
        key,
        { kind: "command", value: { id: commandId, actorId, fingerprint: hash, result } },
        result.threadId,
      );
      return Result.ok(result);
    }, this);
  }

  private bump<T extends OutputConversation>(
    thread: T,
    kind: string,
    recordId: string,
    changes: LiveUpdate["changes"] = [],
  ): T {
    const next = { ...thread, revision: thread.revision + 1, updatedAt: this.now() };
    if ("parentThreadId" in next)
      this.writeRecord(next.id, { kind: "agent-stream", value: next }, next.parentThreadId);
    else this.writeRecord(next.id, { kind: "thread", value: next }, next.id);
    const boundedChanges =
      encoder.encode(JSON.stringify(changes)).byteLength < WINDOW_BYTES && changes.length <= 128
        ? changes
        : [];
    const replay: NativeRecord = {
      kind: "replay",
      value: { checkpoint: this.checkpoint(next), changes: boundedChanges },
    };
    const data = JSON.stringify(replay);
    this.db
      .query(
        "INSERT INTO native_changes(thread_id,revision,generation,created_at,byte_size,kind,record_id,data_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        next.id,
        next.revision,
        next.historyGeneration,
        next.updatedAt,
        encoder.encode(data).byteLength,
        boundedChanges === changes ? kind : "reset",
        recordId,
        data,
      );
    this.notify(thread.id);
    return next;
  }

  ensureDirectThread(actorId: string): NativeStoreResult<NativeThread> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        if (user.role === "service")
          return Result.err(nativeFailure("forbidden", "Service identity cannot start a DM"));
        const existing = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.kind')='dm' AND json_extract(data_json,'$.value.starterId')=?",
          [actorId],
        );
        const record = existing[0];
        if (record?.kind === "thread") return this.getThread(actorId, record.value.id);
        const id = randomUUID();
        this.bump(
          {
            id,
            kind: "dm",
            title: "Chat with Lilac",
            starterId: actorId,
            archived: false,
            deleted: false,
            createdAt: this.now(),
            updatedAt: this.now(),
            revision: 0,
            historyGeneration: 0,
            nextPosition: 0,
            mutationPending: false,
          },
          "thread",
          id,
        );
        return this.getThread(actorId, id);
      }, this),
    );
  }

  createThread(
    actorId: string,
    input: {
      commandId: string;
      title?: string;
      autoTitle?: boolean;
      modelId?: string;
      reasoning?: ModelReasoning;
      ephemeralSessionId?: string;
    },
  ): NativeStoreResult<NativeThread> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        if (user.role === "service")
          return Result.err(
            nativeFailure("forbidden", "Service identity cannot start a user thread"),
          );
        const result = yield* this.command(
          actorId,
          input.commandId,
          { operation: "create", ...input },
          () => {
            const id = randomUUID();
            const thread: NativeThreadRecord = {
              id,
              starterId: actorId,
              ephemeral: input.ephemeralSessionId
                ? { sessionId: input.ephemeralSessionId, lastSeenAt: this.now() }
                : undefined,
              title: input.title ?? "New thread",
              titleGeneration:
                (input.autoTitle ?? input.title === undefined) ? { phase: "initial" } : undefined,
              archived: false,
              deleted: false,
              createdAt: this.now(),
              updatedAt: this.now(),
              revision: 0,
              historyGeneration: 0,
              nextPosition: 0,
              modelId: input.modelId,
              reasoning: input.reasoning,
              mutationPending: false,
            };
            this.bump(thread, "thread", id);
            return Result.ok({ threadId: id });
          },
        );
        return this.getThread(actorId, result.threadId);
      }, this),
    );
  }

  listEphemeralThreads(): NativeStoreResult<NativeThreadRecord[]> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT * FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.ephemeral') IS NOT NULL AND (json_extract(data_json,'$.value.deleted')=0 OR json_extract(data_json,'$.value.mutationPending')=1)",
        [],
      ).map((records) =>
        records.flatMap((record) => (record.kind === "thread" ? [record.value] : [])),
      ),
    );
  }

  getEphemeralThread(sessionId: string): NativeStoreResult<NativeThreadRecord | undefined> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT * FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.ephemeral.sessionId')=? LIMIT 1",
        [sessionId],
      ).map(
        (records) =>
          records.flatMap((record) => (record.kind === "thread" ? [record.value] : []))[0],
      ),
    );
  }

  touchEphemeralThread(threadId: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getThreadRecord(threadId);
        if (!thread.ephemeral || thread.deleted || thread.mutationPending)
          return Result.err(nativeFailure("not-found", "Temporary conversation has ended"));
        this.writeRecord(
          thread.id,
          {
            kind: "thread",
            value: { ...thread, ephemeral: { ...thread.ephemeral, lastSeenAt: this.now() } },
          },
          thread.id,
        );
        return Result.ok();
      }, this),
    );
  }

  updateThread(
    actorId: string,
    input: {
      threadId: string;
      commandId: string;
      title?: string;
      archived?: boolean;
      modelId?: string;
      reasoning?: ModelReasoning;
      revision?: number;
    },
  ): NativeStoreResult<NativeThread> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId, true);
        if (thread.kind === "dm" && (input.title !== undefined || input.archived !== undefined))
          return Result.err(nativeFailure("forbidden", "The DM cannot be renamed or archived"));
        yield* this.command(actorId, input.commandId, { operation: "update", ...input }, () => {
          if (input.revision !== undefined && input.revision !== thread.revision)
            return Result.err(nativeFailure("stale", "Thread changed before this update"));
          this.bump(
            {
              ...thread,
              title: input.title ?? thread.title,
              titleGeneration: input.title === undefined ? thread.titleGeneration : undefined,
              archived: input.archived ?? thread.archived,
              modelId: input.modelId ?? thread.modelId,
              reasoning:
                input.reasoning ??
                (input.modelId && input.modelId !== thread.modelId ? undefined : thread.reasoning),
            },
            "thread",
            thread.id,
          );
          return Result.ok({ threadId: thread.id });
        });
        return this.getThread(actorId, thread.id);
      }, this),
    );
  }

  getTitleGeneration(threadId: string): NativeStoreResult<{
    inputId: string;
    phase: "initial" | "refine";
    user: string;
    assistant?: string;
  } | null> {
    return Result.gen(function* () {
      const agentStream = yield* this.readRecord("agent-stream", threadId);
      if (agentStream?.kind === "agent-stream") {
        const stream = agentStream.value;
        return Result.ok(
          stream.titlePrompt && !stream.deleted
            ? { inputId: stream.requestId, phase: "initial" as const, user: stream.titlePrompt }
            : null,
        );
      }
      const thread = yield* this.getThreadRecord(threadId);
      const state = thread.titleGeneration;
      if (
        !state?.inputId ||
        thread.deleted ||
        thread.mutationPending ||
        thread.historyGeneration !== 0
      )
        return Result.ok(null);
      const input = yield* this.getInput(state.inputId);
      if (input.state === "canceled" || input.state === "failed") return Result.ok(null);
      const uploads = yield* Result.all(input.attachmentIds.map((id) => this.getUpload(id)));
      const user = [input.text, ...uploads.map((upload) => `Attachment: ${upload.filename}`)]
        .join("\n")
        .slice(0, 8000);
      if (state.phase === "initial")
        return Result.ok({ inputId: input.id, phase: state.phase, user });
      const turn = input.turnId ? yield* this.readRecord("turn", input.turnId) : null;
      if (turn?.kind !== "turn" || turn.value.state !== "complete") return Result.ok(null);
      const hasText = (message: DisplayMessage) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "text" && part.text.trim());
      const message =
        turn.value.messages.findLast(
          (message) => message.metadata?.phase === "final" && hasText(message),
        ) ??
        turn.value.messages.findLast(
          (message) => message.metadata?.phase === undefined && hasText(message),
        );
      const assistant = message?.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .slice(0, 4000);
      if (!assistant) return Result.ok(null);
      return Result.ok({ inputId: input.id, phase: state.phase, user, assistant });
    }, this);
  }

  private settleAgentTitle(
    stream: NativeAgentStreamRecord,
    requestId: string,
    title?: string,
  ): NativeStoreResult<void> {
    if (stream.deleted || !stream.titlePrompt || stream.requestId !== requestId)
      return Result.ok(undefined);
    this.writeRecord(
      stream.id,
      {
        kind: "agent-stream",
        value: { ...stream, taskTitle: title ?? stream.taskTitle, titlePrompt: undefined },
      },
      stream.parentThreadId,
    );
    this.notifyDisplayChanged(stream.parentThreadId);
    return Result.ok(undefined);
  }

  settleTitleGeneration(
    threadId: string,
    expected: { inputId: string; phase: "initial" | "refine" },
    generated?: { title: string; needsRefinement: boolean },
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const agent = yield* this.readRecord("agent-stream", threadId);
        if (agent?.kind === "agent-stream")
          return this.settleAgentTitle(agent.value, expected.inputId, generated?.title);
        const thread = yield* this.getThreadRecord(threadId);
        const state = thread.titleGeneration;
        if (
          thread.deleted ||
          thread.mutationPending ||
          thread.historyGeneration !== 0 ||
          state?.inputId !== expected.inputId ||
          state.phase !== expected.phase
        )
          return Result.ok(undefined);
        this.bump(
          {
            ...thread,
            title: generated?.title ?? thread.title,
            titleGeneration:
              generated?.needsRefinement && state.phase === "initial"
                ? { phase: "refine", inputId: state.inputId }
                : undefined,
          },
          "thread",
          thread.id,
        );
        return Result.ok(undefined);
      }, this),
    );
  }

  shareThread(
    actorId: string,
    input: { threadId: string; userId: string; grant: NativeThreadGrant | null },
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.requireOwner(actorId);
        const thread = yield* this.authorizeThread(actorId, input.threadId);
        if (thread.kind === "dm")
          return Result.err(nativeFailure("forbidden", "The DM cannot be shared"));
        yield* this.getUser(input.userId);
        if (input.grant === null)
          this.db
            .query("DELETE FROM native_grants WHERE thread_id=? AND user_id=?")
            .run(input.threadId, input.userId);
        if (input.grant !== null)
          this.db
            .query(
              "INSERT INTO native_grants(thread_id,user_id,grant_mode) VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET grant_mode=excluded.grant_mode",
            )
            .run(input.threadId, input.userId, input.grant);
        this.bump(thread, "access", input.userId);
        return Result.ok(undefined);
      }, this),
    );
  }

  getCheckpoint(actorId: string, threadId: string): NativeStoreResult<ReplayCheckpoint> {
    return this.authorizeThread(actorId, threadId).map((thread) => this.checkpoint(thread));
  }

  private checkpoint(thread: ReplayConversation): ReplayCheckpoint {
    return {
      protocolVersion: 1,
      historyGeneration: thread.historyGeneration,
      projectionRevision: thread.revision,
      cursor: `n_${thread.id}_${thread.historyGeneration}_${thread.revision}`,
    };
  }

  private window(
    thread: ReplayConversation,
    before = Number.MAX_SAFE_INTEGER,
    limit = 5,
  ): NativeStoreResult<TurnSlot[]> {
    return Result.gen(function* () {
      const records = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='turn' AND thread_id=? AND position<? ORDER BY position DESC LIMIT ?",
        [thread.id, before, Math.min(32, limit)],
      );
      const turns: ReadyTurnSlot[] = [];
      let bytes = 0;
      for (const record of records) {
        if (record.kind !== "turn") continue;
        const size = encoder.encode(JSON.stringify(this.boundedTurn(record.value))).byteLength;
        if (turns.length > 0 && bytes + size > WINDOW_BYTES) break;
        turns.push(this.boundedTurn(record.value));
        bytes += size;
      }
      turns.reverse();
      const first = turns[0];
      const slots: TurnSlot[] = [...turns];
      if (
        first &&
        this.db
          .query(
            "SELECT 1 FROM native_records WHERE kind='turn' AND thread_id=? AND position<? LIMIT 1",
          )
          .get(thread.id, first.position)
      )
        slots.unshift({
          kind: "deferred",
          slotId: `range_${thread.historyGeneration}_0_${first.position}`,
          position: 0,
          endPosition: first.position,
        });
      return Result.ok(slots);
    }, this);
  }

  sync(
    actorId: string,
    threadId: string,
    checkpoint?: ReplayCheckpoint,
  ): NativeStoreResult<ReplayReply> {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeThread(actorId, threadId).andThen((thread) => this.replay(thread, checkpoint)),
    );
  }

  private replay(
    thread: ReplayConversation,
    checkpoint?: ReplayCheckpoint,
  ): NativeStoreResult<ReplayReply> {
    return Result.gen(function* () {
      const next = this.checkpoint(thread);
      if (
        checkpoint?.cursor === next.cursor &&
        checkpoint.historyGeneration === thread.historyGeneration &&
        checkpoint.projectionRevision === thread.revision
      )
        return Result.ok({ kind: "unchanged" as const, checkpoint: next });
      if (
        checkpoint &&
        checkpoint.cursor ===
          `n_${thread.id}_${checkpoint.historyGeneration}_${checkpoint.projectionRevision}` &&
        checkpoint.historyGeneration === thread.historyGeneration &&
        checkpoint.projectionRevision < thread.revision
      ) {
        const rows = this.db
          .query<NativePersistedRow & { revision: number; kind: string }, [string, number]>(
            "SELECT format_version,data_json,revision,kind FROM native_changes WHERE thread_id=? AND revision>? ORDER BY revision LIMIT 65",
          )
          .all(thread.id, checkpoint.projectionRevision);
        if (
          rows.length > 0 &&
          rows.length <= 64 &&
          rows[0]?.revision === checkpoint.projectionRevision + 1 &&
          rows.at(-1)?.revision === thread.revision
        ) {
          const decoded = yield* Result.all(rows.map((row) => decodeNativeRecord(row)));
          const changes = decoded.flatMap((record) =>
            record.value.kind === "replay" ? record.value.value.changes : [],
          );
          const complete = rows.every((row) => row.kind !== "reset");
          if (
            complete &&
            changes.length <= 128 &&
            encoder.encode(JSON.stringify(changes)).byteLength < WINDOW_BYTES
          )
            return Result.ok({
              kind: "delta" as const,
              checkpoint: next,
              fromRevision: checkpoint.projectionRevision,
              changes,
            });
        }
      }
      const slots = yield* this.window(thread);
      return Result.ok({ kind: "window" as const, checkpoint: next, slots });
    }, this);
  }

  hydrate(
    actorId: string,
    input: {
      threadId: string;
      historyGeneration: number;
      projectionRevision: number;
      slotId: string;
      position?: number;
      endPosition?: number;
    },
  ): NativeStoreResult<Hydration> {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeThread(actorId, input.threadId).andThen((thread) =>
        this.hydrateConversation(thread, input),
      ),
    );
  }

  private hydrateConversation(
    thread: ReplayConversation,
    input: {
      threadId: string;
      historyGeneration: number;
      projectionRevision: number;
      slotId: string;
      position?: number;
      endPosition?: number;
    },
  ): NativeStoreResult<Hydration> {
    return Result.gen(function* () {
      if (
        thread.historyGeneration !== input.historyGeneration ||
        thread.revision !== input.projectionRevision
      )
        return Result.err(nativeFailure("stale", "History changed before hydration"));
      const endPosition = Number(input.slotId.split("_")[3]);
      if (
        !Number.isSafeInteger(endPosition) ||
        endPosition <= 0 ||
        input.slotId !== `range_${thread.historyGeneration}_0_${endPosition}`
      )
        return Result.err(nativeFailure("invalid", "Hydration slot is invalid"));
      const slots = yield* this.window(thread, endPosition);
      return Result.ok({
        historyGeneration: thread.historyGeneration,
        projectionRevision: thread.revision,
        slotId: input.slotId,
        slots,
      });
    }, this);
  }

  getInput(inputId: string): NativeStoreResult<NativeInputRecord> {
    return nativeStoreTransaction(this.db, () =>
      this.readRecord("input", inputId).andThen((record) =>
        record?.kind === "input"
          ? Result.ok(record.value)
          : Result.err(nativeFailure("not-found", "Input is unavailable")),
      ),
    );
  }

  getInputByDeliveryId(deliveryId: string): NativeStoreResult<NativeInputRecord | null> {
    return this.findInput("deliveryId", deliveryId);
  }
  getInputByRequestId(requestId: string): NativeStoreResult<NativeInputRecord | null> {
    return this.findInput("requestId", requestId);
  }

  private findInput(
    field: "deliveryId" | "requestId",
    value: string,
  ): NativeStoreResult<NativeInputRecord | null> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        `SELECT * FROM native_records WHERE kind='input' AND json_extract(data_json,'$.value.${field}')=? LIMIT 1`,
        [value],
      ).map((records) => {
        const record = records[0];
        return record?.kind === "input" ? record.value : null;
      }),
    );
  }

  listPendingInputs(threadId?: string): NativeStoreResult<NativeInputRecord[]> {
    const sql =
      "SELECT * FROM native_records INDEXED BY native_pending_inputs WHERE kind='input' AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL";
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        `${sql}${threadId ? " AND thread_id=?" : ""} ORDER BY position,id`,
        threadId ? [threadId] : [],
      ).map((records) =>
        records.flatMap((record) => (record.kind === "input" ? [record.value] : [])),
      ),
    );
  }

  private nextTurnPosition(threadId: string): number {
    return (
      this.db
        .query<{ position: number }, [string]>(
          "SELECT COALESCE(MAX(position)+1,0) AS position FROM native_records WHERE kind='turn' AND thread_id=?",
        )
        .get(threadId)?.position ?? 0
    );
  }

  private createInputTurn(
    thread: NativeThreadRecord,
    input: NativeInputRecord,
    uploads: NativeUploadRecord[],
  ): NativeInputRecord {
    const turnId = input.turnId ?? randomUUID();
    const message: DisplayMessage = {
      id: input.messageId,
      role: "user",
      metadata: {
        authorId: input.authorId,
        createdAt: input.createdAt,
        inputId: input.id,
        inputMode: input.mode,
      },
      parts: [
        ...nativeTextParts(input.text),
        ...uploads.map((upload) => ({
          type: "data-resource" as const,
          id: upload.id,
          data: {
            resourceId: upload.id,
            name: upload.filename,
            mediaType: upload.mediaType,
            size: upload.size,
            state: upload.state,
          },
        })),
      ],
    };
    const slot: ReadyTurnSlot = {
      kind: "ready",
      slotId: turnId,
      turnId,
      position: this.nextTurnPosition(thread.id),
      messages: [message],
      state: "pending",
    };
    this.writeRecord(turnId, { kind: "turn", value: slot }, thread.id, slot.position);
    return { ...input, turnId };
  }

  acceptInput(
    actorId: string,
    input: NativeInput,
    options: {
      resolvedModelId?: string;
      resolvedModelRequest?: DurableResolvedModelRequest;
      activeRunId?: string;
      authorId?: string;
    } = {},
  ): NativeStoreResult<NativeInputReceipt> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        let thread = yield* this.authorizeThread(actorId, input.threadId, true);
        const result = yield* this.command(
          actorId,
          input.commandId,
          { operation: "input", ...input },
          () =>
            Result.gen(function* () {
              if (thread.historyGeneration !== input.historyGeneration || thread.mutationPending)
                return Result.err(nativeFailure("stale", "Thread history is changing"));
              const question = input.questionReply
                ? yield* this.authorizeQuestionReply(
                    actorId,
                    input.threadId,
                    input.historyGeneration,
                    input.questionReply,
                  )
                : undefined;
              if (question && !input.text.trim() && input.attachmentIds.length === 0)
                return Result.err(
                  nativeFailure("invalid", "A question reply requires text or an attachment"),
                );
              if (question && input.command)
                return Result.err(nativeFailure("invalid", "Commands cannot answer a question"));
              const answeringActiveSync =
                question?.mode === "sync" && thread.activeRunId === question.requestId;
              const requestedMode = input.command && thread.activeRunId ? "followup" : input.mode;
              const effectiveMode = answeringActiveSync ? "steer" : requestedMode;
              const pendingCount =
                this.db
                  .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) AS count FROM native_records INDEXED BY native_pending_inputs WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.completedAt') IS NULL AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.state') IN ('uploading','queued')",
                  )
                  .get(thread.id)?.count ?? 0;
              if (pendingCount >= 128)
                return Result.err(
                  nativeFailure("conflict", "Thread already has 128 pending inputs"),
                );
              if (effectiveMode !== "prompt" && !thread.activeRunId)
                return Result.err(nativeFailure("stale", "There is no active run for this input"));
              if (effectiveMode === "prompt" && thread.activeRunId)
                return Result.err(
                  nativeFailure("conflict", "Choose steering or follow-up while a run is active"),
                );
              const uploads = yield* Result.all(
                input.attachmentIds.map((id) => this.getUpload(id)),
              );
              for (const upload of uploads) {
                if (upload.published && upload.state === "ready") {
                  yield* this.authorizeThread(actorId, upload.threadId);
                  continue;
                }
                if (
                  upload.threadId !== input.threadId ||
                  upload.ownerId !== actorId ||
                  upload.historyGeneration !== thread.historyGeneration ||
                  upload.state === "canceled"
                )
                  return Result.err(
                    nativeFailure("forbidden", "Attachment is unavailable to this input"),
                  );
              }
              if (question && uploads.some((upload) => upload.state !== "ready"))
                return Result.err(
                  nativeFailure("conflict", "Wait for question attachments to finish uploading"),
                );
              const id = randomUUID();
              const messageId = randomUUID();
              let accepted: NativeInputRecord = {
                id,
                commandId: input.commandId,
                threadId: input.threadId,
                authorId: options.authorId ?? actorId,
                initiatingUserId: actorId,
                deviceId: input.deviceId,
                requestId: `native:${thread.id}:${messageId}`,
                deliveryId: randomUUID(),
                messageId,
                position: thread.nextPosition,
                historyGeneration: thread.historyGeneration,
                text: input.text,
                questionReply: input.questionReply,
                mode: effectiveMode,
                runId: thread.activeRunId,
                state: uploads.some((upload) => upload.state !== "ready") ? "uploading" : "queued",
                attachmentIds: [...input.attachmentIds],
                skillIds: [...input.skillIds],
                modelId: options.resolvedModelId ?? input.modelId ?? thread.modelId,
                reasoning:
                  input.reasoning ??
                  (input.modelId && input.modelId !== thread.modelId
                    ? undefined
                    : thread.reasoning),
                resolvedModelRequest: options.resolvedModelRequest,
                command: input.command,
                createdAt: this.now(),
              };
              if (question) {
                yield* this.updateQuestion(actorId, thread.id, {
                  ...question,
                  prompts:
                    question.prompts ??
                    (question.view.state === "pending" ? [question.view.prompt] : undefined),
                  view: {
                    state: "answered",
                    summary: { answers: [] },
                    replyMessageId: messageId,
                    replyInputId: id,
                  },
                });
                thread = yield* this.getThreadRecord(thread.id);
              }
              const earlierFull = this.db
                .query(
                  "SELECT 1 FROM native_records INDEXED BY native_pending_inputs WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.mode')!='steer' AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL LIMIT 1",
                )
                .get(thread.id);
              if (effectiveMode === "prompt" && !earlierFull)
                accepted = this.createInputTurn(thread, accepted, uploads);
              if (effectiveMode === "steer") {
                const activeInput = yield* this.getInputByRequestId(thread.activeRunId ?? "");
                accepted = {
                  ...accepted,
                  turnId: activeInput?.turnId,
                  resolvedModelRequest: activeInput?.resolvedModelRequest,
                };
                if (accepted.turnId) {
                  yield* this.appendMessage(thread.id, thread.historyGeneration, accepted.turnId, {
                    id: accepted.messageId,
                    role: "user",
                    metadata: {
                      authorId: accepted.authorId,
                      createdAt: accepted.createdAt,
                      inputId: accepted.id,
                      inputMode: "steer",
                    },
                    parts: [
                      ...nativeTextParts(accepted.text),
                      ...uploads.map((upload) => ({
                        type: "data-resource" as const,
                        id: upload.id,
                        data: {
                          resourceId: upload.id,
                          name: upload.filename,
                          mediaType: upload.mediaType,
                          size: upload.size,
                          state: upload.state,
                        },
                      })),
                    ],
                  });
                  thread = yield* this.getThreadRecord(thread.id);
                }
              }
              for (const upload of uploads)
                this.writeRecord(
                  upload.id,
                  { kind: "upload", value: { ...upload, published: true } },
                  upload.threadId,
                );
              this.writeRecord(
                id,
                { kind: "input", value: accepted },
                thread.id,
                accepted.position,
              );
              const visible = accepted.turnId
                ? yield* this.readRecord("turn", accepted.turnId)
                : null;
              const changes: LiveUpdate["changes"] =
                accepted.mode === "prompt" && visible?.kind === "turn"
                  ? [{ kind: "insert", slot: visible.value }]
                  : [];
              this.bump(
                {
                  ...thread,
                  nextPosition: thread.nextPosition + 1,
                  titleGeneration:
                    thread.nextPosition === 0 && thread.titleGeneration
                      ? { phase: "initial", inputId: id }
                      : thread.titleGeneration,
                },
                "input",
                id,
                changes,
              );
              return Result.ok({ threadId: input.threadId, inputId: id });
            }, this),
        );
        if (!result.inputId)
          return Result.err(nativeFailure("invalid", "Input receipt is missing its identity"));
        const accepted = yield* this.getInput(result.inputId);
        return Result.ok(inputReceipt(accepted));
      }, this),
    );
  }

  prepareInput(inputId: string): NativeStoreResult<NativeInputRecord | null> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        let input = yield* this.getInput(inputId);
        const thread = yield* nullableAuthority(
          this.authorizeThread(input.initiatingUserId, input.threadId, true),
        );
        if (!thread) {
          yield* this.settleInput(input.id, "failed");
          return Result.ok(null);
        }
        const starter = yield* nullableAuthority(this.getUser(thread.starterId));
        if (!starter) {
          yield* this.settleInput(input.id, "failed");
          return Result.ok(null);
        }
        if (
          input.historyGeneration !== thread.historyGeneration ||
          thread.mutationPending ||
          input.state === "canceled" ||
          input.state === "failed" ||
          input.state === "target-ended"
        )
          return Result.ok(null);
        if (input.mode === "steer" && input.runId !== thread.activeRunId) {
          yield* this.settleInput(input.id, "target-ended");
          return Result.ok(null);
        }
        if (input.state === "admitted") return Result.ok(input);
        const uploads = yield* Result.all(input.attachmentIds.map((id) => this.getUpload(id)));
        if (uploads.some((upload) => upload.state !== "ready" || !upload.resourceUri))
          return Result.ok(null);
        const pending = yield* this.listPendingInputs(thread.id);
        if (
          input.mode !== "steer" &&
          pending.some((item) => item.mode !== "steer" && item.position < input.position)
        )
          return Result.ok(null);
        if (input.mode !== "steer" && thread.activeRunId) return Result.ok(null);
        let pinnedToolMode = starter.toolMode;
        if (input.mode === "steer" && input.runId) {
          const activeInput = yield* this.getInputByRequestId(input.runId);
          if (!activeInput?.pinnedToolMode)
            return Result.err(nativeFailure("stale", "Active run authority is unavailable"));
          pinnedToolMode = activeInput.pinnedToolMode;
        }
        for (const upload of uploads) {
          const origin = yield* nullableAuthority(
            this.authorizeThread(starter.id, upload.threadId),
          );
          if (origin) continue;
          yield* this.settleInput(input.id, "failed");
          return Result.ok(null);
        }
        if (!input.turnId) {
          input = this.createInputTurn(thread, input, uploads);
          const turn = yield* this.readRecord("turn", input.turnId ?? "");
          if (turn?.kind === "turn")
            this.bump(thread, "turn", turn.value.turnId, [{ kind: "insert", slot: turn.value }]);
        }
        input = { ...input, state: "queued", pinnedToolMode };
        this.writeRecord(input.id, { kind: "input", value: input }, thread.id, input.position);
        return Result.ok(input);
      }, this),
    );
  }

  settleInput(
    inputId: string,
    state: NativeInputRecord["state"],
  ): NativeStoreResult<NativeInputRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const input = yield* this.getInput(inputId);
        const thread = yield* this.getThreadRecord(input.threadId);
        if (input.state === state) return Result.ok(input);
        if (
          input.state === "canceled" ||
          input.state === "target-ended" ||
          thread.deleted ||
          input.historyGeneration !== thread.historyGeneration
        )
          return Result.err(nativeFailure("stale", "Input is no longer active"));
        const next = { ...input, state };
        this.writeRecord(input.id, { kind: "input", value: next }, thread.id, input.position);
        const changes = yield* this.terminalInputProjection(input, state);
        this.bump(thread, "input", input.id, changes);
        return Result.ok(next);
      }, this),
    );
  }

  setInputCanonicalHistoryStart(inputId: string, requestId: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const input = yield* this.getInput(inputId);
        const thread = yield* this.getThreadRecord(input.threadId);
        if (
          input.state !== "admitted" ||
          thread.deleted ||
          thread.mutationPending ||
          input.historyGeneration !== thread.historyGeneration
        )
          return Result.err(nativeFailure("stale", "Input is not admitted in the current history"));
        if (input.canonicalHistoryStartRequestId === requestId) return Result.ok(undefined);
        if (input.canonicalHistoryStartRequestId !== undefined)
          return Result.err(
            nativeFailure("conflict", "Canonical history boundary is already pinned"),
          );
        const first = yield* this.getInputByRequestId(requestId);
        if (
          !first ||
          first.threadId !== input.threadId ||
          first.mode === "steer" ||
          first.position > input.position ||
          !first.turnId
        )
          return Result.err(
            nativeFailure("invalid", "Canonical history boundary is not a preceding full turn"),
          );
        const turn = yield* this.readRecord("turn", first.turnId);
        if (turn?.kind !== "turn")
          return Result.err(
            nativeFailure("stale", "Canonical history boundary is no longer retained"),
          );
        this.writeRecord(
          input.id,
          { kind: "input", value: { ...input, canonicalHistoryStartRequestId: requestId } },
          thread.id,
          input.position,
        );
        return Result.ok(undefined);
      }, this),
    );
  }

  markInputCompleted(inputId: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const input = yield* this.getInput(inputId);
        const thread = yield* this.getThreadRecord(input.threadId);
        if (
          thread.deleted ||
          input.historyGeneration !== thread.historyGeneration ||
          (input.state !== "admitted" && input.state !== "canceled")
        )
          return Result.err(nativeFailure("stale", "Completed input belongs to discarded history"));
        this.writeRecord(
          input.id,
          { kind: "input", value: { ...input, completedAt: this.now() } },
          thread.id,
          input.position,
        );
        return Result.ok(undefined);
      }, this),
    );
  }

  selectCanonicalInput(
    threadId: string,
    options: { since?: number; before?: number } = {},
  ): NativeStoreResult<NativeInputRecord | null> {
    const index =
      options.before === undefined ? "native_input_created" : "native_records_thread_position";
    const order =
      options.before === undefined
        ? "json_extract(i.data_json,'$.value.createdAt'),i.position"
        : "i.position DESC";
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        `SELECT i.* FROM native_records i INDEXED BY ${index} WHERE i.kind='input' AND i.thread_id=? AND json_extract(i.data_json,'$.value.createdAt')>=? AND i.position<? AND ${CANONICAL_INPUT_FILTER} ORDER BY ${order} LIMIT 1`,
        [threadId, options.since ?? 0, options.before ?? Number.MAX_SAFE_INTEGER],
      ).map((records) => {
        const record = records[0];
        return record?.kind === "input" ? record.value : null;
      }),
    );
  }

  selectSessionStartInput(
    threadId: string,
    options: { gapMs: number; at: number },
  ): NativeStoreResult<NativeInputRecord | null> {
    return this.selectSessionWindow(threadId, options).andThen((session) => {
      const firstPosition = session.firstPosition;
      if (firstPosition === null) return Result.ok(null);
      return this.readRows(
        `SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND i.position>=? AND ${CANONICAL_INPUT_FILTER} ORDER BY i.position LIMIT 1`,
        [threadId, firstPosition],
      ).map((records) => {
        const record = records[0];
        return record?.kind === "input" ? record.value : null;
      });
    });
  }

  selectSessionWindow(
    threadId: string,
    options: { gapMs: number; at: number; beforePosition?: number; includePosts?: boolean },
  ): NativeStoreResult<{
    firstPosition: number | null;
    firstAt: number | null;
    postedTurns: ReadyTurnSlot[];
    latestAt: number;
  }> {
    return nativeStoreTransaction(this.db, () => {
      const statement = this.db.prepare<
        {
          id: string;
          position: number;
          posted: number;
          created_at: number | null;
          completed_at: number | null;
        },
        [string, number]
      >(
        `SELECT t.id,t.position,json_extract(t.data_json,'$.value.messages[0].id')=t.id AS posted,
          COALESCE((SELECT MIN(json_extract(m.value,'$.metadata.createdAt')) FROM json_each(t.data_json,'$.value.messages') m),json_extract(t.data_json,'$.value.startedAt')) created_at,
          MAX(COALESCE(json_extract(t.data_json,'$.value.settledAt'),0),
            COALESCE((SELECT MAX(json_extract(i.data_json,'$.value.completedAt')) FROM native_records i WHERE i.kind='input' AND i.thread_id=t.thread_id AND i.position=t.position),0),
            COALESCE((SELECT MAX(json_extract(m.value,'$.metadata.createdAt')) FROM json_each(t.data_json,'$.value.messages') m),0)) completed_at
        FROM native_records t INDEXED BY native_records_thread_position
        WHERE t.kind='turn' AND t.thread_id=? AND t.position<? ORDER BY t.position DESC`,
      );
      const ids: string[] = [];
      let firstPosition: number | null = null;
      let firstAt: number | null = null;
      let nextAt = options.at;
      let latestAt = 0;
      for (const row of statement.iterate(
        threadId,
        options.beforePosition ?? Number.MAX_SAFE_INTEGER,
      )) {
        if (row.created_at === null || row.completed_at === null || row.created_at > options.at)
          continue;
        if (nextAt - row.completed_at > options.gapMs) break;
        latestAt = Math.max(latestAt, row.completed_at);
        firstPosition = row.position;
        firstAt = row.created_at;
        if (row.posted && options.includePosts) ids.push(row.id);
        nextAt = row.created_at;
      }
      statement.finalize();
      return Result.all(ids.toReversed().map((id) => this.readRecord("turn", id))).map(
        (records) => ({
          firstPosition,
          firstAt,
          postedTurns: records.flatMap((record) => (record?.kind === "turn" ? [record.value] : [])),
          latestAt,
        }),
      );
    });
  }

  getTurnPosition(turnId: string): NativeStoreResult<number> {
    return this.readRecord("turn", turnId).andThen((record) =>
      record?.kind === "turn"
        ? Result.ok(record.value.position)
        : Result.err(nativeFailure("not-found", "Turn is unavailable")),
    );
  }

  getLatestCanonicalRequestId(threadId: string): NativeStoreResult<string | null> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        `SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND ${CANONICAL_INPUT_FILTER} ORDER BY i.position DESC LIMIT 1`,
        [threadId],
      ).map((records) => {
        const record = records[0];
        return record?.kind === "input" ? record.value.requestId : null;
      }),
    );
  }

  setActiveRun(
    threadId: string,
    historyGeneration: number,
    runId?: string,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getThreadRecord(threadId);
        if (
          thread.deleted ||
          thread.mutationPending ||
          historyGeneration !== thread.historyGeneration
        )
          return Result.err(nativeFailure("stale", "Run belongs to discarded history"));
        this.bump({ ...thread, activeRunId: runId }, "run", runId ?? "");
        return Result.ok(undefined);
      }, this),
    );
  }

  cancelRun(actorId: string, threadId: string, runId?: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId, true);
        if (runId && thread.activeRunId !== runId)
          return Result.err(nativeFailure("stale", "Run is no longer active"));
        const targetRun = runId ?? thread.activeRunId;
        let current = thread;
        const inputs = yield* this.readRows(
          "SELECT * FROM native_records INDEXED BY native_pending_inputs WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.completedAt') IS NULL AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted')",
          [threadId],
        );
        for (const record of inputs) {
          if (record.kind !== "input") continue;
          const input = record.value;
          if (
            input.completedAt !== undefined ||
            (targetRun !== undefined &&
              input.state === "admitted" &&
              input.runId !== targetRun &&
              input.requestId !== targetRun)
          )
            continue;
          this.writeRecord(
            input.id,
            { kind: "input", value: { ...input, state: "canceled" } },
            threadId,
            input.position,
          );
          const changes = yield* this.terminalInputProjection(input, "canceled");
          current = this.bump(current, "input", input.id, changes);
        }
        yield* this.cancelUnusedUploads(thread.id);
        this.bump({ ...current, activeRunId: undefined }, "cancel", targetRun ?? "pending");
        return Result.ok(undefined);
      }, this),
    );
  }

  removeInput(actorId: string, inputId: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const input = yield* this.getInput(inputId);
        yield* this.authorizeThread(actorId, input.threadId, true);
        if (input.state === "admitted")
          return Result.err(nativeFailure("conflict", "Input has already been admitted"));
        if (input.state === "canceled") return Result.ok(undefined);
        yield* this.settleInput(inputId, "canceled");
        yield* this.cancelUnusedUploads(input.threadId);
        return Result.ok(undefined);
      }, this),
    );
  }

  reserveUpload(
    actorId: string,
    input: {
      threadId: string;
      filename: string;
      mediaType: string;
      size: number;
      commandId?: string;
    },
  ): NativeStoreResult<NativeUploadRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId, true);
        const create = (): NativeStoreResult<NativeMutationResult> => {
          if (thread.mutationPending)
            return Result.err(nativeFailure("stale", "Thread history is changing"));
          const upload: NativeUploadRecord = {
            threadId: input.threadId,
            filename: input.filename,
            mediaType: input.mediaType,
            size: input.size,
            id: randomUUID(),
            ownerId: actorId,
            historyGeneration: thread.historyGeneration,
            state: "pending",
            createdAt: this.now(),
            attempt: 0,
            revision: 0,
            published: false,
          };
          this.writeRecord(upload.id, { kind: "upload", value: upload }, thread.id);
          return Result.ok({ threadId: thread.id, uploadId: upload.id });
        };
        const result = yield* input.commandId
          ? this.command(
              actorId,
              input.commandId,
              { operation: "reserve-upload", ...input },
              create,
            )
          : create();
        if (!result.uploadId)
          return Result.err(nativeFailure("invalid", "Upload receipt is incomplete"));
        return this.getUpload(result.uploadId);
      }, this),
    );
  }

  getUpload(id: string): NativeStoreResult<NativeUploadRecord> {
    return nativeStoreTransaction(this.db, () =>
      this.readRecord("upload", id).andThen((record) =>
        record?.kind === "upload"
          ? Result.ok(record.value)
          : Result.err(nativeFailure("not-found", "Upload is unavailable")),
      ),
    );
  }

  readUpload(actorId: string, id: string): NativeStoreResult<NativeUploadRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const upload = yield* this.getUpload(id);
        yield* this.authorizeThread(actorId, upload.threadId);
        const user = yield* this.getUser(actorId);
        if (!upload.published && upload.ownerId !== actorId && user.role !== "owner")
          return Result.err(nativeFailure("forbidden", "Upload is not published"));
        return Result.ok(upload);
      }, this),
    );
  }

  claimUpload(actorId: string, id: string): NativeStoreResult<NativeUploadRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const upload = yield* this.getUpload(id);
        const thread = yield* this.authorizeThread(actorId, upload.threadId, true);
        if (
          upload.ownerId !== actorId ||
          upload.state === "canceled" ||
          upload.state === "ready" ||
          thread.historyGeneration !== upload.historyGeneration ||
          thread.mutationPending
        )
          return Result.err(nativeFailure("stale", "Upload is no longer writable"));
        const next = {
          ...upload,
          state: "pending" as const,
          attempt: upload.attempt + 1,
          revision: upload.revision + 1,
        };
        this.writeRecord(id, { kind: "upload", value: next }, thread.id);
        return Result.ok(next);
      }, this),
    );
  }

  settleUpload(
    id: string,
    input: {
      attempt: number;
      historyGeneration: number;
      state: "ready" | "failed";
      resourceUri?: string;
    },
  ): NativeStoreResult<NativeUploadRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const upload = yield* this.getUpload(id);
        const thread = yield* this.authorizeThread(upload.ownerId, upload.threadId, true);
        if (
          upload.attempt !== input.attempt ||
          upload.historyGeneration !== input.historyGeneration ||
          thread.historyGeneration !== input.historyGeneration ||
          thread.mutationPending ||
          upload.state !== "pending"
        )
          return Result.err(nativeFailure("stale", "Upload completion is obsolete"));
        if (input.state === "ready" && !input.resourceUri)
          return Result.err(nativeFailure("invalid", "Ready upload requires a resource URI"));
        const next: NativeUploadRecord = {
          ...upload,
          state: input.state,
          resourceUri: input.resourceUri,
          revision: upload.revision + 1,
        };
        this.writeRecord(id, { kind: "upload", value: next }, thread.id);
        let current = thread;
        const turns = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='turn' AND thread_id=?",
          [thread.id],
        );
        for (const record of turns) {
          if (record.kind !== "turn") continue;
          const changes: LiveUpdate["changes"] = [];
          const messages = record.value.messages.map((message) => ({
            ...message,
            parts: message.parts.map((part, partIndex) => {
              if (part.type !== "data-resource" || part.data.resourceId !== id) return part;
              const updated = { ...part, data: { ...part.data, state: next.state } };
              changes.push({
                kind: "set-part",
                turnId: record.value.turnId,
                position: record.value.position,
                messageId: message.id,
                partIndex,
                part: updated,
              });
              return updated;
            }),
          }));
          if (changes.length === 0) continue;
          this.writeRecord(
            record.value.turnId,
            { ...record, value: { ...record.value, messages } },
            thread.id,
            record.value.position,
          );
          current = this.bump(current, "upload", id, changes);
        }
        if (current.revision === thread.revision) this.bump(current, "upload", id);
        return Result.ok(next);
      }, this),
    );
  }

  appendMessage(
    threadId: string,
    historyGeneration: number,
    turnId: string,
    message: DisplayMessage,
    eventId?: string,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getThreadRecord(threadId);
        if (
          thread.deleted ||
          thread.mutationPending ||
          thread.historyGeneration !== historyGeneration
        )
          return Result.err(nativeFailure("stale", "Output belongs to discarded history"));
        if (
          eventId &&
          this.db.query("SELECT 1 FROM native_projection_receipts WHERE event_id=?").get(eventId)
        )
          return Result.ok(undefined);
        const record = yield* this.readRecord("turn", turnId);
        if (record?.kind !== "turn")
          return Result.err(nativeFailure("not-found", "Output turn is unavailable"));
        if (record.value.messages.some((item) => item.id === message.id))
          return Result.ok(undefined);
        const owner = this.db
          .query<{ thread_id: string }, [string]>(
            "SELECT thread_id FROM native_records WHERE kind='turn' AND id=?",
          )
          .get(turnId);
        if (owner?.thread_id !== threadId)
          return Result.err(nativeFailure("forbidden", "Turn belongs to another thread"));
        const slot = { ...record.value, messages: [...record.value.messages, message] };
        this.writeRecord(turnId, { ...record, value: slot }, thread.id, slot.position);
        this.bump(thread, "turn", turnId, [
          { kind: "append-message", turnId, position: slot.position, message },
        ]);
        if (eventId)
          this.db
            .query(
              "INSERT INTO native_projection_receipts(event_id,thread_id,generation) VALUES(?,?,?)",
            )
            .run(eventId, threadId, historyGeneration);
        return Result.ok(undefined);
      }, this),
    );
  }

  beginRewind(
    actorId: string,
    input: {
      threadId: string;
      commandId: string;
      turnId: string;
      historyGeneration: number;
      revision: number;
    },
  ): NativeStoreResult<NativeMutationResult> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId, true);
        if (thread.kind === "dm")
          return Result.err(nativeFailure("forbidden", "The DM cannot be rewound"));
        return this.command(actorId, input.commandId, { operation: "rewind", ...input }, () =>
          Result.gen(function* () {
            if (
              thread.mutationPending ||
              thread.historyGeneration !== input.historyGeneration ||
              thread.revision !== input.revision
            )
              return Result.err(nativeFailure("stale", "Thread changed before rewind"));
            const target = yield* this.readRecord("turn", input.turnId);
            if (target?.kind !== "turn")
              return Result.err(nativeFailure("not-found", "Rewind target is unavailable"));
            const targetInputs = yield* this.readRows(
              "SELECT * FROM native_records WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.turnId')=? AND json_extract(data_json,'$.value.mode')!='steer' LIMIT 1",
              [thread.id, input.turnId],
            );
            const fullInput = targetInputs[0];
            const inputs = yield* this.readRows(
              "SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND (json_extract(i.data_json,'$.value.state') IN ('queued','uploading') OR EXISTS(SELECT 1 FROM native_records t WHERE t.kind='turn' AND t.thread_id=i.thread_id AND t.position>=? AND t.id=json_extract(i.data_json,'$.value.turnId'))) ORDER BY i.position",
              [thread.id, target.value.position],
            );
            if (fullInput?.kind !== "input")
              return Result.err(nativeFailure("invalid", "Only full user turns can be rewound"));
            for (const record of inputs) {
              if (record.kind !== "input") continue;
              this.writeRecord(
                record.value.id,
                { kind: "input", value: { ...record.value, state: "canceled" } },
                thread.id,
                record.value.position,
              );
            }
            this.db
              .query("DELETE FROM native_records WHERE kind='turn' AND thread_id=? AND position>=?")
              .run(thread.id, target.value.position);
            yield* this.cancelUnusedUploads(thread.id);
            this.bump(
              {
                ...thread,
                historyGeneration: thread.historyGeneration + 1,
                activeRunId: undefined,
                mutationPending: true,
              },
              "rewind",
              input.turnId,
            );
            return Result.ok({
              threadId: thread.id,
              historyGeneration: thread.historyGeneration + 1,
              turnId: input.turnId,
              text: fullInput.value.text,
            });
          }, this),
        );
      }, this),
    );
  }

  deleteThread(
    actorId: string,
    input: { threadId: string; commandId: string; historyGeneration?: number },
  ): NativeStoreResult<NativeMutationResult> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const user = yield* this.getUser(actorId);
        const thread = yield* this.getThreadRecord(input.threadId);
        if (thread.kind === "dm")
          return Result.err(nativeFailure("forbidden", "The DM cannot be deleted"));
        const old = yield* this.readRecord("command", commandKey(actorId, input.commandId));
        if (old?.kind === "command")
          return this.command(actorId, input.commandId, { operation: "delete", ...input }, () =>
            Result.err(nativeFailure("conflict", "Deletion receipt is unavailable")),
          );
        if (
          input.historyGeneration !== undefined &&
          input.historyGeneration !== thread.historyGeneration
        )
          return Result.err(nativeFailure("stale", "Thread changed before deletion"));
        if (!this.capabilities(user, thread).edit)
          return Result.err(nativeFailure("forbidden", "Thread access is denied"));
        return this.command(actorId, input.commandId, { operation: "delete", ...input }, () =>
          Result.gen(function* () {
            this.db
              .query("DELETE FROM native_records WHERE kind='send-group' AND thread_id=?")
              .run(thread.id);
            const pending = yield* this.listPendingInputs(thread.id);
            for (const item of pending)
              this.writeRecord(
                item.id,
                { kind: "input", value: { ...item, state: "canceled" } },
                thread.id,
                item.position,
              );
            yield* this.cancelUnusedUploads(thread.id);
            this.bump(
              {
                ...thread,
                deleted: true,
                historyGeneration: thread.historyGeneration + 1,
                mutationPending: true,
                activeRunId: undefined,
              },
              "delete",
              thread.id,
            );
            return Result.ok({
              threadId: thread.id,
              historyGeneration: thread.historyGeneration + 1,
            });
          }, this),
        );
      }, this),
    );
  }

  finishMutation(threadId: string, historyGeneration: number): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getThreadRecord(threadId);
        if (thread.historyGeneration !== historyGeneration)
          return Result.err(nativeFailure("stale", "Mutation belongs to an older generation"));
        if (!thread.mutationPending) return Result.ok(undefined);
        const cleaned = thread.deleted ? yield* this.cleanupDeletedThread(thread) : thread;
        yield* this.cleanupAgentStreams(thread);
        this.bump({ ...cleaned, mutationPending: false }, "mutation", thread.id);
        return Result.ok(undefined);
      }, this),
    );
  }

  listPendingMutations(): NativeStoreResult<NativeThreadRecord[]> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT * FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.mutationPending')=1",
        [],
      ).map((records) =>
        records.flatMap((record) => (record.kind === "thread" ? [record.value] : [])),
      ),
    );
  }

  pruneReplay(): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () => {
      this.db
        .query("DELETE FROM native_changes WHERE created_at<?")
        .run(this.now() - REPLAY_AGE_MS);
      this.db
        .query(
          "DELETE FROM native_changes WHERE rowid IN (SELECT rowid FROM (SELECT rowid,SUM(byte_size) OVER (ORDER BY created_at DESC,rowid DESC) AS retained_bytes FROM native_changes) WHERE retained_bytes>?)",
        )
        .run(REPLAY_BYTE_CAP);
      return Result.ok(undefined);
    });
  }

  listUsers(
    actorId: string,
    options: { cursor?: string; limit?: number } = {},
  ): NativeStoreResult<{ items: DisplayUser[]; nextCursor?: string }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.requireOwner(actorId);
        const limit = Math.min(100, options.limit ?? 30);
        const records = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='user' AND id>? ORDER BY id LIMIT ?",
          [options.cursor ?? "", limit + 1],
        );
        const users = records.flatMap((record) => (record.kind === "user" ? [record.value] : []));
        const items = users.slice(0, limit).map(nativeUserDisplay);
        return Result.ok({
          items,
          nextCursor: users.length > limit ? items.at(-1)?.id : undefined,
        });
      }, this),
    );
  }

  listParticipants(actorId: string, threadId: string): NativeStoreResult<Participant[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId);
        const records = yield* this.readRows(
          "SELECT r.* FROM native_records r WHERE r.kind='user' AND (r.id=? OR json_extract(r.data_json,'$.value.role') IN ('owner','service') OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=? AND g.user_id=r.id)) ORDER BY r.id",
          [thread.starterId, threadId],
        );
        const participants: Participant[] = [];
        for (const record of records) {
          if (record.kind !== "user") continue;
          const user = nativeUserDisplay(record.value);
          const capabilities = this.capabilities(record.value, thread);
          participants.push({ user, role: capabilities.edit ? "edit" : "read" });
        }
        return Result.ok(participants);
      }, this),
    );
  }

  listQueuedInputs(actorId: string, threadId: string): NativeStoreResult<QueuedInput[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, threadId);
        const inputs = yield* this.listPendingInputs(threadId);
        return Result.ok(
          inputs
            .filter((input) => input.state !== "admitted")
            .map((input) => ({
              ...inputReceipt(input),
              authorId: input.authorId,
              text: input.text.slice(0, 4096),
              mode: input.mode,
              createdAt: input.createdAt,
            })),
        );
      }, this),
    );
  }

  removeQueuedInput(actorId: string, inputId: string): NativeStoreResult<void> {
    return this.removeInput(actorId, inputId);
  }

  beginOutputAttempt(requestId: string): NativeStoreResult<{
    threadId: string;
    turnId: string;
    generation: number;
    attemptId: string;
    previousAttemptId?: string;
  }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const input = yield* this.getInputByRequestId(requestId);
        if (!input?.turnId)
          return Result.err(nativeFailure("not-found", "Output input has no turn"));
        const thread = yield* this.getThreadRecord(input.threadId);
        if (
          thread.deleted ||
          thread.mutationPending ||
          thread.historyGeneration !== input.historyGeneration ||
          input.state === "canceled"
        )
          return Result.err(nativeFailure("stale", "Output attempt belongs to discarded history"));
        const attemptId = randomUUID();
        this.writeRecord(
          input.id,
          { kind: "input", value: { ...input, attemptId, previousAttemptId: input.attemptId } },
          thread.id,
          input.position,
        );
        return Result.ok({
          threadId: thread.id,
          turnId: input.turnId,
          generation: thread.historyGeneration,
          attemptId,
          previousAttemptId: input.attemptId,
        });
      }, this),
    );
  }

  projectTurn(
    threadId: string,
    historyGeneration: number,
    eventId: string,
    turnId: string,
    transform: (
      slot: ReadyTurnSlot,
      projection?: NativeOutputProjectionState,
    ) => NativeStoreResult<{
      slot: ReadyTurnSlot;
      changes: LiveUpdate["changes"];
      projection?: NativeOutputProjectionState;
      model?: { spec: string; reasoning?: ModelReasoning };
    }>,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getOutputConversation(threadId);
        if (
          thread.deleted ||
          thread.mutationPending ||
          thread.historyGeneration !== historyGeneration
        )
          return Result.err(nativeFailure("stale", "Output belongs to discarded history"));
        if (this.db.query("SELECT 1 FROM native_projection_receipts WHERE event_id=?").get(eventId))
          return Result.ok(undefined);
        const record = yield* this.readRecord("turn", turnId);
        if (record?.kind !== "turn")
          return Result.err(nativeFailure("not-found", "Output turn is unavailable"));
        const owner = this.db
          .query<{ thread_id: string }, [string]>(
            "SELECT thread_id FROM native_records WHERE kind='turn' AND id=?",
          )
          .get(turnId);
        if (owner?.thread_id !== threadId)
          return Result.err(nativeFailure("forbidden", "Turn belongs to another thread"));
        const changed = yield* transform(record.value, record.projection);
        if (changed.slot.turnId !== turnId || changed.slot.position !== record.value.position)
          return Result.err(nativeFailure("invalid", "Projection cannot change turn identity"));
        this.writeRecord(
          turnId,
          {
            kind: "turn",
            value: changed.slot,
            projection: changed.projection ?? record.projection,
          },
          threadId,
          changed.slot.position,
        );
        let current = thread;
        if ("parentThreadId" in thread) {
          const state =
            changed.slot.state === "pending" || !changed.slot.state
              ? "running"
              : changed.slot.state;
          const part = changed.slot.messages
            .flatMap((message) => message.parts)
            .findLast((part) => part.type === "data-activity" && part.data.state === "running");
          const titles = {
            complete: "Completed",
            failed: "Failed",
            canceled: "Canceled",
            running: part?.type === "data-activity" ? part.data.label : "Thinking…",
          };
          current = {
            ...thread,
            state,
            title: titles[state].slice(0, 256),
            ...(changed.model
              ? { model: changed.model.spec, reasoning: changed.model.reasoning }
              : {}),
          };
        }
        let batch: LiveUpdate["changes"] = [];
        let bytes = 0;
        for (const change of changed.changes) {
          const size = encoder.encode(JSON.stringify(change)).byteLength;
          if (batch.length > 0 && (batch.length >= 64 || bytes + size > WINDOW_BYTES)) {
            current = this.bump(current, "turn", turnId, batch);
            batch = [];
            bytes = 0;
          }
          batch.push(change);
          bytes += size;
        }
        if (batch.length > 0 || changed.changes.length === 0)
          this.bump(current, "turn", turnId, batch);
        this.db
          .query(
            "INSERT INTO native_projection_receipts(event_id,thread_id,generation) VALUES(?,?,?)",
          )
          .run(eventId, threadId, historyGeneration);
        return Result.ok(undefined);
      }, this),
    );
  }

  queueSurfaceSend(
    actorId: string,
    threadId: string,
    requestId: string,
    message: DisplayMessage,
    silent: boolean,
    origin: { deliveryId?: string; transcriptRequestId?: string } = {},
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId, true);
        if (thread.mutationPending)
          return Result.err(nativeFailure("stale", "Thread history is changing"));
        const id = fingerprint({ kind: "send-group", threadId, requestId });
        const existing = yield* this.readRecord("send-group", id);
        if (existing?.kind === "send-group" && existing.value.settled)
          return Result.err(nativeFailure("conflict", "Originating request has already settled"));
        const value: NativeSendGroup =
          existing?.kind === "send-group"
            ? existing.value
            : {
                id,
                requestId,
                ...origin,
                actorId,
                threadId,
                historyGeneration: thread.historyGeneration,
                settled: false,
                delivered: false,
                messages: [],
              };
        const position =
          this.db
            .query<{ position: number }, [string]>(
              "SELECT COALESCE(MAX(position)+1,0) AS position FROM native_records WHERE kind='send-group' AND thread_id=?",
            )
            .get(threadId)?.position ?? 0;
        const oldPosition = this.db
          .query<{ position: number }, [string]>(
            "SELECT position FROM native_records WHERE kind='send-group' AND id=?",
          )
          .get(id)?.position;
        this.writeRecord(
          id,
          {
            kind: "send-group",
            value: { ...value, messages: [...value.messages, { message, silent }] },
          },
          threadId,
          oldPosition ?? position,
        );
        return Result.ok(undefined);
      }, this),
    );
  }

  hasDeferredUpload(uploadId: string): NativeStoreResult<boolean> {
    return nativeStoreTransaction(this.db, () =>
      Result.ok(
        !!this.db
          .query<{ id: string }, [string]>(
            "SELECT r.id FROM native_records r, json_each(r.data_json,'$.value.messages') m, json_each(m.value,'$.message.parts') p WHERE r.kind='send-group' AND json_extract(r.data_json,'$.value.delivered')=0 AND json_extract(p.value,'$.type')='data-resource' AND json_extract(p.value,'$.data.resourceId')=? LIMIT 1",
          )
          .get(uploadId),
      ),
    );
  }

  listUnsettledSurfaceSends(): NativeStoreResult<Array<{ requestId: string; deliveryId: string }>> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT * FROM native_records WHERE kind='send-group' AND json_extract(data_json,'$.value.settled')=0",
        [],
      ).map((groups) =>
        groups.flatMap((group) =>
          group.kind === "send-group" && group.value.deliveryId
            ? [{ requestId: group.value.requestId, deliveryId: group.value.deliveryId }]
            : [],
        ),
      ),
    );
  }

  settleSurfaceSends(requestId: string, untrackedOnly = false): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const groups = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='send-group' AND json_extract(data_json,'$.value.requestId')=?",
          [requestId],
        );
        for (const group of groups) {
          if (group.kind !== "send-group" || group.value.settled) continue;
          if (untrackedOnly && group.value.deliveryId) continue;
          this.db
            .query(
              "UPDATE native_records SET data_json=json_set(data_json,'$.value.settled',json('true')) WHERE kind='send-group' AND id=?",
            )
            .run(group.value.id);
        }
        return Result.ok(undefined);
      }, this),
    );
  }

  deliverSurfaceSends(
    threadId?: string,
  ): NativeStoreResult<{ requestIds: string[]; notifications: string[] }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const groups = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='send-group' AND json_extract(data_json,'$.value.delivered')=0 AND (?='' OR thread_id=?) ORDER BY thread_id,position",
          [threadId ?? "", threadId ?? ""],
        );
        const blocked = new Set<string>();
        const notify = new Set<string>();
        const requestIds = new Set<string>();
        for (const record of groups) {
          if (record.kind !== "send-group") continue;
          const group = record.value;
          if (blocked.has(group.threadId)) continue;
          const thread = yield* nullableAuthority(
            this.authorizeThread(group.actorId, group.threadId, true),
          );
          if (!thread || thread.historyGeneration !== group.historyGeneration) {
            this.db
              .query("DELETE FROM native_records WHERE kind='send-group' AND id=?")
              .run(group.id);
            continue;
          }
          const pending = yield* this.listPendingInputs(thread.id);
          if (
            !group.settled ||
            thread.activeRunId ||
            thread.mutationPending ||
            pending.length > 0
          ) {
            blocked.add(thread.id);
            continue;
          }
          for (const entry of group.messages) {
            yield* this.postMessage(group.actorId, thread.id, {
              ...entry.message,
              metadata: { ...entry.message.metadata, createdAt: this.now() },
            });
            if (!entry.silent) notify.add(thread.id);
          }
          requestIds.add(group.transcriptRequestId ?? group.requestId);
          this.db
            .query(
              "UPDATE native_records SET data_json=json_set(data_json,'$.value.delivered',json('true')) WHERE kind='send-group' AND id=?",
            )
            .run(group.id);
        }
        return Result.ok({ requestIds: [...requestIds], notifications: [...notify] });
      }, this),
    );
  }

  postMessage(actorId: string, threadId: string, message: DisplayMessage): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId, true);
        if (thread.mutationPending)
          return Result.err(nativeFailure("stale", "Thread history is changing"));
        for (const part of message.parts)
          if (part.type === "data-resource")
            yield* this.publishUpload(actorId, part.data.resourceId);
        const existing = yield* this.readRecord("turn", message.id);
        if (existing) return Result.ok(undefined);
        const slot: ReadyTurnSlot = {
          kind: "ready",
          slotId: message.id,
          turnId: message.id,
          position: this.nextTurnPosition(thread.id),
          messages: [message],
          state: "complete",
        };
        this.writeRecord(slot.turnId, { kind: "turn", value: slot }, threadId, slot.position);
        this.bump({ ...thread, nextPosition: thread.nextPosition + 1 }, "turn", slot.turnId, [
          { kind: "insert", slot },
        ]);
        return Result.ok(undefined);
      }, this),
    );
  }

  acceptSurfaceInput(
    actorId: string,
    input: NativeInput,
    authorId = "lilac",
    message?: DisplayMessage,
    resolvedModelRequest?: DurableResolvedModelRequest,
  ): NativeStoreResult<NativeInputReceipt> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const receipt = yield* this.acceptInput(actorId, input, {
          authorId,
          resolvedModelRequest,
        });
        if (message)
          yield* this.updateSurfaceMessage(actorId, input.threadId, receipt.messageId, {
            ...message,
            id: receipt.messageId,
            metadata: {
              ...message.metadata,
              inputId: receipt.inputId,
              inputMode: input.mode,
              authorId,
            },
          });
        return Result.ok(receipt);
      }, this),
    );
  }

  createQuestion(
    actorId: string,
    threadId: string,
    messageId: string,
    create: () => NativeStoreResult<NativeQuestion>,
  ): NativeStoreResult<NativeQuestion> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* (this: NativeStore) {
        const thread = yield* this.authorizeThread(actorId, threadId, true);
        if (thread.mutationPending)
          return Result.err(nativeFailure("stale", "Thread history is changing"));
        const proposed = yield* create();
        const existing = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='turn' AND thread_id=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.value.messages')) m WHERE json_extract(m.value,'$.id')=?) LIMIT 1",
          [threadId, messageId],
        );
        if (existing.length) {
          const previous = yield* this.readQuestion(actorId, threadId, messageId);
          if (previous.respondentId !== actorId)
            return Result.err(nativeFailure("forbidden", "Question belongs to another respondent"));
          if (
            previous.historyGeneration !== thread.historyGeneration ||
            previous.requestId !== proposed.requestId
          )
            return Result.err(nativeFailure("stale", "Question belongs to an earlier request"));
          return Result.ok(previous);
        }
        const request = yield* this.getInputByRequestId(proposed.requestId);
        if (
          !request?.turnId ||
          request.threadId !== threadId ||
          request.historyGeneration !== thread.historyGeneration ||
          request.completedAt !== undefined
        )
          return Result.err(nativeFailure("stale", "Question request is unavailable"));
        const question = { ...proposed, historyGeneration: thread.historyGeneration };
        yield* this.appendMessage(threadId, thread.historyGeneration, request.turnId, {
          id: messageId,
          role: "assistant",
          parts: [{ type: "data-question", id: messageId, data: question }],
        });
        return Result.ok(question);
      }, this),
    );
  }

  interruptPendingSyncQuestions(): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* (this: NativeStore) {
        const records = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='turn' AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.value.messages')) m, json_each(json_extract(m.value,'$.parts')) p WHERE json_extract(p.value,'$.type')='data-question' AND json_extract(p.value,'$.data.view.state')='pending' AND json_extract(p.value,'$.data.mode')='sync')",
          [],
        );
        for (const record of records) {
          if (record.kind !== "turn") continue;
          for (const message of record.value.messages) {
            for (const part of message.parts) {
              if (
                part.type !== "data-question" ||
                part.data.view.state !== "pending" ||
                part.data.mode !== "sync"
              )
                continue;
              const request = yield* this.getInputByRequestId(part.data.requestId);
              if (!request) continue;
              const thread = yield* this.getThreadRecord(request.threadId);
              if (
                thread.deleted ||
                thread.mutationPending ||
                part.data.historyGeneration !== thread.historyGeneration
              )
                continue;
              yield* this.updateQuestion(thread.starterId, thread.id, {
                ...part.data,
                view: { state: "interrupted" },
              });
            }
          }
        }
        return Result.ok(undefined);
      }, this),
    );
  }

  dismissQuestion(
    actorId: string,
    input: NativeRpcInputs["questions"]["dismiss"],
  ): NativeStoreResult<{ ok: true }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* (this: NativeStore) {
        const question = yield* this.authorizeQuestionReply(
          actorId,
          input.threadId,
          input.historyGeneration,
          input,
        );
        yield* this.updateQuestion(actorId, input.threadId, {
          ...question,
          view: { state: "cancelled" },
        });
        return Result.ok({ ok: true as const });
      }, this),
    );
  }

  finishQuestion(
    actorId: string,
    threadId: string,
    messageId: string,
    state: "cancelled" | "expired" | "interrupted",
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* (this: NativeStore) {
        const question = yield* this.readQuestion(actorId, threadId, messageId);
        if (question.view.state !== "pending") return Result.ok(undefined);
        return this.updateQuestion(actorId, threadId, { ...question, view: { state } });
      }, this),
    );
  }

  readQuestion(
    actorId: string,
    threadId: string,
    messageId: string,
  ): NativeStoreResult<NativeQuestion> {
    return this.readDisplayMessage(actorId, threadId, messageId).andThen((message) => {
      const part = message.parts.find((entry) => entry.type === "data-question");
      if (!part || part.type !== "data-question")
        return Result.err(nativeFailure("not-found", "Question is unavailable"));
      return Result.ok(part.data);
    });
  }

  listPendingQuestions(actorId: string, threadId: string): NativeStoreResult<NativeQuestion[]> {
    return Result.gen(function* (this: NativeStore) {
      const thread = yield* this.authorizeThread(actorId, threadId);
      const records = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='turn' AND thread_id=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.value.messages')) m, json_each(json_extract(m.value,'$.parts')) p WHERE json_extract(p.value,'$.type')='data-question' AND json_extract(p.value,'$.data.view.state')='pending') ORDER BY position",
        [threadId],
      );
      const questions: NativeQuestion[] = [];
      for (const record of records) {
        if (record.kind !== "turn") continue;
        for (const message of record.value.messages)
          for (const part of message.parts)
            if (
              part.type === "data-question" &&
              part.data.view.state === "pending" &&
              part.data.historyGeneration === thread.historyGeneration
            )
              questions.push(part.data);
      }
      return Result.ok(questions);
    }, this);
  }

  authorizeQuestionReply(
    actorId: string,
    threadId: string,
    historyGeneration: number,
    reply: { messageId: string; token: string },
  ): NativeStoreResult<NativeQuestion> {
    return Result.gen(function* (this: NativeStore) {
      const thread = yield* this.authorizeThread(actorId, threadId, true);
      const question = yield* this.readQuestion(actorId, threadId, reply.messageId);
      if (question.respondentId !== actorId)
        return Result.err(nativeFailure("forbidden", "Question belongs to another respondent"));
      if (
        thread.mutationPending ||
        historyGeneration !== thread.historyGeneration ||
        question.historyGeneration !== historyGeneration ||
        question.view.state !== "pending"
      )
        return Result.err(nativeFailure("stale", "Question is no longer pending"));
      if (reply.token !== question.view.prompt.customToken)
        return Result.err(nativeFailure("stale", "Question token is no longer valid"));
      return Result.ok(question);
    }, this);
  }

  updateQuestion(
    actorId: string,
    threadId: string,
    question: NativeQuestion,
  ): NativeStoreResult<void> {
    return this.updateSurfaceMessage(actorId, threadId, question.questionCallId, {
      id: question.questionCallId,
      role: "assistant",
      parts: [{ type: "data-question", id: question.questionCallId, data: question }],
    });
  }

  readDisplayMessage(
    actorId: string,
    threadId: string,
    messageId: string,
  ): NativeStoreResult<DisplayMessage> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, threadId);
        const records = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='turn' AND thread_id=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.value.messages')) m WHERE json_extract(m.value,'$.id')=?) LIMIT 1",
          [threadId, messageId],
        );
        const record = records[0];
        const message =
          record?.kind === "turn"
            ? record.value.messages.find((entry) => entry.id === messageId)
            : undefined;
        if (!message) return Result.err(nativeFailure("not-found", "Message is unavailable"));
        return Result.ok(message);
      }, this),
    );
  }

  updateSurfaceMessage(
    actorId: string,
    threadId: string,
    messageId: string,
    message: DisplayMessage | null,
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId, true);
        if (thread.mutationPending)
          return Result.err(nativeFailure("stale", "Thread history is changing"));
        const records = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='turn' AND thread_id=? AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.value.messages')) m WHERE json_extract(m.value,'$.id')=?) LIMIT 1",
          [threadId, messageId],
        );
        const record = records[0];
        if (record?.kind !== "turn")
          return Result.err(nativeFailure("not-found", "Message is unavailable"));
        const oldResources = new Set(
          record.value.messages
            .find((entry) => entry.id === messageId)
            ?.parts.flatMap((part) =>
              part.type === "data-resource" ? [part.data.resourceId] : [],
            ) ?? [],
        );
        if (message)
          for (const part of message.parts)
            if (part.type === "data-resource" && !oldResources.has(part.data.resourceId))
              yield* this.publishUpload(actorId, part.data.resourceId);
        const messages = record.value.messages.flatMap((entry) => {
          if (entry.id !== messageId) return [entry];
          if (message) return [message];
          return [];
        });
        const slot = { ...record.value, messages };
        this.writeRecord(slot.turnId, { ...record, value: slot }, thread.id, slot.position);
        const changes: LiveUpdate["changes"] = [];
        const index = record.value.messages.findIndex((entry) => entry.id === messageId);
        const previous = record.value.messages[index];
        if (
          message &&
          previous &&
          message.role === previous.role &&
          JSON.stringify(message.metadata) === JSON.stringify(previous.metadata)
        ) {
          for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
            const part = message.parts[partIndex];
            if (!part || JSON.stringify(part) === JSON.stringify(previous.parts[partIndex]))
              continue;
            changes.push({
              kind: "set-part",
              turnId: slot.turnId,
              position: slot.position,
              messageId,
              partIndex,
              part,
            });
          }
          if (message.parts.length < previous.parts.length)
            changes.push({
              kind: "truncate-parts",
              turnId: slot.turnId,
              position: slot.position,
              messageId,
              length: message.parts.length,
            });
        } else {
          changes.push({
            kind: "remove-message",
            turnId: slot.turnId,
            position: slot.position,
            messageId,
          });
          if (message)
            changes.push({
              kind: "append-message",
              turnId: slot.turnId,
              position: slot.position,
              message,
              beforeMessageId: record.value.messages[index + 1]?.id,
            });
        }
        if (changes.length === 0) return Result.ok(undefined);
        this.bump(thread, "replace", slot.turnId, changes);
        return Result.ok(undefined);
      }, this),
    );
  }

  registerPublishedPath(
    actorId: string,
    threadId: string,
    path: string,
    cwd?: string,
  ): NativeStoreResult<{ id: string; threadId: string; path: string; cwd?: string }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, threadId, true);
        const id = fingerprint({ kind: "published-path", threadId, path, cwd });
        const existing = yield* this.readRecord("path", id);
        if (existing?.kind === "path") return Result.ok(existing.value);
        const value = { id, threadId, path, cwd };
        this.writeRecord(value.id, { kind: "path", value }, threadId);
        return Result.ok(value);
      }, this),
    );
  }

  readPublishedPath(
    actorId: string,
    id: string,
  ): NativeStoreResult<{ id: string; threadId: string; path: string; cwd?: string }> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const record = yield* this.readRecord("path", id);
        if (record?.kind !== "path")
          return Result.err(nativeFailure("not-found", "Published path is unavailable"));
        yield* this.authorizeThread(actorId, record.value.threadId);
        return Result.ok(record.value);
      }, this),
    );
  }

  saveHtmlPreview(value: Omit<NativeHtmlPreviewRecord, "id">): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () => {
      const id = htmlPreviewKey(value.turnId, value.path);
      this.writeRecord(id, { kind: "html-preview", value: { ...value, id } }, value.threadId);
      return Result.ok(undefined);
    });
  }

  readHtmlPreview(
    actorId: string,
    target: { threadId: string; messageId: string; path: string },
  ): NativeStoreResult<NativeHtmlPreviewRecord> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, target.threadId);
        const turn = this.db
          .query<{ id: string; thread_id: string }, [string, string, string]>(
            "SELECT r.id,r.thread_id FROM native_records r,json_each(r.data_json,'$.value.messages') m WHERE r.kind='turn' AND (r.thread_id=? OR EXISTS(SELECT 1 FROM native_records s WHERE s.kind='agent-stream' AND s.id=r.thread_id AND s.thread_id=?)) AND json_extract(m.value,'$.id')=? LIMIT 1",
          )
          .get(target.threadId, target.threadId, target.messageId);
        if (!turn) return Result.err(nativeFailure("not-found", "Message is unavailable"));
        if (turn.thread_id !== target.threadId)
          yield* this.authorizeAgentStream(actorId, target.threadId, turn.thread_id);
        const record = yield* this.readRecord("html-preview", htmlPreviewKey(turn.id, target.path));
        if (record?.kind !== "html-preview" || record.value.threadId !== target.threadId)
          return Result.err(nativeFailure("not-found", "Preview is unavailable"));
        return Result.ok(record.value);
      }, this),
    );
  }

  private boundedTurn(slot: ReadyTurnSlot): ReadyTurnSlot {
    const indexed = slot.messages.map((message, position) => ({
      ...message,
      metadata: { ...message.metadata, position },
    }));
    if (encoder.encode(JSON.stringify(indexed)).byteLength < WINDOW_BYTES && indexed.length <= 128)
      return { ...slot, messages: indexed };
    const selected: DisplayMessage[] = [];
    let bytes = 0;
    for (let i = indexed.length - 1; i >= 0; i--) {
      const message = indexed[i];
      if (!message) continue;
      const parts: DisplayMessage["parts"] = [];
      let partBytes = 0;
      for (let p = 0; p < message.parts.length; p++) {
        const part = message.parts[p];
        if (!part) continue;
        const size = encoder.encode(JSON.stringify(part)).byteLength;
        if (bytes + partBytes + size > WINDOW_BYTES - 4096) break;
        parts.push(part);
        partBytes += size;
      }
      const candidate = { ...message, parts };
      const size = encoder.encode(JSON.stringify(candidate)).byteLength;
      if (bytes + size > WINDOW_BYTES - 2048 || selected.length >= 32) break;
      selected.unshift(candidate);
      bytes += size;
      if (parts.length !== message.parts.length) break;
    }
    const first = indexed[0];
    if (
      first &&
      selected[0]?.id !== first.id &&
      bytes + encoder.encode(JSON.stringify(first)).byteLength < WINDOW_BYTES
    )
      selected.unshift(first);
    return { ...slot, messages: selected, partsCursor: "p_0_0" };
  }

  turnPage(
    actorId: string,
    input: {
      threadId: string;
      turnId: string;
      historyGeneration: number;
      projectionRevision: number;
      cursor: string;
    },
  ): NativeStoreResult<TurnPage> {
    return nativeStoreTransaction(this.db, () =>
      this.authorizeThread(actorId, input.threadId).andThen((thread) =>
        this.pageConversation(thread, input),
      ),
    );
  }

  private pageConversation(
    thread: ReplayConversation,
    input: {
      threadId: string;
      turnId: string;
      historyGeneration: number;
      projectionRevision: number;
      cursor: string;
    },
  ): NativeStoreResult<TurnPage> {
    return Result.gen(function* () {
      if (
        thread.historyGeneration !== input.historyGeneration ||
        thread.revision !== input.projectionRevision
      )
        return Result.err(nativeFailure("stale", "Turn changed before paging"));
      const record = yield* this.readRecord("turn", input.turnId);
      if (record?.kind !== "turn")
        return Result.err(nativeFailure("not-found", "Turn is unavailable"));
      const owner = this.db
        .query<{ thread_id: string }, [string]>(
          "SELECT thread_id FROM native_records WHERE kind='turn' AND id=?",
        )
        .get(input.turnId);
      if (owner?.thread_id !== thread.id)
        return Result.err(nativeFailure("forbidden", "Turn belongs to another thread"));
      const segments = input.cursor.split("_");
      let messageIndex = Number(segments[1]);
      let partIndex = Number(segments[2]);
      if (
        segments.length !== 3 ||
        segments[0] !== "p" ||
        !Number.isSafeInteger(messageIndex) ||
        !Number.isSafeInteger(partIndex) ||
        messageIndex < 0 ||
        partIndex < 0
      )
        return Result.err(nativeFailure("invalid", "Turn cursor is invalid"));
      const messages: DisplayMessage[] = [];
      const chunks: NonNullable<TurnPage["chunks"]> = [];
      let bytes = 0;
      while (messageIndex < record.value.messages.length) {
        const message = record.value.messages[messageIndex];
        if (!message) break;
        if (partIndex === 0) {
          const header = {
            ...message,
            metadata: { ...message.metadata, position: messageIndex },
            parts: [],
          };
          const size = encoder.encode(JSON.stringify(header)).byteLength;
          if (bytes + size > WINDOW_BYTES || messages.length >= 64) break;
          messages.push(header);
          bytes += size;
        }
        while (partIndex < message.parts.length) {
          const part = message.parts[partIndex];
          if (!part) break;
          const chunk = { messageId: message.id, partIndex, part };
          const size = encoder.encode(JSON.stringify(chunk)).byteLength;
          if (bytes + size > WINDOW_BYTES || chunks.length >= 64)
            return Result.ok({
              turnId: input.turnId,
              historyGeneration: thread.historyGeneration,
              projectionRevision: thread.revision,
              messages,
              chunks,
              nextCursor: `p_${messageIndex}_${partIndex}`,
            });
          chunks.push(chunk);
          bytes += size;
          partIndex++;
        }
        messageIndex++;
        partIndex = 0;
      }
      return Result.ok({
        turnId: input.turnId,
        historyGeneration: thread.historyGeneration,
        projectionRevision: thread.revision,
        messages,
        chunks,
        nextCursor:
          messageIndex < record.value.messages.length
            ? `p_${messageIndex}_${partIndex}`
            : undefined,
      });
    }, this);
  }

  publishUpload(actorId: string, id: string): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const upload = yield* this.getUpload(id);
        const thread = yield* this.authorizeThread(actorId, upload.threadId, !upload.published);
        if (upload.published && upload.state === "ready") return Result.ok(undefined);
        const user = yield* this.getUser(actorId);
        if (upload.ownerId !== actorId && user.role !== "owner")
          return Result.err(nativeFailure("forbidden", "Upload belongs to another user"));
        if (thread.historyGeneration !== upload.historyGeneration || thread.mutationPending)
          return Result.err(nativeFailure("stale", "Upload belongs to discarded history"));
        if (upload.state !== "ready")
          return Result.err(nativeFailure("invalid", "Only completed resources can be published"));
        this.writeRecord(
          id,
          { kind: "upload", value: { ...upload, published: true } },
          upload.threadId,
        );
        return Result.ok(undefined);
      }, this),
    );
  }

  private cancelUnusedUploads(threadId: string): NativeStoreResult<void> {
    return Result.gen(function* () {
      const uploads = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='upload' AND thread_id=? AND json_extract(data_json,'$.value.state') IN ('pending','failed')",
        [threadId],
      );
      const inputs = yield* this.readRows(
        "SELECT * FROM native_records INDEXED BY native_pending_inputs WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL",
        [threadId],
      );
      for (const record of uploads) {
        if (record.kind !== "upload") continue;
        const referenced = inputs.some(
          (input) => input.kind === "input" && input.value.attachmentIds.includes(record.value.id),
        );
        if (referenced) continue;
        this.writeRecord(
          record.value.id,
          {
            kind: "upload",
            value: { ...record.value, state: "canceled", revision: record.value.revision + 1 },
          },
          threadId,
        );
      }
      return Result.ok(undefined);
    }, this);
  }

  listProjectedMessageLinks(
    requestId?: string,
  ): NativeStoreResult<Array<{ requestId: string; threadId: string; messageIds: string[] }>> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const inputs = yield* this.readRows(
          `SELECT i.* FROM native_records i JOIN native_records t ON t.kind='thread' AND t.id=i.thread_id
         WHERE i.kind='input' AND json_extract(i.data_json,'$.value.mode')!='steer'
         AND json_extract(t.data_json,'$.value.deleted')=0
         AND (? = '' OR json_extract(i.data_json,'$.value.requestId')=?)`,
          [requestId ?? "", requestId ?? ""],
        );
        const links: Array<{ requestId: string; threadId: string; messageIds: string[] }> = [];
        for (const input of inputs) {
          if (input.kind !== "input" || !input.value.turnId) continue;
          const turn = yield* this.readRecord("turn", input.value.turnId);
          if (turn?.kind !== "turn") continue;
          const messageIds = turn.value.messages
            .filter(
              (message) =>
                message.role === "assistant" &&
                isNativeServiceMessage(message, "lilac") &&
                message.parts.some((part) => part.type === "text" || part.type === "data-resource"),
            )
            .map((message) => message.id);
          links.push({
            requestId: input.value.requestId,
            threadId: input.value.threadId,
            messageIds,
          });
        }
        const groups = yield* this.readRows(
          "SELECT * FROM native_records WHERE kind='send-group' AND json_extract(data_json,'$.value.delivered')=1 AND (?='' OR json_extract(data_json,'$.value.requestId')=? OR json_extract(data_json,'$.value.transcriptRequestId')=?)",
          [requestId ?? "", requestId ?? "", requestId ?? ""],
        );
        for (const group of groups) {
          if (group.kind !== "send-group") continue;
          links.push({
            requestId: group.value.transcriptRequestId ?? group.value.requestId,
            threadId: group.value.threadId,
            messageIds: group.value.messages.map((entry) => entry.message.id),
          });
        }
        return Result.ok(links);
      }, this),
    );
  }

  listCanonicalRequestIds(threadId: string): NativeStoreResult<string[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.getThreadRecord(threadId);
        if (thread.deleted) return Result.ok([]);
        const records = yield* this.readRows(
          "SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND json_extract(i.data_json,'$.value.state') IN ('admitted','canceled') AND EXISTS(SELECT 1 FROM native_records t WHERE t.kind='turn' AND t.thread_id=i.thread_id AND t.id=json_extract(i.data_json,'$.value.turnId')) ORDER BY i.position",
          [threadId],
        );
        return Result.ok(
          records.flatMap((record) => (record.kind === "input" ? [record.value.requestId] : [])),
        );
      }, this),
    );
  }

  listExpiredThreadIds(cutoff: number, limit = 100): NativeStoreResult<string[]> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT * FROM native_records WHERE kind='thread' AND json_extract(data_json,'$.value.kind') IS NULL AND updated_at<? AND json_extract(data_json,'$.value.deleted')=0 AND json_extract(data_json,'$.value.activeRunId') IS NULL AND json_extract(data_json,'$.value.mutationPending')=0 ORDER BY updated_at,id LIMIT ?",
        [cutoff, Math.max(1, Math.min(limit, 100))],
      ).map((records) =>
        records.flatMap((record) => (record.kind === "thread" ? [record.value.id] : [])),
      ),
    );
  }

  listInputReceipts(
    actorId: string,
    threadId: string,
    options: { afterRevision?: number } = {},
  ): NativeStoreResult<NativeInputReceipt[]> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, threadId);
        if (options.afterRevision === undefined) {
          const pending = yield* this.listPendingInputs(threadId);
          return Result.ok(pending.map(inputReceipt));
        }
        const records = yield* this.readRows(
          "SELECT i.* FROM native_records i WHERE i.kind='input' AND i.id IN (SELECT c.record_id FROM native_changes c WHERE c.thread_id=? AND c.kind='input' AND c.revision>?) ORDER BY i.position",
          [threadId, options.afterRevision],
        );
        return Result.ok(
          records.flatMap((record) =>
            record.kind === "input" ? [inputReceipt(record.value)] : [],
          ),
        );
      }, this),
    );
  }

  private terminalInputProjection(
    input: NativeInputRecord,
    state: NativeInputRecord["state"],
  ): NativeStoreResult<LiveUpdate["changes"]> {
    return Result.gen(function* () {
      if ((state !== "canceled" && state !== "failed") || input.mode === "steer" || !input.turnId)
        return Result.ok([]);
      const record = yield* this.readRecord("turn", input.turnId);
      if (record?.kind !== "turn") return Result.ok([]);
      const settledAt = this.now();
      const changes: LiveUpdate["changes"] = [
        {
          kind: "turn-state",
          turnId: input.turnId,
          position: record.value.position,
          state,
          runId: record.value.runId,
          startedAt: record.value.startedAt,
          settledAt,
        },
      ];
      const messages = record.value.messages.map((message) => {
        if (message.id !== input.messageId) return message;
        return {
          ...message,
          parts: message.parts.map((part, partIndex) => {
            if (part.type !== "data-resource" || part.data.state !== "pending") return part;
            const next = { ...part, data: { ...part.data, state } };
            changes.push({
              kind: "set-part",
              turnId: record.value.turnId,
              position: record.value.position,
              messageId: message.id,
              partIndex,
              part: next,
            });
            return next;
          }),
        };
      });
      this.writeRecord(
        input.turnId,
        { ...record, value: { ...record.value, messages, state, settledAt } },
        input.threadId,
        record.value.position,
      );
      return Result.ok(changes);
    }, this);
  }

  lookupInputReceipt(
    actorId: string,
    input: NativeInput,
  ): NativeStoreResult<NativeInputReceipt | null> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        yield* this.authorizeThread(actorId, input.threadId, true);
        const receipt = yield* this.readRecord("command", commandKey(actorId, input.commandId));
        if (receipt?.kind !== "command") return Result.ok(null);
        if (receipt.value.fingerprint !== fingerprint({ operation: "input", ...input }))
          return Result.err(
            nativeFailure("conflict", "Command ID was already used with different content"),
          );
        if (!receipt.value.result.inputId)
          return Result.err(nativeFailure("invalid", "Input receipt is incomplete"));
        return this.getInput(receipt.value.result.inputId).map(inputReceipt);
      }, this),
    );
  }

  private cleanupDeletedThread(thread: NativeThreadRecord): NativeStoreResult<NativeThreadRecord> {
    return Result.gen(function* () {
      const inputs = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='input' AND thread_id=?",
        [thread.id],
      );
      for (const record of inputs) {
        if (record.kind !== "input") continue;
        this.writeRecord(
          record.value.id,
          {
            kind: "input",
            value: {
              ...record.value,
              text: "",
              attachmentIds: [],
              skillIds: [],
              command: undefined,
              resolvedModelRequest: undefined,
              modelId: undefined,
              state: "canceled",
            },
          },
          thread.id,
          record.value.position,
        );
      }
      const commands = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='command' AND thread_id=?",
        [thread.id],
      );
      for (const record of commands) {
        if (record.kind !== "command") continue;
        this.writeRecord(
          commandKey(record.value.actorId, record.value.id),
          {
            kind: "command",
            value: { ...record.value, result: { ...record.value.result, text: undefined } },
          },
          thread.id,
        );
      }
      this.db
        .query(
          "DELETE FROM native_records WHERE thread_id=? AND kind IN ('turn','upload','path','message','html-preview')",
        )
        .run(thread.id);
      this.db.query("DELETE FROM native_changes WHERE thread_id=?").run(thread.id);
      this.db.query("DELETE FROM native_grants WHERE thread_id=?").run(thread.id);
      this.db.query("DELETE FROM native_projection_receipts WHERE thread_id=?").run(thread.id);
      return Result.ok({ ...thread, title: "Deleted thread", modelId: undefined });
    }, this);
  }

  private cleanupAgentStreams(thread: NativeThreadRecord): NativeStoreResult<void> {
    return Result.gen(function* () {
      const canonical = new Set(yield* this.listCanonicalRequestIds(thread.id));
      const records = yield* this.readRows(
        "SELECT * FROM native_records WHERE kind='agent-stream' AND thread_id=?",
        [thread.id],
      );
      for (const record of records) {
        if (record.kind !== "agent-stream" || canonical.has(record.value.parentRequestId)) continue;
        const id = record.value.id;
        this.db.query("DELETE FROM native_records WHERE thread_id=?").run(id);
        this.writeRecord(
          id,
          {
            kind: "agent-stream",
            value: {
              ...record.value,
              deleted: true,
              title: "Unavailable",
              state: "canceled",
              attemptId: undefined,
              previousAttemptId: undefined,
            },
          },
          thread.id,
        );
        this.db.query("DELETE FROM native_changes WHERE thread_id=?").run(id);
        this.db.query("DELETE FROM native_projection_receipts WHERE thread_id=?").run(id);
        this.notify(id);
      }
      return Result.ok(undefined);
    }, this);
  }
}
