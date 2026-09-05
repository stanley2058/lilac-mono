import { Database, type SQLQueryBindings } from "bun:sqlite";
import path from "node:path";
import { z } from "zod";
import {
  classifyBunSqliteError,
  env,
  runBunSqliteTransaction,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { configureSqliteConnection } from "../shared/sqlite";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import {
  canTransitionWorkflowOperation,
  canTransitionWorkflowRun,
  canTransitionWorkflowTrigger,
  canTransitionWorkflowWait,
  sameWorkflowProgressTarget,
  workflowOperationKindSchema,
  workflowOperationStateSchema,
  workflowSchemaMigrationSchema,
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
  type JsonValue,
  type WorkflowArtifactReference,
  type WorkflowOperation,
  type WorkflowOperationState,
  type WorkflowRevision,
  type WorkflowRevisionIdentity,
  type WorkflowRun,
  type WorkflowRunState,
  type WorkflowSchemaMigration,
  type WorkflowSurfaceAction,
  type WorkflowSurfaceBinding,
  type WorkflowTrigger,
  type WorkflowTriggerState,
  type WorkflowWait,
  type WorkflowWaitState,
} from "./workflow-domain";
import {
  applyWorkflowSchemaMigrations,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowMigrationError,
} from "./workflow-migrations";
import {
  decodeWorkflowPersistenceRow,
  type DecodedWorkflowActionOutboxEntry,
  type DecodedWorkflowRequestDispatch,
  type DecodedWorkflowRequestTerminalReceipt,
  type WorkflowPersistedRow,
  type WorkflowPersistenceDiagnostic,
} from "./workflow-persistence-codec";
import {
  workflowRequestPolicyIdentityProjection,
  type AuthorizedWorkflowRequest,
  type WorkflowRequestPolicy,
} from "./workflow-request-authority";
import { canonicalJson } from "./workflow-definition";
import { encodeWorkflowArtifactReference } from "./workflow-artifact-persistence-codec";
import { resolvedWorkflowAgentInputSchema } from "./workflow-operation-policy";

function resolveWorkflowDbPath(): string {
  return path.resolve(env.sqliteUrl);
}

const liveParentDeliverySnapshotRowSchema = z.object({
  pending_completion_count: z.number(),
  outstanding_run_count: z.number(),
});

const materializationAttemptRowSchema = z.object({
  materialization_attempt_count: z.number(),
});

type WorkflowRowDecoder<T> = (input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}) => ResultType<{ readonly value: T }, PersistedDataError>;

function decodeWorkflowRevisionRow(input: Parameters<WorkflowRowDecoder<WorkflowRevision>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "revision" });
}

function decodeWorkflowRunRow(input: Parameters<WorkflowRowDecoder<WorkflowRun>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "run" });
}

function decodeWorkflowOperationRow(input: Parameters<WorkflowRowDecoder<WorkflowOperation>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "operation" });
}

function decodeWorkflowWaitRow(input: Parameters<WorkflowRowDecoder<WorkflowWait>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "wait" });
}

function decodeWorkflowTriggerRow(input: Parameters<WorkflowRowDecoder<WorkflowTrigger>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "trigger" });
}

function decodeWorkflowSurfaceBindingRow(
  input: Parameters<WorkflowRowDecoder<WorkflowSurfaceBinding>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "binding" });
}

function decodeWorkflowSurfaceActionRow(
  input: Parameters<WorkflowRowDecoder<WorkflowSurfaceAction>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "action" });
}

function decodeWorkflowRequestDispatchRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowRequestDispatch>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "dispatch" });
}

function decodeWorkflowRequestTerminalReceiptRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowRequestTerminalReceipt>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "receipt" });
}

function decodeWorkflowActionOutboxRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowActionOutboxEntry>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "outbox" });
}

function decodeWorkflowArtifactRow(
  input: Parameters<WorkflowRowDecoder<WorkflowArtifactReference>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "artifact" });
}

export class DurableWorkflowSqliteDriverFailure extends TaggedError(
  "DurableWorkflowSqliteDriverFailure",
)<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export class DurableWorkflowInvariantViolation extends TaggedError(
  "DurableWorkflowInvariantViolation",
)<{
  readonly message: string;
}> {}

export type DurableWorkflowReadError = PersistedDataError | DurableWorkflowSqliteDriverFailure;

export function signalDurableWorkflowReadErrorToHost(error: DurableWorkflowReadError): never {
  return adaptToolResultToHost(Result.err(error));
}

function classifyWorkflowSqliteDriverFailure(
  operation: string,
  cause: Error,
): DurableWorkflowSqliteDriverFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError === undefined) return undefined;
  return new DurableWorkflowSqliteDriverFailure({
    operation,
    code: sqliteError.code,
    message: "Durable workflow SQLite operation failed",
  });
}

function captureWorkflowRead<T>(
  operation: string,
  read: () => ResultType<T, PersistedDataError>,
): ResultType<T, DurableWorkflowReadError> {
  const captured = Result.try({
    try: read,
    catch: captureRuntimeError,
  });
  const finishRead = captured.match<() => ResultType<T, DurableWorkflowReadError>>({
    ok: (value) => () => value,
    err: (captured) => () => {
      const cause = preserveToolPanic(
        projectCapturedRuntimeError(captured, "Opaque durable workflow read failure"),
      );
      const failure = classifyWorkflowSqliteDriverFailure(operation, cause);
      if (failure === undefined) return adaptToolResultToHost(Result.err(cause));
      return Result.err(failure);
    },
  });
  return finishRead();
}

function adaptWorkflowTransactionResultToStoreHost<T, TError extends Error>(
  result: ResultType<T, TError | DurableWorkflowSqliteDriverFailure>,
): T {
  return adaptToolResultToHost(result);
}

function runWorkflowResultTransactionForStoreHost<T, TError extends Error>(
  db: Database,
  operation: string,
  callback: () => ResultType<T, TError>,
): T {
  return adaptWorkflowTransactionResultToStoreHost(runWorkflowTransaction(db, operation, callback));
}

function runWorkflowTransaction<T, TError extends Error>(
  db: Database,
  operation: string,
  callback: () => ResultType<T, TError>,
): ResultType<T, TError | DurableWorkflowSqliteDriverFailure> {
  return runBunSqliteTransaction(db, callback, (cause) =>
    classifyWorkflowSqliteDriverFailure(operation, cause),
  );
}

function runWorkflowTransactionForStoreHost<T>(
  db: Database,
  operation: string,
  callback: () => T,
): T {
  return adaptWorkflowTransactionResultToStoreHost(
    runWorkflowTransaction(db, operation, () => Result.ok(callback())),
  );
}

function adaptWorkflowMigrationResultToStartupHost(
  result: ResultType<void, WorkflowMigrationError>,
): void {
  adaptToolResultToHost(result);
}

function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(1_000, limit ?? 100));
}

const workflowOperationProgressSummarySchema = z.object({
  phase: z.string().nullable(),
  kind: workflowOperationKindSchema,
  state: workflowOperationStateSchema,
  count: z.number().int().nonnegative(),
  startedCount: z.number().int().nonnegative(),
});

export type WorkflowOperationProgressSummary = z.infer<
  typeof workflowOperationProgressSummarySchema
>;

function revisionIdentityValues(identity: WorkflowRevisionIdentity): readonly string[] {
  return [
    identity.canonicalProjectId,
    identity.canonicalWorkspaceRoot,
    identity.scope,
    identity.normalizedPath,
    identity.sourceSha256,
    identity.inputSchemaSha256,
    identity.resourcePolicySha256,
    identity.runtimeVersion,
  ];
}

function encodeNullableWorkflowArtifactReference(
  reference: WorkflowArtifactReference | null,
): string | null {
  return reference === null ? null : encodeWorkflowArtifactReference(reference);
}

export type CreateWorkflowInvocationResult =
  | {
      status: "accepted";
      revision: WorkflowRevision;
      run: WorkflowRun;
      revisionCreated: boolean;
    }
  | {
      status: "rejected_capacity";
      activeRuns: number;
      limit: number;
    };

export class WorkflowInvocationInvalid extends TaggedError("WorkflowInvocationInvalid")<{
  readonly message: string;
}> {}

export class WorkflowInvocationConflict extends TaggedError("WorkflowInvocationConflict")<{
  readonly recordId: string;
  readonly message: string;
}> {}

export type CreateWorkflowInvocationError =
  | PersistedDataError
  | DurableWorkflowSqliteDriverFailure
  | WorkflowInvocationInvalid
  | WorkflowInvocationConflict;

export const DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS = 64;

export type ApplyWorkflowSurfaceActionResult =
  | {
      status: "applied";
      action: WorkflowSurfaceAction;
      runIds: string[];
    }
  | { status: "not_found" | "unauthorized" | "expired" | "consumed" | "stale" };

export class WorkflowSurfaceActionAtomicityConflict extends TaggedError(
  "WorkflowSurfaceActionAtomicityConflict",
)<{
  readonly actionId: string;
  readonly stage: "consume" | "load-updated-run" | "insert-run-event" | "insert-progress-event";
  readonly message: string;
}> {}

export type ApplyWorkflowSurfaceActionError =
  | PersistedDataError
  | DurableWorkflowSqliteDriverFailure
  | WorkflowSurfaceActionAtomicityConflict;

export type WorkflowRequestTerminalReceipt = DecodedWorkflowRequestTerminalReceipt;

export type WorkflowRequestDispatchHandoff =
  | { status: "receipt"; receipt: WorkflowRequestTerminalReceipt }
  | { status: "live"; dispatchEpoch: string; policy: WorkflowRequestPolicy }
  | { status: "stale"; dispatchEpoch: string; policy: WorkflowRequestPolicy }
  | { status: "fresh" };

export type WorkflowActionOutboxEntry = DecodedWorkflowActionOutboxEntry;

export type OrphanedLiveParentRun = {
  run: WorkflowRun;
  previousState: WorkflowRunState;
  cancelled: boolean;
};

export type DurableWorkflowStoreOptions = {
  readonly onPersistenceDiagnostic?: (diagnostic: WorkflowPersistenceDiagnostic) => void;
  readonly deferStartupRecovery?: boolean;
  readonly testHooks?: {
    readonly afterSurfaceActionStateChange?: () => void;
  };
};

export class DurableWorkflowStore {
  private readonly db: Database;
  private readonly options: DurableWorkflowStoreOptions;
  private readonly pendingPersistenceDiagnostics: WorkflowPersistenceDiagnostic[] = [];
  private persistenceDiagnosticFlushQueued = false;
  private startupRecoveryInitialized = false;

  constructor(dbPath?: string, options: DurableWorkflowStoreOptions = {}) {
    this.options = options;
    this.db = new Database(dbPath ?? resolveWorkflowDbPath());
    configureSqliteConnection(this.db);
    this.db.run("PRAGMA foreign_keys = ON");
    adaptWorkflowMigrationResultToStartupHost(applyWorkflowSchemaMigrations(this.db));
    if (options.deferStartupRecovery !== true) this.initializeStartupRecovery();
  }

  initializeStartupRecovery(): void {
    if (this.startupRecoveryInitialized) return;
    this.quarantineAndPauseLegacyResolvedReceipts(Date.now());
    this.startupRecoveryInitialized = true;
  }

  close(): void {
    this.db.close();
  }

  private persistedRows(sql: string) {
    return this.db.query<WorkflowPersistedRow, SQLQueryBindings[]>(sql);
  }

  private queuePersistenceDiagnostic(error: PersistedDataError): void {
    this.pendingPersistenceDiagnostics.push({
      table: error.table,
      field: error.field,
      version: error.version,
      issueCode: error.issueCode,
      recordId: error.recordId.slice(0, 256),
    });
    if (this.persistenceDiagnosticFlushQueued) return;
    this.persistenceDiagnosticFlushQueued = true;
    queueMicrotask(() => {
      this.persistenceDiagnosticFlushQueued = false;
      for (const diagnostic of this.pendingPersistenceDiagnostics.splice(0)) {
        this.options.onPersistenceDiagnostic?.(diagnostic);
      }
    });
  }

  private decodeRow<T>(
    row: WorkflowPersistedRow,
    decoder: WorkflowRowDecoder<T>,
  ): ResultType<T, PersistedDataError> {
    const decoded = decoder({ row, schemaVersion: WORKFLOW_SCHEMA_VERSION });
    return decoded
      .map((value) => value.value)
      .mapError((error) => {
        this.queuePersistenceDiagnostic(error);
        return error;
      });
  }

  private decodeRows<T>(
    rows: readonly WorkflowPersistedRow[],
    decoder: WorkflowRowDecoder<T>,
  ): ResultType<T[], PersistedDataError> {
    return Result.gen(function* (this: DurableWorkflowStore) {
      const values: T[] = [];
      for (const row of rows) values.push(yield* this.decodeRow(row, decoder));
      return Result.ok(values);
    }, this);
  }

