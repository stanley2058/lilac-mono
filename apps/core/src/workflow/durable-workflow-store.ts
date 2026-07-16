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
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
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
import {
  workflowRequestPolicySchema,
  type AuthorizedWorkflowRequest,
  type WorkflowRequestPolicy,
} from "./workflow-request-authority";
import { sha256 } from "./workflow-definition";

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
  repair_required: z.number().int().min(0).max(1),
  repair_generation: z.number().int().nonnegative(),
  rendered_repair_generation: z.number().int().nonnegative(),
  send_may_have_succeeded: z.number().int().min(0).max(1),
  discovery_page: z.number().int().positive(),
  discovery_before_message_id: nullableStringSchema,
  discovery_scanned_entries: z.number().int().nonnegative(),
  created_at: z.number(),
  updated_at: z.number(),
});

const projectionOrphanRowSchema = z.object({
  run_id: z.string(),
  platform: z.enum(["discord", "github"]),
  channel_id: z.string(),
  message_id: z.string(),
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: nullableNumberSchema,
  last_error: nullableStringSchema,
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

const requestDispatchRowSchema = z.object({
  request_id: z.string(),
  run_id: z.string(),
  operation_id: z.string(),
  dispatch_epoch: z.string(),
  token_sha256: z.string(),
  session_id: z.string(),
  platform: z.string(),
  canonical_cwd: z.string(),
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
  publish_claim_owner: nullableStringSchema,
  publish_claim_token: nullableStringSchema,
  publish_claimed_at: nullableNumberSchema,
  project_claim_owner: nullableStringSchema,
  project_claim_token: nullableStringSchema,
  project_claimed_at: nullableNumberSchema,
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
    repairGeneration: row.repair_generation,
    renderedRepairGeneration: row.rendered_repair_generation,
    sendMayHaveSucceeded: row.send_may_have_succeeded === 1,
    discoveryCursor:
      row.send_may_have_succeeded === 1
        ? {
            page: row.discovery_page,
            beforeMessageId: row.discovery_before_message_id,
            scannedEntries: row.discovery_scanned_entries,
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseProjectionOrphan(value: unknown): WorkflowSurfaceProjectionOrphan {
  const row = projectionOrphanRowSchema.parse(value);
  return {
    runId: row.run_id,
    messageRef: {
      platform: row.platform,
      channelId: row.channel_id,
      messageId: row.message_id,
    },
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    publishClaimOwner: row.publish_claim_owner,
    publishClaimToken: row.publish_claim_token,
    publishClaimedAt: row.publish_claimed_at,
    projectClaimOwner: row.project_claim_owner,
    projectClaimToken: row.project_claim_token,
    projectClaimedAt: row.project_claimed_at,
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
  | { status: "live"; dispatchEpoch: string }
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
  publishClaimOwner: string | null;
  publishClaimToken: string | null;
  publishClaimedAt: number | null;
  projectClaimOwner: string | null;
  projectClaimToken: string | null;
  projectClaimedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type WorkflowProjectionMsgRef = {
  platform: "discord" | "github";
  channelId: string;
  messageId: string;
};

export type WorkflowSurfaceProjectionOrphan = {
  runId: string;
  messageRef: WorkflowProjectionMsgRef;
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
    return this.getActiveApprovalForPrincipal(revisionId, null, null);
  }

  getActiveApprovalForPrincipal(
    revisionId: string,
    reviewerPlatform: WorkflowApproval["expectedReviewerPlatform"],
    reviewerUserId: string | null,
  ): WorkflowApproval | null {
    const row = this.db
      .query(
        `SELECT * FROM workflow_approvals
         WHERE revision_id = ?
           AND expected_reviewer_platform IS ?
           AND expected_reviewer_user_id IS ?
           AND state IN ('pending', 'approved')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(revisionId, reviewerPlatform, reviewerUserId);
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
    idempotency?: { key: string; fingerprintSha256: string };
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
          const existingApproval = existingRun?.approvalId
            ? this.getApproval(existingRun.approvalId)
            : null;
          if (!existingRun || !existingRevision || !existingApproval) {
            throw new Error("Workflow invocation receipt references missing durable records");
          }
          return {
            run: existingRun,
            revision: existingRevision,
            approval: existingApproval,
            revisionCreated: false,
            approvalCreated: false,
          };
        }
      }
      const revisionCreated = this.createRevision(revision);
      const storedRevision = this.findRevisionByIdentity(revision);
      if (!storedRevision) throw new Error("Revision was not persisted");
      if (storedRevision.revisionId !== revision.revisionId) {
        throw new Error(
          `Revision identity already belongs to ${storedRevision.revisionId}, not ${revision.revisionId}`,
        );
      }

      let approval = this.getActiveApprovalForPrincipal(
        revision.revisionId,
        pendingApproval.expectedReviewerPlatform,
        pendingApproval.expectedReviewerUserId,
      );
      let approvalCreated = false;
      if (!approval) {
        approvalCreated = this.createApproval(pendingApproval);
        approval = this.getApproval(pendingApproval.approvalId);
      }
      if (!approval) throw new Error("Approval was not persisted");

      const run = workflowRunSchema.parse({
        ...requestedRun,
        approvalId: approval.approvalId,
        state: approval.state === "approved" ? "queued" : "awaiting_review",
      });
      if (!this.createRun(run)) throw new Error(`Run ${run.runId} already exists`);
      if (input.idempotency) {
        this.db.run(
          `INSERT INTO workflow_invocation_receipts (
             idempotency_key, run_id, fingerprint_sha256, created_at
           ) VALUES (?, ?, ?, ?)`,
          [input.idempotency.key, run.runId, input.idempotency.fingerprintSha256, run.createdAt],
        );
      }
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

      let approval = this.getActiveApprovalForPrincipal(
        revision.revisionId,
        requestedApproval.expectedReviewerPlatform,
        requestedApproval.expectedReviewerUserId,
      );
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
            AND workflow_runs.state IN ('succeeded', 'failed', 'rejected', 'cancelled')
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
          `UPDATE workflow_operations SET state = 'queued',
           attempt = attempt + CASE WHEN EXISTS (
             SELECT 1 FROM workflow_request_terminal_receipts receipt
             WHERE receipt.request_id = workflow_operations.request_id
           ) THEN 0 ELSE 1 END,
           request_id = CASE WHEN EXISTS (
             SELECT 1 FROM workflow_request_terminal_receipts receipt
             WHERE receipt.request_id = workflow_operations.request_id
           ) THEN request_id ELSE NULL END,
           error = ?, claimed_by = NULL, claimed_at = NULL,
           started_at = NULL, terminal_at = NULL, updated_at = ?
           WHERE run_id IN (
             SELECT run_id FROM workflow_runs WHERE approval_id = ?
               AND state IN ('running', 'blocked')
           ) AND state IN ('queued', 'dispatched', 'running', 'blocked')`,
          [input.reason ?? "Approval revoked before execution", input.now, input.approvalId],
        );
        this.db.run(
          `UPDATE workflow_request_dispatches SET active = 0, expires_at = MIN(expires_at, ?),
           updated_at = ? WHERE run_id IN (
             SELECT run_id FROM workflow_runs WHERE approval_id = ?
           ) AND active = 1`,
          [input.now, input.now, input.approvalId],
        );
        this.db.run(
          `UPDATE workflow_runs SET state = 'paused', terminal_detail = ?, claimed_by = NULL,
             claimed_at = NULL, updated_at = ?
             WHERE approval_id = ? AND state IN ('queued', 'running', 'blocked')`,
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

  authorizeAgentDispatch(input: {
    requestId: string;
    runId: string;
    operationId: string;
    runOwnerId: string;
    token: string;
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
      policy.canonicalCwd === "" ||
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
      const revision = run ? this.getRevision(run.revisionId) : null;
      const approval = run?.approvalId ? this.getApproval(run.approvalId) : null;
      const operation = this.getOperation(input.runId, input.operationId);
      if (
        !run ||
        !revision ||
        !operation ||
        run.state !== "running" ||
        run.claimedBy !== input.runOwnerId ||
        approval?.state !== "approved" ||
        approval.revisionId !== revision.revisionId ||
        policy.revisionId !== revision.revisionId ||
        policy.canonicalProjectId !== revision.canonicalProjectId ||
        policy.canonicalWorkspaceRoot !== revision.canonicalWorkspaceRoot ||
        policy.sourceSha256 !== revision.sourceSha256 ||
        policy.inputSchemaSha256 !== revision.inputSchemaSha256 ||
        policy.capabilitySha256 !== revision.capabilitySha256 ||
        policy.argsSha256 !== run.argsSha256 ||
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
           request_id, run_id, operation_id, dispatch_epoch, token_sha256, session_id, platform,
           canonical_cwd, policy_json, expires_at, owner_id, owner_heartbeat_at,
           active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        [
          input.requestId,
          input.runId,
          input.operationId,
          policy.dispatchEpoch,
          sha256(input.token),
          input.sessionId,
          input.platform,
          policy.canonicalCwd,
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
    token: string;
    sessionId: string;
    platform: string;
    now: number;
  }): AuthorizedWorkflowRequest | null {
    const authorize = this.db.transaction((): AuthorizedWorkflowRequest | null => {
      const raw = this.db
        .query<z.infer<typeof requestDispatchRowSchema>, [string, string, string, string, number]>(
          `SELECT * FROM workflow_request_dispatches
         WHERE request_id = ? AND token_sha256 = ? AND session_id = ? AND platform = ?
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
        .get(input.requestId, sha256(input.token), input.sessionId, input.platform, input.now);
      if (!raw) return null;
      const row = requestDispatchRowSchema.parse(raw);
      const policy = workflowRequestPolicySchema.parse(
        parseJson(row.policy_json, "workflow_request_dispatches.policy_json"),
      );
      const run = this.getRun(row.run_id);
      const operation = this.getOperation(row.run_id, row.operation_id);
      const revision = run ? this.getRevision(run.revisionId) : null;
      const approval = run?.approvalId ? this.getApproval(run.approvalId) : null;
      if (
        !run ||
        !operation ||
        !revision ||
        run.state !== "running" ||
        approval?.state !== "approved" ||
        approval.revisionId !== revision.revisionId ||
        operation.requestId !== input.requestId ||
        !["dispatched", "running"].includes(operation.state) ||
        row.dispatch_epoch !== policy.dispatchEpoch ||
        row.canonical_cwd !== policy.canonicalCwd ||
        policy.runId !== run.runId ||
        policy.operationId !== operation.operationId ||
        policy.revisionId !== revision.revisionId ||
        policy.canonicalProjectId !== revision.canonicalProjectId ||
        policy.canonicalWorkspaceRoot !== revision.canonicalWorkspaceRoot ||
        policy.sourceSha256 !== revision.sourceSha256 ||
        policy.inputSchemaSha256 !== revision.inputSchemaSha256 ||
        policy.capabilitySha256 !== revision.capabilitySha256 ||
        policy.argsSha256 !== run.argsSha256
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
        .query<{ dispatch_epoch: string }, [string, number, number]>(
          `SELECT dispatch_epoch FROM workflow_request_dispatches
           WHERE request_id = ? AND active = 1 AND expires_at > ?
             AND owner_id IS NOT NULL AND owner_heartbeat_at > ?`,
        )
        .get(input.requestId, input.now, staleBefore);
      return dispatch
        ? { status: "live" as const, dispatchEpoch: dispatch.dispatch_epoch }
        : { status: "fresh" as const };
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
    token: string;
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
           WHERE request_id = ? AND token_sha256 = ? AND dispatch_epoch = ?
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
          sha256(input.token),
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
    maxActiveScheduledRuns: number;
    now: number;
  }):
    | { status: "fired"; trigger: WorkflowTrigger; run: WorkflowRun; approval: WorkflowApproval }
    | { status: "skipped"; trigger: WorkflowTrigger }
    | null {
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

      const activeTriggerRuns = this.countActiveScheduledRuns(trigger.triggerId);
      const activeScheduledRuns = this.countActiveScheduledRuns();
      if (
        (trigger.schedulingPolicy.overlap === "coalesce" && activeTriggerRuns > 0) ||
        activeScheduledRuns >= input.maxActiveScheduledRuns
      ) {
        const retryAt =
          trigger.definition.kind === "timestamp" && input.nextFireAt === null
            ? input.expectedFireAt
            : input.nextFireAt;
        const skipped = this.db
          .query(
            `UPDATE workflow_triggers SET next_fire_at = ?, last_fire_at = ?,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
             WHERE trigger_id = ? AND claimed_by = ? AND next_fire_at = ?`,
          )
          .run(
            retryAt,
            input.expectedFireAt,
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

      let approval = this.getActiveApprovalForPrincipal(
        trigger.revisionId,
        pendingApproval.expectedReviewerPlatform,
        pendingApproval.expectedReviewerUserId,
      );
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
      return { status: "fired" as const, trigger: storedTrigger, run, approval };
    });
    return fire.immediate();
  }

  deleteTrigger(triggerId: string): boolean {
    return (
      this.db.query("DELETE FROM workflow_triggers WHERE trigger_id = ?").run(triggerId).changes ===
      1
    );
  }

  countActiveScheduledRuns(triggerId?: string): number {
    const row = triggerId
      ? this.db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM workflow_trigger_runs
             JOIN workflow_runs ON workflow_runs.run_id = workflow_trigger_runs.run_id
             WHERE workflow_trigger_runs.trigger_id = ?
               AND workflow_runs.state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
          )
          .get(triggerId)
      : this.db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM workflow_trigger_runs
             JOIN workflow_runs ON workflow_runs.run_id = workflow_trigger_runs.run_id
             WHERE workflow_runs.state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
          )
          .get();
    return row?.count ?? 0;
  }

  claimSurfaceProjection(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    now: number;
    staleBefore: number;
  }): boolean {
    const claim = this.db.transaction(() => {
      const previous = this.db
        .query<{ owner_id: string; claim_token: string }, [string]>(
          `SELECT owner_id, claim_token FROM workflow_surface_projection_claims
           WHERE run_id = ?`,
        )
        .get(input.runId);
      const changed = this.db
        .query(
          `INSERT INTO workflow_surface_projection_claims (
             run_id, owner_id, claim_token, claimed_at
           ) SELECT ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM workflow_runs WHERE run_id = ?
           )
           ON CONFLICT(run_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             claim_token = excluded.claim_token,
             claimed_at = excluded.claimed_at
           WHERE workflow_surface_projection_claims.claimed_at <= ?`,
        )
        .run(
          input.runId,
          input.ownerId,
          input.claimToken,
          input.now,
          input.runId,
          input.staleBefore,
        ).changes;
      if (changed !== 1) return false;
      if (
        previous &&
        (previous.owner_id !== input.ownerId || previous.claim_token !== input.claimToken)
      ) {
        this.db.run(
          `UPDATE workflow_surface_bindings
           SET repair_required = 1, repair_generation = repair_generation + 1,
             last_rendered_sha256 = NULL,
             last_error = 'Projection ownership changed after a stale claim',
             next_attempt_at = CASE
               WHEN next_attempt_at IS NULL OR next_attempt_at > ? THEN ?
               ELSE next_attempt_at
             END,
             updated_at = MAX(updated_at, ?)
           WHERE run_id = ?`,
          [input.now, input.now, input.now, input.runId],
        );
        this.db.run(
          `UPDATE workflow_surface_actions SET expires_at = MIN(expires_at, ?)
           WHERE run_id = ? AND consumed_at IS NULL`,
          [input.now, input.runId],
        );
      }
      return true;
    });
    return claim.immediate();
  }

  refreshSurfaceProjectionClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    now: number;
  }): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_surface_projection_claims SET claimed_at = ?
           WHERE run_id = ? AND owner_id = ? AND claim_token = ?`,
        )
        .run(input.now, input.runId, input.ownerId, input.claimToken).changes === 1
    );
  }

  releaseSurfaceProjectionClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
  }): void {
    this.db.run(
      `DELETE FROM workflow_surface_projection_claims
       WHERE run_id = ? AND owner_id = ? AND claim_token = ?`,
      [input.runId, input.ownerId, input.claimToken],
    );
  }

  private ownsSurfaceProjectionClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
  }): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM workflow_surface_projection_claims
           WHERE run_id = ? AND owner_id = ? AND claim_token = ?`,
        )
        .get(input.runId, input.ownerId, input.claimToken),
    );
  }

  upsertSurfaceBindingFenced(
    bindingInput: WorkflowSurfaceBinding,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    const binding = workflowSurfaceBindingSchema.parse(bindingInput);
    const update = this.db.transaction(() => {
      if (!this.ownsSurfaceProjectionClaim({ runId: binding.runId, ...claim })) return false;
      this.upsertSurfaceBinding(binding);
      return true;
    });
    return update.immediate();
  }

  commitSurfaceProjectionFenced(input: {
    binding: WorkflowSurfaceBinding;
    actionIds: readonly string[];
    ownerId: string;
    claimToken: string;
    expectedRepairGeneration: number;
  }): boolean {
    const binding = workflowSurfaceBindingSchema.parse(input.binding);
    const commit = this.db.transaction(() => {
      if (
        !this.ownsSurfaceProjectionClaim({
          runId: binding.runId,
          ownerId: input.ownerId,
          claimToken: input.claimToken,
        })
      ) {
        return false;
      }
      const updated = this.db
        .query(
          `UPDATE workflow_surface_bindings
           SET target_json = ?, message_ref_json = ?, last_rendered_sha256 = ?,
             last_error = ?, retry_count = ?, next_attempt_at = ?, repair_required = 0,
              rendered_repair_generation = ?, send_may_have_succeeded = ?,
              discovery_page = ?, discovery_before_message_id = ?,
              discovery_scanned_entries = ?, updated_at = ?
           WHERE run_id = ? AND repair_generation = ?`,
        )
        .run(
          JSON.stringify(binding.target),
          binding.messageRef === null ? null : JSON.stringify(binding.messageRef),
          binding.lastRenderedSha256,
          binding.lastError,
          binding.retryCount,
          binding.nextAttemptAt,
          input.expectedRepairGeneration,
          binding.sendMayHaveSucceeded ? 1 : 0,
          binding.discoveryCursor?.page ?? 1,
          binding.discoveryCursor?.beforeMessageId ?? null,
          binding.discoveryCursor?.scannedEntries ?? 0,
          binding.updatedAt,
          binding.runId,
          input.expectedRepairGeneration,
        );
      if (updated.changes !== 1) return false;
      if (binding.messageRef) {
        for (const actionId of input.actionIds) {
          this.db.run(
            `UPDATE workflow_surface_actions SET expected_message_ref_json = ?
             WHERE action_id = ? AND run_id = ? AND consumed_at IS NULL`,
            [JSON.stringify(binding.messageRef), actionId, binding.runId],
          );
        }
      }
      return true;
    });
    return commit.immediate();
  }

  upsertSurfaceBinding(bindingInput: WorkflowSurfaceBinding): void {
    const binding = workflowSurfaceBindingSchema.parse(bindingInput);
    this.db.run(
      `INSERT INTO workflow_surface_bindings (
        run_id, target_json, message_ref_json, last_rendered_sha256, last_error,
        retry_count, next_attempt_at, repair_required, repair_generation,
        rendered_repair_generation, send_may_have_succeeded, discovery_page,
        discovery_before_message_id, discovery_scanned_entries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        target_json = excluded.target_json,
        message_ref_json = excluded.message_ref_json,
        last_rendered_sha256 = excluded.last_rendered_sha256,
        last_error = excluded.last_error,
        retry_count = excluded.retry_count,
        next_attempt_at = excluded.next_attempt_at,
        send_may_have_succeeded = excluded.send_may_have_succeeded,
        discovery_page = excluded.discovery_page,
        discovery_before_message_id = excluded.discovery_before_message_id,
        discovery_scanned_entries = excluded.discovery_scanned_entries,
        updated_at = excluded.updated_at`,
      [
        binding.runId,
        JSON.stringify(binding.target),
        binding.messageRef === null ? null : JSON.stringify(binding.messageRef),
        binding.lastRenderedSha256,
        binding.lastError,
        binding.retryCount,
        binding.nextAttemptAt,
        binding.repairGeneration > binding.renderedRepairGeneration ? 1 : 0,
        binding.repairGeneration,
        binding.renderedRepairGeneration,
        binding.sendMayHaveSucceeded ? 1 : 0,
        binding.discoveryCursor?.page ?? 1,
        binding.discoveryCursor?.beforeMessageId ?? null,
        binding.discoveryCursor?.scannedEntries ?? 0,
        binding.createdAt,
        binding.updatedAt,
      ],
    );
  }

  requestSurfaceBindingRepair(runId: string, now: number): number | null {
    const mark = this.db.transaction(() => {
      const binding = this.db
        .query(
          `UPDATE workflow_surface_bindings
           SET repair_required = 1, repair_generation = repair_generation + 1,
             last_rendered_sha256 = NULL,
             last_error = 'Projection ownership changed during external I/O',
             next_attempt_at = CASE
               WHEN next_attempt_at IS NULL OR next_attempt_at > ? THEN ?
               ELSE next_attempt_at
             END,
             updated_at = MAX(updated_at, ?)
           WHERE run_id = ?`,
        )
        .run(now, now, now, runId);
      if (binding.changes !== 1) return null;
      this.db.run(
        `UPDATE workflow_surface_actions SET expires_at = MIN(expires_at, ?)
         WHERE run_id = ? AND consumed_at IS NULL`,
        [now, runId],
      );
      return (
        this.db
          .query<{ repair_generation: number }, [string]>(
            `SELECT repair_generation FROM workflow_surface_bindings WHERE run_id = ?`,
          )
          .get(runId)?.repair_generation ?? null
      );
    });
    return mark.immediate();
  }

  ensureSurfaceBindingRepair(runId: string, now: number): number | null {
    const mark = this.db.transaction(() => {
      const binding = this.db
        .query(
          `UPDATE workflow_surface_bindings
           SET repair_required = 1,
             repair_generation = CASE
               WHEN repair_generation = rendered_repair_generation THEN repair_generation + 1
               ELSE repair_generation
             END,
             last_rendered_sha256 = NULL,
             last_error = 'Remote projection generation does not match durable state',
             next_attempt_at = CASE
               WHEN next_attempt_at IS NULL OR next_attempt_at > ? THEN ?
               ELSE next_attempt_at
             END,
             updated_at = MAX(updated_at, ?)
           WHERE run_id = ?`,
        )
        .run(now, now, now, runId);
      if (binding.changes !== 1) return null;
      this.db.run(
        `UPDATE workflow_surface_actions SET expires_at = MIN(expires_at, ?)
         WHERE run_id = ? AND consumed_at IS NULL`,
        [now, runId],
      );
      return (
        this.db
          .query<{ repair_generation: number }, [string]>(
            `SELECT repair_generation FROM workflow_surface_bindings WHERE run_id = ?`,
          )
          .get(runId)?.repair_generation ?? null
      );
    });
    return mark.immediate();
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

  recordSurfaceProjectionOrphan(input: {
    runId: string;
    messageRef: WorkflowProjectionMsgRef;
    now: number;
  }): void {
    this.db.run(
      `INSERT INTO workflow_surface_projection_orphans (
         run_id, platform, channel_id, message_id, attempt_count, next_attempt_at,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)
       ON CONFLICT(platform, channel_id, message_id) DO UPDATE SET
         run_id = excluded.run_id,
         next_attempt_at = CASE
           WHEN workflow_surface_projection_orphans.next_attempt_at IS NULL
             OR workflow_surface_projection_orphans.next_attempt_at > excluded.next_attempt_at
           THEN excluded.next_attempt_at
           ELSE workflow_surface_projection_orphans.next_attempt_at
         END,
         updated_at = MAX(workflow_surface_projection_orphans.updated_at, excluded.updated_at)`,
      [
        input.runId,
        input.messageRef.platform,
        input.messageRef.channelId,
        input.messageRef.messageId,
        input.now,
        input.now,
        input.now,
      ],
    );
  }

  listPendingSurfaceProjectionOrphans(options?: {
    runId?: string;
    dueBefore?: number;
    limit?: number;
  }): WorkflowSurfaceProjectionOrphan[] {
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (options?.runId) {
      clauses.push("run_id = ?");
      bindings.push(options.runId);
    }
    if (options?.dueBefore !== undefined) {
      clauses.push("(next_attempt_at IS NULL OR next_attempt_at <= ?)");
      bindings.push(options.dueBefore);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query(
        `SELECT * FROM workflow_surface_projection_orphans ${where}
         ORDER BY updated_at, message_id LIMIT ?`,
      )
      .all(...bindings, boundedLimit(options?.limit))
      .map(parseProjectionOrphan);
  }

  completeSurfaceProjectionOrphan(messageRef: WorkflowProjectionMsgRef): boolean {
    return (
      this.db
        .query(
          `DELETE FROM workflow_surface_projection_orphans
           WHERE platform = ? AND channel_id = ? AND message_id = ?`,
        )
        .run(messageRef.platform, messageRef.channelId, messageRef.messageId).changes === 1
    );
  }

  recordSurfaceProjectionOrphanFailure(input: {
    messageRef: WorkflowProjectionMsgRef;
    error: string;
    now: number;
  }): void {
    this.db.run(
      `UPDATE workflow_surface_projection_orphans
       SET attempt_count = attempt_count + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE platform = ? AND channel_id = ? AND message_id = ?`,
      [
        input.now + 1_000,
        input.error.slice(0, 16_384),
        input.now,
        input.messageRef.platform,
        input.messageRef.channelId,
        input.messageRef.messageId,
      ],
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

  createSurfaceActionFenced(
    actionInput: WorkflowSurfaceAction,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    const action = workflowSurfaceActionSchema.parse(actionInput);
    const create = this.db.transaction(() => {
      if (!this.ownsSurfaceProjectionClaim({ runId: action.runId, ...claim })) return false;
      return this.createSurfaceAction(action);
    });
    return create.immediate();
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

  bindSurfaceActionsFenced(
    runId: string,
    actionIds: readonly string[],
    messageRef: NonNullable<WorkflowSurfaceAction["expectedMessageRef"]>,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    const bind = this.db.transaction(() => {
      if (!this.ownsSurfaceProjectionClaim({ runId, ...claim })) return false;
      this.bindSurfaceActions(actionIds, messageRef);
      return true;
    });
    return bind.immediate();
  }

  expireActiveSurfaceActions(runId: string, now: number): void {
    this.db.run(
      `UPDATE workflow_surface_actions SET expires_at = ?
       WHERE run_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      [now, runId, now],
    );
  }

  expireActiveSurfaceActionsFenced(
    runId: string,
    now: number,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    const expire = this.db.transaction(() => {
      if (!this.ownsSurfaceProjectionClaim({ runId, ...claim })) return false;
      this.expireActiveSurfaceActions(runId, now);
      return true;
    });
    return expire.immediate();
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
      const previousRunStates = new Map<string, WorkflowRunState>();
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
          .map((run) => {
            previousRunStates.set(run.runId, run.state);
            return run.runId;
          });
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
        previousRunStates.set(run.runId, run.state);
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
      }

      const consumed = this.db
        .query(
          `UPDATE workflow_surface_actions SET consumed_at = ?, consumed_by_platform = ?,
           consumed_by_user_id = ? WHERE action_id = ? AND consumed_at IS NULL`,
        )
        .run(input.now, input.platform, input.userId, action.actionId);
      if (consumed.changes !== 1) return { status: "consumed" };
      if (action.approvalId) {
        const approval = this.getApproval(action.approvalId);
        if (approval) {
          this.insertActionOutboxEntry({
            outboxId: `${action.actionId}:approval`,
            actionId: action.actionId,
            runId: action.runId,
            eventType: "evt.workflow.approval.changed",
            payload: {
              approvalId: approval.approvalId,
              revisionId: approval.revisionId,
              runId: action.runId,
              state: approval.state,
              previousState: "pending",
              ts: input.now,
            },
            now: input.now,
          });
        }
      }
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
      return { status: "applied", action, runIds, approvalId: action.approvalId };
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

  claimPendingActionOutboxEvents(input: {
    ownerId: string;
    claimToken: string;
    now: number;
    staleBefore: number;
    limit?: number;
  }): WorkflowActionOutboxEntry[] {
    const claim = this.db.transaction(() => {
      const candidates = this.db
        .query<{ outbox_id: string }, [number, number, number]>(
          `SELECT outbox_id FROM workflow_action_outbox
           WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (publish_claim_owner IS NULL OR publish_claimed_at <= ?)
           ORDER BY created_at, outbox_id LIMIT ?`,
        )
        .all(input.now, input.staleBefore, boundedLimit(input.limit));
      const claimed: WorkflowActionOutboxEntry[] = [];
      for (const candidate of candidates) {
        const changed = this.db
          .query(
            `UPDATE workflow_action_outbox SET publish_claim_owner = ?,
               publish_claim_token = ?, publish_claimed_at = ?, updated_at = ?
             WHERE outbox_id = ? AND published_at IS NULL
               AND (publish_claim_owner IS NULL OR publish_claimed_at <= ?)`,
          )
          .run(
            input.ownerId,
            input.claimToken,
            input.now,
            input.now,
            candidate.outbox_id,
            input.staleBefore,
          );
        if (changed.changes !== 1) continue;
        const row = this.db
          .query("SELECT * FROM workflow_action_outbox WHERE outbox_id = ?")
          .get(candidate.outbox_id);
        if (row) claimed.push(parseActionOutboxEntry(row));
      }
      return claimed;
    });
    return claim.immediate();
  }

  refreshActionOutboxPublishClaims(input: {
    ownerId: string;
    claimToken: string;
    now: number;
  }): number {
    return this.db
      .query(
        `UPDATE workflow_action_outbox SET publish_claimed_at = ?
         WHERE published_at IS NULL AND publish_claim_owner = ? AND publish_claim_token = ?`,
      )
      .run(input.now, input.ownerId, input.claimToken).changes;
  }

  markActionOutboxPublished(input: {
    outboxId: string;
    ownerId: string;
    claimToken: string;
    now: number;
  }): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_action_outbox SET published_at = ?, next_attempt_at = NULL,
             last_error = NULL, publish_claim_owner = NULL, publish_claim_token = NULL,
             publish_claimed_at = NULL, updated_at = ?
           WHERE outbox_id = ? AND published_at IS NULL AND publish_claim_owner = ?
             AND publish_claim_token = ?`,
        )
        .run(input.now, input.now, input.outboxId, input.ownerId, input.claimToken).changes === 1
    );
  }

  recordActionOutboxFailure(input: {
    outboxId: string;
    ownerId: string;
    claimToken: string;
    error: string;
    now: number;
  }): void {
    this.db.run(
      `UPDATE workflow_action_outbox SET attempt_count = attempt_count + 1,
         next_attempt_at = ?, last_error = ?, publish_claim_owner = NULL,
         publish_claim_token = NULL, publish_claimed_at = NULL, updated_at = ?
       WHERE outbox_id = ? AND published_at IS NULL AND publish_claim_owner = ?
         AND publish_claim_token = ?`,
      [
        input.now + 1_000,
        input.error.slice(0, 16_384),
        input.now,
        input.outboxId,
        input.ownerId,
        input.claimToken,
      ],
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

  claimPendingActionOutboxProjections(input: {
    ownerId: string;
    claimToken: string;
    now: number;
    staleBefore: number;
    limit?: number;
  }): WorkflowActionOutboxEntry[] {
    const claim = this.db.transaction(() => {
      const candidates = this.db
        .query<{ outbox_id: string }, [number, number]>(
          `SELECT outbox_id FROM workflow_action_outbox
           WHERE event_type = 'evt.workflow.progress.requested' AND projected_at IS NULL
             AND (project_claim_owner IS NULL OR project_claimed_at <= ?)
           ORDER BY created_at, outbox_id LIMIT ?`,
        )
        .all(input.staleBefore, boundedLimit(input.limit));
      const claimed: WorkflowActionOutboxEntry[] = [];
      for (const candidate of candidates) {
        const changed = this.db
          .query(
            `UPDATE workflow_action_outbox SET project_claim_owner = ?,
               project_claim_token = ?, project_claimed_at = ?, updated_at = ?
             WHERE outbox_id = ? AND projected_at IS NULL
               AND (project_claim_owner IS NULL OR project_claimed_at <= ?)`,
          )
          .run(
            input.ownerId,
            input.claimToken,
            input.now,
            input.now,
            candidate.outbox_id,
            input.staleBefore,
          );
        if (changed.changes !== 1) continue;
        const row = this.db
          .query("SELECT * FROM workflow_action_outbox WHERE outbox_id = ?")
          .get(candidate.outbox_id);
        if (row) claimed.push(parseActionOutboxEntry(row));
      }
      return claimed;
    });
    return claim.immediate();
  }

  refreshActionOutboxProjectionClaims(input: {
    ownerId: string;
    claimToken: string;
    now: number;
  }): number {
    return this.db
      .query(
        `UPDATE workflow_action_outbox SET project_claimed_at = ?
         WHERE projected_at IS NULL AND project_claim_owner = ? AND project_claim_token = ?`,
      )
      .run(input.now, input.ownerId, input.claimToken).changes;
  }

  markActionOutboxProjected(input: {
    outboxId: string;
    ownerId: string;
    claimToken: string;
    now: number;
  }): boolean {
    return (
      this.db
        .query(
          `UPDATE workflow_action_outbox SET projected_at = ?, project_claim_owner = NULL,
             project_claim_token = NULL, project_claimed_at = NULL, updated_at = ?
           WHERE outbox_id = ? AND projected_at IS NULL AND project_claim_owner = ?
             AND project_claim_token = ?`,
        )
        .run(input.now, input.now, input.outboxId, input.ownerId, input.claimToken).changes === 1
    );
  }

  releaseActionOutboxProjectionClaim(input: {
    outboxId: string;
    ownerId: string;
    claimToken: string;
  }): void {
    this.db.run(
      `UPDATE workflow_action_outbox SET project_claim_owner = NULL,
         project_claim_token = NULL, project_claimed_at = NULL
       WHERE outbox_id = ? AND projected_at IS NULL AND project_claim_owner = ?
         AND project_claim_token = ?`,
      [input.outboxId, input.ownerId, input.claimToken],
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
