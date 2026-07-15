import { Database } from "bun:sqlite";
import path from "node:path";
import { z } from "zod";
import { env } from "@stanley2058/lilac-utils";

import { configureSqliteConnection } from "../shared/sqlite";
import {
  canTransitionWorkflowApproval,
  canTransitionWorkflowOperation,
  canTransitionWorkflowRun,
  canTransitionWorkflowTrigger,
  canTransitionWorkflowWait,
  jsonValueSchema,
  workflowApprovalSchema,
  workflowOperationSchema,
  workflowRevisionSchema,
  workflowRunSchema,
  workflowSchemaMigrationSchema,
  workflowSurfaceActionSchema,
  workflowSurfaceBindingSchema,
  workflowTriggerSchema,
  workflowUsageSchema,
  workflowWaitSchema,
  type WorkflowApproval,
  type WorkflowApprovalState,
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

const approvalRowSchema = z.object({
  approval_id: z.string(),
  revision_id: z.string(),
  state: z.string(),
  expected_reviewer_platform: nullableStringSchema,
  expected_reviewer_user_id: nullableStringSchema,
  first_run_id: z.string(),
  decision_actor_platform: nullableStringSchema,
  decision_actor_user_id: nullableStringSchema,
  decision_source: nullableStringSchema,
  expires_at: nullableNumberSchema,
  decided_at: nullableNumberSchema,
  revoked_at: nullableNumberSchema,
  revocation_reason: nullableStringSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const runRowSchema = z.object({
  run_id: z.string(),
  revision_id: z.string(),
  approval_id: nullableStringSchema,
  state: z.string(),
  input_schema_json: z.string(),
  args_json: z.string(),
  args_sha256: z.string(),
  origin_request_id: nullableStringSchema,
  origin_session_id: nullableStringSchema,
  origin_client: nullableStringSchema,
  origin_user_id: nullableStringSchema,
  origin_safety_mode: z.string(),
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
  approval_id: nullableStringSchema,
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
    capabilitySha256: row.capability_sha256,
    metadata: parseJson(row.metadata_json, "workflow_revisions.metadata_json"),
    inputSchema: parseJson(row.input_schema_json, "workflow_revisions.input_schema_json"),
    capabilities: parseJson(row.capabilities_json, "workflow_revisions.capabilities_json"),
    limits: parseJson(row.limits_json, "workflow_revisions.limits_json"),
    runtimeVersion: row.runtime_version,
    createdAt: row.created_at,
  });
}

function parseApproval(value: unknown): WorkflowApproval {
  const row = approvalRowSchema.parse(value);
  return workflowApprovalSchema.parse({
    approvalId: row.approval_id,
    revisionId: row.revision_id,
    state: row.state,
    expectedReviewerPlatform: row.expected_reviewer_platform,
    expectedReviewerUserId: row.expected_reviewer_user_id,
    firstRunId: row.first_run_id,
    decisionActorPlatform: row.decision_actor_platform,
    decisionActorUserId: row.decision_actor_user_id,
    decisionSource: row.decision_source,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseRun(value: unknown): WorkflowRun {
  const row = runRowSchema.parse(value);
  return workflowRunSchema.parse({
    runId: row.run_id,
    revisionId: row.revision_id,
    approvalId: row.approval_id,
    state: row.state,
    inputSchemaSnapshot: parseJson(row.input_schema_json, "workflow_runs.input_schema_json"),
    args: parseJson(row.args_json, "workflow_runs.args_json"),
    argsSha256: row.args_sha256,
    origin: {
      requestId: row.origin_request_id,
      sessionId: row.origin_session_id,
      client: row.origin_client,
      userId: row.origin_user_id,
      safetyMode: row.origin_safety_mode,
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
    approvalId: row.approval_id,
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
    identity.capabilitySha256,
    identity.runtimeVersion,
  ];
}

export type CreateWorkflowInvocationResult = {
  revision: WorkflowRevision;
  approval: WorkflowApproval;
  run: WorkflowRun;
  revisionCreated: boolean;
  approvalCreated: boolean;
};

export type ApplyWorkflowSurfaceActionResult =
  | {
      status: "applied";
      action: WorkflowSurfaceAction;
      runIds: string[];
      approvalId: string | null;
    }
  | { status: "not_found" | "unauthorized" | "expired" | "consumed" | "stale" };

export class DurableWorkflowStore {
  private readonly db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? resolveWorkflowDbPath());
    configureSqliteConnection(this.db);
    this.db.run("PRAGMA foreign_keys = ON");
    applyWorkflowSchemaMigrations(this.db);
  }

  close(): void {
    this.db.close();
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
        revision.capabilitySha256,
        JSON.stringify(revision.metadata),
        JSON.stringify(revision.inputSchema),
        JSON.stringify(revision.capabilities),
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

  createApproval(approvalInput: WorkflowApproval): boolean {
    const approval = workflowApprovalSchema.parse(approvalInput);
    const result = this.db
      .query(
        `INSERT INTO workflow_approvals (
          approval_id, revision_id, state, expected_reviewer_platform,
          expected_reviewer_user_id, first_run_id, decision_actor_platform,
          decision_actor_user_id, decision_source, expires_at, decided_at,
          revoked_at, revocation_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO NOTHING`,
      )
      .run(
        approval.approvalId,
        approval.revisionId,
        approval.state,
        approval.expectedReviewerPlatform,
        approval.expectedReviewerUserId,
        approval.firstRunId,
        approval.decisionActorPlatform,
        approval.decisionActorUserId,
        approval.decisionSource,
        approval.expiresAt,
        approval.decidedAt,
        approval.revokedAt,
        approval.revocationReason,
        approval.createdAt,
        approval.updatedAt,
      );
    return result.changes === 1;
  }

  getApproval(approvalId: string): WorkflowApproval | null {
    const row = this.db
      .query("SELECT * FROM workflow_approvals WHERE approval_id = ?")
      .get(approvalId);
    return row === null ? null : parseApproval(row);
  }

  getActiveApproval(revisionId: string): WorkflowApproval | null {
    const row = this.db
      .query(
        `SELECT * FROM workflow_approvals
         WHERE revision_id = ? AND state IN ('pending', 'approved')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(revisionId);
    return row === null ? null : parseApproval(row);
  }

  listApprovals(options?: {
    revisionId?: string;
    state?: WorkflowApprovalState;
    limit?: number;
  }): WorkflowApproval[] {
    const clauses: string[] = [];
    const bindings: string[] = [];
    if (options?.revisionId) {
      clauses.push("revision_id = ?");
      bindings.push(options.revisionId);
    }
    if (options?.state) {
      clauses.push("state = ?");
      bindings.push(options.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM workflow_approvals ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...bindings, boundedLimit(options?.limit));
    return tolerantRows(rows, parseApproval);
  }

  createRun(runInput: WorkflowRun): boolean {
    const run = workflowRunSchema.parse(runInput);
    const result = this.db
      .query(
        `INSERT INTO workflow_runs (
          run_id, revision_id, approval_id, state, input_schema_json, args_json,
          args_sha256, origin_request_id, origin_session_id, origin_client,
          origin_user_id, origin_safety_mode, origin_project_cwd,
          completion_target_json, progress_target_json, terminal_detail, result_json,
          result_artifact_id, claimed_by, claimed_at, created_at, started_at,
          updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(
        run.runId,
        run.revisionId,
        run.approvalId,
        run.state,
        JSON.stringify(run.inputSchemaSnapshot),
        JSON.stringify(run.args),
        run.argsSha256,
        run.origin.requestId,
        run.origin.sessionId,
        run.origin.client,
        run.origin.userId,
        run.origin.safetyMode,
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
    approvalId?: string;
    state?: WorkflowRunState;
    limit?: number;
  }): WorkflowRun[] {
    const clauses: string[] = [];
    const bindings: string[] = [];
    if (options?.revisionId) {
      clauses.push("revision_id = ?");
      bindings.push(options.revisionId);
    }
    if (options?.approvalId) {
      clauses.push("approval_id = ?");
      bindings.push(options.approvalId);
    }
    if (options?.state) {
      clauses.push("state = ?");
      bindings.push(options.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC LIMIT ?`)
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

  listRunsMissingSurfaceBindings(limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         LEFT JOIN workflow_surface_bindings
           ON workflow_surface_bindings.run_id = workflow_runs.run_id
         WHERE workflow_runs.progress_target_json IS NOT NULL
           AND workflow_surface_bindings.run_id IS NULL
         ORDER BY workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  createInvocation(input: {
    revision: WorkflowRevision;
    run: WorkflowRun;
    pendingApproval: WorkflowApproval;
    queueApproved?: boolean;
  }): CreateWorkflowInvocationResult {
    const revision = workflowRevisionSchema.parse(input.revision);
    const requestedRun = workflowRunSchema.parse(input.run);
    const pendingApproval = workflowApprovalSchema.parse(input.pendingApproval);
    if (requestedRun.revisionId !== revision.revisionId) {
      throw new Error("Run revisionId must match the requested revision");
    }
    if (pendingApproval.revisionId !== revision.revisionId) {
      throw new Error("Approval revisionId must match the requested revision");
    }
    if (pendingApproval.state !== "pending" || pendingApproval.firstRunId !== requestedRun.runId) {
      throw new Error("New invocation approval must be pending and reference the first run");
    }

    const create = this.db.transaction((): CreateWorkflowInvocationResult => {
      const revisionCreated = this.createRevision(revision);
      const storedRevision = this.findRevisionByIdentity(revision);
      if (!storedRevision) throw new Error("Revision was not persisted");
      if (storedRevision.revisionId !== revision.revisionId) {
        throw new Error(
          `Revision identity already belongs to ${storedRevision.revisionId}, not ${revision.revisionId}`,
        );
      }

      let approval = this.getActiveApproval(revision.revisionId);
      let approvalCreated = false;
      if (!approval) {
        approvalCreated = this.createApproval(pendingApproval);
        approval = this.getApproval(pendingApproval.approvalId);
      }
      if (!approval) throw new Error("Approval was not persisted");

      const run = workflowRunSchema.parse({
        ...requestedRun,
        approvalId: approval.approvalId,
        state:
          approval.state === "approved" && input.queueApproved !== false
            ? "queued"
            : "awaiting_review",
      });
      if (!this.createRun(run)) throw new Error(`Run ${run.runId} already exists`);
      return { revision: storedRevision, approval, run, revisionCreated, approvalCreated };
    });
    return create.immediate();
  }

  createApprovedInvocation(input: {
    revision: WorkflowRevision;
    run: WorkflowRun;
    approval: WorkflowApproval;
  }): CreateWorkflowInvocationResult {
    const revision = workflowRevisionSchema.parse(input.revision);
    const requestedRun = workflowRunSchema.parse(input.run);
    const requestedApproval = workflowApprovalSchema.parse(input.approval);
    if (requestedRun.revisionId !== revision.revisionId) {
      throw new Error("Run revisionId must match the requested revision");
    }
    if (requestedApproval.revisionId !== revision.revisionId) {
      throw new Error("Approval revisionId must match the requested revision");
    }
    if (requestedApproval.state !== "approved") {
      throw new Error("Approved invocation requires an approved grant");
    }

    const create = this.db.transaction((): CreateWorkflowInvocationResult => {
      const revisionCreated = this.createRevision(revision);
      const storedRevision = this.findRevisionByIdentity(revision);
      if (!storedRevision) throw new Error("Revision was not persisted");
      if (storedRevision.revisionId !== revision.revisionId) {
        throw new Error(
          `Revision identity already belongs to ${storedRevision.revisionId}, not ${revision.revisionId}`,
        );
      }

      let approval = this.getActiveApproval(revision.revisionId);
      let approvalCreated = false;
      if (!approval) {
        approvalCreated = this.createApproval(requestedApproval);
        approval = this.getApproval(requestedApproval.approvalId);
      }
      if (!approval || approval.state !== "approved") {
        throw new Error("Approved workflow grant was not persisted");
      }

      const run = workflowRunSchema.parse({
        ...requestedRun,
        approvalId: approval.approvalId,
        state: "queued",
      });
      if (!this.createRun(run)) throw new Error(`Run ${run.runId} already exists`);
      return { revision: storedRevision, approval, run, revisionCreated, approvalCreated };
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
           AND workflow_runs.state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
         ORDER BY workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(parentRequestId, boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  listPendingLiveParentCompletions(parentRequestId: string, limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.parent_request_id = ?
           AND workflow_completion_deliveries.state = 'pending'
           AND workflow_runs.state IN ('succeeded', 'failed', 'rejected', 'cancelled')
         ORDER BY workflow_runs.terminal_at, workflow_runs.created_at, workflow_runs.run_id LIMIT ?`,
      )
      .all(parentRequestId, boundedLimit(limit));
    return tolerantRows(rows, parseRun);
  }

  listOrphanedLiveParentCompletions(limit = 1_000): WorkflowRun[] {
    const rows = this.db
      .query(
        `SELECT workflow_runs.* FROM workflow_runs
         JOIN workflow_completion_deliveries
           ON workflow_completion_deliveries.run_id = workflow_runs.run_id
         WHERE workflow_completion_deliveries.state = 'pending'
           AND workflow_runs.state IN ('succeeded', 'failed', 'rejected', 'cancelled')
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

  transitionApproval(input: {
    approvalId: string;
    from: WorkflowApprovalState;
    to: WorkflowApprovalState;
    now: number;
    actorPlatform?: WorkflowApproval["decisionActorPlatform"];
    actorUserId?: string | null;
    source?: string | null;
    reason?: string | null;
  }): boolean {
    if (!canTransitionWorkflowApproval(input.from, input.to)) {
      throw new Error(`Illegal workflow approval transition: ${input.from} -> ${input.to}`);
    }
    const transition = this.db.transaction(() => {
      const current = this.getApproval(input.approvalId);
      if (!current) return false;
      if (current.state === input.to) return true;
      if (current.state !== input.from) return false;
      const result = this.db
        .query(
          `UPDATE workflow_approvals SET
            state = ?, decision_actor_platform = ?, decision_actor_user_id = ?,
            decision_source = ?, decided_at = ?, revoked_at = ?, revocation_reason = ?, updated_at = ?
           WHERE approval_id = ? AND state = ?`,
        )
        .run(
          input.to,
          input.actorPlatform ?? null,
          input.actorUserId ?? null,
          input.source ?? null,
          input.to === "approved" || input.to === "rejected" ? input.now : current.decidedAt,
          input.to === "revoked" ? input.now : current.revokedAt,
          input.to === "revoked" ? (input.reason ?? null) : current.revocationReason,
          input.now,
          input.approvalId,
          input.from,
        );
      if (result.changes !== 1) return false;
      if (input.to === "approved") {
        this.db.run(
          `UPDATE workflow_runs SET state = 'queued', updated_at = ?
           WHERE approval_id = ? AND state = 'awaiting_review'`,
          [input.now, input.approvalId],
        );
      } else if (input.to === "rejected" || input.to === "expired") {
        this.db.run(
          `UPDATE workflow_runs SET state = 'rejected', terminal_detail = ?, terminal_at = ?, updated_at = ?
           WHERE approval_id = ? AND state = 'awaiting_review'`,
          [input.reason ?? input.to, input.now, input.now, input.approvalId],
        );
      } else if (input.to === "revoked") {
        this.db.run(
          `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, updated_at = ?
           WHERE approval_id = ? AND state = 'queued'`,
          [input.reason ?? "Approval revoked before execution", input.now, input.approvalId],
        );
      }
      return true;
    });
    return transition.immediate();
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

  tryClaimApprovedRun(input: {
    runId: string;
    claimerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowRun | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const claim = this.db.transaction(() => {
      const result = this.db
        .query(
          `UPDATE workflow_runs SET state = 'running', claimed_by = ?, claimed_at = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE run_id = ? AND origin_safety_mode = 'trusted'
             AND (state = 'queued' OR (state = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?))
             AND approval_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM workflow_approvals
               WHERE workflow_approvals.approval_id = workflow_runs.approval_id
                 AND workflow_approvals.revision_id = workflow_runs.revision_id
                 AND workflow_approvals.state = 'approved'
             )`,
        )
        .run(input.claimerId, input.now, input.now, input.now, input.runId, staleBefore);
      return result.changes === 1 ? this.getRun(input.runId) : null;
    });
    return claim.immediate();
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

  createOperation(operationInput: WorkflowOperation): boolean {
    const operation = workflowOperationSchema.parse(operationInput);
    const result = this.db
      .query(
        `INSERT INTO workflow_operations (
          run_id, operation_id, call_site_id, parent_operation_id, phase, label,
          kind, input_json, input_sha256, state, attempt, request_id, output_json,
          result_artifact_id, error, usage_json, claimed_by, claimed_at, created_at,
          started_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         WHERE run_id = ? AND operation_id = ? AND state = ?`,
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
      );
    return result.changes === 1;
  }

  cancelActiveOperations(runId: string, now: number, error: string): WorkflowOperation[] {
    this.db.run(
      `UPDATE workflow_operations SET state = 'cancelled', error = ?, terminal_at = ?, updated_at = ?
       WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
      [error, now, now, runId],
    );
    return this.listOperations(runId, { state: "cancelled", limit: 1_000 });
  }

  requeueActiveOperations(runId: string, now: number, error: string): WorkflowOperation[] {
    this.db.run(
      `UPDATE workflow_operations SET state = 'queued', attempt = attempt + 1,
        request_id = NULL, error = ?, claimed_by = NULL, claimed_at = NULL,
        started_at = NULL, terminal_at = NULL, updated_at = ?
       WHERE run_id = ? AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
      [error, now, runId],
    );
    return this.listOperations(runId, { state: "queued", limit: 1_000 });
  }

  tryClaimOperation(input: {
    runId: string;
    operationId: string;
    claimerId: string;
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
           (state IN ('dispatched', 'running') AND claimed_at IS NOT NULL AND claimed_at <= ?)
         )`,
      )
      .run(input.claimerId, input.now, input.now, input.runId, input.operationId, staleBefore);
    return result.changes === 1 ? this.getOperation(input.runId, input.operationId) : null;
  }

  createWait(waitInput: WorkflowWait): boolean {
    const wait = workflowWaitSchema.parse(waitInput);
    const result = this.db
      .query(
        `INSERT INTO workflow_waits (
          run_id, operation_id, state, match_kind, match_key, match_json, due_at,
          deadline_at, resolver_cursor, result_json, resolved_by, claimed_by,
          claimed_at, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        `SELECT * FROM workflow_waits
         WHERE match_kind = ? AND match_key = ? AND state IN ('pending', 'claimed')
         ORDER BY created_at, run_id, operation_id LIMIT 1000`,
      )
      .all(matchKind, matchKey);
    return tolerantRows(rows, parseWait);
  }

  listDueWaits(now: number): WorkflowWait[] {
    const rows = this.db
      .query(
        `SELECT * FROM workflow_waits
         WHERE state IN ('pending', 'claimed') AND (
           (due_at IS NOT NULL AND due_at <= ?) OR
           (deadline_at IS NOT NULL AND deadline_at <= ?)
         ) ORDER BY COALESCE(due_at, deadline_at), created_at LIMIT 1000`,
      )
      .all(now, now);
    return tolerantRows(rows, parseWait);
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
         WHERE run_id = ? AND operation_id = ? AND state = ?`,
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
      );
    return result.changes === 1;
  }

  tryClaimWait(input: {
    runId: string;
    operationId: string;
    claimerId: string;
    now: number;
    staleAfterMs?: number;
  }): WorkflowWait | null {
    const staleBefore = input.now - (input.staleAfterMs ?? 60_000);
    const result = this.db
      .query(
        `UPDATE workflow_waits SET state = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE run_id = ? AND operation_id = ? AND (
           state = 'pending' OR (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?)
         )`,
      )
      .run(input.claimerId, input.now, input.now, input.runId, input.operationId, staleBefore);
    return result.changes === 1 ? this.getWait(input.runId, input.operationId) : null;
  }

  cancelActiveWaits(runId: string, now: number): WorkflowWait[] {
    this.db.run(
      `UPDATE workflow_waits SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
       resolved_at = ?, updated_at = ?
       WHERE run_id = ? AND state IN ('pending', 'claimed')`,
      [now, now, runId],
    );
    return this.listWaits({ runId, state: "cancelled", limit: 1_000 });
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

  consumeAdapterEventSuppression(input: {
    platform: string;
    channelId: string;
    messageId: string;
    now: number;
  }): { runId: string; operationId: string } | null {
    const consume = this.db.transaction(() => {
      this.db.run("DELETE FROM workflow_adapter_event_suppressions WHERE expires_at <= ?", [
        input.now,
      ]);
      const row = this.db
        .query<{ run_id: string; operation_id: string }, [string, string, string, number]>(
          `SELECT run_id, operation_id FROM workflow_adapter_event_suppressions
           WHERE platform = ? AND channel_id = ? AND message_id = ? AND expires_at > ?`,
        )
        .get(input.platform, input.channelId, input.messageId, input.now);
      if (!row) return null;
      this.db.run(
        `DELETE FROM workflow_adapter_event_suppressions
         WHERE platform = ? AND channel_id = ? AND message_id = ?`,
        [input.platform, input.channelId, input.messageId],
      );
      return { runId: row.run_id, operationId: row.operation_id };
    });
    return consume.immediate();
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
    limit?: number;
  }): WorkflowTrigger[] {
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (options?.revisionId) {
      clauses.push("revision_id = ?");
      bindings.push(options.revisionId);
    }
    if (options?.state) {
      clauses.push("state = ?");
      bindings.push(options.state);
    }
    if (options?.dueBefore !== undefined) {
      clauses.push("next_fire_at IS NOT NULL AND next_fire_at <= ?");
      bindings.push(options.dueBefore);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM workflow_triggers ${where} ORDER BY next_fire_at, created_at LIMIT ?`)
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
    pendingApproval: WorkflowApproval;
    now: number;
  }): { trigger: WorkflowTrigger; run: WorkflowRun; approval: WorkflowApproval } | null {
    const requestedRun = workflowRunSchema.parse(input.run);
    const pendingApproval = workflowApprovalSchema.parse(input.pendingApproval);
    const fire = this.db.transaction(() => {
      const trigger = this.getTrigger(input.triggerId);
      if (
        !trigger ||
        trigger.state !== "active" ||
        trigger.claimedBy !== input.claimerId ||
        trigger.nextFireAt !== input.expectedFireAt ||
        requestedRun.revisionId !== trigger.revisionId ||
        pendingApproval.revisionId !== trigger.revisionId
      ) {
        return null;
      }

      let approval = this.getActiveApproval(trigger.revisionId);
      if (!approval) {
        if (!this.createApproval(pendingApproval)) return null;
        approval = this.getApproval(pendingApproval.approvalId);
      }
      if (!approval) return null;
      const run = workflowRunSchema.parse({
        ...requestedRun,
        approvalId: approval.approvalId,
        state: approval.state === "approved" ? "queued" : "awaiting_review",
      });
      if (!this.createRun(run)) {
        throw new Error(`Scheduled workflow run already exists: ${run.runId}`);
      }
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
      return { trigger: storedTrigger, run, approval };
    });
    return fire.immediate();
  }

  deleteTrigger(triggerId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_triggers WHERE trigger_id = ?").run(triggerId).changes ===
      1
    );
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
      this.db.query("DELETE FROM workflow_surface_bindings WHERE run_id = ?").run(runId).changes ===
      1
    );
  }

  createSurfaceAction(actionInput: WorkflowSurfaceAction): boolean {
    const action = workflowSurfaceActionSchema.parse(actionInput);
    const result = this.db
      .query(
        `INSERT INTO workflow_surface_actions (
          action_id, token_sha256, run_id, approval_id, kind, expected_platform,
          expected_user_id, expected_message_ref_json, expires_at, consumed_at,
          consumed_by_platform, consumed_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(action_id) DO NOTHING`,
      )
      .run(
        action.actionId,
        action.tokenSha256,
        action.runId,
        action.approvalId,
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

      const source = `${input.platform}:${input.messageRef.channelId}:${input.sourceMessageId ?? input.messageRef.messageId}`;
      let runIds: string[] = [];
      if (action.kind === "approve" || action.kind === "reject") {
        if (!action.approvalId) return { status: "stale" };
        const approval = this.getApproval(action.approvalId);
        if (
          !approval ||
          approval.state !== "pending" ||
          approval.expectedReviewerPlatform !== input.platform ||
          approval.expectedReviewerUserId !== input.userId
        ) {
          return { status: "stale" };
        }
        runIds = this.listRuns({ approvalId: approval.approvalId, limit: 1_000 })
          .filter((run) => run.state === "awaiting_review")
          .map((run) => run.runId);
        const nextApprovalState = action.kind === "approve" ? "approved" : "rejected";
        const approvalUpdate = this.db
          .query(
            `UPDATE workflow_approvals SET state = ?, decision_actor_platform = ?,
             decision_actor_user_id = ?, decision_source = ?, decided_at = ?, updated_at = ?
             WHERE approval_id = ? AND state = 'pending'`,
          )
          .run(
            nextApprovalState,
            input.platform,
            input.userId,
            source,
            input.now,
            input.now,
            approval.approvalId,
          );
        if (approvalUpdate.changes !== 1) return { status: "stale" };
        if (action.kind === "approve") {
          this.db.run(
            `UPDATE workflow_runs SET state = 'queued', updated_at = ?
             WHERE approval_id = ? AND state = 'awaiting_review'`,
            [input.now, approval.approvalId],
          );
        } else {
          this.db.run(
            `UPDATE workflow_runs SET state = 'rejected', terminal_detail = 'Rejected by reviewer',
             terminal_at = ?, updated_at = ?
             WHERE approval_id = ? AND state = 'awaiting_review'`,
            [input.now, input.now, approval.approvalId],
          );
        }
      } else {
        const run = this.getRun(action.runId);
        if (!run) return { status: "stale" };
        const nextState =
          action.kind === "cancel" ? "cancelled" : action.kind === "pause" ? "paused" : "queued";
        const valid =
          action.kind === "cancel"
            ? !["succeeded", "failed", "rejected", "cancelled"].includes(run.state)
            : action.kind === "pause"
              ? ["queued", "running", "blocked"].includes(run.state)
              : run.state === "paused";
        if (!valid) return { status: "stale" };
        const terminal = nextState === "cancelled";
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
        runIds = [run.runId];
      }

      const consumed = this.db
        .query(
          `UPDATE workflow_surface_actions SET consumed_at = ?, consumed_by_platform = ?,
           consumed_by_user_id = ? WHERE action_id = ? AND consumed_at IS NULL`,
        )
        .run(input.now, input.platform, input.userId, action.actionId);
      if (consumed.changes !== 1) return { status: "consumed" };
      return { status: "applied", action, runIds, approvalId: action.approvalId };
    });
    return apply.immediate();
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