  getWorkflowArtifact(
    artifactId: string,
  ): ResultType<WorkflowArtifactReference | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-workflow-artifact", () => {
      const row = this.persistedRows(
        "SELECT artifact_id, blob_ref_json, created_at FROM workflow_artifacts WHERE artifact_id = ?",
      ).get(artifactId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowArtifactRow);
    });
  }

  private ensureWorkflowArtifactReference(
    reference: WorkflowArtifactReference,
    createdAt: number,
  ): void {
    this.db
      .query(
        `INSERT INTO workflow_artifacts (artifact_id, blob_ref_json, created_at)
         VALUES (?, ?, ?) ON CONFLICT(artifact_id) DO NOTHING`,
      )
      .run(reference.artifactId, canonicalJson(reference.blobRef), createdAt);
    const stored = adaptToolResultToHost(this.getWorkflowArtifact(reference.artifactId));
    if (
      stored === null ||
      encodeWorkflowArtifactReference(stored) !== encodeWorkflowArtifactReference(reference)
    ) {
      adaptToolResultToHost(
        Result.err(
          new DurableWorkflowInvariantViolation({
            message: `Workflow artifact identity conflict: ${reference.artifactId}`,
          }),
        ),
      );
    }
  }

  registerWorkflowArtifact(
    reference: WorkflowArtifactReference,
    createdAt: number,
  ): ResultType<
    WorkflowArtifactReference,
    DurableWorkflowReadError | DurableWorkflowInvariantViolation
  > {
    return runWorkflowTransaction(this.db, "register-workflow-artifact", () => {
      this.db
        .query(
          `INSERT INTO workflow_artifacts (artifact_id, blob_ref_json, created_at)
           VALUES (?, ?, ?) ON CONFLICT(artifact_id) DO NOTHING`,
        )
        .run(reference.artifactId, canonicalJson(reference.blobRef), createdAt);
      return this.getWorkflowArtifact(reference.artifactId).andThen((stored) => {
        if (stored === null) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: `Workflow artifact registration disappeared: ${reference.artifactId}`,
            }),
          );
        }
        return Result.ok(stored);
      });
    });
  }

  private getWorkflowArtifactPublication(
    objectId: string,
  ): ResultType<WorkflowArtifactReference | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-workflow-artifact-publication", () => {
      const row = this.persistedRows(
        `SELECT artifact_id, blob_ref_json, created_at
         FROM workflow_artifact_publications WHERE object_id = ?`,
      ).get(objectId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowArtifactRow);
    });
  }

  beginWorkflowArtifactPublication(
    reference: WorkflowArtifactReference,
    createdAt: number,
  ): ResultType<void, DurableWorkflowReadError | DurableWorkflowInvariantViolation> {
    return runWorkflowTransaction(this.db, "begin-workflow-artifact-publication", () => {
      this.db.run(
        `INSERT INTO workflow_artifact_publications (object_id, artifact_id, blob_ref_json, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(object_id) DO NOTHING`,
        [
          reference.blobRef.objectId,
          reference.artifactId,
          canonicalJson(reference.blobRef),
          createdAt,
        ],
      );
      return this.getWorkflowArtifactPublication(reference.blobRef.objectId).andThen((stored) => {
        if (
          stored === null ||
          encodeWorkflowArtifactReference(stored) !== encodeWorkflowArtifactReference(reference)
        ) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: `Workflow artifact publication identity conflict: ${reference.blobRef.objectId}`,
            }),
          );
        }
        return Result.ok(undefined);
      });
    });
  }

  listWorkflowArtifactPublications(
    limit = 100,
  ): ResultType<WorkflowArtifactReference[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-workflow-artifact-publications", () => {
      const rows = this.persistedRows(
        `SELECT artifact_id, blob_ref_json, created_at FROM workflow_artifact_publications
         ORDER BY created_at, object_id LIMIT ?`,
      ).all(boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowArtifactRow);
    });
  }

  completeWorkflowArtifactPublication(
    reference: WorkflowArtifactReference,
    createdAt: number,
  ): ResultType<
    WorkflowArtifactReference,
    DurableWorkflowReadError | DurableWorkflowInvariantViolation
  > {
    return runWorkflowTransaction(this.db, "complete-workflow-artifact-publication", () => {
      const publication = this.getWorkflowArtifactPublication(reference.blobRef.objectId).match<
        | { readonly kind: "publication"; readonly reference: WorkflowArtifactReference | null }
        | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
      >({
        ok: (value) => ({ kind: "publication", reference: value }),
        err: (error) => ({ kind: "error", error }),
      });
      if (publication.kind === "error") return Result.err(publication.error);
      const expected = encodeWorkflowArtifactReference(reference);
      if (publication.reference === null) {
        return this.getWorkflowArtifact(reference.artifactId).andThen((canonical) => {
          if (canonical !== null && encodeWorkflowArtifactReference(canonical) === expected) {
            return Result.ok(canonical);
          }
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: `Workflow artifact publication is not retained: ${reference.blobRef.objectId}`,
            }),
          );
        });
      }
      if (encodeWorkflowArtifactReference(publication.reference) !== expected) {
        return Result.err(
          new DurableWorkflowInvariantViolation({
            message: `Workflow artifact publication identity conflict: ${reference.blobRef.objectId}`,
          }),
        );
      }
      const registered = this.registerWorkflowArtifact(reference, createdAt).match<
        | { readonly kind: "registered"; readonly reference: WorkflowArtifactReference }
        | {
            readonly kind: "error";
            readonly error: DurableWorkflowReadError | DurableWorkflowInvariantViolation;
          }
      >({
        ok: (value) => ({ kind: "registered", reference: value }),
        err: (error) => ({ kind: "error", error }),
      });
      if (registered.kind === "error") return Result.err(registered.error);
      if (encodeWorkflowArtifactReference(registered.reference) === expected) {
        this.db.run("DELETE FROM workflow_artifact_publications WHERE object_id = ?", [
          reference.blobRef.objectId,
        ]);
      }
      return Result.ok(registered.reference);
    });
  }

  removeWorkflowArtifactPublication(
    reference: WorkflowArtifactReference,
  ): ResultType<void, DurableWorkflowReadError | DurableWorkflowInvariantViolation> {
    return runWorkflowTransaction(
      this.db,
      "remove-workflow-artifact-publication",
      (): ResultType<void, DurableWorkflowReadError | DurableWorkflowInvariantViolation> => {
        const publication = this.getWorkflowArtifactPublication(reference.blobRef.objectId).match<
          | { readonly kind: "publication"; readonly reference: WorkflowArtifactReference | null }
          | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
        >({
          ok: (value) => ({ kind: "publication", reference: value }),
          err: (error) => ({ kind: "error", error }),
        });
        if (publication.kind === "error") return Result.err(publication.error);
        if (publication.reference === null) return Result.ok(undefined);
        if (
          encodeWorkflowArtifactReference(publication.reference) !==
          encodeWorkflowArtifactReference(reference)
        ) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: `Workflow artifact publication identity conflict: ${reference.blobRef.objectId}`,
            }),
          );
        }
        this.db.run("DELETE FROM workflow_artifact_publications WHERE object_id = ?", [
          reference.blobRef.objectId,
        ]);
        return Result.ok(undefined);
      },
    );
  }

  releaseWorkflowArtifactIfUnreferenced(
    artifactId: string,
  ): ResultType<WorkflowArtifactReference | null, DurableWorkflowReadError> {
    return runWorkflowTransaction(this.db, "release-workflow-artifact", () => {
      const loaded = this.getWorkflowArtifact(artifactId);
      return loaded.andThen((reference) => {
        if (reference === null) return Result.ok(null);
        const referenced = this.db
          .query<{ count: number }, [string, string, string, string]>(
            `SELECT (
               (SELECT COUNT(*) FROM workflow_revisions
                WHERE json_extract(snapshot_artifact_id, '$.artifactId') = ?) +
               (SELECT COUNT(*) FROM workflow_runs
                WHERE json_extract(result_artifact_id, '$.artifactId') = ?) +
               (SELECT COUNT(*) FROM workflow_operations
                WHERE json_extract(result_artifact_id, '$.artifactId') = ?) +
               (SELECT COUNT(*) FROM workflow_request_terminal_receipts
                WHERE json_extract(result_artifact_id, '$.artifactId') = ?)
             ) AS count`,
          )
          .get(artifactId, artifactId, artifactId, artifactId)?.count;
        if (referenced !== 0) return Result.ok(null);
        this.db.run("DELETE FROM workflow_artifacts WHERE artifact_id = ?", [artifactId]);
        return Result.ok(reference);
      });
    });
  }

  private quarantineAndPauseLegacyResolvedReceipts(now: number): void {
    runWorkflowTransactionForStoreHost(this.db, "quarantine-legacy-receipts", () => {
      this.db.run(
        `INSERT OR IGNORE INTO workflow_request_terminal_receipt_quarantine (
           request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
           quarantine_reason, quarantined_at
         )
         SELECT request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
           'legacy_resolved_receipt_missing_payload', ?
         FROM workflow_request_terminal_receipts
         WHERE state = 'resolved' AND output_json IS NULL AND result_artifact_id IS NULL`,
        [now],
      );
      this.db.run(
        `DELETE FROM workflow_request_terminal_receipts
         WHERE state = 'resolved' AND output_json IS NULL AND result_artifact_id IS NULL`,
      );
      this.db.run(
        `UPDATE workflow_operations
         SET state = 'blocked', error = ?,
            claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE state IN ('queued', 'dispatched', 'running')
           AND EXISTS (
             SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
             WHERE quarantine.run_id = workflow_operations.run_id
               AND quarantine.operation_id = workflow_operations.operation_id
           )`,
        [WORKFLOW_MANUAL_RECONCILIATION_DETAIL, now],
      );
      this.db.run(
        `UPDATE workflow_request_dispatches
         SET active = 0, updated_at = ?
         WHERE active = 1 AND EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_request_dispatches.run_id
             AND quarantine.operation_id = workflow_request_dispatches.operation_id
         )`,
        [now],
      );
      this.db.run(
        `UPDATE workflow_runs
         SET state = 'paused',
            terminal_detail = ?,
            claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE state NOT IN ('paused', 'succeeded', 'failed', 'rejected', 'cancelled')
           AND EXISTS (
             SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
             WHERE quarantine.run_id = workflow_runs.run_id
           )`,
        [WORKFLOW_MANUAL_RECONCILIATION_DETAIL, now],
      );
    });
  }

  listMigrations(): WorkflowSchemaMigration[] {
    return this.db
      .query("SELECT version, name, applied_at FROM workflow_schema_migrations ORDER BY version")
      .all()
      .map((value) => {
        const row = z
          .object({ version: z.number(), name: z.string(), applied_at: z.number() })
          .parse(value);
        return workflowSchemaMigrationSchema.parse({
          version: row.version,
          name: row.name,
          appliedAt: row.applied_at,
        });
      });
  }

  createRevision(revisionInput: WorkflowRevision): boolean {
    const revision = revisionInput;
    this.ensureWorkflowArtifactReference(revision.snapshotArtifact, revision.createdAt);
    const result = this.db
      .query(
        `INSERT INTO workflow_revisions (
          revision_id, canonical_project_id, canonical_workspace_root, scope,
          normalized_path, name, snapshot_artifact_id, source_sha256,
          input_schema_sha256, capability_sha256, metadata_json, input_schema_json,
          capabilities_json, limits_json, runtime_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
      )
      .run(
        revision.revisionId,
        revision.canonicalProjectId,
        revision.canonicalWorkspaceRoot,
        revision.scope,
        revision.normalizedPath,
        revision.name,
        encodeWorkflowArtifactReference(revision.snapshotArtifact),
        revision.sourceSha256,
        revision.inputSchemaSha256,
        revision.resourcePolicySha256,
        JSON.stringify(revision.metadata),
        JSON.stringify(revision.inputSchema),
        JSON.stringify(revision.resources),
        JSON.stringify(revision.limits),
        revision.runtimeVersion,
        revision.createdAt,
      );
    return result.changes === 1;
  }

  getRevision(revisionId: string): ResultType<WorkflowRevision | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-revision", () => {
      const row = this.persistedRows("SELECT * FROM workflow_revisions WHERE revision_id = ?").get(
        revisionId,
      );
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowRevisionRow);
    });
  }

  findRevisionByIdentity(
    identityInput: WorkflowRevisionIdentity,
  ): ResultType<WorkflowRevision | null, DurableWorkflowReadError> {
    return captureWorkflowRead("find-revision-by-identity", () => {
      const row = this.persistedRows(
        `SELECT * FROM workflow_revisions WHERE
          canonical_project_id = ? AND canonical_workspace_root = ? AND scope = ? AND
          normalized_path = ? AND source_sha256 = ? AND input_schema_sha256 = ? AND
          capability_sha256 = ? AND runtime_version = ?`,
      ).get(...revisionIdentityValues(identityInput));
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowRevisionRow);
    });
  }

  listRevisions(options?: {
    canonicalProjectId?: string;
    scope?: WorkflowRevision["scope"];
    limit?: number;
  }): ResultType<WorkflowRevision[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-revisions", () => {
      const clauses: string[] = [];
      const bindings: string[] = [];
      if (options?.canonicalProjectId) {
        clauses.push("canonical_project_id = ?");
        bindings.push(options.canonicalProjectId);
      }
      if (options?.scope) {
        clauses.push("scope = ?");
        bindings.push(options.scope);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.persistedRows(
        `SELECT * FROM workflow_revisions ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...bindings, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowRevisionRow);
    });
  }

  createRun(runInput: WorkflowRun): boolean {
    const run = runInput;
    if (run.resultArtifact) {
      this.ensureWorkflowArtifactReference(run.resultArtifact, run.createdAt);
    }
    const result = this.db
      .query(
        `INSERT INTO workflow_runs (
          run_id, revision_id, state, input_schema_json, args_json,
          args_sha256, origin_request_id, origin_session_id, origin_client,
          origin_user_id, origin_project_cwd,
          completion_target_json, progress_target_json, terminal_detail, result_json,
          result_artifact_id, claimed_by, claimed_at, created_at, started_at,
          updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(
        run.runId,
        run.revisionId,
        run.state,
        JSON.stringify(run.inputSchemaSnapshot),
        JSON.stringify(run.args),
        run.argsSha256,
        run.origin.requestId,
        run.origin.sessionId,
        run.origin.client,
        run.origin.userId,
        run.origin.projectCwd,
        JSON.stringify(run.completionTarget),
        run.progressTarget === null ? null : JSON.stringify(run.progressTarget),
        run.terminalDetail,
        run.result === null ? null : JSON.stringify(run.result),
        run.resultArtifact === null ? null : encodeWorkflowArtifactReference(run.resultArtifact),
        run.claimedBy,
        run.claimedAt,
        run.createdAt,
        run.startedAt,
        run.updatedAt,
        run.terminalAt,
      );
    // SQLite includes the live-parent delivery trigger in the statement change count.
    return result.changes >= 1;
  }

  getRun(runId: string): ResultType<WorkflowRun | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-run", () => {
      const row = this.persistedRows("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowRunRow);
    });
  }

  listRuns(options?: {
    revisionId?: string;
    state?: WorkflowRunState;
    canonicalProjectId?: string;
    originClient?: string;
    originUserId?: string;
    limit?: number;
  }): ResultType<WorkflowRun[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-runs", () => {
      const clauses: string[] = [];
      const bindings: string[] = [];
      if (options?.revisionId) {
        clauses.push("workflow_runs.revision_id = ?");
        bindings.push(options.revisionId);
      }
      if (options?.state) {
        clauses.push("workflow_runs.state = ?");
        bindings.push(options.state);
      }
      if (options?.canonicalProjectId) {
        clauses.push("workflow_revisions.canonical_project_id = ?");
        bindings.push(options.canonicalProjectId);
      }
      if (options?.originClient) {
        clauses.push("workflow_runs.origin_client = ?");
        bindings.push(options.originClient);
      }
      if (options?.originUserId) {
        clauses.push("workflow_runs.origin_user_id = ?");
        bindings.push(options.originUserId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_revisions ON workflow_revisions.revision_id = workflow_runs.revision_id
         ${where} ORDER BY workflow_runs.created_at DESC LIMIT ?`,
      ).all(...bindings, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowRunRow);
    });
  }

  listActiveRuns(limit = 1_000): ResultType<WorkflowRun[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-active-runs", () => {
      const rows = this.persistedRows(
        `SELECT * FROM workflow_runs
         WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
         ORDER BY updated_at, run_id LIMIT ?`,
      ).all(boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowRunRow);
    });
  }

  countActiveRuns(): number {
    const row = this.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM workflow_runs
         WHERE state NOT IN ('succeeded', 'failed', 'cancelled')`,
      )
      .get();
    return row?.count ?? 0;
  }

  listRunsNeedingProjectionReconciliation(options?: {
    readonly limit?: number;
    readonly after?: { readonly updatedAt: number; readonly runId: string };
  }): ResultType<WorkflowRun[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-runs-needing-projection-reconciliation", () => {
      const cursorClause = options?.after
        ? `AND (
             workflow_runs.updated_at > ?
             OR (workflow_runs.updated_at = ? AND workflow_runs.run_id > ?)
           )`
        : "";
      const cursorBindings = options?.after
        ? [options.after.updatedAt, options.after.updatedAt, options.after.runId]
        : [];
      const rows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
         LEFT JOIN workflow_surface_bindings
           ON workflow_surface_bindings.run_id = workflow_runs.run_id
         WHERE workflow_runs.progress_target_json IS NOT NULL
           AND (
             workflow_runs.state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
             OR workflow_surface_bindings.run_id IS NULL
              OR (
                workflow_runs.terminal_at IS NOT NULL
                AND workflow_surface_bindings.updated_at < workflow_runs.terminal_at
              )
              OR workflow_surface_bindings.permanent_failure_json IS NOT NULL
             )
           ${cursorClause}
          ORDER BY workflow_runs.updated_at, workflow_runs.run_id LIMIT ?`,
      ).all(...cursorBindings, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowRunRow);
    });
  }

  createInvocation(input: {
    revision: WorkflowRevision;
    run: WorkflowRun;
    idempotency?: { key: string; fingerprintSha256: string };
    maxActiveRuns?: number;
  }): ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError> {
    const revision = input.revision;
    const requestedRun = input.run;
    if (requestedRun.revisionId !== revision.revisionId) {
      return Result.err(
        new WorkflowInvocationInvalid({
          message: "Run revisionId must match the requested revision",
        }),
      );
    }
    if (requestedRun.state !== "queued") {
      return Result.err(
        new WorkflowInvocationInvalid({ message: "Workflow invocations must be queued" }),
      );
    }
    const maxActiveRuns = input.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS;
    if (!Number.isInteger(maxActiveRuns) || maxActiveRuns <= 0) {
      return Result.err(
        new WorkflowInvocationInvalid({ message: "Maximum active workflow runs must be positive" }),
      );
    }

    return runBunSqliteTransaction(
      this.db,
      (): ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError> => {
        const acceptNewInvocation = (): ResultType<
          CreateWorkflowInvocationResult,
          CreateWorkflowInvocationError
        > => {
          const activeRuns = this.countActiveRuns();
          if (activeRuns >= maxActiveRuns) {
            return Result.ok<CreateWorkflowInvocationResult>({
              status: "rejected_capacity",
              activeRuns,
              limit: maxActiveRuns,
            });
          }
          const revisionCreated = this.createRevision(revision);
          const storedRevisionRow = this.persistedRows(
            `SELECT * FROM workflow_revisions WHERE
              canonical_project_id = ? AND canonical_workspace_root = ? AND scope = ? AND
              normalized_path = ? AND source_sha256 = ? AND input_schema_sha256 = ? AND
              capability_sha256 = ? AND runtime_version = ?`,
          ).get(...revisionIdentityValues(revision));
          if (storedRevisionRow === null) {
            return Result.err(
              new WorkflowInvocationConflict({
                recordId: revision.revisionId,
                message: "Workflow revision was not persisted",
              }),
            );
          }
          const continueWithRevision = this.decodeRow(
            storedRevisionRow,
            decodeWorkflowRevisionRow,
          ).match<() => ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError>>({
            err: (error) => () => Result.err(error),
            ok: (storedRevision) => () => {
              if (storedRevision.revisionId !== revision.revisionId) {
                return Result.err(
                  new WorkflowInvocationConflict({
                    recordId: revision.revisionId,
                    message: "Workflow revision identity already belongs to another revision",
                  }),
                );
              }
              const run = requestedRun;
              if (!this.createRun(run)) {
                return Result.err(
                  new WorkflowInvocationConflict({
                    recordId: run.runId,
                    message: "Workflow run already exists",
                  }),
                );
              }
              if (input.idempotency) {
                this.db.run(
                  `INSERT INTO workflow_invocation_receipts (
             idempotency_key, run_id, fingerprint_sha256, created_at
           ) VALUES (?, ?, ?, ?)`,
                  [
                    input.idempotency.key,
                    run.runId,
                    input.idempotency.fingerprintSha256,
                    run.createdAt,
                  ],
                );
              }
              return Result.ok<CreateWorkflowInvocationResult>({
                status: "accepted",
                revision: storedRevision,
                run,
                revisionCreated,
              });
            },
          });
          return continueWithRevision();
        };

        if (!input.idempotency) return acceptNewInvocation();
        const idempotency = input.idempotency;
        const receipt = this.db
          .query<{ run_id: string; fingerprint_sha256: string }, [string]>(
            "SELECT run_id, fingerprint_sha256 FROM workflow_invocation_receipts WHERE idempotency_key = ?",
          )
          .get(idempotency.key);
        if (!receipt) return acceptNewInvocation();
        if (receipt.fingerprint_sha256 !== idempotency.fingerprintSha256) {
          return Result.err(
            new WorkflowInvocationConflict({
              recordId: idempotency.key,
              message: "Workflow idempotency key was reused with different invocation input",
            }),
          );
        }
        const existingRunRow = this.persistedRows(
          "SELECT * FROM workflow_runs WHERE run_id = ?",
        ).get(receipt.run_id);
        if (existingRunRow === null) {
          return Result.err(
            new WorkflowInvocationConflict({
              recordId: idempotency.key,
              message: "Workflow invocation receipt references missing durable records",
            }),
          );
        }
        const continueWithRun = this.decodeRow(existingRunRow, decodeWorkflowRunRow).match<
          () => ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError>
        >({
          err: (error) => () => Result.err(error),
          ok: (existingRun) => () => {
            const existingRevisionRow = this.persistedRows(
              "SELECT * FROM workflow_revisions WHERE revision_id = ?",
            ).get(existingRun.revisionId);
            if (existingRevisionRow === null) {
              return Result.err(
                new WorkflowInvocationConflict({
                  recordId: idempotency.key,
                  message: "Workflow invocation receipt references missing durable records",
                }),
              );
            }
            const continueWithExistingRevision = this.decodeRow(
              existingRevisionRow,
              decodeWorkflowRevisionRow,
            ).match<
              () => ResultType<CreateWorkflowInvocationResult, CreateWorkflowInvocationError>
            >({
              err: (error) => () => Result.err(error),
              ok: (existingRevision) => () =>
                Result.ok<CreateWorkflowInvocationResult>({
                  status: "accepted",
                  run: existingRun,
                  revision: existingRevision,
                  revisionCreated: false,
                }),
            });
            return continueWithExistingRevision();
          },
        });
        return continueWithRun();
      },
      (cause) => classifyWorkflowSqliteDriverFailure("create-invocation", cause),
    );
  }

  listActiveLiveParentRuns(
    parentRequestId: string,
    limit = 1_000,
  ): ResultType<WorkflowRun[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-active-live-parent-runs", () => {
      const rows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.parent_request_id = ?
           AND workflow_completion_deliveries.state = 'pending'
            AND workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')
         ORDER BY workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      ).all(parentRequestId, boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowRunRow);
    });
  }

  getLiveParentDeliverySnapshot(
    parentRequestId: string,
    includeSynchronous = false,
  ): { pendingCompletionCount: number; outstandingRunCount: number } {
    const raw = this.db
      .query(
        `SELECT
           COALESCE(SUM(CASE
             WHEN workflow_runs.state IN ('succeeded', 'failed', 'cancelled')
              AND (? = 1 OR COALESCE(
                json_extract(workflow_runs.completion_target_json, '$.deferredDelivery'), 1
              ) = 1)
             THEN 1 ELSE 0 END), 0) AS pending_completion_count,
           COALESCE(SUM(CASE
             WHEN workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')
             THEN 1 ELSE 0 END), 0) AS outstanding_run_count
         FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.parent_request_id = ?
           AND workflow_completion_deliveries.state = 'pending'`,
      )
      .get(includeSynchronous ? 1 : 0, parentRequestId);
    const row = liveParentDeliverySnapshotRowSchema.parse(raw);
    return {
      pendingCompletionCount: row.pending_completion_count,
      outstandingRunCount: row.outstanding_run_count,
    };
  }

  listPendingLiveParentCompletions(
    parentRequestId: string,
    limit = 1_000,
    includeSynchronous = false,
  ): ResultType<WorkflowRun[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-pending-live-parent-completions", () => {
      const rows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
          WHERE workflow_completion_deliveries.parent_request_id = ?
            AND workflow_completion_deliveries.state = 'pending'
            AND (? = 1 OR COALESCE(
              json_extract(workflow_runs.completion_target_json, '$.deferredDelivery'), 1
            ) = 1)
             AND workflow_runs.state IN ('succeeded', 'failed', 'cancelled')
         ORDER BY workflow_runs.terminal_at, workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      ).all(parentRequestId, includeSynchronous ? 1 : 0, boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowRunRow);
    });
  }

  getLiveParentDeliveryState(
    runId: string,
  ): "pending" | "delivered" | "fallback" | "orphaned" | null {
    const row = this.db
      .query<{ state: string }, [string]>(
        "SELECT state FROM workflow_completion_deliveries WHERE run_id = ?",
      )
      .get(runId);
    if (!row) return null;
    return z.enum(["pending", "delivered", "fallback", "orphaned"]).parse(row.state);
  }

  reconcileOrphanedLiveParentRuns(input: {
    resolvableParentRequestIds: readonly string[];
    now: number;
    detail: string;
  }): OrphanedLiveParentRun[] {
    return runWorkflowResultTransactionForStoreHost<
      OrphanedLiveParentRun[],
      DurableWorkflowReadError | DurableWorkflowInvariantViolation
    >(this.db, "reconcile-orphaned-live-parent-runs", () => {
      const pendingRows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
           JOIN workflow_completion_deliveries
             ON workflow_completion_deliveries.run_id = workflow_runs.run_id
           WHERE workflow_completion_deliveries.state = 'pending'
           ORDER BY workflow_runs.created_at, workflow_runs.run_id`,
      ).all();
      const continueWithPendingRuns = this.decodeRows(pendingRows, decodeWorkflowRunRow).match<
        () => ResultType<
          OrphanedLiveParentRun[],
          DurableWorkflowReadError | DurableWorkflowInvariantViolation
        >
      >({
        err: (error) => () => Result.err(error),
        ok: (pendingRuns) => () => {
          const resolvableRequestIds = new Set(input.resolvableParentRequestIds);
          const retainedRunIds = new Set<string>();

          const durableRootRequestRows = this.db
            .query<{ request_id: string }, []>(
              `SELECT workflow_operations.request_id FROM workflow_operations
           JOIN workflow_runs ON workflow_runs.run_id = workflow_operations.run_id
           WHERE workflow_operations.kind = 'agent'
             AND workflow_operations.request_id IS NOT NULL
             AND workflow_operations.state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')
             AND workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')
             AND json_extract(workflow_runs.completion_target_json, '$.kind') <> 'live_parent'`,
            )
            .all();
          for (const row of durableRootRequestRows) resolvableRequestIds.add(row.request_id);
          const liveParentRequestRows = this.db
            .query<{ run_id: string; request_id: string }, []>(
              `SELECT workflow_operations.run_id, workflow_operations.request_id
           FROM workflow_operations
           JOIN workflow_completion_deliveries
             ON workflow_completion_deliveries.run_id = workflow_operations.run_id
           WHERE workflow_completion_deliveries.state = 'pending'
             AND workflow_operations.kind = 'agent'
             AND workflow_operations.request_id IS NOT NULL
             AND workflow_operations.state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
            )
            .all();
          const activeRequestIdsByRun = new Map<string, string[]>();
          for (const row of liveParentRequestRows) {
            const requestIds = activeRequestIdsByRun.get(row.run_id) ?? [];
            requestIds.push(row.request_id);
            activeRequestIdsByRun.set(row.run_id, requestIds);
          }

          let changed = true;
          while (changed) {
            changed = false;
            for (const run of pendingRuns) {
              if (
                retainedRunIds.has(run.runId) ||
                run.completionTarget.kind !== "live_parent" ||
                !resolvableRequestIds.has(run.completionTarget.parentRequestId)
              ) {
                continue;
              }
              retainedRunIds.add(run.runId);
              changed = true;
              if (["succeeded", "failed", "cancelled"].includes(run.state)) continue;
              for (const requestId of activeRequestIdsByRun.get(run.runId) ?? []) {
                resolvableRequestIds.add(requestId);
              }
            }
          }

          const orphaned: OrphanedLiveParentRun[] = [];
          for (const run of pendingRuns) {
            if (retainedRunIds.has(run.runId)) continue;
            const terminal = ["succeeded", "failed", "cancelled"].includes(run.state);
            if (!terminal) {
              this.db.run(
                `UPDATE workflow_operations SET state = 'cancelled', error = ?, terminal_at = ?,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
             WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
                [input.detail, input.now, input.now, run.runId],
              );
              this.db.run(
                `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
             resolved_at = ?, updated_at = ?
             WHERE run_id = ? AND state IN ('pending', 'claimed')`,
                [input.now, input.now, run.runId],
              );
              this.db.run(
                `UPDATE workflow_request_dispatches SET active = 0, owner_id = NULL,
             owner_heartbeat_at = NULL, updated_at = ?
             WHERE run_id = ? AND active = 1`,
                [input.now, run.runId],
              );
              this.db.run(
                `UPDATE workflow_runs SET state = 'cancelled', terminal_detail = ?, terminal_at = ?,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
             WHERE run_id = ? AND state = ?`,
                [input.detail, input.now, input.now, run.runId, run.state],
              );
            }
            const delivery = this.db
              .query(
                `UPDATE workflow_completion_deliveries
             SET state = 'orphaned', delivered_at = ?, updated_at = ?
             WHERE run_id = ? AND state = 'pending'`,
              )
              .run(input.now, input.now, run.runId);
            if (delivery.changes !== 1) continue;
            const updatedRow = this.persistedRows(
              "SELECT * FROM workflow_runs WHERE run_id = ?",
            ).get(run.runId);
            if (updatedRow === null) {
              return Result.err(
                new DurableWorkflowInvariantViolation({
                  message: `Orphaned workflow run disappeared: ${run.runId}`,
                }),
              );
            }
            const updatedResult = this.decodeRow(updatedRow, decodeWorkflowRunRow);
            const updateError = updatedResult.match({
              err: (error) => error,
              ok: (updated) => {
                orphaned.push({ run: updated, previousState: run.state, cancelled: !terminal });
                return null;
              },
            });
            if (updateError) return Result.err(updateError);
          }
          return Result.ok(orphaned);
        },
      });
      return continueWithPendingRuns();
    });
  }

  markLiveParentCompletionDelivered(runId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_completion_deliveries
           SET state = 'delivered', delivered_at = ?, updated_at = ?
           WHERE run_id = ? AND state = 'pending'`,
        )
        .run(now, now, runId).changes === 1
    );
  }

  recordLiveParentCompletionMaterializationFailure(input: {
    runId: string;
    error: string;
    now: number;
  }): number | null {
    return runWorkflowTransactionForStoreHost(
      this.db,
      "record-live-parent-materialization-failure",
      () => {
        const updated = this.db
          .query(
            `UPDATE workflow_completion_deliveries
           SET materialization_attempt_count = materialization_attempt_count + 1,
               materialization_error = ?, updated_at = ?
           WHERE run_id = ? AND state = 'pending'`,
          )
          .run(input.error.slice(0, 2_000), input.now, input.runId);
        if (updated.changes !== 1) return null;
        const raw = this.db
          .query(
            `SELECT materialization_attempt_count
           FROM workflow_completion_deliveries WHERE run_id = ?`,
          )
          .get(input.runId);
        return materializationAttemptRowSchema.parse(raw).materialization_attempt_count;
      },
    );
  }

  clearLiveParentCompletionMaterializationFailure(runId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_completion_deliveries
           SET materialization_attempt_count = 0, materialization_error = NULL, updated_at = ?
           WHERE run_id = ? AND state = 'pending'
             AND (materialization_attempt_count <> 0 OR materialization_error IS NOT NULL)`,
        )
        .run(now, runId).changes === 1
    );
  }

  transitionRun(input: {
    runId: string;
    from: WorkflowRunState;
    to: WorkflowRunState;
    now: number;
    detail?: string | null;
    result?: WorkflowRun["result"];
    resultArtifact?: WorkflowArtifactReference | null;
  }): boolean {
    if (!canTransitionWorkflowRun(input.from, input.to)) {
      return false;
    }
    const current = adaptToolResultToHost(this.getRun(input.runId));
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    if (input.resultArtifact) {
      this.ensureWorkflowArtifactReference(input.resultArtifact, input.now);
    }
    if (input.from === "paused" && input.to === "queued") {
      return runWorkflowTransactionForStoreHost(this.db, "resume-run", () => {
        const readPaused = this.getRun(input.runId).match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const paused = readPaused();
        if (!paused || paused.state !== "paused") return false;
        if (!this.preparePausedOperationsForResume(input.runId, input.now)) return false;
        return (
          this.db
            .query(
              `UPDATE workflow_runs SET state = 'queued', terminal_detail = ?, updated_at = ?
               WHERE run_id = ? AND state = 'paused'`,
            )
            .run(input.detail ?? paused.terminalDetail, input.now, input.runId).changes === 1
        );
      });
    }
    const terminal = ["succeeded", "failed", "rejected", "cancelled"].includes(input.to);
    let resultJson: string | null;
    if (input.result === undefined) {
      resultJson = current.result === null ? null : JSON.stringify(current.result);
    } else if (input.result === null) {
      resultJson = null;
    } else {
      resultJson = JSON.stringify(input.result);
    }
    const result = this.db
      .query(
        `UPDATE workflow_runs SET state = ?, terminal_detail = ?, result_json = ?,
          result_artifact_id = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END, updated_at = ?
         WHERE run_id = ? AND state = ?`,
      )
      .run(
        input.to,
        input.detail ?? current.terminalDetail,
        resultJson,
        input.resultArtifact === undefined
          ? encodeNullableWorkflowArtifactReference(current.resultArtifact)
          : encodeNullableWorkflowArtifactReference(input.resultArtifact),
        input.to,
        input.now,
        terminal,
        input.now,
        input.now,
        input.runId,
        input.from,
      );
    return result.changes === 1;
  }

  terminalizeRun(input: {
    runId: string;
    from: "running";
    to: "succeeded" | "failed";
    ownerId: string;
    now: number;
    detail: string;
    result: WorkflowRun["result"];
    resultArtifact: WorkflowArtifactReference | null;
  }): boolean {
    return runWorkflowTransactionForStoreHost(this.db, "terminalize-run", () => {
      if (input.resultArtifact) {
        this.ensureWorkflowArtifactReference(input.resultArtifact, input.now);
      }
      const readRun = this.getRun(input.runId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const run = readRun();
      if (!run || run.state !== input.from || run.claimedBy !== input.ownerId) return false;
      const activeCount = this.db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM workflow_operations
           WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
        )
        .get(input.runId)?.count;
      if (input.to === "succeeded" && activeCount !== 0) return false;
      if (input.to === "failed") {
        this.db.run(
          `UPDATE workflow_operations SET state = 'cancelled', error = ?, terminal_at = ?,
           updated_at = ? WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
          [input.detail, input.now, input.now, input.runId],
        );
      }
      this.db.run(
        `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
         resolved_at = ?, updated_at = ?
         WHERE run_id = ? AND state IN ('pending', 'claimed')`,
        [input.now, input.now, input.runId],
      );
      this.db.run(
        `UPDATE workflow_request_dispatches SET active = 0, updated_at = ?
         WHERE run_id = ? AND active = 1`,
        [input.now, input.runId],
      );
      const result = this.db
        .query(
          `UPDATE workflow_runs SET state = ?, terminal_detail = ?, result_json = ?,
           result_artifact_id = ?, terminal_at = ?, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND claimed_by = ?`,
        )
        .run(
          input.to,
          input.detail,
          input.result === null ? null : JSON.stringify(input.result),
          input.resultArtifact === null
            ? null
            : encodeWorkflowArtifactReference(input.resultArtifact),
          input.now,
          input.now,
          input.runId,
          input.ownerId,
        );
      return result.changes === 1;
    });
  }

  cancelRunAndChildren(input: { runId: string; now: number; detail: string }): WorkflowRun | null {
    return runWorkflowTransactionForStoreHost(this.db, "cancel-run-and-children", () =>
      this.cancelRunAndChildrenInTransaction(input),
    );
  }

  cancelLiveParentRunsAndSuppress(input: {
    parentRequestId: string;
    now: number;
    detail: string;
  }): OrphanedLiveParentRun[] {
    return runWorkflowTransactionForStoreHost(this.db, "cancel-live-parent-runs", () => {
      const rows = this.persistedRows(
        `SELECT workflow_runs.* FROM workflow_runs
           JOIN workflow_completion_deliveries
             ON workflow_completion_deliveries.run_id = workflow_runs.run_id
           WHERE workflow_completion_deliveries.parent_request_id = ?
             AND workflow_completion_deliveries.state = 'pending'
             AND workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')
           ORDER BY workflow_runs.created_at, workflow_runs.run_id`,
      ).all(input.parentRequestId);
      const readRuns = this.decodeRows(rows, decodeWorkflowRunRow).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const runs = readRuns();
      const cancelled: OrphanedLiveParentRun[] = [];
      for (const run of runs) {
        const updated = this.cancelRunAndChildrenInTransaction({
          runId: run.runId,
          now: input.now,
          detail: input.detail,
        });
        if (updated?.state === "cancelled") {
          cancelled.push({ run: updated, previousState: run.state, cancelled: true });
        }
      }
      this.db.run(
        `UPDATE workflow_completion_deliveries
         SET state = 'delivered', delivered_at = ?, updated_at = ?
         WHERE parent_request_id = ? AND state = 'pending'`,
        [input.now, input.now, input.parentRequestId],
      );
      return cancelled;
    });
  }

  private cancelRunAndChildrenInTransaction(input: {
    runId: string;
    now: number;
    detail: string;
  }): WorkflowRun | null {
    const readRun = this.getRun(input.runId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const run = readRun();
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.state)) return run;
    this.db.run(
      `UPDATE workflow_operations SET state = 'cancelled', error = ?, terminal_at = ?,
       claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
      [input.detail, input.now, input.now, input.runId],
    );
    this.db.run(
      `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
       resolved_at = ?, updated_at = ?
       WHERE run_id = ? AND state IN ('pending', 'claimed')`,
      [input.now, input.now, input.runId],
    );
    this.db.run(
      `UPDATE workflow_request_dispatches SET active = 0, owner_id = NULL,
       owner_heartbeat_at = NULL, updated_at = ? WHERE run_id = ? AND active = 1`,
      [input.now, input.runId],
    );
    const changed = this.db
      .query(
        `UPDATE workflow_runs SET state = 'cancelled', terminal_detail = ?, terminal_at = ?,
         claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE run_id = ? AND state = ?`,
      )
      .run(input.detail, input.now, input.now, input.runId, run.state);
    if (changed.changes !== 1) return null;
    const readUpdatedRun = this.getRun(input.runId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readUpdatedRun();
  }

  pauseRunAndChildren(input: { runId: string; now: number; detail: string }): WorkflowRun | null {
    return runWorkflowTransactionForStoreHost(this.db, "pause-run-and-children", () => {
      const readRun = this.getRun(input.runId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const run = readRun();
      if (!run || !["queued", "running", "blocked"].includes(run.state)) return run;
      this.prepareOperationsForPause(input.runId, input.now, input.detail);
      const changed = this.db
        .query(
          `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, claimed_by = NULL,
           claimed_at = NULL, updated_at = ? WHERE run_id = ? AND state = ?`,
        )
        .run(input.detail, input.now, input.runId, run.state);
      if (changed.changes !== 1) return null;
      const readUpdatedRun = this.getRun(input.runId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      return readUpdatedRun();
    });
  }

  private prepareOperationsForPause(runId: string, now: number, detail: string): void {
    this.db.run(
      `UPDATE workflow_operations SET
       state = CASE WHEN request_id IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         ) OR EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
           WHERE dispatch.request_id = workflow_operations.request_id
             AND dispatch.run_id = workflow_operations.run_id
             AND dispatch.operation_id = workflow_operations.operation_id
             AND dispatch.active = 1
         )
       ) THEN state ELSE 'queued' END,
       attempt = attempt + CASE WHEN request_id IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         ) OR EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
           WHERE dispatch.request_id = workflow_operations.request_id
             AND dispatch.run_id = workflow_operations.run_id
             AND dispatch.operation_id = workflow_operations.operation_id
             AND dispatch.active = 1
         )
       ) THEN 0 ELSE 1 END,
       request_id = CASE WHEN request_id IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         ) OR EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
           WHERE dispatch.request_id = workflow_operations.request_id
             AND dispatch.run_id = workflow_operations.run_id
             AND dispatch.operation_id = workflow_operations.operation_id
             AND dispatch.active = 1
         )
       ) THEN request_id ELSE NULL END,
       error = CASE WHEN request_id IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         ) OR EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
           WHERE dispatch.request_id = workflow_operations.request_id
             AND dispatch.run_id = workflow_operations.run_id
             AND dispatch.operation_id = workflow_operations.operation_id
             AND dispatch.active = 1
         )
       ) THEN 'Paused request awaiting durable terminal handoff' ELSE ? END,
       claimed_by = NULL, claimed_at = NULL,
       started_at = CASE WHEN request_id IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         ) OR EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
           WHERE dispatch.request_id = workflow_operations.request_id
             AND dispatch.run_id = workflow_operations.run_id
             AND dispatch.operation_id = workflow_operations.operation_id
             AND dispatch.active = 1
         )
       ) THEN started_at ELSE NULL END,
       terminal_at = NULL, updated_at = ?
       WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
      [detail, now, runId],
    );
  }

  private preparePausedOperationsForResume(runId: string, now: number): boolean {
    if (this.getManualReconciliationDetail(runId)) return false;
    const ambiguous = this.db.run(
      `UPDATE workflow_operations SET state = 'blocked', error = ?,
       claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE run_id = ? AND request_id IS NOT NULL
         AND state IN ('queued', 'dispatched', 'running', 'blocked')
         AND EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
             AND receipt.state = 'cancelled'
         )`,
      [WORKFLOW_MANUAL_RECONCILIATION_DETAIL, now, runId],
    );
    if (ambiguous.changes > 0) {
      this.db.run(
        `UPDATE workflow_runs SET terminal_detail = ?, claimed_by = NULL, claimed_at = NULL,
         updated_at = ? WHERE run_id = ? AND state = 'paused'`,
        [WORKFLOW_MANUAL_RECONCILIATION_DETAIL, now, runId],
      );
      return false;
    }
    this.db.run(
      `UPDATE workflow_operations SET state = 'queued', attempt = attempt + 1,
       request_id = NULL, error = 'Paused request has no active durable dispatch',
       claimed_by = NULL, claimed_at = NULL, started_at = NULL, terminal_at = NULL,
       updated_at = ?
       WHERE run_id = ? AND request_id IS NOT NULL
         AND state IN ('queued', 'dispatched', 'running', 'blocked')
         AND NOT EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipts receipt
           WHERE receipt.request_id = workflow_operations.request_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM workflow_request_dispatches dispatch
            WHERE dispatch.request_id = workflow_operations.request_id
              AND dispatch.run_id = workflow_operations.run_id
              AND dispatch.operation_id = workflow_operations.operation_id
              AND dispatch.active = 1
          )`,
      [now, runId],
    );
    return true;
  }

  blockAmbiguousPausedCancelledOperation(input: {
    runId: string;
    operationId: string;
    requestId: string;
    runOwnerId: string;
    now: number;
  }): boolean {
    return runWorkflowTransactionForStoreHost(this.db, "block-ambiguous-paused-operation", () => {
      const changed = this.db
        .query(
          `UPDATE workflow_operations SET state = 'blocked', error = ?,
         claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE run_id = ? AND operation_id = ? AND request_id = ?
           AND state IN ('queued', 'dispatched', 'running', 'blocked')
           AND error = 'Paused request awaiting durable terminal handoff'
           AND EXISTS (
             SELECT 1 FROM workflow_request_terminal_receipts receipt
             WHERE receipt.request_id = workflow_operations.request_id
               AND receipt.state = 'cancelled'
           )
           AND EXISTS (
             SELECT 1 FROM workflow_runs run
             WHERE run.run_id = workflow_operations.run_id
               AND run.state = 'running' AND run.claimed_by = ?
           )`,
        )
        .run(
          WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
          input.now,
          input.runId,
          input.operationId,
          input.requestId,
          input.runOwnerId,
        );
      if (changed.changes !== 1) return false;
      this.db.run(
        `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, claimed_by = NULL,
         claimed_at = NULL, updated_at = ?
         WHERE run_id = ? AND state = 'running' AND claimed_by = ?`,
        [WORKFLOW_MANUAL_RECONCILIATION_DETAIL, input.now, input.runId, input.runOwnerId],
      );
      return true;
    });
  }

  blockAmbiguousTerminalLifecycleOperation(input: {
    runId: string;
    operationId: string;
    requestId: string;
    runOwnerId: string;
    now: number;
  }): boolean {
    return runWorkflowTransactionForStoreHost(this.db, "block-ambiguous-terminal-operation", () => {
      const changed = this.db
        .query(
          `UPDATE workflow_operations SET state = 'blocked', error = ?,
           claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE run_id = ? AND operation_id = ? AND request_id = ?
             AND state IN ('queued', 'dispatched', 'running', 'blocked')
             AND EXISTS (
               SELECT 1 FROM workflow_runs run
               WHERE run.run_id = workflow_operations.run_id
                 AND run.state = 'running' AND run.claimed_by = ?
             )`,
        )
        .run(
          WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
          input.now,
          input.runId,
          input.operationId,
          input.requestId,
          input.runOwnerId,
        );
      if (changed.changes !== 1) return false;
      const paused = this.db
        .query(
          `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, claimed_by = NULL,
           claimed_at = NULL, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND claimed_by = ?`,
        )
        .run(WORKFLOW_MANUAL_RECONCILIATION_DETAIL, input.now, input.runId, input.runOwnerId);
      return paused.changes === 1;
    });
  }

  getManualReconciliationDetail(runId: string): string | null {
    const run = this.db
      .query<{ terminal_detail: string }, [string, string]>(
        `SELECT terminal_detail FROM workflow_runs
         WHERE run_id = ? AND terminal_detail = ?`,
      )
      .get(runId, WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
    if (run) return run.terminal_detail;
    const operation = this.db
      .query<{ error: string }, [string, string]>(
        `SELECT error FROM workflow_operations
         WHERE run_id = ? AND state = 'blocked' AND request_id IS NOT NULL AND error = ?
         LIMIT 1`,
      )
      .get(runId, WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
    return operation?.error ?? null;
  }

  tryClaimRun(input: {
    runId: string;
    claimerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowRun | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const result = this.db
      .query(
        `UPDATE workflow_runs SET state = 'running', claimed_by = ?, claimed_at = ?,
          started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE run_id = ? AND (
           state = 'queued' OR (state = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?)
         )`,
      )
      .run(input.claimerId, input.now, input.now, input.now, input.runId, staleBefore);
    if (result.changes !== 1) return null;
    const readRun = this.getRun(input.runId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readRun();
  }

  refreshRunClaim(runId: string, claimerId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_runs SET claimed_at = ?, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND claimed_by = ?`,
        )
        .run(now, now, runId, claimerId).changes === 1
    );
  }

  createOperation(operationInput: WorkflowOperation, runOwnerId: string): boolean {
    const operation = operationInput;
    const result = this.db
      .query(
        `INSERT INTO workflow_operations (
          run_id, operation_id, call_site_id, parent_operation_id, phase, label,
          kind, input_json, input_sha256, state, attempt, request_id, output_json,
          result_artifact_id, error, usage_json, claimed_by, claimed_at, created_at,
          started_at, updated_at, terminal_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM workflow_runs
            WHERE run_id = ? AND state = 'running' AND claimed_by = ?
          )
        ON CONFLICT(run_id, operation_id) DO NOTHING`,
      )
      .run(
        operation.runId,
        operation.operationId,
        operation.callSiteId,
        operation.parentOperationId,
        operation.phase,
        operation.label,
        operation.kind,
        JSON.stringify(operation.input),
        operation.inputSha256,
        operation.state,
        operation.attempt,
        operation.requestId,
        operation.output === null ? null : JSON.stringify(operation.output),
        operation.resultArtifact === null
          ? null
          : encodeWorkflowArtifactReference(operation.resultArtifact),
        operation.error,
        operation.usage === null ? null : JSON.stringify(operation.usage),
        operation.claimedBy,
        operation.claimedAt,
        operation.createdAt,
        operation.startedAt,
        operation.updatedAt,
        operation.terminalAt,
        operation.runId,
        runOwnerId,
      );
    return result.changes === 1;
  }

  getOperation(
    runId: string,
    operationId: string,
  ): ResultType<WorkflowOperation | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-operation", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_operations WHERE run_id = ? AND operation_id = ?",
      ).get(runId, operationId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowOperationRow);
    });
  }

  getOperationByRequestId(
    requestId: string,
  ): ResultType<WorkflowOperation | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-operation-by-request-id", () => {
      const row = this.persistedRows("SELECT * FROM workflow_operations WHERE request_id = ?").get(
        requestId,
      );
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowOperationRow);
    });
  }

  private matchesWorkflowRequestPolicyIdentity(input: {
    policy: WorkflowRequestPolicy;
    run: WorkflowRun | null;
    operation: WorkflowOperation | null;
  }): boolean {
    const { policy, run, operation } = input;
    if (!run || !operation) return false;
    const operationInput = resolvedWorkflowAgentInputSchema.safeParse(operation.input);
    if (!operationInput.success) return false;
    const options = operationInput.data.options;
    const expectedStableNamedContinuation =
      run.completionTarget.kind === "live_parent" &&
      run.completionTarget.stableNamedContinuation === true
        ? {
            sessionId: run.completionTarget.childSessionId,
            requestClient: run.completionTarget.parentRequestClient,
          }
        : undefined;
    const stableNamedContinuationMatches =
      expectedStableNamedContinuation === undefined
        ? policy.stableNamedContinuation === undefined
        : policy.stableNamedContinuation?.sessionId === expectedStableNamedContinuation.sessionId &&
          policy.stableNamedContinuation.requestClient ===
            expectedStableNamedContinuation.requestClient;
    return (
      policy.runId === run.runId &&
      policy.operationId === operation.operationId &&
      policy.profile === options.profile &&
      policy.model === (options.model ?? null) &&
      policy.reasoning === (options.reasoning ?? null) &&
      policy.cwd === options.cwd &&
      policy.originSession.requestId === run.origin.requestId &&
      policy.originSession.sessionId === run.origin.sessionId &&
      policy.originSession.client === run.origin.client &&
      policy.originSession.userId === run.origin.userId &&
      stableNamedContinuationMatches
    );
  }

  authorizeAgentDispatch(input: {
    requestId: string;
    runId: string;
    operationId: string;
    runOwnerId: string;
    sessionId: string;
    platform: string;
    policy: WorkflowRequestPolicy;
    now: number;
    staleOwnerBefore: number;
  }): WorkflowOperation | null {
    const policy = input.policy;
    if (
      policy.runId !== input.runId ||
      policy.operationId !== input.operationId ||
      policy.cwd === ""
    ) {
      return null;
    }
    return runWorkflowTransactionForStoreHost(this.db, "authorize-agent-dispatch", () => {
      const quarantined = this.db
        .query(
          `SELECT 1 FROM workflow_request_terminal_receipt_quarantine
           WHERE run_id = ? AND operation_id = ? LIMIT 1`,
        )
        .get(input.runId, input.operationId);
      if (quarantined) return null;
      const terminalReceipt = this.db
        .query(
          `SELECT 1 FROM workflow_request_terminal_receipts
           WHERE request_id = ? OR (
             run_id = ? AND operation_id = ? AND dispatch_epoch = ?
           ) LIMIT 1`,
        )
        .get(input.requestId, input.runId, input.operationId, policy.dispatchEpoch);
      if (terminalReceipt) return null;
      const readRun = this.getRun(input.runId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const run = readRun();
      const readOperation = this.getOperation(input.runId, input.operationId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const operation = readOperation();
      if (
        !run ||
        !operation ||
        run.state !== "running" ||
        run.claimedBy !== input.runOwnerId ||
        !this.matchesWorkflowRequestPolicyIdentity({
          policy,
          run,
          operation,
        }) ||
        !["queued", "dispatched", "running"].includes(operation.state)
      ) {
        return null;
      }
      const existingRow = this.persistedRows(
        "SELECT * FROM workflow_request_dispatches WHERE request_id = ?",
      ).get(input.requestId);
      const existingResult: ResultType<DecodedWorkflowRequestDispatch | null, PersistedDataError> =
        existingRow === null
          ? Result.ok(null)
          : this.decodeRow(existingRow, decodeWorkflowRequestDispatchRow);
      const readExisting = existingResult.match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const existing = readExisting();
      if (
        existing &&
        existing.active &&
        existing.ownerHeartbeatAt !== null &&
        existing.ownerHeartbeatAt > input.staleOwnerBefore
      ) {
        return null;
      }
      if (existing) {
        if (
          canonicalJson(
            workflowRequestPolicyIdentityProjection(existing.policy).resolvedModelRequest,
          ) !== canonicalJson(workflowRequestPolicyIdentityProjection(policy).resolvedModelRequest)
        ) {
          return null;
        }
      }
      if (operation.state === "queued") {
        const changed = this.db
          .query(
            `UPDATE workflow_operations SET state = 'dispatched', request_id = ?, updated_at = ?
             WHERE run_id = ? AND operation_id = ? AND state = 'queued'`,
          )
          .run(input.requestId, input.now, input.runId, input.operationId);
        if (changed.changes !== 1) return null;
      } else if (operation.requestId !== input.requestId) {
        return null;
      }
      this.db.run("DELETE FROM workflow_request_dispatches WHERE run_id = ? AND operation_id = ?", [
        input.runId,
        input.operationId,
      ]);
      this.db.run(
        `INSERT INTO workflow_request_dispatches (
            request_id, run_id, operation_id, dispatch_epoch, session_id, platform,
            policy_json, owner_id, owner_heartbeat_at,
            active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        [
          input.requestId,
          input.runId,
          input.operationId,
          policy.dispatchEpoch,
          input.sessionId,
          input.platform,
          JSON.stringify(policy),
          input.now,
          input.now,
        ],
      );
      const readUpdatedOperation = this.getOperation(input.runId, input.operationId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      return readUpdatedOperation();
    });
  }

  authorizeWorkflowRequest(input: {
    requestId: string;
    sessionId: string;
    platform: string;
  }): AuthorizedWorkflowRequest | null {
    return runWorkflowTransactionForStoreHost(
      this.db,
      "authorize-workflow-request",
      (): AuthorizedWorkflowRequest | null => {
        const raw = this.persistedRows(
          `SELECT * FROM workflow_request_dispatches
          WHERE request_id = ? AND session_id = ? AND platform = ?
             AND active = 1
            AND NOT EXISTS (
              SELECT 1 FROM workflow_request_terminal_receipts receipt
              WHERE receipt.request_id = workflow_request_dispatches.request_id OR (
                receipt.run_id = workflow_request_dispatches.run_id
                AND receipt.operation_id = workflow_request_dispatches.operation_id
                AND receipt.dispatch_epoch = workflow_request_dispatches.dispatch_epoch
              )
            )`,
        ).get(input.requestId, input.sessionId, input.platform);
        if (!raw) return null;
        const readRow = this.decodeRow(raw, decodeWorkflowRequestDispatchRow).match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const row = readRow();
        const readRun = this.getRun(row.runId).match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const run = readRun();
        if (!run) return null;
        const policy = row.policy;
        const readOperation = this.getOperation(row.runId, row.operationId).match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const operation = readOperation();
        if (
          !operation ||
          run.state !== "running" ||
          operation.requestId !== input.requestId ||
          !["dispatched", "running"].includes(operation.state) ||
          row.dispatchEpoch !== policy.dispatchEpoch ||
          !this.matchesWorkflowRequestPolicyIdentity({
            policy,
            run,
            operation,
          })
        ) {
          return null;
        }
        return {
          requestId: row.requestId,
          sessionId: row.sessionId,
          platform: row.platform,
          policy,
        };
      },
    );
  }

  recordWorkflowRequestTerminal(input: {
    requestId: string;
    runId: string;
    operationId: string;
    dispatchEpoch: string;
    ownerId: string;
    state: "resolved" | "failed" | "cancelled";
    detail?: string;
    output?: WorkflowOperation["output"];
    resultArtifact?: WorkflowArtifactReference | null;
    usage?: WorkflowOperation["usage"];
    now: number;
  }): boolean {
    const output = input.output ?? null;
    const usage = input.usage ?? null;
    if (input.state === "resolved" && output === null && !input.resultArtifact) return false;
    return runWorkflowResultTransactionForStoreHost<boolean, DurableWorkflowInvariantViolation>(
      this.db,
      "record-workflow-request-terminal",
      () => {
        if (input.resultArtifact) {
          this.ensureWorkflowArtifactReference(input.resultArtifact, input.now);
        }
        const inserted = this.db
          .query(
            `INSERT INTO workflow_request_terminal_receipts (
             request_id, run_id, operation_id, dispatch_epoch, state, detail, output_json,
             result_artifact_id, usage_json, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
              SELECT 1 FROM workflow_request_dispatches
              WHERE request_id = ? AND run_id = ? AND operation_id = ?
                AND dispatch_epoch = ? AND owner_id = ? AND active = 1
                AND prompt_published_at IS NOT NULL
            )
           ON CONFLICT(request_id) DO NOTHING`,
          )
          .run(
            input.requestId,
            input.runId,
            input.operationId,
            input.dispatchEpoch,
            input.state,
            input.detail ?? null,
            output === null ? null : JSON.stringify(output),
            input.resultArtifact === undefined || input.resultArtifact === null
              ? null
              : encodeWorkflowArtifactReference(input.resultArtifact),
            usage === null ? null : JSON.stringify(usage),
            input.now,
            input.requestId,
            input.runId,
            input.operationId,
            input.dispatchEpoch,
            input.ownerId,
          );
        if (inserted.changes !== 1) return Result.ok(false);
        const deactivated = this.db
          .query(
            `UPDATE workflow_request_dispatches
           SET active = 0, updated_at = ?
           WHERE request_id = ? AND run_id = ? AND operation_id = ?
             AND dispatch_epoch = ? AND owner_id = ? AND active = 1
             AND prompt_published_at IS NOT NULL`,
          )
          .run(
            input.now,
            input.requestId,
            input.runId,
            input.operationId,
            input.dispatchEpoch,
            input.ownerId,
          );
        if (deactivated.changes !== 1) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: `Workflow terminal receipt lost its exact dispatch: ${input.requestId}`,
            }),
          );
        }
        return Result.ok(true);
      },
    );
  }

  getWorkflowRequestTerminalReceipt(
    requestId: string,
  ): ResultType<WorkflowRequestTerminalReceipt | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-workflow-request-terminal-receipt", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_request_terminal_receipts WHERE request_id = ?",
      ).get(requestId);
      return row === null
        ? Result.ok(null)
        : this.decodeRow(row, decodeWorkflowRequestTerminalReceiptRow);
    });
  }

  getWorkflowRequestDispatchPolicy(
    requestId: string,
  ): ResultType<WorkflowRequestPolicy | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-workflow-request-dispatch-policy", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_request_dispatches WHERE request_id = ?",
      ).get(requestId);
      if (!row) return Result.ok(null);
      return this.decodeRow(row, decodeWorkflowRequestDispatchRow).map((value) => value.policy);
    });
  }

  getWorkflowRequestDispatchHandoff(input: {
    requestId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowRequestDispatchHandoff {
    return runWorkflowResultTransactionForStoreHost<
      WorkflowRequestDispatchHandoff,
      DurableWorkflowReadError | DurableWorkflowInvariantViolation
    >(this.db, "get-workflow-request-dispatch-handoff", () => {
      const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
      const continueWithDispatch = (
        dispatch: DecodedWorkflowRequestDispatch,
      ): ResultType<
        WorkflowRequestDispatchHandoff,
        DurableWorkflowReadError | DurableWorkflowInvariantViolation
      > => {
        const policy = dispatch.policy;
        const runRow = this.persistedRows("SELECT * FROM workflow_runs WHERE run_id = ?").get(
          dispatch.runId,
        );
        const operationRow = this.persistedRows(
          "SELECT * FROM workflow_operations WHERE run_id = ? AND operation_id = ?",
        ).get(dispatch.runId, dispatch.operationId);
        const runResult: ResultType<WorkflowRun | null, PersistedDataError> =
          runRow === null ? Result.ok(null) : this.decodeRow(runRow, decodeWorkflowRunRow);
        const continueWithRun = runResult.match<
          () => ResultType<
            WorkflowRequestDispatchHandoff,
            DurableWorkflowReadError | DurableWorkflowInvariantViolation
          >
        >({
          err: (error) => () => Result.err(error),
          ok: (run) => () => {
            const operationResult: ResultType<WorkflowOperation | null, PersistedDataError> =
              operationRow === null
                ? Result.ok(null)
                : this.decodeRow(operationRow, decodeWorkflowOperationRow);
            const continueWithOperation = operationResult.match<
              () => ResultType<
                WorkflowRequestDispatchHandoff,
                DurableWorkflowReadError | DurableWorkflowInvariantViolation
              >
            >({
              err: (error) => () => Result.err(error),
              ok: (operation) => () => {
                if (
                  dispatch.dispatchEpoch !== policy.dispatchEpoch ||
                  run?.state !== "running" ||
                  !operation ||
                  !["dispatched", "running"].includes(operation.state) ||
                  !this.matchesWorkflowRequestPolicyIdentity({ policy, run, operation })
                ) {
                  return Result.err(
                    new DurableWorkflowInvariantViolation({
                      message: "Live workflow dispatch has an invalid durable policy identity",
                    }),
                  );
                }
                return Result.ok<WorkflowRequestDispatchHandoff>({
                  status:
                    dispatch.ownerId !== null &&
                    dispatch.ownerHeartbeatAt !== null &&
                    dispatch.ownerHeartbeatAt > staleBefore
                      ? "live"
                      : "stale",
                  dispatchEpoch: dispatch.dispatchEpoch,
                  policy,
                });
              },
            });
            return continueWithOperation();
          },
        });
        return continueWithRun();
      };

      const receipt = this.persistedRows(
        "SELECT * FROM workflow_request_terminal_receipts WHERE request_id = ?",
      ).get(input.requestId);
      if (receipt !== null) {
        const continueWithReceipt = this.decodeRow(
          receipt,
          decodeWorkflowRequestTerminalReceiptRow,
        ).match<
          () => ResultType<
            WorkflowRequestDispatchHandoff,
            DurableWorkflowReadError | DurableWorkflowInvariantViolation
          >
        >({
          err: (error) => () => Result.err(error),
          ok: (decoded) => () =>
            Result.ok<WorkflowRequestDispatchHandoff>({ status: "receipt", receipt: decoded }),
        });
        return continueWithReceipt();
      }
      const dispatchRow = this.persistedRows(
        "SELECT * FROM workflow_request_dispatches WHERE request_id = ? AND active = 1",
      ).get(input.requestId);
      if (!dispatchRow) return Result.ok<WorkflowRequestDispatchHandoff>({ status: "fresh" });
      const continueDecodedDispatch = this.decodeRow(
        dispatchRow,
        decodeWorkflowRequestDispatchRow,
      ).match<
        () => ResultType<
          WorkflowRequestDispatchHandoff,
          DurableWorkflowReadError | DurableWorkflowInvariantViolation
        >
      >({
        err: (error) => () => Result.err(error),
        ok: (dispatch) => () => continueWithDispatch(dispatch),
      });
      return continueDecodedDispatch();
    });
  }

  claimWorkflowRequestPromptPublication(input: {
    requestId: string;
    runId: string;
    operationId: string;
    runOwnerId: string;
    now: number;
  }): boolean {
    const result = this.db
      .query(
        `UPDATE workflow_request_dispatches SET prompt_published_at = ?, updated_at = ?
         WHERE request_id = ? AND run_id = ? AND operation_id = ? AND active = 1
           AND prompt_published_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_request_terminal_receipts
              WHERE workflow_request_terminal_receipts.request_id = workflow_request_dispatches.request_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
              WHERE quarantine.run_id = workflow_request_dispatches.run_id
                AND quarantine.operation_id = workflow_request_dispatches.operation_id
            )
           AND EXISTS (
             SELECT 1 FROM workflow_runs
             WHERE workflow_runs.run_id = workflow_request_dispatches.run_id
               AND workflow_runs.state = 'running' AND workflow_runs.claimed_by = ?
           )`,
      )
      .run(input.now, input.now, input.requestId, input.runId, input.operationId, input.runOwnerId);
    return result.changes === 1;
  }

  claimWorkflowRequest(input: {
    requestId: string;
    dispatchEpoch: string;
    ownerId: string;
    now: number;
    staleAfterMs?: number;
  }): boolean {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    return (
      this.db
        .query(
          `UPDATE workflow_request_dispatches
           SET owner_id = ?, owner_heartbeat_at = ?, updated_at = ?
           WHERE request_id = ? AND dispatch_epoch = ?
              AND active = 1
              AND NOT EXISTS (
                SELECT 1 FROM workflow_request_terminal_receipts receipt
                WHERE receipt.request_id = workflow_request_dispatches.request_id OR (
                  receipt.run_id = workflow_request_dispatches.run_id
                  AND receipt.operation_id = workflow_request_dispatches.operation_id
                  AND receipt.dispatch_epoch = workflow_request_dispatches.dispatch_epoch
                )
              )
               AND (owner_id IS NULL OR owner_id = ? OR owner_heartbeat_at <= ?)`,
        )
        .run(
          input.ownerId,
          input.now,
          input.now,
          input.requestId,
          input.dispatchEpoch,
          input.ownerId,
          staleBefore,
        ).changes === 1
    );
  }

  refreshWorkflowRequestClaim(requestId: string, ownerId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_request_dispatches SET owner_heartbeat_at = ?, updated_at = ?
           WHERE request_id = ? AND owner_id = ? AND active = 1`,
        )
        .run(now, now, requestId, ownerId).changes === 1
    );
  }

  releaseWorkflowRequestClaim(requestId: string, ownerId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_request_dispatches
           SET owner_id = NULL, owner_heartbeat_at = NULL, updated_at = ?
           WHERE request_id = ? AND owner_id = ? AND active = 1`,
        )
        .run(now, requestId, ownerId).changes === 1
    );
  }

  hasLiveWorkflowRequestOwner(requestId: string, now: number, staleAfterMs = 60_000): boolean {
    const row = this.db
      .query<{ present: number }, [string, number]>(
        `SELECT 1 AS present FROM workflow_request_dispatches
         WHERE request_id = ? AND active = 1
           AND owner_id IS NOT NULL AND owner_heartbeat_at > ?`,
      )
      .get(requestId, now - staleAfterMs);
    return row?.present === 1;
  }

  getActiveWorkflowRequestDispatchEpoch(requestId: string): string | null {
    const row = this.db
      .query<{ dispatch_epoch: string }, [string]>(
        `SELECT dispatch_epoch FROM workflow_request_dispatches
         WHERE request_id = ? AND active = 1`,
      )
      .get(requestId);
    return row?.dispatch_epoch ?? null;
  }

  expireWorkflowRequest(requestId: string, now: number, ownerId?: string): boolean {
    const result = ownerId
      ? this.db.run(
          `UPDATE workflow_request_dispatches SET active = 0, updated_at = ?
           WHERE request_id = ? AND owner_id = ? AND active = 1`,
          [now, requestId, ownerId],
        )
      : this.db.run(
          `UPDATE workflow_request_dispatches SET active = 0, updated_at = ?
           WHERE request_id = ? AND active = 1`,
          [now, requestId],
        );
    return result.changes === 1;
  }

  expireWorkflowRequestsForRun(runId: string, now: number): void {
    this.db.run(
      `UPDATE workflow_request_dispatches SET active = 0, updated_at = ?
       WHERE run_id = ? AND active = 1`,
      [now, runId],
    );
  }

  listOperations(
    runId: string,
    options?: { state?: WorkflowOperationState; limit?: number },
  ): ResultType<WorkflowOperation[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-operations", () => {
      const rows = options?.state
        ? this.persistedRows(
            "SELECT * FROM workflow_operations WHERE run_id = ? AND state = ? ORDER BY created_at LIMIT ?",
          ).all(runId, options.state, boundedLimit(options.limit))
        : this.persistedRows(
            "SELECT * FROM workflow_operations WHERE run_id = ? ORDER BY created_at LIMIT ?",
          ).all(runId, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowOperationRow);
    });
  }

  summarizeMeaningfulOperations(runId: string): WorkflowOperationProgressSummary[] {
    const rows = this.persistedRows(
      `SELECT phase, kind, state, COUNT(*) AS count,
           SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS startedCount
         FROM workflow_operations
         WHERE run_id = ? AND kind IN ('agent', 'wait')
         GROUP BY phase, kind, state
         ORDER BY MIN(created_at), phase, kind, state`,
    ).all(runId);
    return rows.map((row) => workflowOperationProgressSummarySchema.parse(row));
  }

  listRecentMeaningfulOperations(
    runId: string,
    limit = 5,
  ): ResultType<WorkflowOperation[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-recent-meaningful-operations", () => {
      const rows = this.persistedRows(
        `SELECT * FROM workflow_operations
         WHERE run_id = ? AND kind IN ('agent', 'wait')
         ORDER BY created_at DESC, operation_id DESC LIMIT ?`,
      ).all(runId, boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowOperationRow);
    });
  }

  countOperations(runId: string, kind?: WorkflowOperation["kind"]): number {
    const row = kind
      ? this.db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM workflow_operations WHERE run_id = ? AND kind = ?",
          )
          .get(runId, kind)
      : this.db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM workflow_operations WHERE run_id = ?",
          )
          .get(runId);
    return row?.count ?? 0;
  }

  transitionOperation(input: {
    runId: string;
    operationId: string;
    from: WorkflowOperationState;
    to: WorkflowOperationState;
    now: number;
    requestId?: string | null;
    output?: WorkflowOperation["output"];
    resultArtifact?: WorkflowArtifactReference | null;
    error?: string | null;
    usage?: WorkflowOperation["usage"];
    runOwnerId: string;
  }): boolean {
    if (!canTransitionWorkflowOperation(input.from, input.to)) {
      return false;
    }
    const current = adaptToolResultToHost(this.getOperation(input.runId, input.operationId));
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    if (input.resultArtifact) {
      this.ensureWorkflowArtifactReference(input.resultArtifact, input.now);
    }
    const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(input.to);
    let outputJson: string | null;
    if (input.output === undefined) {
      outputJson = current.output === null ? null : JSON.stringify(current.output);
    } else if (input.output === null) {
      outputJson = null;
    } else {
      outputJson = JSON.stringify(input.output);
    }
    let usageJson: string | null;
    if (input.usage === undefined) {
      usageJson = current.usage === null ? null : JSON.stringify(current.usage);
    } else if (input.usage === null) {
      usageJson = null;
    } else {
      usageJson = JSON.stringify(input.usage);
    }
    const result = this.db
      .query(
        `UPDATE workflow_operations SET state = ?, request_id = ?, output_json = ?,
          result_artifact_id = ?, error = ?, usage_json = ?,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END, updated_at = ?
         WHERE run_id = ? AND operation_id = ? AND state = ?
           AND EXISTS (
             SELECT 1 FROM workflow_runs
             WHERE workflow_runs.run_id = workflow_operations.run_id
               AND workflow_runs.state = 'running' AND workflow_runs.claimed_by = ?
           )`,
      )
      .run(
        input.to,
        input.requestId === undefined ? current.requestId : input.requestId,
        outputJson,
        input.resultArtifact === undefined
          ? encodeNullableWorkflowArtifactReference(current.resultArtifact)
          : encodeNullableWorkflowArtifactReference(input.resultArtifact),
        input.error === undefined ? current.error : input.error,
        usageJson,
        input.to,
        input.now,
        terminal,
        input.now,
        input.now,
        input.runId,
        input.operationId,
        input.from,
        input.runOwnerId,
      );
    return result.changes === 1;
  }

  terminalizeOperationAndExpireRequest(input: {
    runId: string;
    operationId: string;
    requestId: string;
    from: WorkflowOperationState;
    to: "succeeded" | "failed" | "cancelled" | "timed_out";
    now: number;
    output?: WorkflowOperation["output"];
    resultArtifact?: WorkflowArtifactReference | null;
    error?: string | null;
    usage?: WorkflowOperation["usage"];
    runOwnerId: string;
  }): boolean {
    return runWorkflowTransactionForStoreHost(
      this.db,
      "terminalize-operation-and-expire-request",
      () => {
        const readCurrent = this.getOperation(input.runId, input.operationId).match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const current = readCurrent();
        if (!current || current.state !== input.from) return false;
        const changed = this.transitionOperation(input);
        if (!changed) return false;
        this.db
          .query(
            `UPDATE workflow_request_dispatches SET active = 0, updated_at = ?
           WHERE request_id = ? AND run_id = ? AND operation_id = ? AND active = 1`,
          )
          .run(input.now, input.requestId, input.runId, input.operationId);
        return true;
      },
    );
  }

  tryClaimOperation(input: {
    runId: string;
    operationId: string;
    claimerId: string;
    runOwnerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowOperation | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const result = this.db
      .query(
        `UPDATE workflow_operations SET
          state = CASE WHEN state = 'queued' THEN 'dispatched' ELSE state END,
          claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE run_id = ? AND operation_id = ? AND (
           state = 'queued' OR
            (state IN ('dispatched', 'running') AND (claimed_by IS NULL OR claimed_at <= ?))
          ) AND EXISTS (
            SELECT 1 FROM workflow_runs
            WHERE workflow_runs.run_id = workflow_operations.run_id
              AND workflow_runs.state = 'running' AND workflow_runs.claimed_by = ?
          )`,
      )
      .run(
        input.claimerId,
        input.now,
        input.now,
        input.runId,
        input.operationId,
        staleBefore,
        input.runOwnerId,
      );
    if (result.changes !== 1) return null;
    const readOperation = this.getOperation(input.runId, input.operationId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readOperation();
  }

  createWait(waitInput: WorkflowWait, runOwnerId: string): boolean {
    const wait = waitInput;
    const result = this.db
      .query(
        `INSERT INTO workflow_waits (
          run_id, operation_id, state, match_kind, match_key, match_json, due_at,
          deadline_at, resolver_cursor, result_json, resolved_by, claimed_by,
          claimed_at, created_at, updated_at, resolved_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM workflow_runs
            WHERE run_id = ? AND state = 'running' AND claimed_by = ?
          )
        ON CONFLICT(run_id, operation_id) DO NOTHING`,
      )
      .run(
        wait.runId,
        wait.operationId,
        wait.state,
        wait.match.kind,
        wait.matchKey,
        JSON.stringify(wait.match),
        wait.dueAt,
        wait.deadlineAt,
        wait.resolverCursor,
        wait.result === null ? null : JSON.stringify(wait.result),
        wait.resolvedBy,
        wait.claimedBy,
        wait.claimedAt,
        wait.createdAt,
        wait.updatedAt,
        wait.resolvedAt,
        wait.runId,
        runOwnerId,
      );
    return result.changes === 1;
  }

  getWait(
    runId: string,
    operationId: string,
  ): ResultType<WorkflowWait | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-wait", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_waits WHERE run_id = ? AND operation_id = ?",
      ).get(runId, operationId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowWaitRow);
    });
  }

  listWaits(options: {
    runId?: string;
    state?: WorkflowWaitState;
    matchKind?: WorkflowWait["match"]["kind"];
    matchKey?: string;
    dueBefore?: number;
    limit?: number;
  }): ResultType<WorkflowWait[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-waits", () => {
      const clauses: string[] = [];
      const bindings: Array<string | number> = [];
      if (options.runId) {
        clauses.push("run_id = ?");
        bindings.push(options.runId);
      }
      if (options.state) {
        clauses.push("state = ?");
        bindings.push(options.state);
      }
      if (options.matchKind) {
        clauses.push("match_kind = ?");
        bindings.push(options.matchKind);
      }
      if (options.matchKey) {
        clauses.push("match_key = ?");
        bindings.push(options.matchKey);
      }
      if (options.dueBefore !== undefined) {
        clauses.push("due_at IS NOT NULL AND due_at <= ?");
        bindings.push(options.dueBefore);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.persistedRows(
        `SELECT * FROM workflow_waits ${where} ORDER BY updated_at LIMIT ?`,
      ).all(...bindings, boundedLimit(options.limit));
      return this.decodeRows(rows, decodeWorkflowWaitRow);
    });
  }

  listActiveWaitsByMatchKey(
    matchKind: WorkflowWait["match"]["kind"],
    matchKey: string,
  ): ResultType<WorkflowWait[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-active-waits-by-match-key", () => {
      const rows = this.persistedRows(
        `SELECT workflow_waits.* FROM workflow_waits
         JOIN workflow_runs ON workflow_runs.run_id = workflow_waits.run_id
         WHERE match_kind = ? AND match_key = ? AND workflow_waits.state IN ('pending', 'claimed')
           AND workflow_runs.state = 'running'
         ORDER BY workflow_waits.created_at, workflow_waits.run_id,
           workflow_waits.operation_id LIMIT 1000`,
      ).all(matchKind, matchKey);
      return this.decodeRows(rows, decodeWorkflowWaitRow);
    });
  }

  listDueWaits(now: number): ResultType<WorkflowWait[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-due-waits", () => {
      const rows = this.persistedRows(
        `SELECT workflow_waits.* FROM workflow_waits
         JOIN workflow_runs ON workflow_runs.run_id = workflow_waits.run_id
         WHERE workflow_waits.state IN ('pending', 'claimed')
          AND workflow_runs.state = 'running' AND (
           (due_at IS NOT NULL AND due_at <= ?) OR
           (deadline_at IS NOT NULL AND deadline_at <= ?)
          ) ORDER BY COALESCE(workflow_waits.due_at, workflow_waits.deadline_at),
            workflow_waits.created_at LIMIT 1000`,
      ).all(now, now);
      return this.decodeRows(rows, decodeWorkflowWaitRow);
    });
  }

  claimWorkflowWaitResolverLease(input: {
    ownerId: string;
    now: number;
    staleBefore: number;
  }): boolean {
    return (
      this.db
        .query(
          `INSERT INTO workflow_wait_resolver_lease (singleton, owner_id, heartbeat_at)
           VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             owner_id = excluded.owner_id,
             heartbeat_at = excluded.heartbeat_at
           WHERE workflow_wait_resolver_lease.owner_id = excluded.owner_id
             OR workflow_wait_resolver_lease.heartbeat_at <= ?`,
        )
        .run(input.ownerId, input.now, input.staleBefore).changes === 1
    );
  }

  getWorkflowWaitResolverCheckpoint(topic: string): string | null {
    return (
      this.db
        .query<{ processed_cursor: string }, [string]>(
          `SELECT processed_cursor FROM workflow_wait_resolver_checkpoints WHERE topic = ?`,
        )
        .get(topic)?.processed_cursor ?? null
    );
  }

  advanceWorkflowWaitResolverCheckpoint(input: {
    ownerId: string;
    topic: string;
    cursor: string;
    now: number;
  }): boolean {
    return runWorkflowTransactionForStoreHost(this.db, "advance-wait-resolver-checkpoint", () => {
      const lease = this.db
        .query<{ owner_id: string }, []>(
          "SELECT owner_id FROM workflow_wait_resolver_lease WHERE singleton = 1",
        )
        .get();
      if (lease?.owner_id !== input.ownerId) return false;
      this.db.run(
        `INSERT INTO workflow_wait_resolver_checkpoints (topic, processed_cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           processed_cursor = excluded.processed_cursor,
           updated_at = excluded.updated_at`,
        [input.topic, input.cursor, input.now],
      );
      return true;
    });
  }

  refreshWorkflowWaitResolverLease(ownerId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_wait_resolver_lease SET heartbeat_at = ?
           WHERE singleton = 1 AND owner_id = ?`,
        )
        .run(now, ownerId).changes === 1
    );
  }

  isWorkflowWaitResolverLeaseOwner(ownerId: string): boolean {
    return (
      this.db
        .query<{ owned: number }, [string]>(
          `SELECT 1 AS owned FROM workflow_wait_resolver_lease
           WHERE singleton = 1 AND owner_id = ?`,
        )
        .get(ownerId)?.owned === 1
    );
  }

  releaseWorkflowWaitResolverLease(ownerId: string): void {
    this.db.run("DELETE FROM workflow_wait_resolver_lease WHERE singleton = 1 AND owner_id = ?", [
      ownerId,
    ]);
  }

  prepareWaitExpiryBarrier(input: {
    runId: string;
    operationId: string;
    barrierId: string;
    now: number;
    retryBefore: number;
  }): { barrierId: string; processed: boolean; shouldPublish: boolean } | null {
    return runWorkflowTransactionForStoreHost(this.db, "prepare-wait-expiry-barrier", () => {
      const row = this.db
        .query<
          {
            state: string;
            expiry_barrier_id: string | null;
            expiry_barrier_requested_at: number | null;
            expiry_barrier_processed_at: number | null;
          },
          [string, string]
        >(
          `SELECT state, expiry_barrier_id, expiry_barrier_requested_at,
             expiry_barrier_processed_at
           FROM workflow_waits WHERE run_id = ? AND operation_id = ?`,
        )
        .get(input.runId, input.operationId);
      if (!row || !["pending", "claimed"].includes(row.state)) return null;
      if (row.expiry_barrier_processed_at !== null && row.expiry_barrier_id) {
        return { barrierId: row.expiry_barrier_id, processed: true, shouldPublish: false };
      }
      const barrierId = row.expiry_barrier_id ?? input.barrierId;
      const shouldPublish =
        row.expiry_barrier_id === null ||
        row.expiry_barrier_requested_at === null ||
        row.expiry_barrier_requested_at <= input.retryBefore;
      if (shouldPublish) {
        this.db.run(
          `UPDATE workflow_waits SET expiry_barrier_id = ?, expiry_barrier_requested_at = ?,
             updated_at = ?
           WHERE run_id = ? AND operation_id = ? AND state IN ('pending', 'claimed')`,
          [barrierId, input.now, input.now, input.runId, input.operationId],
        );
      }
      return { barrierId, processed: false, shouldPublish };
    });
  }

  recordWaitExpiryBarrierCursor(barrierId: string, cursor: string, now: number): void {
    this.db.run(
      `UPDATE workflow_waits SET expiry_barrier_cursor = COALESCE(expiry_barrier_cursor, ?),
         updated_at = ?
       WHERE expiry_barrier_id = ? AND state IN ('pending', 'claimed')`,
      [cursor, now, barrierId],
    );
  }

  markWaitExpiryBarrierProcessed(barrierId: string, cursor: string, now: number): void {
    this.db.run(
      `UPDATE workflow_waits SET expiry_barrier_cursor = ?, expiry_barrier_processed_at = ?,
         updated_at = ?
       WHERE expiry_barrier_id = ? AND state IN ('pending', 'claimed')`,
      [cursor, now, now, barrierId],
    );
  }

  transitionWait(input: {
    runId: string;
    operationId: string;
    from: WorkflowWaitState;
    to: WorkflowWaitState;
    now: number;
    resolverCursor?: string | null;
    result?: WorkflowWait["result"];
    resolvedBy?: string | null;
    runOwnerId: string;
  }): boolean {
    if (!canTransitionWorkflowWait(input.from, input.to)) {
      return false;
    }
    const current = adaptToolResultToHost(this.getWait(input.runId, input.operationId));
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    const resolved = input.to === "resolved" || input.to === "expired";
    let resultJson: string | null;
    if (input.result === undefined) {
      resultJson = current.result === null ? null : JSON.stringify(current.result);
    } else if (input.result === null) {
      resultJson = null;
    } else {
      resultJson = JSON.stringify(input.result);
    }
    const result = this.db
      .query(
        `UPDATE workflow_waits SET state = ?, resolver_cursor = ?, result_json = ?,
          resolved_by = ?, resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END, updated_at = ?
          WHERE run_id = ? AND operation_id = ? AND state = ?
            AND EXISTS (
              SELECT 1 FROM workflow_runs
              WHERE workflow_runs.run_id = workflow_waits.run_id
                AND workflow_runs.state = 'running' AND workflow_runs.claimed_by = ?
            )`,
      )
      .run(
        input.to,
        input.resolverCursor === undefined ? current.resolverCursor : input.resolverCursor,
        resultJson,
        input.resolvedBy === undefined ? current.resolvedBy : input.resolvedBy,
        resolved,
        input.now,
        input.now,
        input.runId,
        input.operationId,
        input.from,
        input.runOwnerId,
      );
    return result.changes === 1;
  }

  resolveReplyWaitAndSuppress(input: {
    runId: string;
    operationId: string;
    platform: string;
    channelId: string;
    messageId: string;
    eventTs: number;
    cursor: string;
    result: WorkflowWait["result"];
    now: number;
  }): WorkflowWait | null {
    return runWorkflowTransactionForStoreHost(this.db, "resolve-reply-wait", () => {
      const readWait = this.getWait(input.runId, input.operationId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const wait = readWait();
      const readRun = this.getRun(input.runId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const run = readRun();
      if (
        !wait ||
        wait.match.kind !== "reply" ||
        !run ||
        run.state !== "running" ||
        !["pending", "claimed"].includes(wait.state) ||
        input.eventTs < wait.createdAt ||
        (wait.deadlineAt !== null && input.eventTs >= wait.deadlineAt)
      ) {
        return null;
      }
      const changed = this.db
        .query(
          `UPDATE workflow_waits SET state = 'resolved', resolver_cursor = ?, result_json = ?,
           resolved_by = ?, resolved_at = ?, updated_at = ?, claimed_by = NULL, claimed_at = NULL
           WHERE run_id = ? AND operation_id = ? AND state IN ('pending', 'claimed')
              AND created_at <= ? AND (deadline_at IS NULL OR deadline_at > ?)`,
        )
        .run(
          input.cursor,
          input.result === null ? null : JSON.stringify(input.result),
          `${input.platform}:${input.channelId}:${input.messageId}`,
          input.now,
          input.now,
          input.runId,
          input.operationId,
          input.eventTs,
          input.eventTs,
        );
      if (changed.changes !== 1) return null;
      this.recordAdapterEventSuppression({
        platform: input.platform,
        channelId: input.channelId,
        messageId: input.messageId,
        runId: input.runId,
        operationId: input.operationId,
        now: input.now,
      });
      const readResolvedWait = this.getWait(input.runId, input.operationId).match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      return readResolvedWait();
    });
  }

  tryClaimWait(input: {
    runId: string;
    operationId: string;
    claimerId: string;
    runOwnerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowWait | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const result = this.db
      .query(
        `UPDATE workflow_waits SET state = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE run_id = ? AND operation_id = ? AND (
           state = 'pending' OR (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?)
          ) AND EXISTS (
            SELECT 1 FROM workflow_runs
            WHERE workflow_runs.run_id = workflow_waits.run_id
              AND workflow_runs.state = 'running' AND workflow_runs.claimed_by = ?
          )`,
      )
      .run(
        input.claimerId,
        input.now,
        input.now,
        input.runId,
        input.operationId,
        staleBefore,
        input.runOwnerId,
      );
    if (result.changes !== 1) return null;
    const readWait = this.getWait(input.runId, input.operationId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readWait();
  }

  recordAdapterEventSuppression(input: {
    platform: string;
    channelId: string;
    messageId: string;
    runId: string;
    operationId: string;
    now: number;
  }): void {
    this.db.run(
      `INSERT INTO workflow_adapter_event_suppressions (
        platform, channel_id, message_id, run_id, operation_id, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, channel_id, message_id) DO UPDATE SET
        run_id = excluded.run_id, operation_id = excluded.operation_id,
        expires_at = excluded.expires_at`,
      [
        input.platform,
        input.channelId,
        input.messageId,
        input.runId,
        input.operationId,
        input.now + 5 * 60_000,
        input.now,
      ],
    );
  }

  getAdapterEventSuppression(input: {
    platform: string;
    channelId: string;
    messageId: string;
    now: number;
  }): { runId: string; operationId: string } | null {
    return runWorkflowTransactionForStoreHost(this.db, "get-adapter-event-suppression", () => {
      this.db.run("DELETE FROM workflow_adapter_event_suppressions WHERE expires_at <= ?", [
        input.now,
      ]);
      const row = this.db
        .query<{ run_id: string; operation_id: string }, [string, string, string, number]>(
          `SELECT run_id, operation_id FROM workflow_adapter_event_suppressions
           WHERE platform = ? AND channel_id = ? AND message_id = ? AND expires_at > ?`,
        )
        .get(input.platform, input.channelId, input.messageId, input.now);
      return row ? { runId: row.run_id, operationId: row.operation_id } : null;
    });
  }

  createTrigger(triggerInput: WorkflowTrigger): boolean {
    const trigger = triggerInput;
    const result = this.db
      .query(
        `INSERT INTO workflow_triggers (
          trigger_id, revision_id, state, kind, definition_json, args_json,
          args_sha256, scheduling_policy_json, origin_json, completion_target_json,
          progress_target_json, next_fire_at, last_fire_at, last_run_id, claimed_by,
          claimed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trigger_id) DO NOTHING`,
      )
      .run(
        trigger.triggerId,
        trigger.revisionId,
        trigger.state,
        trigger.definition.kind,
        JSON.stringify(trigger.definition),
        JSON.stringify(trigger.args),
        trigger.argsSha256,
        JSON.stringify(trigger.schedulingPolicy),
        JSON.stringify(trigger.origin),
        JSON.stringify(trigger.completionTarget),
        trigger.progressTarget === null ? null : JSON.stringify(trigger.progressTarget),
        trigger.nextFireAt,
        trigger.lastFireAt,
        trigger.lastRunId,
        trigger.claimedBy,
        trigger.claimedAt,
        trigger.createdAt,
        trigger.updatedAt,
      );
    return result.changes === 1;
  }

  createTriggerInvocation(input: {
    trigger: WorkflowTrigger;
    idempotency: { key: string; fingerprintSha256: string };
  }): { trigger: WorkflowTrigger; created: boolean } {
    const trigger = input.trigger;
    return runWorkflowResultTransactionForStoreHost<
      { trigger: WorkflowTrigger; created: boolean },
      DurableWorkflowReadError | DurableWorkflowInvariantViolation
    >(this.db, "create-trigger-invocation", () => {
      const receipt = this.db
        .query<{ trigger_id: string; fingerprint_sha256: string }, [string]>(
          `SELECT trigger_id, fingerprint_sha256 FROM workflow_trigger_invocation_receipts
           WHERE idempotency_key = ?`,
        )
        .get(input.idempotency.key);
      if (receipt) {
        if (receipt.fingerprint_sha256 !== input.idempotency.fingerprintSha256) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: "Workflow trigger idempotency key was reused with different input",
            }),
          );
        }
        const triggerRow = this.persistedRows(
          "SELECT * FROM workflow_triggers WHERE trigger_id = ?",
        ).get(receipt.trigger_id);
        if (triggerRow === null) {
          return Result.err(
            new DurableWorkflowInvariantViolation({
              message: "Workflow trigger receipt references a missing trigger",
            }),
          );
        }
        const continueWithTrigger = this.decodeRow(triggerRow, decodeWorkflowTriggerRow).match<
          () => ResultType<
            { trigger: WorkflowTrigger; created: boolean },
            DurableWorkflowReadError | DurableWorkflowInvariantViolation
          >
        >({
          err: (error) => () => Result.err(error),
          ok: (existing) => () => Result.ok({ trigger: existing, created: false }),
        });
        return continueWithTrigger();
      }
      if (!this.createTrigger(trigger)) {
        return Result.err(
          new DurableWorkflowInvariantViolation({
            message: `Workflow trigger already exists: ${trigger.triggerId}`,
          }),
        );
      }
      this.db.run(
        `INSERT INTO workflow_trigger_invocation_receipts (
           idempotency_key, trigger_id, fingerprint_sha256, created_at
         ) VALUES (?, ?, ?, ?)`,
        [
          input.idempotency.key,
          trigger.triggerId,
          input.idempotency.fingerprintSha256,
          trigger.createdAt,
        ],
      );
      return Result.ok({ trigger, created: true });
    });
  }

  getTrigger(triggerId: string): ResultType<WorkflowTrigger | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-trigger", () => {
      const row = this.persistedRows("SELECT * FROM workflow_triggers WHERE trigger_id = ?").get(
        triggerId,
      );
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowTriggerRow);
    });
  }

  getTriggerByLastRunId(
    runId: string,
  ): ResultType<WorkflowTrigger | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-trigger-by-last-run-id", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_triggers WHERE last_run_id = ? ORDER BY updated_at DESC LIMIT 1",
      ).get(runId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowTriggerRow);
    });
  }

  listTriggers(options?: {
    revisionId?: string;
    state?: WorkflowTriggerState;
    dueBefore?: number;
    canonicalProjectId?: string;
    originClient?: string;
    originUserId?: string;
    limit?: number;
  }): ResultType<WorkflowTrigger[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-triggers", () => {
      const clauses: string[] = [];
      const bindings: Array<string | number> = [];
      if (options?.revisionId) {
        clauses.push("workflow_triggers.revision_id = ?");
        bindings.push(options.revisionId);
      }
      if (options?.state) {
        clauses.push("workflow_triggers.state = ?");
        bindings.push(options.state);
      }
      if (options?.dueBefore !== undefined) {
        clauses.push(
          "workflow_triggers.next_fire_at IS NOT NULL AND workflow_triggers.next_fire_at <= ?",
        );
        bindings.push(options.dueBefore);
      }
      if (options?.canonicalProjectId) {
        clauses.push("workflow_revisions.canonical_project_id = ?");
        bindings.push(options.canonicalProjectId);
      }
      if (options?.originClient) {
        clauses.push("json_extract(workflow_triggers.origin_json, '$.client') = ?");
        bindings.push(options.originClient);
      }
      if (options?.originUserId) {
        clauses.push("json_extract(workflow_triggers.origin_json, '$.userId') = ?");
        bindings.push(options.originUserId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.persistedRows(
        `SELECT workflow_triggers.* FROM workflow_triggers
         JOIN workflow_revisions ON workflow_revisions.revision_id = workflow_triggers.revision_id
         ${where} ORDER BY workflow_triggers.next_fire_at, workflow_triggers.created_at LIMIT ?`,
      ).all(...bindings, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowTriggerRow);
    });
  }

  transitionTrigger(input: {
    triggerId: string;
    from: WorkflowTriggerState;
    to: WorkflowTriggerState;
    now: number;
    nextFireAt?: number | null;
    lastFireAt?: number | null;
    lastRunId?: string | null;
  }): boolean {
    if (!canTransitionWorkflowTrigger(input.from, input.to)) {
      return false;
    }
    const readCurrent = this.getTrigger(input.triggerId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const current = readCurrent();
    if (!current) return false;
    if (current.state !== input.from) return false;
    const result = this.db
      .query(
        `UPDATE workflow_triggers SET state = ?, next_fire_at = ?, last_fire_at = ?,
          last_run_id = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE trigger_id = ? AND state = ?`,
      )
      .run(
        input.to,
        input.nextFireAt === undefined ? current.nextFireAt : input.nextFireAt,
        input.lastFireAt === undefined ? current.lastFireAt : input.lastFireAt,
        input.lastRunId === undefined ? current.lastRunId : input.lastRunId,
        input.now,
        input.triggerId,
        input.from,
      );
    return result.changes === 1;
  }

  tryClaimDueTrigger(input: {
    triggerId: string;
    claimerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowTrigger | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const result = this.db
      .query(
        `UPDATE workflow_triggers SET claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE trigger_id = ? AND state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
           AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .run(input.claimerId, input.now, input.now, input.triggerId, input.now, staleBefore);
    if (result.changes !== 1) return null;
    const readTrigger = this.getTrigger(input.triggerId).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readTrigger();
  }

  fireClaimedTrigger(input: {
    triggerId: string;
    claimerId: string;
    expectedFireAt: number;
    nextFireAt: number | null;
    run: WorkflowRun;
    maxActiveRuns: number;
    now: number;
  }):
    | { status: "fired"; trigger: WorkflowTrigger; run: WorkflowRun }
    | { status: "skipped"; trigger: WorkflowTrigger }
    | null {
    const requestedRun = input.run;
    const maxActiveRuns = input.maxActiveRuns;
    if (!Number.isInteger(maxActiveRuns) || maxActiveRuns <= 0) {
      return null;
    }
    return runWorkflowResultTransactionForStoreHost<
      | { status: "fired"; trigger: WorkflowTrigger; run: WorkflowRun }
      | { status: "skipped"; trigger: WorkflowTrigger }
      | null,
      DurableWorkflowReadError | DurableWorkflowInvariantViolation
    >(this.db, "fire-claimed-trigger", () => {
      type FireClaimedTriggerResult =
        | { status: "fired"; trigger: WorkflowTrigger; run: WorkflowRun }
        | { status: "skipped"; trigger: WorkflowTrigger }
        | null;
      const readTriggerInTransaction = (
        triggerId: string,
      ): ResultType<WorkflowTrigger | null, PersistedDataError> => {
        const row = this.persistedRows("SELECT * FROM workflow_triggers WHERE trigger_id = ?").get(
          triggerId,
        );
        return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowTriggerRow);
      };
      const triggerResult = readTriggerInTransaction(input.triggerId);
      const continueWithTrigger = triggerResult.match<
        () => ResultType<
          FireClaimedTriggerResult,
          DurableWorkflowReadError | DurableWorkflowInvariantViolation
        >
      >({
        err: (error) => () => Result.err(error),
        ok: (trigger) => () => {
          if (
            !trigger ||
            trigger.state !== "active" ||
            trigger.claimedBy !== input.claimerId ||
            trigger.nextFireAt !== input.expectedFireAt ||
            requestedRun.revisionId !== trigger.revisionId ||
            requestedRun.state !== "queued" ||
            requestedRun.origin.client !== trigger.origin.client ||
            requestedRun.origin.sessionId !== trigger.origin.sessionId ||
            requestedRun.origin.userId !== trigger.origin.userId ||
            !sameWorkflowProgressTarget(requestedRun.progressTarget, trigger.progressTarget)
          ) {
            return Result.ok(null);
          }

          const activeTriggerRuns = this.countActiveTriggerRuns(trigger.triggerId);
          const activeRuns = this.countActiveRuns();
          if (
            (trigger.schedulingPolicy.overlap === "coalesce" && activeTriggerRuns > 0) ||
            activeRuns >= maxActiveRuns
          ) {
            const retryAt =
              trigger.definition.kind === "timestamp" && input.nextFireAt === null
                ? input.expectedFireAt
                : input.nextFireAt;
            const lastFireAt =
              trigger.definition.kind === "timestamp" && input.nextFireAt === null
                ? trigger.lastFireAt
                : input.expectedFireAt;
            const skipped = this.db
              .query(
                `UPDATE workflow_triggers SET next_fire_at = ?, last_fire_at = ?,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
             WHERE trigger_id = ? AND claimed_by = ? AND next_fire_at = ?`,
              )
              .run(
                retryAt,
                lastFireAt,
                input.now,
                trigger.triggerId,
                input.claimerId,
                input.expectedFireAt,
              );
            if (skipped.changes !== 1) {
              return Result.err(
                new DurableWorkflowInvariantViolation({
                  message: `Lost workflow trigger claim: ${trigger.triggerId}`,
                }),
              );
            }
            const storedTrigger = readTriggerInTransaction(trigger.triggerId);
            const finishSkipped = storedTrigger.match<
              () => ResultType<
                FireClaimedTriggerResult,
                DurableWorkflowReadError | DurableWorkflowInvariantViolation
              >
            >({
              err: (error) => () => Result.err(error),
              ok: (stored) => () =>
                stored
                  ? Result.ok<FireClaimedTriggerResult>({ status: "skipped", trigger: stored })
                  : Result.err(
                      new DurableWorkflowInvariantViolation({
                        message: `Workflow trigger disappeared: ${trigger.triggerId}`,
                      }),
                    ),
            });
            return finishSkipped();
          }

          const run = requestedRun;
          if (!this.createRun(run)) {
            return Result.err(
              new DurableWorkflowInvariantViolation({
                message: `Scheduled workflow run already exists: ${run.runId}`,
              }),
            );
          }
          this.db.run(
            `INSERT INTO workflow_trigger_runs (trigger_id, run_id, created_at)
         VALUES (?, ?, ?)`,
            [trigger.triggerId, run.runId, run.createdAt],
          );
          const updated = this.db
            .query(
              `UPDATE workflow_triggers SET next_fire_at = ?, last_fire_at = ?, last_run_id = ?,
           claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE trigger_id = ? AND claimed_by = ? AND next_fire_at = ?`,
            )
            .run(
              input.nextFireAt,
              input.expectedFireAt,
              run.runId,
              input.now,
              trigger.triggerId,
              input.claimerId,
              input.expectedFireAt,
            );
          if (updated.changes !== 1) {
            return Result.err(
              new DurableWorkflowInvariantViolation({
                message: `Lost workflow trigger claim: ${trigger.triggerId}`,
              }),
            );
          }
          const storedTrigger = readTriggerInTransaction(trigger.triggerId);
          const finishFired = storedTrigger.match<
            () => ResultType<
              FireClaimedTriggerResult,
              DurableWorkflowReadError | DurableWorkflowInvariantViolation
            >
          >({
            err: (error) => () => Result.err(error),
            ok: (stored) => () =>
              stored
                ? Result.ok<FireClaimedTriggerResult>({ status: "fired", trigger: stored, run })
                : Result.err(
                    new DurableWorkflowInvariantViolation({
                      message: `Workflow trigger disappeared: ${trigger.triggerId}`,
                    }),
                  ),
          });
          return finishFired();
        },
      });
      return continueWithTrigger();
    });
  }

  deleteTrigger(triggerId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_triggers WHERE trigger_id = ?").run(triggerId).changes ===
      1
    );
  }

  countActiveTriggerRuns(triggerId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM workflow_trigger_runs
         JOIN workflow_runs ON workflow_runs.run_id = workflow_trigger_runs.run_id
         WHERE workflow_trigger_runs.trigger_id = ?
           AND workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')`,
      )
      .get(triggerId);
    return row?.count ?? 0;
  }

  upsertSurfaceBinding(bindingInput: WorkflowSurfaceBinding): void {
    const binding = bindingInput;
    this.db.run(
      `INSERT INTO workflow_surface_bindings (
         run_id, target_json, message_ref_json, last_rendered_sha256, last_error,
         retry_count, next_attempt_at, permanent_failure_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         target_json = excluded.target_json,
         message_ref_json = excluded.message_ref_json,
         last_rendered_sha256 = excluded.last_rendered_sha256,
          last_error = excluded.last_error,
          retry_count = excluded.retry_count,
          next_attempt_at = excluded.next_attempt_at,
          permanent_failure_json = excluded.permanent_failure_json,
          updated_at = excluded.updated_at`,
      [
        binding.runId,
        JSON.stringify(binding.target),
        binding.messageRef === null ? null : JSON.stringify(binding.messageRef),
        binding.lastRenderedSha256,
        binding.lastError,
        binding.retryCount,
        binding.nextAttemptAt,
        binding.permanentFailure === null ? null : JSON.stringify(binding.permanentFailure),
        binding.createdAt,
        binding.updatedAt,
      ],
    );
  }

  commitSurfaceBindingWithActionRevocation(binding: WorkflowSurfaceBinding, now: number): void {
    runWorkflowTransactionForStoreHost(
      this.db,
      "commit-surface-binding-with-action-revocation",
      () => {
        this.upsertSurfaceBinding(binding);
        this.expireActiveSurfaceActions(binding.runId, now);
      },
    );
  }

  commitSurfaceProjection(input: {
    binding: WorkflowSurfaceBinding;
    actionIds: readonly string[];
  }): void {
    const binding = input.binding;
    runWorkflowTransactionForStoreHost(this.db, "commit-surface-projection", () => {
      this.upsertSurfaceBinding(binding);
      if (binding.messageRef) this.bindSurfaceActions(input.actionIds, binding.messageRef);
    });
  }

  getSurfaceBinding(
    runId: string,
  ): ResultType<WorkflowSurfaceBinding | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-surface-binding", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_surface_bindings WHERE run_id = ?",
      ).get(runId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowSurfaceBindingRow);
    });
  }

  listSurfaceBindings(options?: {
    dueBefore?: number;
    missingMessageOnly?: boolean;
    limit?: number;
  }): ResultType<WorkflowSurfaceBinding[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-surface-bindings", () => {
      const clauses: string[] = [];
      const bindings: number[] = [];
      if (options?.dueBefore !== undefined) {
        clauses.push(
          "permanent_failure_json IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?",
        );
        bindings.push(options.dueBefore);
      }
      if (options?.missingMessageOnly) clauses.push("message_ref_json IS NULL");
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.persistedRows(
        `SELECT * FROM workflow_surface_bindings ${where} ORDER BY updated_at LIMIT ?`,
      ).all(...bindings, boundedLimit(options?.limit));
      return this.decodeRows(rows, decodeWorkflowSurfaceBindingRow);
    });
  }

  deleteSurfaceBinding(runId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_surface_bindings WHERE run_id = ?").run(runId).changes >=
      1
    );
  }

  createSurfaceAction(actionInput: WorkflowSurfaceAction): boolean {
    const action = actionInput;
    const result = this.db
      .query(
        `INSERT INTO workflow_surface_actions (
          action_id, token_sha256, run_id, kind, expected_platform,
          expected_user_id, expected_message_ref_json, expires_at, consumed_at,
          consumed_by_platform, consumed_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(action_id) DO NOTHING`,
      )
      .run(
        action.actionId,
        action.tokenSha256,
        action.runId,
        action.kind,
        action.expectedPlatform,
        action.expectedUserId,
        action.expectedMessageRef === null ? null : JSON.stringify(action.expectedMessageRef),
        action.expiresAt,
        action.consumedAt,
        action.consumedByPlatform,
        action.consumedByUserId,
        action.createdAt,
      );
    return result.changes === 1;
  }

  getSurfaceAction(
    actionId: string,
  ): ResultType<WorkflowSurfaceAction | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-surface-action", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_surface_actions WHERE action_id = ?",
      ).get(actionId);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowSurfaceActionRow);
    });
  }

  getSurfaceActionByTokenSha256(
    tokenSha256: string,
  ): ResultType<WorkflowSurfaceAction | null, DurableWorkflowReadError> {
    return captureWorkflowRead("get-surface-action-by-token", () => {
      const row = this.persistedRows(
        "SELECT * FROM workflow_surface_actions WHERE token_sha256 = ?",
      ).get(tokenSha256);
      return row === null ? Result.ok(null) : this.decodeRow(row, decodeWorkflowSurfaceActionRow);
    });
  }

  listSurfaceActions(
    runId: string,
    options?: { activeAt?: number; limit?: number },
  ): ResultType<WorkflowSurfaceAction[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-surface-actions", () => {
      const rows =
        options?.activeAt === undefined
          ? this.persistedRows(
              "SELECT * FROM workflow_surface_actions WHERE run_id = ? ORDER BY created_at LIMIT ?",
            ).all(runId, boundedLimit(options?.limit))
          : this.persistedRows(
              `SELECT * FROM workflow_surface_actions
             WHERE run_id = ? AND consumed_at IS NULL AND expires_at > ?
             ORDER BY created_at LIMIT ?`,
            ).all(runId, options.activeAt, boundedLimit(options.limit));
      return this.decodeRows(rows, decodeWorkflowSurfaceActionRow);
    });
  }

  bindSurfaceActions(
    actionIds: readonly string[],
    messageRef: NonNullable<WorkflowSurfaceAction["expectedMessageRef"]>,
  ): void {
    if (actionIds.length === 0) return;
    runWorkflowTransactionForStoreHost(this.db, "bind-surface-actions", () => {
      for (const actionId of actionIds) {
        this.db.run(
          `UPDATE workflow_surface_actions SET expected_message_ref_json = ?
           WHERE action_id = ? AND consumed_at IS NULL`,
          [JSON.stringify(messageRef), actionId],
        );
      }
    });
  }

  expireActiveSurfaceActions(runId: string, now: number): void {
    this.db.run(
      `UPDATE workflow_surface_actions SET expires_at = ?
       WHERE run_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      [now, runId, now],
    );
  }

  applySurfaceAction(input: {
    tokenSha256: string;
    platform: WorkflowSurfaceAction["expectedPlatform"];
    userId: string;
    messageRef: NonNullable<WorkflowSurfaceAction["expectedMessageRef"]>;
    sourceMessageId?: string;
    now: number;
  }): ResultType<ApplyWorkflowSurfaceActionResult, ApplyWorkflowSurfaceActionError> {
    return runBunSqliteTransaction(
      this.db,
      (): ResultType<ApplyWorkflowSurfaceActionResult, ApplyWorkflowSurfaceActionError> => {
        const actionRow = this.persistedRows(
          "SELECT * FROM workflow_surface_actions WHERE token_sha256 = ?",
        ).get(input.tokenSha256);
        if (actionRow === null)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "not_found" });
        const decodedAction = decodeWorkflowSurfaceActionRow({
          row: actionRow,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
        });
        const action = decodedAction.match({ ok: (value) => value.value, err: () => null });
        if (!action) {
          return decodedAction.match<ResultType<never, ApplyWorkflowSurfaceActionError>>({
            err: (error) => Result.err(error),
            ok: () =>
              Result.err(
                new WorkflowSurfaceActionAtomicityConflict({
                  actionId: "unknown",
                  stage: "load-updated-run",
                  message: "Decoded workflow surface action is unexpectedly absent",
                }),
              ),
          });
        }
        if (action.consumedAt !== null)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "consumed" });
        if (action.expiresAt <= input.now)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "expired" });
        const expected = action.expectedMessageRef;
        if (
          action.expectedPlatform !== input.platform ||
          action.expectedUserId !== input.userId ||
          !expected ||
          expected.platform !== action.expectedPlatform ||
          input.messageRef.platform !== input.platform ||
          expected.platform !== input.messageRef.platform ||
          expected.channelId !== input.messageRef.channelId ||
          expected.messageId !== input.messageRef.messageId
        ) {
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "unauthorized" });
        }

        const runRow = this.persistedRows("SELECT * FROM workflow_runs WHERE run_id = ?").get(
          action.runId,
        );
        if (runRow === null)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "stale" });
        const decodedRun = decodeWorkflowRunRow({
          row: runRow,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
        });
        const run = decodedRun.match({ ok: (value) => value.value, err: () => null });
        if (!run) {
          return decodedRun.match<ResultType<never, ApplyWorkflowSurfaceActionError>>({
            err: (error) => Result.err(error),
            ok: () =>
              Result.err(
                new WorkflowSurfaceActionAtomicityConflict({
                  actionId: action.actionId,
                  stage: "load-updated-run",
                  message: "Decoded workflow run is unexpectedly absent",
                }),
              ),
          });
        }
        const bindingRow = this.persistedRows(
          "SELECT * FROM workflow_surface_bindings WHERE run_id = ?",
        ).get(run.runId);
        if (bindingRow === null)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "unauthorized" });
        const decodedBinding = decodeWorkflowSurfaceBindingRow({
          row: bindingRow,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
        });
        const binding = decodedBinding.match({ ok: (value) => value.value, err: () => null });
        if (!binding) {
          return decodedBinding.match<ResultType<never, ApplyWorkflowSurfaceActionError>>({
            err: (error) => Result.err(error),
            ok: () =>
              Result.err(
                new WorkflowSurfaceActionAtomicityConflict({
                  actionId: action.actionId,
                  stage: "load-updated-run",
                  message: "Decoded workflow surface binding is unexpectedly absent",
                }),
              ),
          });
        }
        if (
          binding.permanentFailure !== null ||
          run.origin.client !== action.expectedPlatform ||
          run.origin.userId !== action.expectedUserId ||
          !run.progressTarget ||
          run.progressTarget.platform !== action.expectedPlatform ||
          run.progressTarget.channelId !== expected.channelId ||
          !sameWorkflowProgressTarget(run.progressTarget, binding.target) ||
          !binding.messageRef ||
          binding.messageRef.platform !== expected.platform ||
          binding.messageRef.channelId !== expected.channelId ||
          binding.messageRef.messageId !== expected.messageId
        ) {
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "unauthorized" });
        }
        let nextState: WorkflowRunState;
        let valid: boolean;
        switch (action.kind) {
          case "cancel":
            nextState = "cancelled";
            valid = !["succeeded", "failed", "cancelled"].includes(run.state);
            break;
          case "pause":
            nextState = "paused";
            valid = ["queued", "running", "blocked"].includes(run.state);
            break;
          case "resume":
            nextState = "queued";
            valid = run.state === "paused";
            break;
        }
        if (!valid) return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "stale" });
        const terminal = nextState === "cancelled";
        if (
          action.kind === "resume" &&
          !this.preparePausedOperationsForResume(run.runId, input.now)
        ) {
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "stale" });
        }
        const result = this.db
          .query(
            `UPDATE workflow_runs SET state = ?, terminal_detail = ?,
           terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END, updated_at = ?
           WHERE run_id = ? AND state = ?`,
          )
          .run(
            nextState,
            action.kind === "cancel" ? "Cancelled from surface control" : run.terminalDetail,
            terminal,
            input.now,
            input.now,
            run.runId,
            run.state,
          );
        if (result.changes !== 1)
          return Result.ok<ApplyWorkflowSurfaceActionResult>({ status: "stale" });
        if (action.kind === "pause") {
          this.prepareOperationsForPause(run.runId, input.now, "Paused from surface control");
        } else if (action.kind === "cancel") {
          this.db.run(
            `UPDATE workflow_operations SET state = 'cancelled', error = 'Cancelled from surface control',
           terminal_at = ?, updated_at = ?
           WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
            [input.now, input.now, run.runId],
          );
          this.db.run(
            `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
           resolved_at = ?, updated_at = ?
           WHERE run_id = ? AND state IN ('pending', 'claimed')`,
            [input.now, input.now, run.runId],
          );
          this.db.run(
            `UPDATE workflow_request_dispatches SET active = 0,
           updated_at = ?
           WHERE run_id = ? AND active = 1`,
            [input.now, run.runId],
          );
        }
        this.options.testHooks?.afterSurfaceActionStateChange?.();
        const consumed = this.db
          .query(
            `UPDATE workflow_surface_actions SET consumed_at = ?, consumed_by_platform = ?,
           consumed_by_user_id = ? WHERE action_id = ? AND consumed_at IS NULL`,
          )
          .run(input.now, input.platform, input.userId, action.actionId);
        if (consumed.changes !== 1) {
          return Result.err(
            new WorkflowSurfaceActionAtomicityConflict({
              actionId: action.actionId,
              stage: "consume",
              message: "Workflow surface action consumption conflicted after its state change",
            }),
          );
        }
        const updatedRunRow = this.persistedRows(
          "SELECT * FROM workflow_runs WHERE run_id = ?",
        ).get(run.runId);
        if (updatedRunRow === null) {
          return Result.err(
            new WorkflowSurfaceActionAtomicityConflict({
              actionId: action.actionId,
              stage: "load-updated-run",
              message: "Workflow run disappeared after its surface action state change",
            }),
          );
        }
        const decodedUpdatedRun = decodeWorkflowRunRow({
          row: updatedRunRow,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
        });
        const updatedRun = decodedUpdatedRun.match({ ok: (value) => value.value, err: () => null });
        if (!updatedRun) {
          return decodedUpdatedRun.match<ResultType<never, ApplyWorkflowSurfaceActionError>>({
            err: (error) => Result.err(error),
            ok: () =>
              Result.err(
                new WorkflowSurfaceActionAtomicityConflict({
                  actionId: action.actionId,
                  stage: "load-updated-run",
                  message: "Decoded updated workflow run is unexpectedly absent",
                }),
              ),
          });
        }
        const runEventInserted = this.insertActionOutboxEntry({
          outboxId: `${action.actionId}:run:${run.runId}`,
          actionId: action.actionId,
          runId: run.runId,
          eventType: "evt.workflow.run.changed",
          payload: {
            runId: run.runId,
            revisionId: updatedRun.revisionId,
            state: updatedRun.state,
            previousState: run.state,
            ts: input.now,
          },
          now: input.now,
        });
        if (!runEventInserted) {
          return Result.err(
            new WorkflowSurfaceActionAtomicityConflict({
              actionId: action.actionId,
              stage: "insert-run-event",
              message: "Workflow run-change outbox identity already exists",
            }),
          );
        }
        const progressEventInserted = this.insertActionOutboxEntry({
          outboxId: `${action.actionId}:progress:${run.runId}`,
          actionId: action.actionId,
          runId: run.runId,
          eventType: "evt.workflow.progress.requested",
          payload: {
            runId: run.runId,
            revisionId: updatedRun.revisionId,
            reason: "state_changed",
            ts: input.now,
          },
          now: input.now,
        });
        if (!progressEventInserted) {
          return Result.err(
            new WorkflowSurfaceActionAtomicityConflict({
              actionId: action.actionId,
              stage: "insert-progress-event",
              message: "Workflow progress outbox identity already exists",
            }),
          );
        }
        return Result.ok<ApplyWorkflowSurfaceActionResult>({
          status: "applied",
          action,
          runIds: [run.runId],
        });
      },
      (cause) => classifyWorkflowSqliteDriverFailure("apply-surface-action", cause),
    );
  }

  private insertActionOutboxEntry(input: {
    outboxId: string;
    actionId: string;
    runId: string;
    eventType: string;
    payload: JsonValue;
    now: number;
  }): boolean {
    return (
      this.db.run(
        `INSERT INTO workflow_action_outbox (
         outbox_id, action_id, run_id, event_type, payload_json, published_at,
         projected_at, attempt_count, next_attempt_at, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?)
       ON CONFLICT(outbox_id) DO NOTHING`,
        [
          input.outboxId,
          input.actionId,
          input.runId,
          input.eventType,
          JSON.stringify(input.payload),
          input.now,
          input.now,
        ],
      ).changes === 1
    );
  }

  listPendingActionOutboxEvents(
    now: number,
    limit = 100,
  ): ResultType<WorkflowActionOutboxEntry[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-pending-action-outbox-events", () => {
      const rows = this.persistedRows(
        `SELECT * FROM workflow_action_outbox
         WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at, outbox_id LIMIT ?`,
      ).all(now, boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowActionOutboxRow);
    });
  }

  markActionOutboxPublished(input: { outboxId: string; now: number }): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_action_outbox SET published_at = ?, next_attempt_at = NULL,
             last_error = NULL, updated_at = ?
           WHERE outbox_id = ? AND published_at IS NULL`,
        )
        .run(input.now, input.now, input.outboxId).changes === 1
    );
  }

  recordActionOutboxFailure(input: { outboxId: string; error: string; now: number }): void {
    this.db.run(
      `UPDATE workflow_action_outbox SET attempt_count = attempt_count + 1,
         next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE outbox_id = ? AND published_at IS NULL`,
      [input.now + 1_000, input.error.slice(0, 16_384), input.now, input.outboxId],
    );
  }

  listPendingActionOutboxProjections(
    limit = 100,
  ): ResultType<WorkflowActionOutboxEntry[], DurableWorkflowReadError> {
    return captureWorkflowRead("list-pending-action-outbox-projections", () => {
      const rows = this.persistedRows(
        `SELECT * FROM workflow_action_outbox
         WHERE event_type = 'evt.workflow.progress.requested' AND projected_at IS NULL
         ORDER BY created_at, outbox_id LIMIT ?`,
      ).all(boundedLimit(limit));
      return this.decodeRows(rows, decodeWorkflowActionOutboxRow);
    });
  }

  markActionOutboxProjected(input: { outboxId: string; now: number }): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_action_outbox SET projected_at = ?, updated_at = ?
           WHERE outbox_id = ? AND projected_at IS NULL`,
        )
        .run(input.now, input.now, input.outboxId).changes === 1
    );
  }

  consumeSurfaceAction(input: {
    tokenSha256: string;
    platform: WorkflowSurfaceAction["expectedPlatform"];
    userId: string;
    now: number;
  }): WorkflowSurfaceAction | null {
    const result = this.db
      .query(
        `UPDATE workflow_surface_actions SET
          consumed_at = ?, consumed_by_platform = ?, consumed_by_user_id = ?
         WHERE token_sha256 = ? AND consumed_at IS NULL AND expires_at > ?
           AND expected_platform = ? AND expected_user_id = ?`,
      )
      .run(
        input.now,
        input.platform,
        input.userId,
        input.tokenSha256,
        input.now,
        input.platform,
        input.userId,
      );
    if (result.changes !== 1) return null;
    const readAction = this.getSurfaceActionByTokenSha256(input.tokenSha256).match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    return readAction();
  }

  deleteSurfaceAction(actionId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_surface_actions WHERE action_id = ?").run(actionId)
        .changes === 1
    );
  }
}
