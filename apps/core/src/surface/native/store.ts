import { isNativeServiceMessage } from "./message-ownership";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
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
  type NativeInputRecord,
  type NativeMutationResult,
  type NativePersistedRow,
  type NativeRecord,
  type NativeThreadRecord,
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
      if (version > 1)
        return Result.err(
          nativeFailure("invalid", "Native store version is newer than this build"),
        );
      this.db
        .run(`CREATE TABLE IF NOT EXISTS native_records (kind TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT, position INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, format_version INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(kind,id));
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
        PRAGMA user_version = 1;`);
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
        const value = { settings: input.settings, revision: current.revision + 1 };
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
  ): NativeStoreResult<NonNullable<NativeThread["displayStatus"]>> {
    if (thread.activeRunId) return Result.ok("working");
    // The sidebar needs turn state and the read frontier, never transcript bodies.
    const row = this.db
      .query<NativePersistedRow & { last_message_index: number }, [string]>(
        `SELECT format_version,json_object('kind','turn','value',json_set(json_extract(data_json,'$.value'),'$.messages',json('[]'))) AS data_json,json_array_length(data_json,'$.value.messages')-1 AS last_message_index FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position DESC LIMIT 1`,
      )
      .get(thread.id);
    if (!row) return Result.ok("idle");
    const db = this.db;
    return Result.gen(function* () {
      const { value: record } = yield* decodeNativeRecord(row);
      if (record.kind !== "turn")
        return Result.err(nativeFailure("invalid", "Thread display projection is not a turn"));
      const turn = record.value;
      if (turn.state === "failed") return Result.ok("error" as const);
      if (turn.state === "running") return Result.ok("working" as const);
      if (turn.state !== "complete") return Result.ok("idle" as const);
      const read = db
        .query<{ position: number; message_index: number }, [string, string, number]>(
          "SELECT position,message_index FROM native_surface_read WHERE thread_id=? AND reader_id=? AND generation=?",
        )
        .get(thread.id, user.id, thread.historyGeneration);
      const checked =
        read !== null &&
        (read.position > turn.position ||
          (read.position === turn.position && read.message_index >= row.last_message_index));
      return Result.ok<NonNullable<NativeThread["displayStatus"]>>(checked ? "idle" : "completed");
    });
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
      const displayStatus = yield* this.displayStatus(user, thread);
      return Result.ok({
        id: thread.id,
        title: thread.title,
        starterId: thread.starterId,
        starterDisplayName: starter.displayName,
        starterAvatarUrl: nativeUserDisplay(starter).avatarUrl,
        displayStatus,
        archived: thread.archived,
        updatedAt: thread.updatedAt,
        revision: thread.revision,
        modelId: thread.modelId,
        activeRunId: thread.activeRunId,
        capabilities: this.capabilities(user, thread),
      });
    }, this);
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
          `SELECT r.* FROM native_records r WHERE r.kind='thread' AND (r.updated_at < ? OR (r.updated_at = ? AND r.id > ?)) AND ( ? = 'owner' OR json_extract(r.data_json,'$.value.starterId') = ? OR EXISTS(SELECT 1 FROM native_grants g WHERE g.thread_id=r.id AND g.user_id=?)) AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL AND json_extract(r.data_json,'$.value.archived')=? AND json_extract(r.data_json,'$.value.title') LIKE ? ESCAPE '\\' AND (?=0 OR NOT EXISTS(SELECT 1 FROM native_thread_preferences p WHERE p.user_id=? AND p.thread_id=r.id AND p.section='settled')) ORDER BY r.updated_at DESC,r.id LIMIT ?`,
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
      FROM native_records r WHERE r.kind='thread' AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL
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
        WHERE p.user_id=? AND p.section=? AND json_extract(r.data_json,'$.value.deleted')=0 AND json_extract(r.data_json,'$.value.ephemeral') IS NULL AND json_extract(r.data_json,'$.value.archived')=0
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

  private bump(
    thread: NativeThreadRecord,
    kind: string,
    recordId: string,
    changes: LiveUpdate["changes"] = [],
  ): NativeThreadRecord {
    const next = { ...thread, revision: thread.revision + 1, updatedAt: this.now() };
    this.writeRecord(next.id, { kind: "thread", value: next }, next.id);
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

  createThread(
    actorId: string,
    input: {
      commandId: string;
      title?: string;
      autoTitle?: boolean;
      modelId?: string;
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
      revision?: number;
    },
  ): NativeStoreResult<NativeThread> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId, true);
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

  settleTitleGeneration(
    threadId: string,
    expected: { inputId: string; phase: "initial" | "refine" },
    generated?: { title: string; needsRefinement: boolean },
  ): NativeStoreResult<void> {
    return nativeStoreTransaction(this.db, () =>
      Result.gen(function* () {
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

  private checkpoint(thread: NativeThreadRecord): ReplayCheckpoint {
    return {
      protocolVersion: 1,
      historyGeneration: thread.historyGeneration,
      projectionRevision: thread.revision,
      cursor: `n_${thread.id}_${thread.historyGeneration}_${thread.revision}`,
    };
  }

  private window(
    thread: NativeThreadRecord,
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
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, threadId);
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
      }, this),
    );
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
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId);
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
      }, this),
    );
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
      "SELECT * FROM native_records WHERE kind='input' AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL";
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
              const effectiveMode = input.command && thread.activeRunId ? "followup" : input.mode;
              const pendingCount =
                this.db
                  .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) AS count FROM native_records WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.state') IN ('uploading','queued')",
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
              const id = randomUUID();
              const messageId = randomUUID();
              let accepted: NativeInputRecord = {
                id,
                commandId: input.commandId,
                threadId: input.threadId,
                authorId: options.authorId ?? actorId,
                initiatingUserId: actorId,
                requestId: `native:${thread.id}:${messageId}`,
                deliveryId: randomUUID(),
                messageId,
                position: thread.nextPosition,
                historyGeneration: thread.historyGeneration,
                text: input.text,
                mode: effectiveMode,
                runId: thread.activeRunId,
                state: uploads.some((upload) => upload.state !== "ready") ? "uploading" : "queued",
                attachmentIds: [...input.attachmentIds],
                skillIds: [...input.skillIds],
                modelId: options.resolvedModelId ?? input.modelId ?? thread.modelId,
                resolvedModelRequest: options.resolvedModelRequest,
                command: input.command,
                createdAt: this.now(),
              };
              const earlierFull = this.db
                .query(
                  "SELECT 1 FROM native_records WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.mode')!='steer' AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL LIMIT 1",
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

  getLatestCanonicalRequestId(threadId: string): NativeStoreResult<string | null> {
    return nativeStoreTransaction(this.db, () =>
      this.readRows(
        "SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND json_extract(i.data_json,'$.value.completedAt') IS NOT NULL AND json_extract(i.data_json,'$.value.mode')!='steer' AND json_extract(i.data_json,'$.value.state') IN ('admitted','canceled') AND EXISTS(SELECT 1 FROM native_records t WHERE t.kind='turn' AND t.id=json_extract(i.data_json,'$.value.turnId')) ORDER BY i.position DESC LIMIT 1",
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
          "SELECT * FROM native_records WHERE kind='input' AND thread_id=?",
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
    }>,
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
      Result.gen(function* () {
        const thread = yield* this.authorizeThread(actorId, input.threadId);
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
      }, this),
    );
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
        "SELECT * FROM native_records WHERE kind='input' AND thread_id=? AND json_extract(data_json,'$.value.state') IN ('uploading','queued','admitted') AND json_extract(data_json,'$.value.completedAt') IS NULL",
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
        "SELECT * FROM native_records WHERE kind='thread' AND updated_at<? AND json_extract(data_json,'$.value.deleted')=0 AND json_extract(data_json,'$.value.activeRunId') IS NULL AND json_extract(data_json,'$.value.mutationPending')=0 ORDER BY updated_at,id LIMIT ?",
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
          "SELECT i.* FROM native_records i WHERE i.kind='input' AND i.thread_id=? AND EXISTS(SELECT 1 FROM native_changes c WHERE c.thread_id=i.thread_id AND c.kind='input' AND c.record_id=i.id AND c.revision>?) ORDER BY i.position",
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
          "DELETE FROM native_records WHERE thread_id=? AND kind IN ('turn','upload','path','message')",
        )
        .run(thread.id);
      this.db.query("DELETE FROM native_changes WHERE thread_id=?").run(thread.id);
      this.db.query("DELETE FROM native_grants WHERE thread_id=?").run(thread.id);
      this.db.query("DELETE FROM native_projection_receipts WHERE thread_id=?").run(thread.id);
      return Result.ok({ ...thread, title: "Deleted thread", modelId: undefined });
    }, this);
  }
}
