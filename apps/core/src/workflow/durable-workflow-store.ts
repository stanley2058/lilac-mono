import { Database } from "bun:sqlite";
import path from "node:path";
import { z } from "zod";
import { env } from "@stanley2058/lilac-utils";

import { configureSqliteConnection } from "../shared/sqlite";
import {
  canTransitionWorkflowOperation,
  canTransitionWorkflowRun,
  canTransitionWorkflowTrigger,
  canTransitionWorkflowWait,
  jsonValueSchema,
  workflowOperationSchema,
  workflowRevisionSchema,
  workflowRunSchema,
  workflowSchemaMigrationSchema,
  workflowSurfaceActionSchema,
  workflowSurfaceBindingSchema,
  workflowTriggerSchema,
  workflowUsageSchema,
  workflowWaitSchema,
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
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
import { applyWorkflowSchemaMigrations } from "./workflow-migrations";
import {
  workflowRequestPolicySchema,
  type AuthorizedWorkflowRequest,
  type WorkflowRequestPolicy,
} from "./workflow-request-authority";
import { canonicalJson } from "./workflow-definition";
import { resolvedWorkflowAgentInputSchema } from "./workflow-operation-policy";

function resolveWorkflowDbPath(): string {
  return path.resolve(env.sqliteUrl);
}

const nullableStringSchema = z.string().nullable();
const nullableNumberSchema = z.number().nullable();

const revisionRowSchema = z.object({
  revision_id: z.string(),
  canonical_project_id: z.string(),
  canonical_workspace_root: z.string(),
  scope: z.string(),
  normalized_path: z.string(),
  name: z.string(),
  snapshot_artifact_id: z.string(),
  source_sha256: z.string(),
  input_schema_sha256: z.string(),
  capability_sha256: z.string(),
  metadata_json: z.string(),
  input_schema_json: z.string(),
  capabilities_json: z.string(),
  limits_json: z.string(),
  runtime_version: z.string(),
  created_at: z.number(),
});

const runRowSchema = z.object({
  run_id: z.string(),
  revision_id: z.string(),
  state: z.string(),
  input_schema_json: z.string(),
  args_json: z.string(),
  args_sha256: z.string(),
  origin_request_id: nullableStringSchema,
  origin_session_id: nullableStringSchema,
  origin_client: nullableStringSchema,
  origin_user_id: nullableStringSchema,
  origin_project_cwd: z.string(),
  completion_target_json: z.string(),
  progress_target_json: nullableStringSchema,
  terminal_detail: nullableStringSchema,
  result_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  started_at: nullableNumberSchema,
  updated_at: z.number(),
  terminal_at: nullableNumberSchema,
});

const operationRowSchema = z.object({
  run_id: z.string(),
  operation_id: z.string(),
  call_site_id: z.string(),
  parent_operation_id: nullableStringSchema,
  phase: nullableStringSchema,
  label: nullableStringSchema,
  kind: z.string(),
  input_json: z.string(),
  input_sha256: z.string(),
  state: z.string(),
  attempt: z.number(),
  request_id: nullableStringSchema,
  output_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  error: nullableStringSchema,
  usage_json: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  started_at: nullableNumberSchema,
  updated_at: z.number(),
  terminal_at: nullableNumberSchema,
});

const waitRowSchema = z.object({
  run_id: z.string(),
  operation_id: z.string(),
  state: z.string(),
  match_json: z.string(),
  match_key: z.string(),
  due_at: nullableNumberSchema,
  deadline_at: nullableNumberSchema,
  resolver_cursor: nullableStringSchema,
  result_json: nullableStringSchema,
  resolved_by: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
  resolved_at: nullableNumberSchema,
});

const triggerRowSchema = z.object({
  trigger_id: z.string(),
  revision_id: z.string(),
  state: z.string(),
  definition_json: z.string(),
  args_json: z.string(),
  args_sha256: z.string(),
  scheduling_policy_json: z.string(),
  origin_json: z.string(),
  completion_target_json: z.string(),
  progress_target_json: nullableStringSchema,
  next_fire_at: nullableNumberSchema,
  last_fire_at: nullableNumberSchema,
  last_run_id: nullableStringSchema,
  claimed_by: nullableStringSchema,
  claimed_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const bindingRowSchema = z.object({
  run_id: z.string(),
  target_json: z.string(),
  message_ref_json: nullableStringSchema,
  last_rendered_sha256: nullableStringSchema,
  last_error: nullableStringSchema,
  retry_count: z.number(),
  next_attempt_at: nullableNumberSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const actionRowSchema = z.object({
  action_id: z.string(),
  token_sha256: z.string(),
  run_id: z.string(),
  kind: z.string(),
  expected_platform: z.string(),
  expected_user_id: z.string(),
  expected_message_ref_json: nullableStringSchema,
  expires_at: z.number(),
  consumed_at: nullableNumberSchema,
  consumed_by_platform: nullableStringSchema,
  consumed_by_user_id: nullableStringSchema,
  created_at: z.number(),
});

const requestDispatchRowSchema = z.object({
  request_id: z.string(),
  run_id: z.string(),
  operation_id: z.string(),
  dispatch_epoch: z.string(),
  session_id: z.string(),
  platform: z.string(),
  policy_json: z.string(),
  expires_at: z.number(),
  owner_id: nullableStringSchema,
  owner_heartbeat_at: nullableNumberSchema,
  active: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});

const requestTerminalReceiptRowSchema = z.object({
  request_id: z.string(),
  run_id: z.string(),
  operation_id: z.string(),
  dispatch_epoch: z.string(),
  state: z.enum(["resolved", "failed", "cancelled"]),
  detail: nullableStringSchema,
  output_json: nullableStringSchema,
  result_artifact_id: nullableStringSchema,
  usage_json: nullableStringSchema,
  created_at: z.number(),
});

const actionOutboxRowSchema = z.object({
  outbox_id: z.string(),
  action_id: z.string(),
  run_id: z.string(),
  event_type: z.string(),
  payload_json: z.string(),
  published_at: nullableNumberSchema,
  projected_at: nullableNumberSchema,
  attempt_count: z.number(),
  next_attempt_at: nullableNumberSchema,
  last_error: nullableStringSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid workflow JSON in ${context}: ${message}`);
  }
}

function parseNullableJson(raw: string | null, context: string): unknown | null {
  return raw === null ? null : parseJson(raw, context);
}

function parseRevision(value: unknown): WorkflowRevision {
  const row = revisionRowSchema.parse(value);
  return workflowRevisionSchema.parse({
    revisionId: row.revision_id,
    canonicalProjectId: row.canonical_project_id,
    canonicalWorkspaceRoot: row.canonical_workspace_root,
    scope: row.scope,
    normalizedPath: row.normalized_path,
    name: row.name,
    snapshotArtifactId: row.snapshot_artifact_id,
    sourceSha256: row.source_sha256,
    inputSchemaSha256: row.input_schema_sha256,
    resourcePolicySha256: row.capability_sha256,
    metadata: parseJson(row.metadata_json, "workflow_revisions.metadata_json"),
    inputSchema: parseJson(row.input_schema_json, "workflow_revisions.input_schema_json"),
    resources: parseJson(row.capabilities_json, "workflow_revisions.capabilities_json"),
    limits: parseJson(row.limits_json, "workflow_revisions.limits_json"),
    runtimeVersion: row.runtime_version,
    createdAt: row.created_at,
  });
}

function parseRun(value: unknown): WorkflowRun {
  const row = runRowSchema.parse(value);
  return workflowRunSchema.parse({
    runId: row.run_id,
    revisionId: row.revision_id,
    state: row.state,
    inputSchemaSnapshot: parseJson(row.input_schema_json, "workflow_runs.input_schema_json"),
    args: parseJson(row.args_json, "workflow_runs.args_json"),
    argsSha256: row.args_sha256,
    origin: {
      requestId: row.origin_request_id,
      sessionId: row.origin_session_id,
      client: row.origin_client,
      userId: row.origin_user_id,
      projectCwd: row.origin_project_cwd,
    },
    completionTarget: parseJson(row.completion_target_json, "workflow_runs.completion_target_json"),
    progressTarget: parseNullableJson(
      row.progress_target_json,
      "workflow_runs.progress_target_json",
    ),
    terminalDetail: row.terminal_detail,
    result: parseNullableJson(row.result_json, "workflow_runs.result_json"),
    resultArtifactId: row.result_artifact_id,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  });
}

function parseOperation(value: unknown): WorkflowOperation {
  const row = operationRowSchema.parse(value);
  return workflowOperationSchema.parse({
    runId: row.run_id,
    operationId: row.operation_id,
    callSiteId: row.call_site_id,
    parentOperationId: row.parent_operation_id,
    phase: row.phase,
    label: row.label,
    kind: row.kind,
    input: parseJson(row.input_json, "workflow_operations.input_json"),
    inputSha256: row.input_sha256,
    state: row.state,
    attempt: row.attempt,
    requestId: row.request_id,
    output: parseNullableJson(row.output_json, "workflow_operations.output_json"),
    resultArtifactId: row.result_artifact_id,
    error: row.error,
    usage: parseNullableJson(row.usage_json, "workflow_operations.usage_json"),
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  });
}

function parseWait(value: unknown): WorkflowWait {
  const row = waitRowSchema.parse(value);
  return workflowWaitSchema.parse({
    runId: row.run_id,
    operationId: row.operation_id,
    state: row.state,
    match: parseJson(row.match_json, "workflow_waits.match_json"),
    matchKey: row.match_key,
    dueAt: row.due_at,
    deadlineAt: row.deadline_at,
    resolverCursor: row.resolver_cursor,
    result: parseNullableJson(row.result_json, "workflow_waits.result_json"),
    resolvedBy: row.resolved_by,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  });
}

function parseTrigger(value: unknown): WorkflowTrigger {
  const row = triggerRowSchema.parse(value);
  return workflowTriggerSchema.parse({
    triggerId: row.trigger_id,
    revisionId: row.revision_id,
    state: row.state,
    definition: parseJson(row.definition_json, "workflow_triggers.definition_json"),
    args: parseJson(row.args_json, "workflow_triggers.args_json"),
    argsSha256: row.args_sha256,
    schedulingPolicy: parseJson(
      row.scheduling_policy_json,
      "workflow_triggers.scheduling_policy_json",
    ),
    origin: parseJson(row.origin_json, "workflow_triggers.origin_json"),
    completionTarget: parseJson(
      row.completion_target_json,
      "workflow_triggers.completion_target_json",
    ),
    progressTarget: parseNullableJson(
      row.progress_target_json,
      "workflow_triggers.progress_target_json",
    ),
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    lastRunId: row.last_run_id,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseBinding(value: unknown): WorkflowSurfaceBinding {
  const row = bindingRowSchema.parse(value);
  return workflowSurfaceBindingSchema.parse({
    runId: row.run_id,
    target: parseJson(row.target_json, "workflow_surface_bindings.target_json"),
    messageRef: parseNullableJson(
      row.message_ref_json,
      "workflow_surface_bindings.message_ref_json",
    ),
    lastRenderedSha256: row.last_rendered_sha256,
    lastError: row.last_error,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseAction(value: unknown): WorkflowSurfaceAction {
  const row = actionRowSchema.parse(value);
  return workflowSurfaceActionSchema.parse({
    actionId: row.action_id,
    tokenSha256: row.token_sha256,
    runId: row.run_id,
    kind: row.kind,
    expectedPlatform: row.expected_platform,
    expectedUserId: row.expected_user_id,
    expectedMessageRef: parseNullableJson(
      row.expected_message_ref_json,
      "workflow_surface_actions.expected_message_ref_json",
    ),
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedByPlatform: row.consumed_by_platform,
    consumedByUserId: row.consumed_by_user_id,
    createdAt: row.created_at,
  });
}

function parseRequestTerminalReceipt(value: unknown): WorkflowRequestTerminalReceipt {
  const row = requestTerminalReceiptRowSchema.parse(value);
  return {
    requestId: row.request_id,
    runId: row.run_id,
    operationId: row.operation_id,
    dispatchEpoch: row.dispatch_epoch,
    state: row.state,
    detail: row.detail,
    output:
      row.output_json === null
        ? null
        : jsonValueSchema.parse(
            parseJson(row.output_json, "workflow_request_terminal_receipts.output_json"),
          ),
    resultArtifactId: row.result_artifact_id,
    usage:
      row.usage_json === null
        ? null
        : workflowUsageSchema.parse(
            parseJson(row.usage_json, "workflow_request_terminal_receipts.usage_json"),
          ),
    createdAt: row.created_at,
  };
}

function parseActionOutboxEntry(value: unknown): WorkflowActionOutboxEntry {
  const row = actionOutboxRowSchema.parse(value);
  return {
    outboxId: row.outbox_id,
    actionId: row.action_id,
    runId: row.run_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json, "workflow_action_outbox.payload_json"),
    publishedAt: row.published_at,
    projectedAt: row.projected_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tolerantRows<T>(rows: readonly unknown[], parse: (row: unknown) => T): T[] {
  return rows.flatMap((row) => {
    try {
      return [parse(row)];
    } catch {
      return [];
    }
  });
}

function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(1_000, limit ?? 100));
}

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

export const DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS = 64;

export type ApplyWorkflowSurfaceActionResult =
  | {
      status: "applied";
      action: WorkflowSurfaceAction;
      runIds: string[];
    }
  | { status: "not_found" | "unauthorized" | "expired" | "consumed" | "stale" };

export type WorkflowRequestTerminalReceipt = {
  requestId: string;
  runId: string;
  operationId: string;
  dispatchEpoch: string;
  state: "resolved" | "failed" | "cancelled";
  detail: string | null;
  output: WorkflowOperation["output"];
  resultArtifactId: string | null;
  usage: WorkflowOperation["usage"];
  createdAt: number;
};

export type WorkflowRequestDispatchHandoff =
  | { status: "receipt"; receipt: WorkflowRequestTerminalReceipt }
  | { status: "live"; dispatchEpoch: string; policy: WorkflowRequestPolicy }
  | { status: "stale"; dispatchEpoch: string; policy: WorkflowRequestPolicy }
  | { status: "fresh" };

export type WorkflowActionOutboxEntry = {
  outboxId: string;
  actionId: string;
  runId: string;
  eventType: string;
  payload: unknown;
  publishedAt: number | null;
  projectedAt: number | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export class DurableWorkflowStore {
  private readonly db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? resolveWorkflowDbPath());
    configureSqliteConnection(this.db);
    this.db.run("PRAGMA foreign_keys = ON");
    applyWorkflowSchemaMigrations(this.db);
    this.quarantineAndPauseLegacyResolvedReceipts(Date.now());
  }

  close(): void {
    this.db.close();
  }

  private quarantineAndPauseLegacyResolvedReceipts(now: number): void {
    const quarantine = this.db.transaction(() => {
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
         SET active = 0, expires_at = MIN(expires_at, ?), updated_at = ?
         WHERE active = 1 AND EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_request_dispatches.run_id
             AND quarantine.operation_id = workflow_request_dispatches.operation_id
         )`,
        [now, now],
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
    quarantine.immediate();
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
    const revision = workflowRevisionSchema.parse(revisionInput);
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
        revision.snapshotArtifactId,
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

  getRevision(revisionId: string): WorkflowRevision | null {
    const row = this.db
      .query("SELECT * FROM workflow_revisions WHERE revision_id = ?")
      .get(revisionId);
    return row === null ? null : parseRevision(row);
  }

  findRevisionByIdentity(identityInput: WorkflowRevisionIdentity): WorkflowRevision | null {
    const row = this.db
      .query(
        `SELECT * FROM workflow_revisions WHERE
          canonical_project_id = ? AND canonical_workspace_root = ? AND scope = ? AND
          normalized_path = ? AND source_sha256 = ? AND input_schema_sha256 = ? AND
          capability_sha256 = ? AND runtime_version = ?`,
      )
      .get(...revisionIdentityValues(identityInput));
    return row === null ? null : parseRevision(row);
  }

  listRevisions(options?: {
    canonicalProjectId?: string;
    scope?: WorkflowRevision["scope"];
    limit?: number;
  }): WorkflowRevision[] {
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
    const rows = this.db
      .query(`SELECT * FROM workflow_revisions ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...bindings, boundedLimit(options?.limit));
    return tolerantRows(rows, parseRevision);
  }

  createRun(runInput: WorkflowRun): boolean {
    const run = workflowRunSchema.parse(runInput);
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
        run.resultArtifactId,
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

  getRun(runId: string): WorkflowRun | null {
    const row = this.db.query("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId);
    return row === null ? null : parseRun(row);
  }

  listRuns(options?: {
    revisionId?: string;
    state?: WorkflowRunState;
    canonicalProjectId?: string;
    originClient?: string;
    originUserId?: string;
    limit?: number;
  }): WorkflowRun[] {
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
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_revisions ON workflow_revisions.revision_id = workflow_runs.revision_id
         ${where} ORDER BY workflow_runs.created_at DESC LIMIT ?`,
      )
      .all(...bindings, boundedLimit(options?.limit));
    return tolerantRows(rows, parseRun);
  }

  listActiveRuns(limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT * FROM workflow_runs
         WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
         ORDER BY updated_at, run_id LIMIT ?`,
      )
      .all(boundedLimit(limit));
    return tolerantRows(rows, parseRun);
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

  listRunsNeedingProjectionReconciliation(limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
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
           )
         ORDER BY workflow_runs.updated_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  createInvocation(input: {
    revision: WorkflowRevision;
    run: WorkflowRun;
    idempotency?: { key: string; fingerprintSha256: string };
    maxActiveRuns?: number;
  }): CreateWorkflowInvocationResult {
    const revision = workflowRevisionSchema.parse(input.revision);
    const requestedRun = workflowRunSchema.parse(input.run);
    if (requestedRun.revisionId !== revision.revisionId) {
      throw new Error("Run revisionId must match the requested revision");
    }
    if (requestedRun.state !== "queued") {
      throw new Error("Workflow invocations must be queued");
    }
    const maxActiveRuns = z
      .number()
      .int()
      .positive()
      .parse(input.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS);

    const create = this.db.transaction((): CreateWorkflowInvocationResult => {
      if (input.idempotency) {
        const receipt = this.db
          .query<{ run_id: string; fingerprint_sha256: string }, [string]>(
            "SELECT run_id, fingerprint_sha256 FROM workflow_invocation_receipts WHERE idempotency_key = ?",
          )
          .get(input.idempotency.key);
        if (receipt) {
          if (receipt.fingerprint_sha256 !== input.idempotency.fingerprintSha256) {
            throw new Error("Workflow idempotency key was reused with different invocation input");
          }
          const existingRun = this.getRun(receipt.run_id);
          const existingRevision = existingRun ? this.getRevision(existingRun.revisionId) : null;
          if (!existingRun || !existingRevision) {
            throw new Error("Workflow invocation receipt references missing durable records");
          }
          return {
            status: "accepted",
            run: existingRun,
            revision: existingRevision,
            revisionCreated: false,
          };
        }
      }
      const activeRuns = this.countActiveRuns();
      if (activeRuns >= maxActiveRuns) {
        return { status: "rejected_capacity", activeRuns, limit: maxActiveRuns };
      }
      const revisionCreated = this.createRevision(revision);
      const storedRevision = this.findRevisionByIdentity(revision);
      if (!storedRevision) throw new Error("Revision was not persisted");
      if (storedRevision.revisionId !== revision.revisionId) {
        throw new Error(
          `Revision identity already belongs to ${storedRevision.revisionId}, not ${revision.revisionId}`,
        );
      }

      const run = requestedRun;
      if (!this.createRun(run)) throw new Error(`Run ${run.runId} already exists`);
      if (input.idempotency) {
        this.db.run(
          `INSERT INTO workflow_invocation_receipts (
             idempotency_key, run_id, fingerprint_sha256, created_at
           ) VALUES (?, ?, ?, ?)`,
          [input.idempotency.key, run.runId, input.idempotency.fingerprintSha256, run.createdAt],
        );
      }
      return { status: "accepted", revision: storedRevision, run, revisionCreated };
    });
    return create.immediate();
  }

  listActiveLiveParentRuns(parentRequestId: string, limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.parent_request_id = ?
           AND workflow_completion_deliveries.state = 'pending'
            AND workflow_runs.state NOT IN ('succeeded', 'failed', 'cancelled')
         ORDER BY workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(parentRequestId, boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  listPendingLiveParentCompletions(
    parentRequestId: string,
    limit = 1_000,
    includeSynchronous = false,
  ): WorkflowRun[] {
    const rows = this.db
      .query(
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
      )
      .all(parentRequestId, includeSynchronous ? 1 : 0, boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  listOrphanedLiveParentCompletions(limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.state = 'pending'
            AND workflow_runs.state IN ('succeeded', 'failed', 'cancelled')
         ORDER BY workflow_runs.terminal_at, workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(boundedLimit(limit));
    return tolerantRows(rows, parseRun);
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

  activateLiveParentFallback(runId: string, now: number): WorkflowRun | null {
    const activate = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.completionTarget.kind !== "live_parent") return null;
      const changed = this.db
        .query(
          `UPDATE workflow_completion_deliveries
           SET state = 'fallback', delivered_at = ?, updated_at = ?
           WHERE run_id = ? AND state = 'pending'`,
        )
        .run(now, now, runId);
      if (changed.changes !== 1) return null;
      if (run.completionTarget.fallbackToSurface && run.completionTarget.fallbackProgressTarget) {
        this.db
          .query(
            `UPDATE workflow_runs SET progress_target_json = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(JSON.stringify(run.completionTarget.fallbackProgressTarget), now, runId);
      }
      return this.getRun(runId);
    });
    return activate.immediate();
  }

  transitionRun(input: {
    runId: string;
    from: WorkflowRunState;
    to: WorkflowRunState;
    now: number;
    detail?: string | null;
    result?: WorkflowRun["result"];
    resultArtifactId?: string | null;
  }): boolean {
    if (!canTransitionWorkflowRun(input.from, input.to)) {
      throw new Error(`Illegal workflow run transition: ${input.from} -> ${input.to}`);
    }
    const current = this.getRun(input.runId);
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    if (input.from === "paused" && input.to === "queued") {
      const resume = this.db.transaction(() => {
        const paused = this.getRun(input.runId);
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
      return resume.immediate();
    }
    const terminal = ["succeeded", "failed", "rejected", "cancelled"].includes(input.to);
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
        input.result === undefined
          ? current.result === null
            ? null
            : JSON.stringify(current.result)
          : input.result === null
            ? null
            : JSON.stringify(jsonValueSchema.parse(input.result)),
        input.resultArtifactId === undefined ? current.resultArtifactId : input.resultArtifactId,
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
    resultArtifactId: string | null;
  }): boolean {
    const terminalize = this.db.transaction(() => {
      const run = this.getRun(input.runId);
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
        `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
         updated_at = ? WHERE run_id = ? AND active = 1`,
        [input.now, input.now, input.runId],
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
          input.result === null ? null : JSON.stringify(jsonValueSchema.parse(input.result)),
          input.resultArtifactId,
          input.now,
          input.now,
          input.runId,
          input.ownerId,
        );
      return result.changes === 1;
    });
    return terminalize.immediate();
  }

  cancelRunAndChildren(input: { runId: string; now: number; detail: string }): WorkflowRun | null {
    const cancel = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run || ["succeeded", "failed", "rejected", "cancelled"].includes(run.state)) {
        return run;
      }
      this.db.run(
        `UPDATE workflow_operations SET state = 'cancelled', error = ?, terminal_at = ?,
         updated_at = ? WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
        [input.detail, input.now, input.now, input.runId],
      );
      this.db.run(
        `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
         resolved_at = ?, updated_at = ?
         WHERE run_id = ? AND state IN ('pending', 'claimed')`,
        [input.now, input.now, input.runId],
      );
      this.db.run(
        `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
         updated_at = ? WHERE run_id = ? AND active = 1`,
        [input.now, input.now, input.runId],
      );
      const changed = this.db
        .query(
          `UPDATE workflow_runs SET state = 'cancelled', terminal_detail = ?, terminal_at = ?,
           updated_at = ? WHERE run_id = ? AND state = ?`,
        )
        .run(input.detail, input.now, input.now, input.runId, run.state);
      return changed.changes === 1 ? this.getRun(input.runId) : null;
    });
    return cancel.immediate();
  }

  pauseRunAndChildren(input: { runId: string; now: number; detail: string }): WorkflowRun | null {
    const pause = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run || !["queued", "running", "blocked"].includes(run.state)) return run;
      this.prepareOperationsForPause(input.runId, input.now, input.detail);
      const changed = this.db
        .query(
          `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, claimed_by = NULL,
           claimed_at = NULL, updated_at = ? WHERE run_id = ? AND state = ?`,
        )
        .run(input.detail, input.now, input.runId, run.state);
      return changed.changes === 1 ? this.getRun(input.runId) : null;
    });
    return pause.immediate();
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
             AND dispatch.active = 1 AND dispatch.expires_at > ?
         )`,
      [now, runId, now],
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
    const block = this.db.transaction(() => {
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
    return block.immediate();
  }

  blockAmbiguousTerminalLifecycleOperation(input: {
    runId: string;
    operationId: string;
    requestId: string;
    runOwnerId: string;
    now: number;
  }): boolean {
    const block = this.db.transaction(() => {
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
    return block.immediate();
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
    return result.changes === 1 ? this.getRun(input.runId) : null;
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
    const operation = workflowOperationSchema.parse(operationInput);
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
        operation.resultArtifactId,
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

  getOperation(runId: string, operationId: string): WorkflowOperation | null {
    const row = this.db
      .query("SELECT * FROM workflow_operations WHERE run_id = ? AND operation_id = ?")
      .get(runId, operationId);
    return row === null ? null : parseOperation(row);
  }

  getOperationByRequestId(requestId: string): WorkflowOperation | null {
    const row = this.db
      .query("SELECT * FROM workflow_operations WHERE request_id = ?")
      .get(requestId);
    return row === null ? null : parseOperation(row);
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
      policy.originSession.userId === run.origin.userId
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
    expiresAt: number;
    staleOwnerBefore: number;
  }): WorkflowOperation | null {
    const policy = workflowRequestPolicySchema.parse(input.policy);
    if (
      policy.runId !== input.runId ||
      policy.operationId !== input.operationId ||
      policy.cwd === "" ||
      input.expiresAt <= input.now
    ) {
      return null;
    }
    const authorize = this.db.transaction(() => {
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
      const run = this.getRun(input.runId);
      const operation = this.getOperation(input.runId, input.operationId);
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
      const existing = this.db
        .query<z.infer<typeof requestDispatchRowSchema>, [string]>(
          "SELECT * FROM workflow_request_dispatches WHERE request_id = ?",
        )
        .get(input.requestId);
      if (
        existing &&
        existing.active === 1 &&
        existing.owner_heartbeat_at !== null &&
        existing.owner_heartbeat_at > input.staleOwnerBefore
      ) {
        return null;
      }
      if (existing) {
        const existingPolicy = workflowRequestPolicySchema.safeParse(
          parseJson(existing.policy_json, "workflow_request_dispatches.policy_json"),
        );
        if (
          !existingPolicy.success ||
          canonicalJson(existingPolicy.data.resolvedModelRequest) !==
            canonicalJson(policy.resolvedModelRequest)
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
           policy_json, expires_at, owner_id, owner_heartbeat_at,
           active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        [
          input.requestId,
          input.runId,
          input.operationId,
          policy.dispatchEpoch,
          input.sessionId,
          input.platform,
          JSON.stringify(policy),
          input.expiresAt,
          input.now,
          input.now,
        ],
      );
      return this.getOperation(input.runId, input.operationId);
    });
    return authorize.immediate();
  }

  authorizeWorkflowRequest(input: {
    requestId: string;
    sessionId: string;
    platform: string;
    now: number;
  }): AuthorizedWorkflowRequest | null {
    const authorize = this.db.transaction((): AuthorizedWorkflowRequest | null => {
      const raw = this.db
        .query<z.infer<typeof requestDispatchRowSchema>, [string, string, string, number]>(
          `SELECT * FROM workflow_request_dispatches
         WHERE request_id = ? AND session_id = ? AND platform = ?
            AND active = 1 AND expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM workflow_request_terminal_receipts receipt
              WHERE receipt.request_id = workflow_request_dispatches.request_id OR (
                receipt.run_id = workflow_request_dispatches.run_id
                AND receipt.operation_id = workflow_request_dispatches.operation_id
                AND receipt.dispatch_epoch = workflow_request_dispatches.dispatch_epoch
              )
            )`,
        )
        .get(input.requestId, input.sessionId, input.platform, input.now);
      if (!raw) return null;
      const row = requestDispatchRowSchema.parse(raw);
      const run = this.getRun(row.run_id);
      if (!run) return null;
      const rawPolicy = parseJson(row.policy_json, "workflow_request_dispatches.policy_json");
      const policy = workflowRequestPolicySchema.parse(rawPolicy);
      const operation = this.getOperation(row.run_id, row.operation_id);
      if (
        !operation ||
        run.state !== "running" ||
        operation.requestId !== input.requestId ||
        !["dispatched", "running"].includes(operation.state) ||
        row.dispatch_epoch !== policy.dispatchEpoch ||
        !this.matchesWorkflowRequestPolicyIdentity({
          policy,
          run,
          operation,
        })
      ) {
        return null;
      }
      return {
        requestId: row.request_id,
        sessionId: row.session_id,
        platform: row.platform,
        policy,
        expiresAt: row.expires_at,
      };
    });
    return authorize.immediate();
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
    resultArtifactId?: string | null;
    usage?: WorkflowOperation["usage"];
    now: number;
  }): boolean {
    const output = input.output === undefined ? null : jsonValueSchema.parse(input.output);
    const usage = input.usage === undefined ? null : workflowUsageSchema.parse(input.usage);
    if (input.state === "resolved" && output === null && !input.resultArtifactId) return false;
    const record = this.db.transaction(() => {
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
          input.resultArtifactId ?? null,
          usage === null ? null : JSON.stringify(usage),
          input.now,
          input.requestId,
          input.runId,
          input.operationId,
          input.dispatchEpoch,
          input.ownerId,
        );
      if (inserted.changes !== 1) return false;
      const deactivated = this.db
        .query(
          `UPDATE workflow_request_dispatches
           SET active = 0, expires_at = MIN(expires_at, ?), updated_at = ?
           WHERE request_id = ? AND run_id = ? AND operation_id = ?
             AND dispatch_epoch = ? AND owner_id = ? AND active = 1
             AND prompt_published_at IS NOT NULL`,
        )
        .run(
          input.now,
          input.now,
          input.requestId,
          input.runId,
          input.operationId,
          input.dispatchEpoch,
          input.ownerId,
        );
      if (deactivated.changes !== 1) {
        throw new Error(`Workflow terminal receipt lost its exact dispatch: ${input.requestId}`);
      }
      return true;
    });
    return record.immediate();
  }

  getWorkflowRequestTerminalReceipt(requestId: string): WorkflowRequestTerminalReceipt | null {
    const row = this.db
      .query("SELECT * FROM workflow_request_terminal_receipts WHERE request_id = ?")
      .get(requestId);
    return row === null ? null : parseRequestTerminalReceipt(row);
  }

  getWorkflowRequestDispatchPolicy(requestId: string): WorkflowRequestPolicy | null {
    const row = this.db
      .query<{ policy_json: string }, [string]>(
        "SELECT policy_json FROM workflow_request_dispatches WHERE request_id = ?",
      )
      .get(requestId);
    if (!row) return null;
    const parsed = workflowRequestPolicySchema.safeParse(
      parseJson(row.policy_json, "workflow_request_dispatches.policy_json"),
    );
    return parsed.success ? parsed.data : null;
  }

  getWorkflowRequestDispatchHandoff(input: {
    requestId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowRequestDispatchHandoff {
    const inspect = this.db.transaction(() => {
      const receipt = this.db
        .query("SELECT * FROM workflow_request_terminal_receipts WHERE request_id = ?")
        .get(input.requestId);
      if (receipt !== null) {
        return { status: "receipt" as const, receipt: parseRequestTerminalReceipt(receipt) };
      }
      const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
      const dispatch = this.db
        .query<
          {
            dispatch_epoch: string;
            policy_json: string;
            run_id: string;
            operation_id: string;
            owner_id: string | null;
            owner_heartbeat_at: number | null;
          },
          [string, number]
        >(
          `SELECT dispatch_epoch, policy_json, run_id, operation_id, owner_id,
             owner_heartbeat_at FROM workflow_request_dispatches
           WHERE request_id = ? AND active = 1 AND expires_at > ?`,
        )
        .get(input.requestId, input.now);
      if (!dispatch) return { status: "fresh" as const };
      const policy = workflowRequestPolicySchema.parse(
        parseJson(dispatch.policy_json, "workflow_request_dispatches.policy_json"),
      );
      const run = this.getRun(dispatch.run_id);
      const operation = this.getOperation(dispatch.run_id, dispatch.operation_id);
      if (
        dispatch.dispatch_epoch !== policy.dispatchEpoch ||
        run?.state !== "running" ||
        !operation ||
        !["dispatched", "running"].includes(operation.state) ||
        !this.matchesWorkflowRequestPolicyIdentity({
          policy,
          run,
          operation,
        })
      ) {
        throw new Error("Live workflow dispatch has an invalid durable policy identity");
      }
      return {
        status:
          dispatch.owner_id !== null &&
          dispatch.owner_heartbeat_at !== null &&
          dispatch.owner_heartbeat_at > staleBefore
            ? ("live" as const)
            : ("stale" as const),
        dispatchEpoch: dispatch.dispatch_epoch,
        policy,
      };
    });
    return inspect.immediate();
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
              AND active = 1 AND expires_at > ?
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
          input.now,
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
           WHERE request_id = ? AND owner_id = ? AND active = 1 AND expires_at > ?`,
        )
        .run(now, now, requestId, ownerId, now).changes === 1
    );
  }

  releaseWorkflowRequestClaim(requestId: string, ownerId: string, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_request_dispatches
           SET owner_id = NULL, owner_heartbeat_at = NULL, updated_at = ?
           WHERE request_id = ? AND owner_id = ? AND active = 1 AND expires_at > ?`,
        )
        .run(now, requestId, ownerId, now).changes === 1
    );
  }

  hasLiveWorkflowRequestOwner(requestId: string, now: number, staleAfterMs = 60_000): boolean {
    const row = this.db
      .query<{ present: number }, [string, number, number]>(
        `SELECT 1 AS present FROM workflow_request_dispatches
         WHERE request_id = ? AND active = 1 AND expires_at > ?
           AND owner_id IS NOT NULL AND owner_heartbeat_at > ?`,
      )
      .get(requestId, now, now - staleAfterMs);
    return row?.present === 1;
  }

  getActiveWorkflowRequestDispatchEpoch(requestId: string, now: number): string | null {
    const row = this.db
      .query<{ dispatch_epoch: string }, [string, number]>(
        `SELECT dispatch_epoch FROM workflow_request_dispatches
         WHERE request_id = ? AND active = 1 AND expires_at > ?`,
      )
      .get(requestId, now);
    return row?.dispatch_epoch ?? null;
  }

  expireWorkflowRequest(requestId: string, now: number, ownerId?: string): boolean {
    const result = ownerId
      ? this.db.run(
          `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
           updated_at = ? WHERE request_id = ? AND owner_id = ? AND active = 1`,
          [now, now, requestId, ownerId],
        )
      : this.db.run(
          `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
           updated_at = ? WHERE request_id = ? AND active = 1`,
          [now, now, requestId],
        );
    return result.changes === 1;
  }

  expireWorkflowRequestsForRun(runId: string, now: number): void {
    this.db.run(
      `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
       updated_at = ? WHERE run_id = ? AND active = 1`,
      [now, now, runId],
    );
  }

  listOperations(
    runId: string,
    options?: { state?: WorkflowOperationState; limit?: number },
  ): WorkflowOperation[] {
    const rows = options?.state
      ? this.db
          .query(
            "SELECT * FROM workflow_operations WHERE run_id = ? AND state = ? ORDER BY created_at LIMIT ?",
          )
          .all(runId, options.state, boundedLimit(options.limit))
      : this.db
          .query("SELECT * FROM workflow_operations WHERE run_id = ? ORDER BY created_at LIMIT ?")
          .all(runId, boundedLimit(options?.limit));
    return tolerantRows(rows, parseOperation);
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
    resultArtifactId?: string | null;
    error?: string | null;
    usage?: WorkflowOperation["usage"];
    runOwnerId: string;
  }): boolean {
    if (!canTransitionWorkflowOperation(input.from, input.to)) {
      throw new Error(`Illegal workflow operation transition: ${input.from} -> ${input.to}`);
    }
    const current = this.getOperation(input.runId, input.operationId);
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(input.to);
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
        input.output === undefined
          ? current.output === null
            ? null
            : JSON.stringify(current.output)
          : input.output === null
            ? null
            : JSON.stringify(jsonValueSchema.parse(input.output)),
        input.resultArtifactId === undefined ? current.resultArtifactId : input.resultArtifactId,
        input.error === undefined ? current.error : input.error,
        input.usage === undefined
          ? current.usage === null
            ? null
            : JSON.stringify(current.usage)
          : input.usage === null
            ? null
            : JSON.stringify(workflowUsageSchema.parse(input.usage)),
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
    resultArtifactId?: string | null;
    error?: string | null;
    usage?: WorkflowOperation["usage"];
    runOwnerId: string;
  }): boolean {
    const terminalize = this.db.transaction(() => {
      const current = this.getOperation(input.runId, input.operationId);
      if (!current || current.state !== input.from) return false;
      const changed = this.transitionOperation(input);
      if (!changed) return false;
      this.db
        .query(
          `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
           updated_at = ? WHERE request_id = ? AND run_id = ? AND operation_id = ? AND active = 1`,
        )
        .run(input.now, input.now, input.requestId, input.runId, input.operationId);
      return true;
    });
    return terminalize.immediate();
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
    return result.changes === 1 ? this.getOperation(input.runId, input.operationId) : null;
  }

  createWait(waitInput: WorkflowWait, runOwnerId: string): boolean {
    const wait = workflowWaitSchema.parse(waitInput);
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

  getWait(runId: string, operationId: string): WorkflowWait | null {
    const row = this.db
      .query("SELECT * FROM workflow_waits WHERE run_id = ? AND operation_id = ?")
      .get(runId, operationId);
    return row === null ? null : parseWait(row);
  }

  listWaits(options: {
    runId?: string;
    state?: WorkflowWaitState;
    matchKind?: WorkflowWait["match"]["kind"];
    matchKey?: string;
    dueBefore?: number;
    limit?: number;
  }): WorkflowWait[] {
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
    const rows = this.db
      .query(`SELECT * FROM workflow_waits ${where} ORDER BY updated_at LIMIT ?`)
      .all(...bindings, boundedLimit(options.limit));
    return tolerantRows(rows, parseWait);
  }

  listActiveWaitsByMatchKey(
    matchKind: WorkflowWait["match"]["kind"],
    matchKey: string,
  ): WorkflowWait[] {
    const rows = this.db
      .query(
        `SELECT workflow_waits.* FROM workflow_waits
         JOIN workflow_runs ON workflow_runs.run_id = workflow_waits.run_id
         WHERE match_kind = ? AND match_key = ? AND workflow_waits.state IN ('pending', 'claimed')
           AND workflow_runs.state = 'running'
         ORDER BY workflow_waits.created_at, workflow_waits.run_id,
           workflow_waits.operation_id LIMIT 1000`,
      )
      .all(matchKind, matchKey);
    return tolerantRows(rows, parseWait);
  }

  listDueWaits(now: number): WorkflowWait[] {
    const rows = this.db
      .query(
        `SELECT workflow_waits.* FROM workflow_waits
         JOIN workflow_runs ON workflow_runs.run_id = workflow_waits.run_id
         WHERE workflow_waits.state IN ('pending', 'claimed')
          AND workflow_runs.state = 'running' AND (
           (due_at IS NOT NULL AND due_at <= ?) OR
           (deadline_at IS NOT NULL AND deadline_at <= ?)
          ) ORDER BY COALESCE(workflow_waits.due_at, workflow_waits.deadline_at),
            workflow_waits.created_at LIMIT 1000`,
      )
      .all(now, now);
    return tolerantRows(rows, parseWait);
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
    const advance = this.db.transaction(() => {
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
    return advance.immediate();
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
    const prepare = this.db.transaction(() => {
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
    return prepare.immediate();
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
      throw new Error(`Illegal workflow wait transition: ${input.from} -> ${input.to}`);
    }
    const current = this.getWait(input.runId, input.operationId);
    if (!current) return false;
    if (current.state === input.to) return true;
    if (current.state !== input.from) return false;
    const resolved = input.to === "resolved" || input.to === "expired";
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
        input.result === undefined
          ? current.result === null
            ? null
            : JSON.stringify(current.result)
          : input.result === null
            ? null
            : JSON.stringify(jsonValueSchema.parse(input.result)),
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
    const resolve = this.db.transaction(() => {
      const wait = this.getWait(input.runId, input.operationId);
      const run = this.getRun(input.runId);
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
          input.result === null ? null : JSON.stringify(jsonValueSchema.parse(input.result)),
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
      return this.getWait(input.runId, input.operationId);
    });
    return resolve.immediate();
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
    return result.changes === 1 ? this.getWait(input.runId, input.operationId) : null;
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
    const lookup = this.db.transaction(() => {
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
    return lookup.immediate();
  }

  createTrigger(triggerInput: WorkflowTrigger): boolean {
    const trigger = workflowTriggerSchema.parse(triggerInput);
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
    const trigger = workflowTriggerSchema.parse(input.trigger);
    const create = this.db.transaction(() => {
      const receipt = this.db
        .query<{ trigger_id: string; fingerprint_sha256: string }, [string]>(
          `SELECT trigger_id, fingerprint_sha256 FROM workflow_trigger_invocation_receipts
           WHERE idempotency_key = ?`,
        )
        .get(input.idempotency.key);
      if (receipt) {
        if (receipt.fingerprint_sha256 !== input.idempotency.fingerprintSha256) {
          throw new Error("Workflow trigger idempotency key was reused with different input");
        }
        const existing = this.getTrigger(receipt.trigger_id);
        if (!existing) throw new Error("Workflow trigger receipt references a missing trigger");
        return { trigger: existing, created: false };
      }
      if (!this.createTrigger(trigger)) {
        throw new Error(`Workflow trigger already exists: ${trigger.triggerId}`);
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
      return { trigger, created: true };
    });
    return create.immediate();
  }

  getTrigger(triggerId: string): WorkflowTrigger | null {
    const row = this.db
      .query("SELECT * FROM workflow_triggers WHERE trigger_id = ?")
      .get(triggerId);
    return row === null ? null : parseTrigger(row);
  }

  getTriggerByLastRunId(runId: string): WorkflowTrigger | null {
    const row = this.db
      .query(
        "SELECT * FROM workflow_triggers WHERE last_run_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(runId);
    return row === null ? null : parseTrigger(row);
  }

  listTriggers(options?: {
    revisionId?: string;
    state?: WorkflowTriggerState;
    dueBefore?: number;
    canonicalProjectId?: string;
    originClient?: string;
    originUserId?: string;
    limit?: number;
  }): WorkflowTrigger[] {
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
    const rows = this.db
      .query(
        `SELECT workflow_triggers.* FROM workflow_triggers
         JOIN workflow_revisions ON workflow_revisions.revision_id = workflow_triggers.revision_id
         ${where} ORDER BY workflow_triggers.next_fire_at, workflow_triggers.created_at LIMIT ?`,
      )
      .all(...bindings, boundedLimit(options?.limit));
    return tolerantRows(rows, parseTrigger);
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
      throw new Error(`Illegal workflow trigger transition: ${input.from} -> ${input.to}`);
    }
    const current = this.getTrigger(input.triggerId);
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
    return result.changes === 1 ? this.getTrigger(input.triggerId) : null;
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
    const requestedRun = workflowRunSchema.parse(input.run);
    const maxActiveRuns = z.number().int().positive().parse(input.maxActiveRuns);
    const fire = this.db.transaction(() => {
      const trigger = this.getTrigger(input.triggerId);
      if (
        !trigger ||
        trigger.state !== "active" ||
        trigger.claimedBy !== input.claimerId ||
        trigger.nextFireAt !== input.expectedFireAt ||
        requestedRun.revisionId !== trigger.revisionId ||
        requestedRun.state !== "queued"
      ) {
        return null;
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
        if (skipped.changes !== 1)
          throw new Error(`Lost workflow trigger claim: ${trigger.triggerId}`);
        const storedTrigger = this.getTrigger(trigger.triggerId);
        if (!storedTrigger) throw new Error(`Workflow trigger disappeared: ${trigger.triggerId}`);
        return { status: "skipped" as const, trigger: storedTrigger };
      }

      const run = requestedRun;
      if (!this.createRun(run)) {
        throw new Error(`Scheduled workflow run already exists: ${run.runId}`);
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
      if (updated.changes !== 1)
        throw new Error(`Lost workflow trigger claim: ${trigger.triggerId}`);
      const storedTrigger = this.getTrigger(trigger.triggerId);
      if (!storedTrigger) throw new Error(`Workflow trigger disappeared: ${trigger.triggerId}`);
      return { status: "fired" as const, trigger: storedTrigger, run };
    });
    return fire.immediate();
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
    const binding = workflowSurfaceBindingSchema.parse(bindingInput);
    this.db.run(
      `INSERT INTO workflow_surface_bindings (
         run_id, target_json, message_ref_json, last_rendered_sha256, last_error,
         retry_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         target_json = excluded.target_json,
         message_ref_json = excluded.message_ref_json,
         last_rendered_sha256 = excluded.last_rendered_sha256,
         last_error = excluded.last_error,
         retry_count = excluded.retry_count,
         next_attempt_at = excluded.next_attempt_at,
         updated_at = excluded.updated_at`,
      [
        binding.runId,
        JSON.stringify(binding.target),
        binding.messageRef === null ? null : JSON.stringify(binding.messageRef),
        binding.lastRenderedSha256,
        binding.lastError,
        binding.retryCount,
        binding.nextAttemptAt,
        binding.createdAt,
        binding.updatedAt,
      ],
    );
  }

  commitSurfaceProjection(input: {
    binding: WorkflowSurfaceBinding;
    actionIds: readonly string[];
  }): void {
    const binding = workflowSurfaceBindingSchema.parse(input.binding);
    const commit = this.db.transaction(() => {
      this.upsertSurfaceBinding(binding);
      if (binding.messageRef) this.bindSurfaceActions(input.actionIds, binding.messageRef);
    });
    commit.immediate();
  }

  getSurfaceBinding(runId: string): WorkflowSurfaceBinding | null {
    const row = this.db
      .query("SELECT * FROM workflow_surface_bindings WHERE run_id = ?")
      .get(runId);
    return row === null ? null : parseBinding(row);
  }

  listSurfaceBindings(options?: {
    dueBefore?: number;
    missingMessageOnly?: boolean;
    limit?: number;
  }): WorkflowSurfaceBinding[] {
    const clauses: string[] = [];
    const bindings: number[] = [];
    if (options?.dueBefore !== undefined) {
      clauses.push("next_attempt_at IS NOT NULL AND next_attempt_at <= ?");
      bindings.push(options.dueBefore);
    }
    if (options?.missingMessageOnly) clauses.push("message_ref_json IS NULL");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM workflow_surface_bindings ${where} ORDER BY updated_at LIMIT ?`)
      .all(...bindings, boundedLimit(options?.limit));
    return tolerantRows(rows, parseBinding);
  }

  deleteSurfaceBinding(runId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_surface_bindings WHERE run_id = ?").run(runId).changes >=
      1
    );
  }

  createSurfaceAction(actionInput: WorkflowSurfaceAction): boolean {
    const action = workflowSurfaceActionSchema.parse(actionInput);
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

  getSurfaceAction(actionId: string): WorkflowSurfaceAction | null {
    const row = this.db
      .query("SELECT * FROM workflow_surface_actions WHERE action_id = ?")
      .get(actionId);
    return row === null ? null : parseAction(row);
  }

  getSurfaceActionByTokenSha256(tokenSha256: string): WorkflowSurfaceAction | null {
    const row = this.db
      .query("SELECT * FROM workflow_surface_actions WHERE token_sha256 = ?")
      .get(tokenSha256);
    return row === null ? null : parseAction(row);
  }

  listSurfaceActions(
    runId: string,
    options?: { activeAt?: number; limit?: number },
  ): WorkflowSurfaceAction[] {
    const rows =
      options?.activeAt === undefined
        ? this.db
            .query(
              "SELECT * FROM workflow_surface_actions WHERE run_id = ? ORDER BY created_at LIMIT ?",
            )
            .all(runId, boundedLimit(options?.limit))
        : this.db
            .query(
              `SELECT * FROM workflow_surface_actions
             WHERE run_id = ? AND consumed_at IS NULL AND expires_at > ?
             ORDER BY created_at LIMIT ?`,
            )
            .all(runId, options.activeAt, boundedLimit(options.limit));
    return tolerantRows(rows, parseAction);
  }

  bindSurfaceActions(
    actionIds: readonly string[],
    messageRef: NonNullable<WorkflowSurfaceAction["expectedMessageRef"]>,
  ): void {
    if (actionIds.length === 0) return;
    const bind = this.db.transaction(() => {
      for (const actionId of actionIds) {
        this.db.run(
          `UPDATE workflow_surface_actions SET expected_message_ref_json = ?
           WHERE action_id = ? AND consumed_at IS NULL`,
          [JSON.stringify(messageRef), actionId],
        );
      }
    });
    bind.immediate();
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
  }): ApplyWorkflowSurfaceActionResult {
    const apply = this.db.transaction((): ApplyWorkflowSurfaceActionResult => {
      const action = this.getSurfaceActionByTokenSha256(input.tokenSha256);
      if (!action) return { status: "not_found" };
      if (action.consumedAt !== null) return { status: "consumed" };
      if (action.expiresAt <= input.now) return { status: "expired" };
      const expected = action.expectedMessageRef;
      if (
        action.expectedPlatform !== input.platform ||
        action.expectedUserId !== input.userId ||
        !expected ||
        expected.platform !== input.messageRef.platform ||
        expected.channelId !== input.messageRef.channelId ||
        expected.messageId !== input.messageRef.messageId
      ) {
        return { status: "unauthorized" };
      }

      let runIds: string[] = [];
      const previousRunStates = new Map<string, WorkflowRunState>();
      const run = this.getRun(action.runId);
      if (!run) return { status: "stale" };
      previousRunStates.set(run.runId, run.state);
      const nextState =
        action.kind === "cancel" ? "cancelled" : action.kind === "pause" ? "paused" : "queued";
      const valid =
        action.kind === "cancel"
          ? !["succeeded", "failed", "cancelled"].includes(run.state)
          : action.kind === "pause"
            ? ["queued", "running", "blocked"].includes(run.state)
            : run.state === "paused";
      if (!valid) return { status: "stale" };
      const terminal = nextState === "cancelled";
      if (
        action.kind === "resume" &&
        !this.preparePausedOperationsForResume(run.runId, input.now)
      ) {
        return { status: "stale" };
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
      if (result.changes !== 1) return { status: "stale" };
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
           expires_at = MIN(expires_at, ?), updated_at = ?
           WHERE run_id = ? AND active = 1`,
          [input.now, input.now, run.runId],
        );
      }
      runIds = [run.runId];

      const consumed = this.db
        .query(
          `UPDATE workflow_surface_actions SET consumed_at = ?, consumed_by_platform = ?,
           consumed_by_user_id = ? WHERE action_id = ? AND consumed_at IS NULL`,
        )
        .run(input.now, input.platform, input.userId, action.actionId);
      if (consumed.changes !== 1) return { status: "consumed" };
      for (const runId of runIds) {
        const updatedRun = this.getRun(runId);
        if (!updatedRun) continue;
        this.insertActionOutboxEntry({
          outboxId: `${action.actionId}:run:${runId}`,
          actionId: action.actionId,
          runId,
          eventType: "evt.workflow.run.changed",
          payload: {
            runId,
            revisionId: updatedRun.revisionId,
            state: updatedRun.state,
            previousState: previousRunStates.get(runId),
            ts: input.now,
          },
          now: input.now,
        });
        this.insertActionOutboxEntry({
          outboxId: `${action.actionId}:progress:${runId}`,
          actionId: action.actionId,
          runId,
          eventType: "evt.workflow.progress.requested",
          payload: {
            runId,
            revisionId: updatedRun.revisionId,
            reason: "state_changed",
            ts: input.now,
          },
          now: input.now,
        });
      }
      return { status: "applied", action, runIds };
    });
    return apply.immediate();
  }

  private insertActionOutboxEntry(input: {
    outboxId: string;
    actionId: string;
    runId: string;
    eventType: string;
    payload: unknown;
    now: number;
  }): void {
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
        JSON.stringify(jsonValueSchema.parse(input.payload)),
        input.now,
        input.now,
      ],
    );
  }

  listPendingActionOutboxEvents(now: number, limit = 100): WorkflowActionOutboxEntry[] {
    return this.db
      .query(
        `SELECT * FROM workflow_action_outbox
         WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at, outbox_id LIMIT ?`,
      )
      .all(now, boundedLimit(limit))
      .map(parseActionOutboxEntry);
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

  listPendingActionOutboxProjections(limit = 100): WorkflowActionOutboxEntry[] {
    return this.db
      .query(
        `SELECT * FROM workflow_action_outbox
         WHERE event_type = 'evt.workflow.progress.requested' AND projected_at IS NULL
         ORDER BY created_at, outbox_id LIMIT ?`,
      )
      .all(boundedLimit(limit))
      .map(parseActionOutboxEntry);
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
    return result.changes === 1 ? this.getSurfaceActionByTokenSha256(input.tokenSha256) : null;
  }

  deleteSurfaceAction(actionId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_surface_actions WHERE action_id = ?").run(actionId)
        .changes === 1
    );
  }
}
