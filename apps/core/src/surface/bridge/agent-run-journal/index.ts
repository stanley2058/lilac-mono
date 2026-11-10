import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  corePrimaryLineageV2Schema,
  nativeOutputFrontierSchema,
  type NativeOutputFrontier,
  storedMessagesV1Schema,
  type CorePrimaryLineageV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { classifyBunSqliteError, runBunSqliteTransaction } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import { adaptToolResultToHost } from "../../../tools/tool-result-adapters";
import type { RequestDeliveryTerminalOutcome } from "../request-delivery";

import {
  mcpImageCheckpointReferenceSchema,
  validMcpImageCheckpointReferences,
  type McpImageCheckpointReference,
} from "../../../mcp/image-checkpoint";

const JOURNAL_SCHEMA_VERSION = 2 as const;
// Schema 1 stored only full checkpoints; its events read as schema 2 snapshots.
const MIGRATABLE_JOURNAL_SCHEMA_VERSION = 1 as const;
// A delta chain this long is folded into a fresh snapshot on the next write.
const MAX_CHECKPOINT_DELTA_CHAIN = 64;

const terminalOutcomeSchema = z.strictObject({
  kind: z.enum([
    "completed",
    "failed",
    "cancelled",
    "abandoned",
    "publication-failed",
    "upload-failed",
    "upload-timeout",
  ]),
  code: z.string().optional(),
});

const retainedDeliverySchema = z.strictObject({
  requestDeliveryId: z.uuid(),
  outcome: terminalOutcomeSchema,
});

export const agentRunCheckpointV1Schema = z
  .strictObject({
    version: z.literal(1),
    messages: storedMessagesV1Schema,
    mcpImages: z.array(mcpImageCheckpointReferenceSchema).optional(),
    corePrimaryLineage: corePrimaryLineageV2Schema.optional(),
    nativeOutput: nativeOutputFrontierSchema.optional(),
    loadedCatalogIds: z.array(z.string().min(1)).optional(),
    questionResultIds: z.array(z.string().min(1)).optional(),
    currentTurnUserId: z.string().optional(),
    retainedRequestDeliveries: z.array(retainedDeliverySchema),
  })
  .refine(validMcpImageCheckpointReferences, {
    message: "MCP image references must match unique checkpoint image markers",
  });

export type AgentRunCheckpointV1 = z.output<typeof agentRunCheckpointV1Schema>;

/** Keeps the first `keep` messages of the preceding checkpoint and appends `append`. */
const agentRunCheckpointDeltaSchema = z.strictObject({
  version: z.literal(2),
  keep: z.number().int().nonnegative(),
  append: storedMessagesV1Schema,
  mcpImages: z.array(mcpImageCheckpointReferenceSchema).optional(),
  corePrimaryLineage: corePrimaryLineageV2Schema.optional(),
  nativeOutput: nativeOutputFrontierSchema.optional(),
  loadedCatalogIds: z.array(z.string().min(1)).optional(),
  questionResultIds: z.array(z.string().min(1)).optional(),
  currentTurnUserId: z.string().optional(),
  retainedRequestDeliveries: z.array(retainedDeliverySchema),
});

type AgentRunCheckpointDelta = z.output<typeof agentRunCheckpointDeltaSchema>;

type CheckpointMetadata = Omit<AgentRunCheckpointV1, "version" | "messages">;

type LatestCheckpointState = {
  readonly sequence: number;
  readonly messages: readonly StoredMessageV1[];
  readonly metadataHash: string;
  readonly deltasSinceSnapshot: number;
};

type JournalCheckpointEventRow = {
  sequence: number;
  delta: number;
  payload_json: string;
};

const openedPayloadSchema = z.strictObject({
  version: z.literal(1),
});

const terminalPayloadSchema = z.strictObject({
  version: z.literal(1),
  outcome: terminalOutcomeSchema,
  finalReplayDeadline: z.number().int().nonnegative().optional(),
});

type JournalHeadStateRow = Omit<JournalHeadRow, "checkpoint_json" | "terminal_outcome_json">;

type JournalHeadRow = {
  request_delivery_id: string;
  request_id: string;
  session_id: string;
  state: string;
  latest_sequence: number;
  checkpoint_sequence: number | null;
  checkpoint_json: string | null;
  terminal_outcome_json: string | null;
  created_at: number;
  updated_at: number;
};

type JournalOwnerRow = {
  request_id: string;
  state: string;
};

type JournalEventRow = {
  sequence: number;
  event_kind: string;
  payload_json: string;
  created_at: number;
};

export type AgentRunJournalHandle = {
  readonly runId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sequence: number;
};

export type AgentRunJournalOwner = {
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly sessionId: string;
};

export type AgentRunRecoveryHead = {
  readonly handle: AgentRunJournalHandle;
  readonly state: "active" | "terminal";
  readonly checkpoint?: AgentRunCheckpointV1;
  readonly previousCheckpoint?: AgentRunCheckpointV1;
  readonly terminalOutcome?: RequestDeliveryTerminalOutcome;
  readonly finalReplayDeadline?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AgentRunJournalResetNotice = {
  readonly scope: "run" | "all";
  readonly runId?: string;
  readonly reason: "corrupt-payload" | "incompatible-schema" | "sqlite-failure";
  readonly errorName: string;
};

export type AgentRunJournalLoad = {
  readonly heads: readonly AgentRunRecoveryHead[];
  readonly resets: readonly AgentRunJournalResetNotice[];
};

export interface AgentRunJournal {
  openRun(work: AgentRunJournalOwner): ResultType<AgentRunJournalHandle, AgentRunJournalError>;
  writeCheckpoint(
    handle: AgentRunJournalHandle,
    checkpoint: AgentRunCheckpointV1,
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError>;
  promotePreviousCheckpoint(
    handle: AgentRunJournalHandle,
    checkpoint: AgentRunCheckpointV1,
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError>;
  markTerminal(
    handle: AgentRunJournalHandle,
    terminal: {
      readonly outcome: RequestDeliveryTerminalOutcome;
      readonly finalReplayDeadline?: number;
    },
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError>;
  loadRecoveryHeads(): ResultType<AgentRunJournalLoad, AgentRunJournalSqliteFailure>;
  resetRun(runId: string): ResultType<void, AgentRunJournalSqliteFailure>;
  resetAll(): ResultType<void, AgentRunJournalSqliteFailure>;
  removeReconciled(runId: string): ResultType<void, AgentRunJournalSqliteFailure>;
}

export class AgentRunJournalSqliteFailure extends TaggedError("AgentRunJournalSqliteFailure")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

/** The schema 1 journal stayed intact after its upgrade rolled back; startup must not reset it. */
export class AgentRunJournalMigrationFailure extends TaggedError(
  "AgentRunJournalMigrationFailure",
)<{
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly message: string;
}> {}

export class AgentRunJournalCodecFailure extends TaggedError("AgentRunJournalCodecFailure")<{
  readonly runId: string;
  readonly field: string;
  readonly message: string;
}> {}

export class AgentRunJournalConflict extends TaggedError("AgentRunJournalConflict")<{
  readonly runId: string;
  readonly message: string;
}> {}

export type AgentRunJournalError =
  | AgentRunJournalSqliteFailure
  | AgentRunJournalCodecFailure
  | AgentRunJournalConflict;

function sqliteFailure(operation: string, cause: Error): AgentRunJournalSqliteFailure | undefined {
  const classified = classifyBunSqliteError(cause);
  if (!classified) return undefined;
  return new AgentRunJournalSqliteFailure({
    operation,
    code: classified.code,
    message: `Agent run journal SQLite ${operation} failed`,
  });
}

function transaction<T, TError extends Error>(
  database: Database,
  operation: string,
  callback: () => ResultType<T, TError>,
): ResultType<T, TError | AgentRunJournalSqliteFailure> {
  return runBunSqliteTransaction(database, callback, (cause) => sqliteFailure(operation, cause));
}

function serialize<T>(
  runId: string,
  field: string,
  value: T,
): ResultType<string, AgentRunJournalCodecFailure> {
  return Result.try({
    try: () => SuperJSON.stringify(value),
    catch: () =>
      new AgentRunJournalCodecFailure({
        runId,
        field,
        message: `Agent run journal ${field} is not serializable`,
      }),
  });
}

function deserialize<T>(
  runId: string,
  field: string,
  schema: z.ZodType<T>,
  value: string,
): ResultType<T, AgentRunJournalCodecFailure> {
  return Result.try({
    try: () => SuperJSON.parse(value) as unknown,
    catch: () =>
      new AgentRunJournalCodecFailure({
        runId,
        field,
        message: `Persisted agent run journal ${field} is not decodable`,
      }),
  }).andThen((decoded) => {
    const validated = schema.safeParse(decoded);
    return validated.success
      ? Result.ok(validated.data)
      : Result.err(
          new AgentRunJournalCodecFailure({
            runId,
            field,
            message: `Persisted agent run journal ${field} failed validation`,
          }),
        );
  });
}

export function decodeAgentRunCheckpointPayload(
  payloadJson: string,
  runId = "agent-run-checkpoint",
): ResultType<
  { readonly value: AgentRunCheckpointV1; readonly provenance: "current" },
  AgentRunJournalCodecFailure
> {
  return deserialize(runId, "checkpoint", agentRunCheckpointV1Schema, payloadJson).map((value) => ({
    value,
    provenance: "current" as const,
  }));
}

export function decodeAgentRunOpenedPayload(
  payloadJson: string,
  runId = "agent-run-opened",
): ResultType<
  { readonly value: z.output<typeof openedPayloadSchema>; readonly provenance: "current" },
  AgentRunJournalCodecFailure
> {
  return deserialize(runId, "opened", openedPayloadSchema, payloadJson).map((value) => ({
    value,
    provenance: "current" as const,
  }));
}

export function decodeAgentRunTerminalPayload(
  payloadJson: string,
  runId = "agent-run-terminal",
): ResultType<
  { readonly value: z.output<typeof terminalPayloadSchema>; readonly provenance: "current" },
  AgentRunJournalCodecFailure
> {
  return deserialize(runId, "terminalOutcome", terminalPayloadSchema, payloadJson).map((value) => ({
    value,
    provenance: "current" as const,
  }));
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function invalidHead(row: JournalHeadRow, message: string): AgentRunJournalCodecFailure {
  return new AgentRunJournalCodecFailure({
    runId: row.request_delivery_id,
    field: "head",
    message,
  });
}

function expectedLatestEventKind(row: JournalHeadRow): "opened" | "checkpoint" | "terminal" {
  if (row.state === "terminal") return "terminal";
  if (row.checkpoint_sequence === null) return "opened";
  return "checkpoint";
}

function openedPayload(runId: string): ResultType<string, AgentRunJournalCodecFailure> {
  return serialize(runId, "opened", { version: 1 }).andThen((payload) =>
    decodeAgentRunOpenedPayload(payload, runId).map(() => payload),
  );
}

// Checkpoints can hold a whole transcript, so the write skips the decode round trip;
// recovery still validates the payload and resets the run when it does not decode.
function checkpointPayload(
  runId: string,
  checkpoint: AgentRunCheckpointV1,
): ResultType<string, AgentRunJournalCodecFailure> {
  return serialize(runId, "checkpoint", checkpoint);
}

function terminalPayload(
  runId: string,
  terminal: {
    readonly outcome: RequestDeliveryTerminalOutcome;
    readonly finalReplayDeadline?: number;
  },
): ResultType<string, AgentRunJournalCodecFailure> {
  return serialize(runId, "terminalOutcome", { version: 1, ...terminal }).andThen((payload) =>
    decodeAgentRunTerminalPayload(payload, runId).map(() => payload),
  );
}

function payloadHash(payload: string): string {
  return new Bun.CryptoHasher("sha256").update(payload).digest("hex");
}

function checkpointMetadata(checkpoint: AgentRunCheckpointV1): CheckpointMetadata {
  const { version: _version, messages: _messages, ...metadata } = checkpoint;
  return metadata;
}

function sharedMessagePrefix(
  previous: readonly StoredMessageV1[],
  next: readonly StoredMessageV1[],
): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit) {
    const before = previous[index];
    const after = next[index];
    if (before !== after && !isDeepStrictEqual(before, after)) break;
    index += 1;
  }
  return index;
}

export function decodeAgentRunCheckpointDelta(
  payloadJson: string,
  runId = "agent-run-checkpoint-delta",
): ResultType<
  { readonly value: AgentRunCheckpointDelta; readonly provenance: "current" },
  AgentRunJournalCodecFailure
> {
  return deserialize(runId, "checkpoint", agentRunCheckpointDeltaSchema, payloadJson).map(
    (value) => ({ value, provenance: "current" as const }),
  );
}

function applyCheckpointDelta(
  runId: string,
  base: AgentRunCheckpointV1,
  delta: AgentRunCheckpointDelta,
): ResultType<AgentRunCheckpointV1, AgentRunJournalCodecFailure> {
  const { version: _version, keep, append, ...metadata } = delta;
  const checkpoint: AgentRunCheckpointV1 = {
    version: 1,
    messages: [...base.messages.slice(0, keep), ...append],
    ...metadata,
  };
  if (keep > base.messages.length || !validMcpImageCheckpointReferences(checkpoint)) {
    return Result.err(
      new AgentRunJournalCodecFailure({
        runId,
        field: "checkpoint",
        message: "Persisted agent run journal checkpoint delta does not fit its base",
      }),
    );
  }
  return Result.ok(checkpoint);
}

function handleFromRow(row: JournalHeadStateRow): AgentRunJournalHandle {
  return {
    runId: row.request_delivery_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    sequence: row.latest_sequence,
  };
}

export class SqliteAgentRunJournal implements AgentRunJournal {
  readonly #database: Database;
  readonly #now: () => number;
  // Each run's latest checkpoint as last written, so the next write can append a delta.
  readonly #latestCheckpoints = new Map<string, LatestCheckpointState>();

  constructor(input: { readonly dbPath: string; readonly now?: () => number }) {
    this.#database = new Database(input.dbPath, { create: true, strict: true });
    this.#now = input.now ?? Date.now;
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("PRAGMA journal_mode = WAL");
    const created = Result.try({
      try: () => this.#createTables(),
      catch: () =>
        new AgentRunJournalSqliteFailure({
          operation: "initialize",
          code: "SQLITE_SCHEMA",
          message: "Agent run journal schema initialization failed",
        }),
    });
    if (created.isErr()) this.#resetAllTables();
    // A failed upgrade rolls back to the intact schema 1 journal; resetting here would drop
    // checkpoints the next start can still migrate and recover.
    const migrated = Result.try({
      try: () => this.#migrateSchema(),
      catch: () =>
        new AgentRunJournalMigrationFailure({
          fromVersion: MIGRATABLE_JOURNAL_SCHEMA_VERSION,
          toVersion: JOURNAL_SCHEMA_VERSION,
          message: "Agent run journal schema migration failed",
        }),
    });
    if (migrated.isErr()) this.#database.close();
    adaptToolResultToHost(migrated);
  }

  close(): void {
    this.#database.close();
  }

  #createTables(): void {
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS agent_run_wal_metadata (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_run_wal_heads (
        request_delivery_id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'terminal')),
        latest_sequence INTEGER NOT NULL,
        checkpoint_sequence INTEGER,
        checkpoint_json TEXT,
        terminal_outcome_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_run_wal_events (
        request_delivery_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('opened', 'checkpoint', 'terminal')),
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delta INTEGER NOT NULL DEFAULT 0 CHECK (delta IN (0, 1)),
        PRIMARY KEY (request_delivery_id, sequence),
        FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_run_wal_heads_recovery_idx
        ON agent_run_wal_heads(state, created_at, request_delivery_id);
      INSERT OR IGNORE INTO agent_run_wal_metadata (singleton, schema_version)
        VALUES (1, ${JOURNAL_SCHEMA_VERSION});
    `);
  }

  /** Reads a head's state without its payload columns, which can hold a whole transcript. */
  /** Upgrades schema 1 in place: its full checkpoints become snapshots and stay recoverable. */
  #migrateSchema(): void {
    const metadata = this.#database
      .query<{ schema_version: number }, []>(
        "SELECT schema_version FROM agent_run_wal_metadata WHERE singleton = 1",
      )
      .get();
    if (metadata?.schema_version !== MIGRATABLE_JOURNAL_SCHEMA_VERSION) return;
    this.#database.transaction(() => {
      this.#database.run(
        "ALTER TABLE agent_run_wal_events ADD COLUMN delta INTEGER NOT NULL DEFAULT 0 CHECK (delta IN (0, 1))",
      );
      this.#database.run("UPDATE agent_run_wal_heads SET checkpoint_json = NULL");
      this.#database.run(
        "UPDATE agent_run_wal_metadata SET schema_version = ? WHERE singleton = 1",
        [JOURNAL_SCHEMA_VERSION],
      );
    })();
  }

  #selectHead(runId: string): JournalHeadStateRow | null {
    return (
      this.#database
        .query<JournalHeadStateRow, [string]>(
          `SELECT request_delivery_id, request_id, session_id, state, latest_sequence,
                  checkpoint_sequence, created_at, updated_at
           FROM agent_run_wal_heads WHERE request_delivery_id = ?`,
        )
        .get(runId) ?? null
    );
  }

  /** Returns the run's latest checkpoint, decoding it once when this process has not written it. */
  #latestCheckpoint(
    current: JournalHeadStateRow,
  ): ResultType<LatestCheckpointState | null, AgentRunJournalCodecFailure> {
    if (current.checkpoint_sequence === null) return Result.ok(null);
    const known = this.#latestCheckpoints.get(current.request_delivery_id);
    if (known?.sequence === current.checkpoint_sequence) return Result.ok(known);
    return this.#decodeCheckpointChain(current).map((chain) => {
      if (!chain.latest) return null;
      const state: LatestCheckpointState = {
        sequence: current.checkpoint_sequence ?? 0,
        messages: chain.latest.messages,
        metadataHash: payloadHash(SuperJSON.stringify(checkpointMetadata(chain.latest))),
        deltasSinceSnapshot: chain.deltasSinceSnapshot,
      };
      this.#latestCheckpoints.set(current.request_delivery_id, state);
      return state;
    });
  }

  /** Rebuilds the latest checkpoint and its predecessor from the retained snapshot and deltas. */
  #decodeCheckpointChain(row: JournalHeadStateRow): ResultType<
    {
      readonly latest?: AgentRunCheckpointV1;
      readonly previous?: AgentRunCheckpointV1;
      readonly deltasSinceSnapshot: number;
    },
    AgentRunJournalCodecFailure
  > {
    if (row.checkpoint_sequence === null) return Result.ok({ deltasSinceSnapshot: 0 });
    const runId = row.request_delivery_id;
    const events = this.#database
      .query<JournalCheckpointEventRow, [string]>(
        `SELECT sequence, delta, payload_json
         FROM agent_run_wal_events
         WHERE request_delivery_id = ? AND event_kind = 'checkpoint'
         ORDER BY sequence`,
      )
      .all(runId);
    if (events[0]?.delta !== 0 || events.at(-1)?.sequence !== row.checkpoint_sequence) {
      return Result.err(
        new AgentRunJournalCodecFailure({
          runId,
          field: "checkpoint",
          message: "Persisted agent run journal checkpoints do not start with a snapshot",
        }),
      );
    }
    let latest: AgentRunCheckpointV1 | undefined;
    let previous: AgentRunCheckpointV1 | undefined;
    let deltasSinceSnapshot = 0;
    for (const event of events) {
      const base = latest;
      const decoded =
        event.delta === 1 && base
          ? decodeAgentRunCheckpointDelta(event.payload_json, runId).andThen(({ value }) =>
              applyCheckpointDelta(runId, base, value),
            )
          : decodeAgentRunCheckpointPayload(event.payload_json, runId).map(({ value }) => value);
      const failure = decoded.match({ ok: () => null, err: (error) => error });
      if (failure) return Result.err(failure);
      previous = latest;
      latest = decoded.match({ ok: (value) => value, err: () => undefined });
      deltasSinceSnapshot = event.delta === 1 ? deltasSinceSnapshot + 1 : 0;
    }
    return Result.ok({
      ...(latest ? { latest } : {}),
      ...(previous ? { previous } : {}),
      deltasSinceSnapshot,
    });
  }

  openRun(work: AgentRunJournalOwner): ResultType<AgentRunJournalHandle, AgentRunJournalError> {
    const runId = work.requestDeliveryId;
    return openedPayload(runId).andThen((payload) =>
      transaction(
        this.#database,
        "open-run",
        (): ResultType<AgentRunJournalHandle, AgentRunJournalError> => {
          const owner = this.#database
            .query<JournalOwnerRow, [string]>(
              "SELECT request_id, state FROM request_delivery_records WHERE request_delivery_id = ?",
            )
            .get(runId);
          if (!owner || owner.state !== "accepted") {
            return Result.err(
              new AgentRunJournalConflict({
                runId,
                message: "Agent run journal requires an accepted request delivery owner",
              }),
            );
          }
          if (owner.request_id !== work.requestId) {
            return Result.err(
              new AgentRunJournalConflict({
                runId,
                message: "Agent run journal owner has a different request identity",
              }),
            );
          }
          const existing = this.#selectHead(runId);
          if (existing) {
            if (
              existing.state !== "active" ||
              existing.request_id !== work.requestId ||
              existing.session_id !== work.sessionId
            ) {
              return Result.err(
                new AgentRunJournalConflict({
                  runId,
                  message: "Agent run journal is already bound to incompatible run state",
                }),
              );
            }
            return Result.ok(handleFromRow(existing));
          }
          const now = this.#now();
          if (!nonnegativeSafeInteger(now)) {
            return Result.err(
              new AgentRunJournalCodecFailure({
                runId,
                field: "timestamp",
                message: "Agent run journal clock returned an invalid timestamp",
              }),
            );
          }
          this.#database.run(
            `INSERT INTO agent_run_wal_heads (
               request_delivery_id, request_id, session_id, state, latest_sequence,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'active', 1, ?, ?)`,
            [runId, work.requestId, work.sessionId, now, now],
          );
          this.#database.run(
            `INSERT INTO agent_run_wal_events (
               request_delivery_id, sequence, event_kind, payload_json, created_at
             ) VALUES (?, 1, 'opened', ?, ?)`,
            [runId, payload, now],
          );
          return Result.ok({
            runId,
            requestId: work.requestId,
            sessionId: work.sessionId,
            sequence: 1,
          });
        },
      ),
    );
  }

  /**
   * Appends the checkpoint as a delta on the latest one when they share a message prefix, or as
   * a snapshot otherwise. An unchanged checkpoint keeps the handle.
   */
  writeCheckpoint(
    handle: AgentRunJournalHandle,
    checkpoint: AgentRunCheckpointV1,
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError> {
    const metadata = checkpointMetadata(checkpoint);
    return serialize(handle.runId, "checkpoint", metadata).andThen((metadataPayload) =>
      transaction(
        this.#database,
        "write-checkpoint",
        (): ResultType<AgentRunJournalHandle, AgentRunJournalError> => {
          const current = this.#selectHead(handle.runId);
          if (
            !current ||
            current.state !== "active" ||
            current.request_id !== handle.requestId ||
            current.session_id !== handle.sessionId ||
            current.latest_sequence !== handle.sequence ||
            !positiveSafeInteger(handle.sequence) ||
            handle.sequence === Number.MAX_SAFE_INTEGER
          ) {
            return Result.err(
              new AgentRunJournalConflict({
                runId: handle.runId,
                message: "Agent run checkpoint used a stale or incompatible journal handle",
              }),
            );
          }
          const latestResult = this.#latestCheckpoint(current);
          const latestFailure = latestResult.match({ ok: () => null, err: (error) => error });
          if (latestFailure) return Result.err(latestFailure);
          const latest = latestResult.match({ ok: (value) => value, err: () => null });
          const metadataHash = payloadHash(metadataPayload);
          const keep = latest ? sharedMessagePrefix(latest.messages, checkpoint.messages) : 0;
          const unchanged =
            latest !== null &&
            keep === latest.messages.length &&
            keep === checkpoint.messages.length &&
            latest.metadataHash === metadataHash;
          if (unchanged) return Result.ok(handle);
          const appendsDelta =
            latest !== null && keep > 0 && latest.deltasSinceSnapshot < MAX_CHECKPOINT_DELTA_CHAIN;
          const payload = appendsDelta
            ? serialize(handle.runId, "checkpoint", {
                ...metadata,
                version: 2,
                keep,
                append: checkpoint.messages.slice(keep),
              } satisfies AgentRunCheckpointDelta)
            : serialize(handle.runId, "checkpoint", checkpoint);
          const payloadFailure = payload.match({ ok: () => null, err: (error) => error });
          if (payloadFailure) return Result.err(payloadFailure);
          const payloadJson = payload.match({ ok: (value) => value, err: () => "" });
          const sequence = handle.sequence + 1;
          const observedNow = this.#now();
          if (!nonnegativeSafeInteger(observedNow)) {
            return Result.err(
              new AgentRunJournalCodecFailure({
                runId: handle.runId,
                field: "timestamp",
                message: "Agent run journal clock returned an invalid timestamp",
              }),
            );
          }
          const now = Math.max(observedNow, current.updated_at);
          this.#database.run(
            `INSERT INTO agent_run_wal_events (
               request_delivery_id, sequence, event_kind, payload_json, created_at, delta
             ) VALUES (?, ?, 'checkpoint', ?, ?, ?)`,
            [handle.runId, sequence, payloadJson, now, appendsDelta ? 1 : 0],
          );
          this.#database.run(
            `UPDATE agent_run_wal_heads
             SET latest_sequence = ?, checkpoint_sequence = ?, checkpoint_json = NULL, updated_at = ?
             WHERE request_delivery_id = ?`,
            [sequence, sequence, now, handle.runId],
          );
          // Keep the chains of the new checkpoint and of its predecessor, nothing older.
          if (current.checkpoint_sequence !== null) {
            this.#database.run(
              `DELETE FROM agent_run_wal_events
               WHERE request_delivery_id = ? AND event_kind = 'checkpoint' AND sequence < (
                 SELECT MAX(sequence)
                 FROM agent_run_wal_events
                 WHERE request_delivery_id = ? AND event_kind = 'checkpoint'
                   AND delta = 0 AND sequence <= ?
               )`,
              [handle.runId, handle.runId, current.checkpoint_sequence],
            );
          }
          this.#latestCheckpoints.set(handle.runId, {
            sequence,
            messages: checkpoint.messages,
            metadataHash,
            deltasSinceSnapshot: appendsDelta ? (latest?.deltasSinceSnapshot ?? 0) + 1 : 0,
          });
          return Result.ok({ ...handle, sequence });
        },
      ),
    );
  }

  promotePreviousCheckpoint(
    handle: AgentRunJournalHandle,
    checkpoint: AgentRunCheckpointV1,
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError> {
    return checkpointPayload(handle.runId, checkpoint).andThen((payload) =>
      transaction(
        this.#database,
        "promote-previous-checkpoint",
        (): ResultType<AgentRunJournalHandle, AgentRunJournalError> => {
          const current = this.#selectHead(handle.runId);
          if (
            !current ||
            current.state !== "active" ||
            current.request_id !== handle.requestId ||
            current.session_id !== handle.sessionId ||
            current.latest_sequence !== handle.sequence ||
            !positiveSafeInteger(handle.sequence) ||
            handle.sequence === Number.MAX_SAFE_INTEGER
          ) {
            return Result.err(
              new AgentRunJournalConflict({
                runId: handle.runId,
                message: "Agent run fallback used a stale or incompatible journal handle",
              }),
            );
          }
          const chain = this.#decodeCheckpointChain(current);
          const chainFailure = chain.match({ ok: () => null, err: (error) => error });
          if (chainFailure) return Result.err(chainFailure);
          const previous = chain.match({ ok: (value) => value.previous, err: () => undefined });
          if (!previous || SuperJSON.stringify(previous) !== payload) {
            return Result.err(
              new AgentRunJournalConflict({
                runId: handle.runId,
                message: "Agent run fallback checkpoint is no longer the retained predecessor",
              }),
            );
          }
          const sequence = handle.sequence + 1;
          const observedNow = this.#now();
          if (!nonnegativeSafeInteger(observedNow)) {
            return Result.err(
              new AgentRunJournalCodecFailure({
                runId: handle.runId,
                field: "timestamp",
                message: "Agent run journal clock returned an invalid timestamp",
              }),
            );
          }
          const now = Math.max(observedNow, current.updated_at);
          this.#database.run(
            `DELETE FROM agent_run_wal_events
             WHERE request_delivery_id = ? AND event_kind = 'checkpoint'`,
            [handle.runId],
          );
          this.#database.run(
            `INSERT INTO agent_run_wal_events (
               request_delivery_id, sequence, event_kind, payload_json, created_at, delta
             ) VALUES (?, ?, 'checkpoint', ?, ?, 0)`,
            [handle.runId, sequence, payload, now],
          );
          this.#database.run(
            `UPDATE agent_run_wal_heads
             SET latest_sequence = ?, checkpoint_sequence = ?, checkpoint_json = NULL, updated_at = ?
             WHERE request_delivery_id = ?`,
            [sequence, sequence, now, handle.runId],
          );
          this.#latestCheckpoints.set(handle.runId, {
            sequence,
            messages: checkpoint.messages,
            metadataHash: payloadHash(SuperJSON.stringify(checkpointMetadata(checkpoint))),
            deltasSinceSnapshot: 0,
          });
          return Result.ok({ ...handle, sequence });
        },
      ),
    );
  }

  markTerminal(
    handle: AgentRunJournalHandle,
    terminal: {
      readonly outcome: RequestDeliveryTerminalOutcome;
      readonly finalReplayDeadline?: number;
    },
  ): ResultType<AgentRunJournalHandle, AgentRunJournalError> {
    return terminalPayload(handle.runId, terminal).andThen((payload) =>
      transaction(
        this.#database,
        "mark-terminal",
        (): ResultType<AgentRunJournalHandle, AgentRunJournalError> => {
          const current = this.#selectHead(handle.runId);
          if (
            !current ||
            current.state !== "active" ||
            current.request_id !== handle.requestId ||
            current.session_id !== handle.sessionId ||
            current.latest_sequence !== handle.sequence ||
            !positiveSafeInteger(handle.sequence) ||
            handle.sequence === Number.MAX_SAFE_INTEGER
          ) {
            return Result.err(
              new AgentRunJournalConflict({
                runId: handle.runId,
                message: "Agent run terminal marker used a stale or inactive journal handle",
              }),
            );
          }
          const sequence = handle.sequence + 1;
          const observedNow = this.#now();
          if (!nonnegativeSafeInteger(observedNow)) {
            return Result.err(
              new AgentRunJournalCodecFailure({
                runId: handle.runId,
                field: "timestamp",
                message: "Agent run journal clock returned an invalid timestamp",
              }),
            );
          }
          const now = Math.max(observedNow, current.updated_at);
          this.#database.run(
            `INSERT INTO agent_run_wal_events (
               request_delivery_id, sequence, event_kind, payload_json, created_at
             ) VALUES (?, ?, 'terminal', ?, ?)`,
            [handle.runId, sequence, payload, now],
          );
          this.#database.run(
            `UPDATE agent_run_wal_heads
             SET state = 'terminal', latest_sequence = ?, terminal_outcome_json = ?, updated_at = ?
             WHERE request_delivery_id = ?`,
            [sequence, payload, now, handle.runId],
          );
          return Result.ok({ ...handle, sequence });
        },
      ),
    );
  }

  #decodeHead(row: JournalHeadRow): ResultType<AgentRunRecoveryHead, AgentRunJournalCodecFailure> {
    if (
      !positiveSafeInteger(row.latest_sequence) ||
      !nonnegativeSafeInteger(row.created_at) ||
      !nonnegativeSafeInteger(row.updated_at) ||
      (row.checkpoint_sequence !== null && !positiveSafeInteger(row.checkpoint_sequence))
    ) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal head has invalid numeric fields"),
      );
    }
    if (row.updated_at < row.created_at) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal head has incoherent timestamps"),
      );
    }
    if (row.checkpoint_json !== null) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal head duplicates its checkpoint payload"),
      );
    }
    if (row.checkpoint_sequence !== null && row.checkpoint_sequence > row.latest_sequence) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal checkpoint is newer than its head"),
      );
    }
    const handle = handleFromRow(row);
    if (row.state === "active") {
      if (row.terminal_outcome_json !== null) {
        return Result.err(
          new AgentRunJournalCodecFailure({
            runId: row.request_delivery_id,
            field: "head",
            message: "Active agent run journal head has a terminal outcome",
          }),
        );
      }
      return this.#validateHeadEvents(row).andThen(() =>
        this.#decodeCheckpointChain(row).map(({ latest, previous }) => ({
          handle,
          state: "active" as const,
          ...(latest ? { checkpoint: latest } : {}),
          ...(previous ? { previousCheckpoint: previous } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      );
    }
    if (row.state !== "terminal" || row.terminal_outcome_json === null) {
      return Result.err(
        new AgentRunJournalCodecFailure({
          runId: row.request_delivery_id,
          field: "head",
          message: "Persisted agent run journal head has an invalid state",
        }),
      );
    }
    return decodeAgentRunTerminalPayload(
      row.terminal_outcome_json,
      row.request_delivery_id,
    ).andThen(({ value: terminal }) =>
      this.#validateHeadEvents(row).andThen(() =>
        this.#decodeCheckpointChain(row).map(({ latest, previous }) => ({
          handle,
          state: "terminal" as const,
          ...(latest ? { checkpoint: latest } : {}),
          ...(previous ? { previousCheckpoint: previous } : {}),
          terminalOutcome: terminal.outcome,
          ...(terminal.finalReplayDeadline === undefined
            ? {}
            : { finalReplayDeadline: terminal.finalReplayDeadline }),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      ),
    );
  }

  #validateHeadEvents(row: JournalHeadRow): ResultType<void, AgentRunJournalCodecFailure> {
    const events = this.#database
      .query<JournalEventRow, [string]>(
        `SELECT sequence, event_kind, payload_json, created_at
         FROM agent_run_wal_events
         WHERE request_delivery_id = ?
         ORDER BY sequence`,
      )
      .all(row.request_delivery_id);
    const checkpointEvents = events.filter((event) => event.event_kind === "checkpoint");
    const checkpointEvent = checkpointEvents.at(-1);
    const terminalEvent = events.find((event) => event.event_kind === "terminal");
    const checkpointEventCountIsCoherent =
      row.checkpoint_sequence === null
        ? checkpointEvents.length === 0
        : checkpointEvents.length > 0;
    const expectedEventCount = 1 + checkpointEvents.length + (row.state === "terminal" ? 1 : 0);
    const everyEventTimestampIsCoherent = events.every(
      (event) =>
        positiveSafeInteger(event.sequence) &&
        nonnegativeSafeInteger(event.created_at) &&
        event.created_at >= row.created_at &&
        event.created_at <= row.updated_at,
    );
    const openedEvent = events[0];
    if (!openedEvent) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal events do not match their recovery head"),
      );
    }
    const openedEventIsCoherent =
      openedEvent.sequence === 1 &&
      openedEvent.event_kind === "opened" &&
      openedEvent.created_at === row.created_at;
    const checkpointEventIsCoherent =
      row.checkpoint_sequence === null
        ? checkpointEvent === undefined
        : checkpointEvent?.sequence === row.checkpoint_sequence;
    const latestEvent = events.at(-1);
    const latestEventIsCoherent =
      latestEvent?.sequence === row.latest_sequence &&
      latestEvent.event_kind === expectedLatestEventKind(row) &&
      (row.state !== "terminal" || latestEvent.payload_json === row.terminal_outcome_json);
    const terminalEventIsCoherent =
      row.state === "terminal"
        ? terminalEvent?.sequence === row.latest_sequence &&
          terminalEvent.payload_json === row.terminal_outcome_json
        : terminalEvent === undefined;
    if (
      events.length !== expectedEventCount ||
      !checkpointEventCountIsCoherent ||
      !everyEventTimestampIsCoherent ||
      !openedEventIsCoherent ||
      !checkpointEventIsCoherent ||
      !latestEventIsCoherent ||
      !terminalEventIsCoherent
    ) {
      return Result.err(
        invalidHead(row, "Persisted agent run journal events do not match their recovery head"),
      );
    }
    return decodeAgentRunOpenedPayload(openedEvent.payload_json, row.request_delivery_id).map(
      () => undefined,
    );
  }

  loadRecoveryHeads(): ResultType<AgentRunJournalLoad, AgentRunJournalSqliteFailure> {
    return transaction(
      this.#database,
      "load-recovery-heads",
      (): ResultType<AgentRunJournalLoad, AgentRunJournalSqliteFailure> => {
        const metadata = this.#database
          .query<{ schema_version: number }, []>(
            "SELECT schema_version FROM agent_run_wal_metadata WHERE singleton = 1",
          )
          .get();
        if (!metadata || metadata.schema_version !== JOURNAL_SCHEMA_VERSION) {
          this.#resetAllTables();
          return Result.ok({
            heads: [],
            resets: [
              {
                scope: "all",
                reason: "incompatible-schema",
                errorName: "AgentRunJournalSchemaIncompatible",
              },
            ],
          });
        }
        const rows = this.#database
          .query<JournalHeadRow, []>(
            "SELECT * FROM agent_run_wal_heads ORDER BY created_at, request_delivery_id",
          )
          .all();
        const heads: AgentRunRecoveryHead[] = [];
        const resets: AgentRunJournalResetNotice[] = [];
        for (const row of rows) {
          const decoded = this.#decodeHead(row).match<
            | { readonly kind: "head"; readonly head: AgentRunRecoveryHead }
            | { readonly kind: "reset"; readonly error: AgentRunJournalCodecFailure }
          >({
            ok: (head) => ({ kind: "head", head }),
            err: (error) => ({ kind: "reset", error }),
          });
          if (decoded.kind === "head") {
            heads.push(decoded.head);
            continue;
          }
          this.#deleteRun(row.request_delivery_id);
          resets.push({
            scope: "run",
            runId: row.request_delivery_id,
            reason: "corrupt-payload",
            errorName: decoded.error.name,
          });
        }
        return Result.ok({ heads, resets });
      },
    );
  }

  resetRun(runId: string): ResultType<void, AgentRunJournalSqliteFailure> {
    return transaction(
      this.#database,
      "reset-run",
      (): ResultType<void, AgentRunJournalSqliteFailure> => {
        this.#deleteRun(runId);
        return Result.ok(undefined);
      },
    );
  }

  resetAll(): ResultType<void, AgentRunJournalSqliteFailure> {
    return transaction(
      this.#database,
      "reset-all",
      (): ResultType<void, AgentRunJournalSqliteFailure> => {
        this.#resetAllTables();
        return Result.ok(undefined);
      },
    );
  }

  removeReconciled(runId: string): ResultType<void, AgentRunJournalSqliteFailure> {
    return transaction(
      this.#database,
      "remove-reconciled",
      (): ResultType<void, AgentRunJournalSqliteFailure> => {
        this.#deleteRun(runId);
        return Result.ok(undefined);
      },
    );
  }

  #deleteRun(runId: string): void {
    this.#latestCheckpoints.delete(runId);
    this.#database.run("DELETE FROM agent_run_wal_events WHERE request_delivery_id = ?", [runId]);
    this.#database.run("DELETE FROM agent_run_wal_heads WHERE request_delivery_id = ?", [runId]);
  }

  #resetAllTables(): void {
    this.#latestCheckpoints.clear();
    this.#database.run(`
      DROP TABLE IF EXISTS agent_run_wal_events;
      DROP TABLE IF EXISTS agent_run_wal_heads;
      DROP TABLE IF EXISTS agent_run_wal_metadata;
    `);
    this.#createTables();
  }
}

export function createAgentRunCheckpoint(input: {
  readonly mcpImages?: readonly McpImageCheckpointReference[];
  readonly messages: readonly StoredMessageV1[];
  readonly corePrimaryLineage?: CorePrimaryLineageV2;
  readonly nativeOutput?: NativeOutputFrontier;
  readonly loadedCatalogIds?: readonly string[];
  readonly questionResultIds?: readonly string[];
  readonly currentTurnUserId?: string;
  readonly retainedRequestDeliveries?: readonly {
    readonly requestDeliveryId: string;
    readonly outcome: RequestDeliveryTerminalOutcome;
  }[];
}): AgentRunCheckpointV1 {
  return {
    version: 1,
    messages: [...input.messages],
    ...(input.mcpImages?.length ? { mcpImages: [...input.mcpImages] } : {}),
    ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
    ...(input.nativeOutput ? { nativeOutput: input.nativeOutput } : {}),
    ...(input.loadedCatalogIds ? { loadedCatalogIds: [...input.loadedCatalogIds] } : {}),
    ...(input.questionResultIds ? { questionResultIds: [...input.questionResultIds] } : {}),
    ...(input.currentTurnUserId ? { currentTurnUserId: input.currentTurnUserId } : {}),
    retainedRequestDeliveries: [...(input.retainedRequestDeliveries ?? [])],
  };
}

const checkpointFixture = SuperJSON.stringify({
  version: 1,
  messages: [{ role: "user", content: "recover" }],
  retainedRequestDeliveries: [],
});

export const agentRunOpenedPayloadCodecCases = {
  current: {
    input: SuperJSON.stringify({ version: 1 }),
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: SuperJSON.stringify({ version: 0 }),
    outcome: "error",
  },
  "missing-defaulted": {
    input: SuperJSON.stringify({}),
    outcome: "error",
  },
  "unsupported-version": {
    input: SuperJSON.stringify({ version: 2 }),
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: SuperJSON.stringify({ version: 1, unexpected: true }),
    outcome: "error",
  },
} as const;

export const agentRunCheckpointPayloadCodecCases = {
  current: { input: checkpointFixture, outcome: "ok", provenance: "current" },
  legacy: {
    input: SuperJSON.stringify({ version: 0, messages: [], retainedRequestDeliveries: [] }),
    outcome: "error",
  },
  "missing-defaulted": {
    input: SuperJSON.stringify({ version: 1, messages: [] }),
    outcome: "error",
  },
  "unsupported-version": {
    input: SuperJSON.stringify({ version: 2, messages: [], retainedRequestDeliveries: [] }),
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: SuperJSON.stringify({
      version: 1,
      messages: [{ role: "invalid", content: "recover" }],
      retainedRequestDeliveries: [],
    }),
    outcome: "error",
  },
} as const;

export const agentRunCheckpointDeltaPayloadCodecCases = {
  current: {
    input: SuperJSON.stringify({
      version: 2,
      keep: 1,
      append: [{ role: "assistant", content: "continued" }],
      retainedRequestDeliveries: [],
    }),
    outcome: "ok",
    provenance: "current",
  },
  legacy: { input: checkpointFixture, outcome: "error" },
  "missing-defaulted": {
    input: SuperJSON.stringify({ version: 2, keep: 1, append: [] }),
    outcome: "error",
  },
  "unsupported-version": {
    input: SuperJSON.stringify({ version: 3, keep: 1, append: [], retainedRequestDeliveries: [] }),
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: SuperJSON.stringify({
      version: 2,
      keep: -1,
      append: [],
      retainedRequestDeliveries: [],
    }),
    outcome: "error",
  },
} as const;

export const agentRunTerminalPayloadCodecCases = {
  current: {
    input: SuperJSON.stringify({ version: 1, outcome: { kind: "completed" } }),
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: SuperJSON.stringify({ version: 0, outcome: { kind: "completed" } }),
    outcome: "error",
  },
  "missing-defaulted": {
    input: SuperJSON.stringify({ version: 1 }),
    outcome: "error",
  },
  "unsupported-version": {
    input: SuperJSON.stringify({ version: 2, outcome: { kind: "completed" } }),
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: SuperJSON.stringify({ version: 1, outcome: { kind: "unknown" } }),
    outcome: "error",
  },
} as const;
