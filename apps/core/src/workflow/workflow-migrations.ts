import type { Database } from "bun:sqlite";

import { WORKFLOW_MANUAL_RECONCILIATION_DETAIL } from "./workflow-domain";

export const WORKFLOW_SCHEMA_VERSION = 21;

type WorkflowMigration = {
  version: number;
  name: string;
  statements: readonly string[];
};

const PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE = `
  runtime_version <> 'lilac-workflow-js-v2'
  OR COALESCE(json_type(capabilities_json, '$.agents'), 'missing') <> 'object'
  OR COALESCE(json_type(capabilities_json, '$.agents.profiles'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.models'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.reasoning'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.allowedRoots'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.tools'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.executables'), 'missing') <> 'text'
  OR COALESCE(json_type(capabilities_json, '$.agents.editing'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.agents.delegation'), 'missing') NOT IN ('true', 'false')
  OR COALESCE(json_type(capabilities_json, '$.agents.maxConcurrent'), 'missing') <> 'integer'
  OR COALESCE(json_type(capabilities_json, '$.agents.maxTotal'), 'missing') <> 'integer'
  OR COALESCE(json_type(capabilities_json, '$.level2.callables'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.surfaces.origin'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.maxNestingDepth'), 'missing') <> 'integer'
  OR COALESCE(json_type(capabilities_json, '$.maxWallTimeMs'), 'missing') <> 'integer'
  OR COALESCE(json_type(capabilities_json, '$.operationIdleTimeoutMs'), 'missing') <> 'integer'
  OR COALESCE(json_type(capabilities_json, '$.waits'), 'missing') <> 'array'
  OR COALESCE(json_type(capabilities_json, '$.safety.originatingMode'), 'missing') <> 'text'
  OR COALESCE(json_type(capabilities_json, '$.safety.escalation'), 'missing') <> 'text'
`;

const WORKFLOW_MIGRATIONS: readonly WorkflowMigration[] = [
  {
    version: 1,
    name: "initial durable workflow schema",
    statements: [
      `CREATE TABLE workflow_revisions (
        revision_id TEXT PRIMARY KEY,
        canonical_project_id TEXT NOT NULL,
        canonical_workspace_root TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'personal')),
        normalized_path TEXT NOT NULL,
        name TEXT NOT NULL,
        snapshot_artifact_id TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        input_schema_sha256 TEXT NOT NULL,
        capability_sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        runtime_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (
          canonical_project_id, canonical_workspace_root, scope, normalized_path,
          source_sha256, input_schema_sha256, capability_sha256, runtime_version
        )
      )`,
      `CREATE TABLE workflow_approvals (
        approval_id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id),
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'revoked', 'expired')),
        expected_reviewer_platform TEXT,
        expected_reviewer_user_id TEXT,
        first_run_id TEXT NOT NULL,
        decision_actor_platform TEXT,
        decision_actor_user_id TEXT,
        decision_source TEXT,
        expires_at INTEGER,
        decided_at INTEGER,
        revoked_at INTEGER,
        revocation_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_workflow_approvals_active_revision
        ON workflow_approvals(revision_id)
        WHERE state IN ('pending', 'approved')`,
      `CREATE INDEX idx_workflow_approvals_revision_state
        ON workflow_approvals(revision_id, state, updated_at DESC)`,
      `CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id),
        approval_id TEXT REFERENCES workflow_approvals(approval_id),
        state TEXT NOT NULL CHECK (state IN (
          'awaiting_review', 'queued', 'running', 'blocked', 'paused',
          'succeeded', 'failed', 'rejected', 'cancelled'
        )),
        input_schema_json TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_sha256 TEXT NOT NULL,
        origin_request_id TEXT,
        origin_session_id TEXT,
        origin_client TEXT,
        origin_user_id TEXT,
        origin_safety_mode TEXT NOT NULL,
        origin_project_cwd TEXT NOT NULL,
        completion_target_json TEXT NOT NULL,
        progress_target_json TEXT,
        terminal_detail TEXT,
        result_json TEXT,
        result_artifact_id TEXT,
        claimed_by TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER
      )`,
      `CREATE INDEX idx_workflow_runs_state_updated
        ON workflow_runs(state, updated_at, run_id)`,
      `CREATE INDEX idx_workflow_runs_revision_created
        ON workflow_runs(revision_id, created_at DESC)`,
      `CREATE INDEX idx_workflow_runs_approval_state
        ON workflow_runs(approval_id, state)`,
      `CREATE INDEX idx_workflow_runs_origin_session
        ON workflow_runs(origin_client, origin_session_id, created_at DESC)`,
      `CREATE TABLE workflow_operations (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        call_site_id TEXT NOT NULL,
        parent_operation_id TEXT,
        phase TEXT,
        label TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'parallel', 'pipeline', 'phase', 'wait')),
        input_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'dispatched', 'running', 'blocked', 'succeeded',
          'failed', 'cancelled', 'timed_out'
        )),
        attempt INTEGER NOT NULL,
        request_id TEXT,
        output_json TEXT,
        result_artifact_id TEXT,
        error TEXT,
        usage_json TEXT,
        claimed_by TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        PRIMARY KEY (run_id, operation_id),
        UNIQUE (run_id, call_site_id, operation_id)
      )`,
      `CREATE INDEX idx_workflow_operations_run_state
        ON workflow_operations(run_id, state, created_at)`,
      `CREATE INDEX idx_workflow_operations_claim
        ON workflow_operations(state, claimed_at, updated_at)`,
      `CREATE UNIQUE INDEX idx_workflow_operations_request
        ON workflow_operations(request_id) WHERE request_id IS NOT NULL`,
      `CREATE TABLE workflow_waits (
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'resolved', 'expired', 'cancelled')),
        match_kind TEXT NOT NULL CHECK (match_kind IN ('reply', 'sleep')),
        match_key TEXT NOT NULL,
        match_json TEXT NOT NULL,
        due_at INTEGER,
        deadline_at INTEGER,
        resolver_cursor TEXT,
        result_json TEXT,
        resolved_by TEXT,
        claimed_by TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (run_id, operation_id),
        FOREIGN KEY (run_id, operation_id)
          REFERENCES workflow_operations(run_id, operation_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX idx_workflow_waits_match
        ON workflow_waits(match_kind, match_key, state)`,
      `CREATE INDEX idx_workflow_waits_due
        ON workflow_waits(state, due_at, deadline_at)`,
      `CREATE TABLE workflow_triggers (
        trigger_id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id),
        state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'cancelled')),
        kind TEXT NOT NULL CHECK (kind IN ('immediate', 'timestamp', 'cron', 'reply')),
        definition_json TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_sha256 TEXT NOT NULL,
        scheduling_policy_json TEXT NOT NULL,
        progress_target_json TEXT,
        next_fire_at INTEGER,
        last_fire_at INTEGER,
        last_run_id TEXT REFERENCES workflow_runs(run_id),
        claimed_by TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_triggers_due
        ON workflow_triggers(state, next_fire_at, claimed_at)`,
      `CREATE INDEX idx_workflow_triggers_revision
        ON workflow_triggers(revision_id, state)`,
      `CREATE TABLE workflow_surface_bindings (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        target_json TEXT NOT NULL,
        message_ref_json TEXT,
        last_rendered_sha256 TEXT,
        last_error TEXT,
        retry_count INTEGER NOT NULL,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_surface_bindings_retry
        ON workflow_surface_bindings(next_attempt_at)
        WHERE next_attempt_at IS NOT NULL`,
      `CREATE TABLE workflow_surface_actions (
        action_id TEXT PRIMARY KEY,
        token_sha256 TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        approval_id TEXT REFERENCES workflow_approvals(approval_id),
        kind TEXT NOT NULL CHECK (kind IN ('approve', 'reject', 'pause', 'resume', 'cancel')),
        expected_platform TEXT NOT NULL,
        expected_user_id TEXT NOT NULL,
        expected_message_ref_json TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by_platform TEXT,
        consumed_by_user_id TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_surface_actions_run_active
        ON workflow_surface_actions(run_id, expires_at)
        WHERE consumed_at IS NULL`,
    ],
  },
  {
    version: 2,
    name: "durable waits and trigger invocation context",
    statements: [
      `ALTER TABLE workflow_triggers ADD COLUMN origin_json TEXT`,
      `ALTER TABLE workflow_triggers ADD COLUMN completion_target_json TEXT`,
      `CREATE TABLE workflow_adapter_event_suppressions (
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (platform, channel_id, message_id)
      )`,
      `CREATE INDEX idx_workflow_adapter_event_suppressions_expiry
        ON workflow_adapter_event_suppressions(expires_at)`,
    ],
  },
  {
    version: 3,
    name: "durable live-parent completion delivery",
    statements: [
      `CREATE TABLE workflow_completion_deliveries (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        parent_request_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'fallback')),
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_completion_deliveries_parent_state
        ON workflow_completion_deliveries(parent_request_id, state, created_at, run_id)`,
      `CREATE TRIGGER workflow_completion_delivery_after_run_insert
        AFTER INSERT ON workflow_runs
        WHEN json_extract(NEW.completion_target_json, '$.kind') = 'live_parent'
        BEGIN
          INSERT INTO workflow_completion_deliveries (
            run_id, parent_request_id, state, delivered_at, created_at, updated_at
          ) VALUES (
            NEW.run_id,
            json_extract(NEW.completion_target_json, '$.parentRequestId'),
            'pending',
            NULL,
            NEW.created_at,
            NEW.created_at
          );
        END`,
    ],
  },
  {
    version: 4,
    name: "workflow authority and incremental hardening",
    statements: [
      `UPDATE workflow_triggers
       SET origin_json = json_object(
         'requestId', NULL,
         'sessionId', NULL,
         'client', NULL,
         'userId', NULL,
         'safetyMode', 'restricted',
         'projectCwd', '/quarantined-workflow-trigger'
       )
       WHERE origin_json IS NULL`,
      `UPDATE workflow_triggers
       SET completion_target_json = json_object('kind', 'detached')
       WHERE completion_target_json IS NULL`,
      `DROP TRIGGER workflow_completion_delivery_after_run_insert`,
      `CREATE TRIGGER workflow_completion_delivery_after_run_insert
        AFTER INSERT ON workflow_runs
        WHEN json_extract(NEW.completion_target_json, '$.kind') = 'live_parent'
          AND COALESCE(json_extract(NEW.completion_target_json, '$.deferredDelivery'), 1) = 1
        BEGIN
          INSERT INTO workflow_completion_deliveries (
            run_id, parent_request_id, state, delivered_at, created_at, updated_at
          ) VALUES (
            NEW.run_id,
            json_extract(NEW.completion_target_json, '$.parentRequestId'),
            'pending',
            NULL,
            NEW.created_at,
            NEW.created_at
          );
        END`,
      `INSERT OR IGNORE INTO workflow_completion_deliveries (
         run_id, parent_request_id, state, delivered_at, created_at, updated_at
       )
       SELECT run_id, json_extract(completion_target_json, '$.parentRequestId'),
         'pending', NULL, created_at, updated_at
       FROM workflow_runs
       WHERE json_extract(completion_target_json, '$.kind') = 'live_parent'
         AND COALESCE(json_extract(completion_target_json, '$.deferredDelivery'), 1) = 1`,
      `DROP INDEX idx_workflow_approvals_active_revision`,
      `CREATE UNIQUE INDEX idx_workflow_approvals_active_revision_principal
        ON workflow_approvals(
          revision_id,
          COALESCE(expected_reviewer_platform, ''),
          COALESCE(expected_reviewer_user_id, '')
        ) WHERE state IN ('pending', 'approved')`,
      `CREATE TABLE workflow_request_dispatches (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        token_sha256 TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        canonical_cwd TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        owner_id TEXT,
        owner_heartbeat_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, operation_id),
        FOREIGN KEY (run_id, operation_id)
          REFERENCES workflow_operations(run_id, operation_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX idx_workflow_request_dispatches_active
        ON workflow_request_dispatches(active, owner_heartbeat_at, expires_at)`,
      `CREATE TABLE workflow_invocation_receipts (
        idempotency_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        fingerprint_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE workflow_quarantine (
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL,
        PRIMARY KEY (record_kind, record_id)
      )`,
    ],
  },
  {
    version: 5,
    name: "scheduled run admission tracking",
    statements: [
      `CREATE TABLE workflow_trigger_runs (
        trigger_id TEXT NOT NULL REFERENCES workflow_triggers(trigger_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (trigger_id, run_id)
      )`,
      `CREATE INDEX idx_workflow_trigger_runs_trigger_created
        ON workflow_trigger_runs(trigger_id, created_at DESC)`,
      `INSERT OR IGNORE INTO workflow_trigger_runs (trigger_id, run_id, created_at)
       SELECT workflow_triggers.trigger_id, workflow_runs.run_id, workflow_runs.created_at
       FROM workflow_triggers
       JOIN workflow_runs ON workflow_runs.run_id = workflow_triggers.last_run_id`,
    ],
  },
  {
    version: 6,
    name: "round 2 trigger and delivery durability",
    statements: [
      `CREATE TABLE workflow_trigger_invocation_receipts (
        idempotency_key TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL UNIQUE REFERENCES workflow_triggers(trigger_id) ON DELETE CASCADE,
        fingerprint_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `DROP TRIGGER workflow_completion_delivery_after_run_insert`,
      `CREATE TRIGGER workflow_completion_delivery_after_run_insert
        AFTER INSERT ON workflow_runs
        WHEN json_extract(NEW.completion_target_json, '$.kind') = 'live_parent'
        BEGIN
          INSERT INTO workflow_completion_deliveries (
            run_id, parent_request_id, state, delivered_at, created_at, updated_at
          ) VALUES (
            NEW.run_id,
            json_extract(NEW.completion_target_json, '$.parentRequestId'),
            'pending',
            NULL,
            NEW.created_at,
            NEW.created_at
          );
        END`,
      `INSERT OR IGNORE INTO workflow_completion_deliveries (
         run_id, parent_request_id, state, delivered_at, created_at, updated_at
       )
       SELECT run_id, json_extract(completion_target_json, '$.parentRequestId'),
         'pending', NULL, created_at, updated_at
       FROM workflow_runs
       WHERE json_extract(completion_target_json, '$.kind') = 'live_parent'`,
    ],
  },
  {
    version: 7,
    name: "round 4 request and adapter stream linearization",
    statements: [
      `ALTER TABLE workflow_request_dispatches ADD COLUMN prompt_published_at INTEGER`,
      `ALTER TABLE workflow_request_dispatches ADD COLUMN dispatch_epoch TEXT`,
      `UPDATE workflow_request_dispatches SET dispatch_epoch = lower(hex(randomblob(16)))
       WHERE dispatch_epoch IS NULL`,
      `CREATE TABLE workflow_request_terminal_receipts (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        dispatch_epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('resolved', 'failed', 'cancelled')),
        detail TEXT,
        created_at INTEGER NOT NULL
      )`,
      `ALTER TABLE workflow_waits ADD COLUMN expiry_cutoff_cursor TEXT`,
      `CREATE TABLE workflow_adapter_stream_watermarks (
        topic TEXT PRIMARY KEY,
        processed_cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `UPDATE workflow_request_dispatches
       SET policy_json = json_set(
         policy_json,
         '$.isolation',
         CASE
           WHEN json_extract(policy_json, '$.editing') = 1
             AND canonical_cwd <> json_extract(policy_json, '$.canonicalWorkspaceRoot')
           THEN 'worktree'
           ELSE 'shared'
         END
       )
       WHERE json_type(policy_json, '$.isolation') IS NULL`,
      `UPDATE workflow_request_dispatches
       SET policy_json = json_set(policy_json, '$.dispatchEpoch', dispatch_epoch)
       WHERE json_type(policy_json, '$.dispatchEpoch') IS NULL`,
    ],
  },
  {
    version: 8,
    name: "round 5 terminal adoption and durable workflow actions",
    statements: [
      `ALTER TABLE workflow_request_terminal_receipts ADD COLUMN output_json TEXT`,
      `ALTER TABLE workflow_request_terminal_receipts ADD COLUMN result_artifact_id TEXT`,
      `ALTER TABLE workflow_request_terminal_receipts ADD COLUMN usage_json TEXT`,
      `ALTER TABLE workflow_waits ADD COLUMN expiry_barrier_id TEXT`,
      `ALTER TABLE workflow_waits ADD COLUMN expiry_barrier_cursor TEXT`,
      `ALTER TABLE workflow_waits ADD COLUMN expiry_barrier_requested_at INTEGER`,
      `ALTER TABLE workflow_waits ADD COLUMN expiry_barrier_processed_at INTEGER`,
      `CREATE INDEX idx_workflow_waits_expiry_barrier
         ON workflow_waits(expiry_barrier_id)
         WHERE expiry_barrier_id IS NOT NULL`,
      `CREATE TABLE workflow_wait_resolver_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL
      )`,
      `CREATE TABLE workflow_action_outbox (
        outbox_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        published_at INTEGER,
        projected_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_action_outbox_publish
         ON workflow_action_outbox(published_at, next_attempt_at, created_at)`,
      `CREATE INDEX idx_workflow_action_outbox_project
         ON workflow_action_outbox(projected_at, event_type, created_at)`,
    ],
  },
  {
    version: 9,
    name: "round 6 recoverable streams and fenced projection",
    statements: [
      `CREATE TABLE workflow_request_terminal_receipt_quarantine (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        dispatch_epoch TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        quarantine_reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL
      )`,
      `INSERT INTO workflow_request_terminal_receipt_quarantine (
         request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
         quarantine_reason, quarantined_at
       )
       SELECT request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
         'legacy_resolved_receipt_missing_payload', created_at
       FROM workflow_request_terminal_receipts
       WHERE state = 'resolved' AND output_json IS NULL AND result_artifact_id IS NULL`,
      `DELETE FROM workflow_request_terminal_receipts
       WHERE state = 'resolved' AND output_json IS NULL AND result_artifact_id IS NULL`,
      `CREATE TABLE workflow_wait_resolver_checkpoints (
        topic TEXT PRIMARY KEY,
        processed_cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN publish_claim_owner TEXT`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN publish_claim_token TEXT`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN publish_claimed_at INTEGER`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN project_claim_owner TEXT`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN project_claim_token TEXT`,
      `ALTER TABLE workflow_action_outbox ADD COLUMN project_claimed_at INTEGER`,
      `CREATE TABLE workflow_surface_projection_claims (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 10,
    name: "round 7 blocking legacy receipt quarantine",
    statements: [
      `UPDATE workflow_operations
       SET state = 'blocked', error = 'Manual reconciliation required: ambiguous legacy terminal receipt',
         claimed_by = NULL, claimed_at = NULL,
         updated_at = MAX(updated_at, COALESCE((
           SELECT MAX(quarantine.quarantined_at)
           FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_operations.run_id
             AND quarantine.operation_id = workflow_operations.operation_id
         ), updated_at))
       WHERE state IN ('queued', 'dispatched', 'running', 'blocked')
         AND EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_operations.run_id
             AND quarantine.operation_id = workflow_operations.operation_id
         )`,
      `UPDATE workflow_request_dispatches
       SET active = 0,
         expires_at = MIN(expires_at, COALESCE((
           SELECT MAX(quarantine.quarantined_at)
           FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_request_dispatches.run_id
             AND quarantine.operation_id = workflow_request_dispatches.operation_id
         ), expires_at)),
         updated_at = MAX(updated_at, COALESCE((
           SELECT MAX(quarantine.quarantined_at)
           FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_request_dispatches.run_id
             AND quarantine.operation_id = workflow_request_dispatches.operation_id
         ), updated_at))
       WHERE active = 1 AND EXISTS (
         SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
         WHERE quarantine.run_id = workflow_request_dispatches.run_id
           AND quarantine.operation_id = workflow_request_dispatches.operation_id
       )`,
      `UPDATE workflow_runs
       SET state = 'paused',
         terminal_detail = 'Manual reconciliation required: ambiguous legacy terminal receipt',
         claimed_by = NULL, claimed_at = NULL,
         updated_at = MAX(updated_at, COALESCE((
           SELECT MAX(quarantine.quarantined_at)
           FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_runs.run_id
         ), updated_at))
       WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
         AND EXISTS (
           SELECT 1 FROM workflow_request_terminal_receipt_quarantine quarantine
           WHERE quarantine.run_id = workflow_runs.run_id
      )`,
    ],
  },
  {
    version: 11,
    name: "round 8 projection repair marker",
    statements: [
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN repair_required INTEGER NOT NULL DEFAULT 0 CHECK (repair_required IN (0, 1))`,
    ],
  },
  {
    version: 12,
    name: "round 9 generational projection repair",
    statements: [
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN repair_generation INTEGER NOT NULL DEFAULT 0 CHECK (repair_generation >= 0)`,
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN rendered_repair_generation INTEGER NOT NULL DEFAULT 0
       CHECK (rendered_repair_generation >= 0)`,
      `UPDATE workflow_surface_bindings
       SET repair_generation = CASE WHEN repair_required = 1 THEN 1 ELSE 0 END,
         rendered_repair_generation = 0`,
      `CREATE TABLE workflow_surface_projection_orphans (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, channel_id, message_id)
      )`,
      `CREATE INDEX idx_workflow_surface_projection_orphans_retry
       ON workflow_surface_projection_orphans(next_attempt_at, updated_at)`,
    ],
  },
  {
    version: 13,
    name: "round 12 incremental projection discovery",
    statements: [
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN send_may_have_succeeded INTEGER NOT NULL DEFAULT 0
       CHECK (send_may_have_succeeded IN (0, 1))`,
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN discovery_page INTEGER NOT NULL DEFAULT 1 CHECK (discovery_page >= 1)`,
      `ALTER TABLE workflow_surface_bindings ADD COLUMN discovery_before_message_id TEXT`,
      `ALTER TABLE workflow_surface_bindings
       ADD COLUMN discovery_scanned_entries INTEGER NOT NULL DEFAULT 0
       CHECK (discovery_scanned_entries >= 0)`,
      `UPDATE workflow_surface_bindings SET send_may_have_succeeded = 1
       WHERE message_ref_json IS NULL`,
    ],
  },
  {
    version: 14,
    name: "round 15 canonical manual reconciliation state",
    statements: [
      `UPDATE workflow_operations SET error = '${WORKFLOW_MANUAL_RECONCILIATION_DETAIL}'
       WHERE error IN (
         'Manual reconciliation required: ambiguous legacy terminal receipt',
         'Manual reconciliation required: paused request has a cancelled terminal receipt; cancel this run and create a new run',
         'Manual reconciliation required: terminal request lifecycle could not be reconciled with its exact durable receipt; cancel this run and create a new run'
       )`,
      `UPDATE workflow_runs SET terminal_detail = '${WORKFLOW_MANUAL_RECONCILIATION_DETAIL}'
       WHERE terminal_detail IN (
         'Manual reconciliation required: ambiguous legacy terminal receipt',
         'Manual reconciliation required: paused request has a cancelled terminal receipt; cancel this run and create a new run',
         'Manual reconciliation required: terminal request lifecycle could not be reconciled with its exact durable receipt; cancel this run and create a new run'
       )`,
    ],
  },
  {
    version: 15,
    name: "backfill workflow dispatch origin principal",
    statements: [
      `UPDATE workflow_request_dispatches
       SET policy_json = json_set(
         policy_json,
         '$.originUserId',
         (
           SELECT workflow_runs.origin_user_id
           FROM workflow_runs
           WHERE workflow_runs.run_id = workflow_request_dispatches.run_id
         )
       )
       WHERE active = 1
         AND json_type(policy_json, '$.originUserId') IS NULL
         AND EXISTS (
           SELECT 1 FROM workflow_runs
           WHERE workflow_runs.run_id = workflow_request_dispatches.run_id
      )`,
    ],
  },
  {
    version: 16,
    name: "bounded missing surface binding reconciliation",
    statements: [
      `CREATE TABLE workflow_missing_surface_bindings (
        run_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_missing_surface_bindings_created
       ON workflow_missing_surface_bindings(created_at, run_id)`,
      `INSERT INTO workflow_missing_surface_bindings (run_id, created_at)
       SELECT workflow_runs.run_id, workflow_runs.created_at
       FROM workflow_runs
       LEFT JOIN workflow_surface_bindings
         ON workflow_surface_bindings.run_id = workflow_runs.run_id
       WHERE workflow_runs.progress_target_json IS NOT NULL
         AND workflow_surface_bindings.run_id IS NULL`,
      `CREATE TRIGGER workflow_missing_surface_binding_after_run_insert
       AFTER INSERT ON workflow_runs
       WHEN NEW.progress_target_json IS NOT NULL
       BEGIN
         INSERT OR IGNORE INTO workflow_missing_surface_bindings (run_id, created_at)
         VALUES (NEW.run_id, NEW.created_at);
       END`,
      `CREATE TRIGGER workflow_missing_surface_binding_after_target_update
       AFTER UPDATE OF progress_target_json ON workflow_runs
       BEGIN
         DELETE FROM workflow_missing_surface_bindings WHERE run_id = NEW.run_id;
         INSERT OR IGNORE INTO workflow_missing_surface_bindings (run_id, created_at)
         SELECT NEW.run_id, NEW.created_at
         WHERE NEW.progress_target_json IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM workflow_surface_bindings WHERE run_id = NEW.run_id
           );
       END`,
      `CREATE TRIGGER workflow_missing_surface_binding_after_run_delete
       AFTER DELETE ON workflow_runs
       BEGIN
         DELETE FROM workflow_missing_surface_bindings WHERE run_id = OLD.run_id;
       END`,
      `CREATE TRIGGER workflow_missing_surface_binding_after_binding_insert
       AFTER INSERT ON workflow_surface_bindings
       BEGIN
         DELETE FROM workflow_missing_surface_bindings WHERE run_id = NEW.run_id;
       END`,
      `CREATE TRIGGER workflow_missing_surface_binding_after_binding_delete
       AFTER DELETE ON workflow_surface_bindings
       BEGIN
         INSERT OR IGNORE INTO workflow_missing_surface_bindings (run_id, created_at)
         SELECT workflow_runs.run_id, workflow_runs.created_at
         FROM workflow_runs
         WHERE workflow_runs.run_id = OLD.run_id
           AND workflow_runs.progress_target_json IS NOT NULL;
       END`,
      `CREATE TABLE workflow_projection_reconciliation_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor_created_at INTEGER NOT NULL,
        cursor_run_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 17,
    name: "durable isolated editing outputs",
    statements: [
      `CREATE TABLE workflow_worktree_outputs (
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'captured', 'cleaned', 'quarantined')),
        worktree_path TEXT NOT NULL,
        base_commit TEXT,
        artifact_id TEXT,
        patch_sha256 TEXT,
        bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
        cleanup_error TEXT,
        prepared_at INTEGER NOT NULL,
        captured_at INTEGER,
        cleaned_at INTEGER,
        PRIMARY KEY (run_id, operation_id),
        FOREIGN KEY (run_id, operation_id)
          REFERENCES workflow_operations(run_id, operation_id) ON DELETE CASCADE,
        CHECK (
          (state = 'quarantined' AND base_commit IS NULL AND artifact_id IS NULL
            AND patch_sha256 IS NULL AND bytes IS NULL AND captured_at IS NULL
            AND cleaned_at IS NULL AND cleanup_error IS NOT NULL) OR
          (state = 'prepared' AND base_commit IS NOT NULL
            AND artifact_id IS NULL AND patch_sha256 IS NULL
            AND bytes IS NULL AND captured_at IS NULL AND cleaned_at IS NULL) OR
          (state = 'captured' AND base_commit IS NOT NULL
            AND artifact_id IS NOT NULL AND patch_sha256 IS NOT NULL
            AND bytes IS NOT NULL AND captured_at IS NOT NULL AND cleaned_at IS NULL) OR
          (state = 'cleaned' AND base_commit IS NOT NULL
            AND artifact_id IS NOT NULL AND patch_sha256 IS NOT NULL
            AND bytes IS NOT NULL AND captured_at IS NOT NULL AND cleaned_at IS NOT NULL)
        )
      )`,
      `CREATE INDEX idx_workflow_worktree_outputs_cleanup
       ON workflow_worktree_outputs(state, captured_at, run_id, operation_id)`,
    ],
  },
  {
    version: 18,
    name: "maximum-envelope capability contract",
    statements: [
      `DELETE FROM workflow_triggers
       WHERE revision_id IN (
          SELECT revision_id FROM workflow_revisions
          WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
          )`,
      `DELETE FROM workflow_runs
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
          WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
       )`,
      `DELETE FROM workflow_approvals
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
          WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
       )`,
      `DELETE FROM workflow_revisions
       WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}`,
    ],
  },
  {
    version: 19,
    name: "complete envelope retirement and shared editor leases",
    statements: [
      `DELETE FROM workflow_triggers
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
        )`,
      `DELETE FROM workflow_runs
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
       )`,
      `DELETE FROM workflow_approvals
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}
       )`,
      `DELETE FROM workflow_revisions
       WHERE ${PRE_MAXIMUM_ENVELOPE_REVISION_PREDICATE}`,
      `CREATE TABLE workflow_shared_editor_leases (
        authority_root TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        FOREIGN KEY (run_id, operation_id)
          REFERENCES workflow_operations(run_id, operation_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX idx_workflow_shared_editor_leases_heartbeat
       ON workflow_shared_editor_leases(heartbeat_at)`,
    ],
  },
  {
    version: 20,
    name: "profile-native trusted auto-run clean break",
    statements: [
      `CREATE TABLE workflow_legacy_audit_records (
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (record_kind, record_id)
      )`,
      `INSERT OR IGNORE INTO workflow_legacy_audit_records (
         record_kind, record_id, reason, payload_json, archived_at
       )
       SELECT 'revision', revision_id, 'v19_maximum_envelope_incompatible_with_profile_native_policy',
         json_object(
           'revisionId', revision_id,
           'runtimeVersion', runtime_version,
           'sourceSha256', source_sha256,
           'inputSchemaSha256', input_schema_sha256,
           'capabilitySha256', capability_sha256,
           'snapshotArtifactId', snapshot_artifact_id,
           'createdAt', created_at
         ), created_at
       FROM workflow_revisions
       WHERE runtime_version <> 'lilac-workflow-js-v3'`,
      `INSERT OR IGNORE INTO workflow_legacy_audit_records (
         record_kind, record_id, reason, payload_json, archived_at
       )
       SELECT 'run', run_id,
         CASE WHEN state IN ('succeeded', 'failed', 'rejected', 'cancelled')
           THEN 'v19_terminal_audit_record_retired'
           ELSE 'v19_nonterminal_run_terminalized_for_profile_native_migration'
         END,
         json_object(
           'runId', run_id,
           'revisionId', revision_id,
           'state', state,
           'argsSha256', args_sha256,
           'originRequestId', origin_request_id,
           'originClient', origin_client,
           'originUserId', origin_user_id,
           'terminalDetail', terminal_detail,
           'createdAt', created_at,
           'terminalAt', terminal_at
         ), COALESCE(terminal_at, updated_at)
       FROM workflow_runs
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE runtime_version <> 'lilac-workflow-js-v3'
       )`,
      `INSERT OR IGNORE INTO workflow_legacy_audit_records (
         record_kind, record_id, reason, payload_json, archived_at
       )
       SELECT 'trigger', trigger_id,
         CASE WHEN state IN ('active', 'paused')
           THEN 'v19_active_trigger_cancelled_for_profile_native_migration'
           ELSE 'v19_terminal_trigger_retired'
         END,
         json_object(
           'triggerId', trigger_id,
           'revisionId', revision_id,
           'state', state,
           'argsSha256', args_sha256,
           'nextFireAt', next_fire_at,
           'lastRunId', last_run_id,
           'createdAt', created_at
         ), updated_at
       FROM workflow_triggers
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE runtime_version <> 'lilac-workflow-js-v3'
        )`,
      `INSERT OR IGNORE INTO workflow_legacy_audit_records (
         record_kind, record_id, reason, payload_json, archived_at
       )
       SELECT 'terminal_receipt', request_id,
         'v19_terminal_receipt_retired_with_legacy_run',
         json_object(
           'requestId', request_id,
           'runId', run_id,
           'operationId', operation_id,
           'dispatchEpoch', dispatch_epoch,
           'state', state,
           'detail', detail,
           'resultArtifactId', result_artifact_id,
           'createdAt', created_at
         ), created_at
       FROM workflow_request_terminal_receipts
       WHERE run_id IN (
         SELECT run_id FROM workflow_runs
         WHERE revision_id IN (
           SELECT revision_id FROM workflow_revisions
           WHERE runtime_version <> 'lilac-workflow-js-v3'
         )
       )`,
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'run', run_id,
         'v19_nonterminal_run_terminalized_for_profile_native_migration', updated_at
       FROM workflow_runs
       WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')
         AND revision_id IN (
           SELECT revision_id FROM workflow_revisions
           WHERE runtime_version <> 'lilac-workflow-js-v3'
         )`,
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'operation', run_id || ':' || operation_id,
         'v19_nonterminal_operation_cancelled_for_profile_native_migration', updated_at
       FROM workflow_operations
       WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')
         AND run_id IN (
           SELECT run_id FROM workflow_runs
           WHERE revision_id IN (
             SELECT revision_id FROM workflow_revisions
             WHERE runtime_version <> 'lilac-workflow-js-v3'
           )
         )`,
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'trigger', trigger_id,
         'v19_active_trigger_cancelled_for_profile_native_migration', updated_at
       FROM workflow_triggers
       WHERE state IN ('active', 'paused')
         AND revision_id IN (
           SELECT revision_id FROM workflow_revisions
           WHERE runtime_version <> 'lilac-workflow-js-v3'
         )`,
      `UPDATE workflow_request_dispatches
       SET active = 0, expires_at = MIN(expires_at, updated_at)
       WHERE active = 1 AND run_id IN (
         SELECT run_id FROM workflow_runs
         WHERE revision_id IN (
           SELECT revision_id FROM workflow_revisions
           WHERE runtime_version <> 'lilac-workflow-js-v3'
         )
       )`,
      `DELETE FROM workflow_triggers
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE runtime_version <> 'lilac-workflow-js-v3'
        )`,
      `DELETE FROM workflow_request_terminal_receipts
       WHERE run_id IN (
         SELECT run_id FROM workflow_runs
         WHERE revision_id IN (
           SELECT revision_id FROM workflow_revisions
           WHERE runtime_version <> 'lilac-workflow-js-v3'
         )
       )`,
      `DELETE FROM workflow_runs
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE runtime_version <> 'lilac-workflow-js-v3'
       )`,
      `DELETE FROM workflow_approvals
       WHERE revision_id IN (
         SELECT revision_id FROM workflow_revisions
         WHERE runtime_version <> 'lilac-workflow-js-v3'
       )`,
      `DELETE FROM workflow_revisions
       WHERE runtime_version <> 'lilac-workflow-js-v3'`,
      `DROP TABLE workflow_shared_editor_leases`,
    ],
  },
  {
    version: 21,
    name: "minimal durable dispatch contract",
    statements: [
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'run', run_id, 'v20_nonterminal_run_cancelled_for_minimal_dispatch_migration',
         updated_at
       FROM workflow_runs
       WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'operation', run_id || ':' || operation_id,
         'v20_nonterminal_operation_cancelled_for_minimal_dispatch_migration', updated_at
       FROM workflow_operations
       WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
      `INSERT OR IGNORE INTO workflow_quarantine (
         record_kind, record_id, reason, quarantined_at
       )
       SELECT 'trigger', trigger_id,
         'v20_active_trigger_cancelled_for_minimal_dispatch_migration', updated_at
       FROM workflow_triggers
       WHERE state IN ('active', 'paused')`,
      `UPDATE workflow_request_dispatches
       SET active = 0, expires_at = MIN(expires_at, updated_at), owner_id = NULL,
         owner_heartbeat_at = NULL
       WHERE active = 1`,
      `UPDATE workflow_waits
       SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL,
          resolved_at = COALESCE(resolved_at, updated_at)
       WHERE state IN ('pending', 'claimed')`,
      `UPDATE workflow_runs
       SET state = 'failed',
         terminal_detail = COALESCE(
           terminal_detail,
           'Rejected under the pre-v21 workflow approval model'
         )
       WHERE state = 'rejected'`,
      `UPDATE workflow_operations
       SET state = 'cancelled',
         error = 'Cancelled by schema v21 minimal durable dispatch migration',
         claimed_by = NULL, claimed_at = NULL, terminal_at = COALESCE(terminal_at, updated_at)
       WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
      `UPDATE workflow_runs
       SET state = 'cancelled',
         terminal_detail = 'Cancelled by schema v21 minimal durable dispatch migration',
         claimed_by = NULL, claimed_at = NULL, terminal_at = COALESCE(terminal_at, updated_at)
       WHERE state NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
      `UPDATE workflow_triggers
       SET state = 'cancelled', next_fire_at = NULL, claimed_by = NULL, claimed_at = NULL
       WHERE state IN ('active', 'paused')`,
      `UPDATE workflow_request_dispatches
       SET policy_json = json_object(
         'runId', run_id,
         'operationId', operation_id,
         'dispatchEpoch', dispatch_epoch,
         'profile', CASE WHEN json_valid(policy_json)
           THEN json_extract(policy_json, '$.profile') ELSE NULL END,
         'model', CASE WHEN json_valid(policy_json)
           THEN json_extract(policy_json, '$.model') ELSE NULL END,
         'reasoning', CASE WHEN json_valid(policy_json)
           THEN json_extract(policy_json, '$.reasoning') ELSE NULL END,
         'resolvedModelRequest', CASE WHEN json_valid(policy_json)
           THEN json_extract(policy_json, '$.resolvedModelRequest') ELSE NULL END,
         'cwd', CASE WHEN json_valid(policy_json)
           THEN json_extract(policy_json, '$.canonicalCwd') ELSE NULL END,
         'originSession', json_object(
           'requestId', (SELECT origin_request_id FROM workflow_runs WHERE run_id = workflow_request_dispatches.run_id),
           'sessionId', (SELECT origin_session_id FROM workflow_runs WHERE run_id = workflow_request_dispatches.run_id),
           'client', (SELECT origin_client FROM workflow_runs WHERE run_id = workflow_request_dispatches.run_id),
           'userId', (SELECT origin_user_id FROM workflow_runs WHERE run_id = workflow_request_dispatches.run_id)
         )
       )`,
      `UPDATE workflow_revisions
       SET capabilities_json = json_remove(capabilities_json, '$.safety'),
         limits_json = json_remove(limits_json, '$.maxRuntimeMemoryBytes')`,
      `UPDATE workflow_triggers SET origin_json = json_remove(origin_json, '$.safetyMode')`,
      `DROP INDEX idx_workflow_runs_approval_state`,
      `ALTER TABLE workflow_runs DROP COLUMN approval_id`,
      `ALTER TABLE workflow_runs DROP COLUMN origin_safety_mode`,
      `ALTER TABLE workflow_surface_actions DROP COLUMN approval_id`,
      `DROP TABLE workflow_approvals`,
      `CREATE TABLE workflow_request_dispatches_v21 (
         request_id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         operation_id TEXT NOT NULL,
         session_id TEXT NOT NULL,
         platform TEXT NOT NULL,
         policy_json TEXT NOT NULL,
         expires_at INTEGER NOT NULL,
         owner_id TEXT,
         owner_heartbeat_at INTEGER,
         active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         prompt_published_at INTEGER,
         dispatch_epoch TEXT NOT NULL,
         UNIQUE (run_id, operation_id),
         FOREIGN KEY (run_id, operation_id)
           REFERENCES workflow_operations(run_id, operation_id) ON DELETE CASCADE
       )`,
      `INSERT INTO workflow_request_dispatches_v21 (
         request_id, run_id, operation_id, session_id, platform, policy_json,
         expires_at, owner_id, owner_heartbeat_at, active, created_at, updated_at,
         prompt_published_at, dispatch_epoch
       )
       SELECT request_id, run_id, operation_id, session_id, platform, policy_json,
         expires_at, owner_id, owner_heartbeat_at, active, created_at, updated_at,
         prompt_published_at, dispatch_epoch
       FROM workflow_request_dispatches`,
      `DROP TABLE workflow_request_dispatches`,
      `ALTER TABLE workflow_request_dispatches_v21 RENAME TO workflow_request_dispatches`,
      `CREATE INDEX idx_workflow_request_dispatches_active
       ON workflow_request_dispatches(active, owner_heartbeat_at, expires_at)`,
      `DROP TABLE workflow_worktree_outputs`,
      `DROP TRIGGER IF EXISTS workflow_missing_surface_binding_after_run_insert`,
      `DROP TRIGGER IF EXISTS workflow_missing_surface_binding_after_target_update`,
      `DROP TRIGGER IF EXISTS workflow_missing_surface_binding_after_run_delete`,
      `DROP TRIGGER IF EXISTS workflow_missing_surface_binding_after_binding_insert`,
      `DROP TRIGGER IF EXISTS workflow_missing_surface_binding_after_binding_delete`,
      `CREATE TABLE workflow_surface_bindings_v21 (
         run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
         target_json TEXT NOT NULL,
         message_ref_json TEXT,
         last_rendered_sha256 TEXT,
         last_error TEXT,
         retry_count INTEGER NOT NULL,
         next_attempt_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `INSERT INTO workflow_surface_bindings_v21 (
         run_id, target_json, message_ref_json, last_rendered_sha256, last_error,
         retry_count, next_attempt_at, created_at, updated_at
       )
       SELECT run_id, target_json, message_ref_json, last_rendered_sha256, last_error,
         retry_count, next_attempt_at, created_at, updated_at
       FROM workflow_surface_bindings`,
      `DROP TABLE workflow_surface_bindings`,
      `ALTER TABLE workflow_surface_bindings_v21 RENAME TO workflow_surface_bindings`,
      `CREATE INDEX idx_workflow_surface_bindings_retry
       ON workflow_surface_bindings(next_attempt_at)
       WHERE next_attempt_at IS NOT NULL`,
      `DROP TABLE IF EXISTS workflow_surface_projection_claims`,
      `DROP TABLE IF EXISTS workflow_surface_projection_orphans`,
      `DROP TABLE IF EXISTS workflow_missing_surface_bindings`,
      `DROP TABLE IF EXISTS workflow_projection_reconciliation_state`,
      `CREATE TABLE workflow_action_outbox_v21 (
         outbox_id TEXT PRIMARY KEY,
         action_id TEXT NOT NULL,
         run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
         event_type TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         published_at INTEGER,
         projected_at INTEGER,
         attempt_count INTEGER NOT NULL DEFAULT 0,
         next_attempt_at INTEGER,
         last_error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `INSERT INTO workflow_action_outbox_v21 (
         outbox_id, action_id, run_id, event_type, payload_json, published_at,
         projected_at, attempt_count, next_attempt_at, last_error, created_at, updated_at
       )
       SELECT outbox_id, action_id, run_id, event_type, payload_json, published_at,
         projected_at, attempt_count, next_attempt_at, last_error, created_at, updated_at
       FROM workflow_action_outbox`,
      `DROP TABLE workflow_action_outbox`,
      `ALTER TABLE workflow_action_outbox_v21 RENAME TO workflow_action_outbox`,
      `CREATE INDEX idx_workflow_action_outbox_publish
       ON workflow_action_outbox(published_at, next_attempt_at, created_at)`,
      `CREATE INDEX idx_workflow_action_outbox_project
       ON workflow_action_outbox(projected_at, event_type, created_at)`,
    ],
  },
];

export function applyWorkflowSchemaMigrations(db: Database, now: () => number = Date.now): void {
  db.run(`CREATE TABLE IF NOT EXISTS workflow_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Map(
    db
      .query<{ version: number; name: string }, []>(
        "SELECT version, name FROM workflow_schema_migrations ORDER BY version",
      )
      .all()
      .map((row) => [row.version, row.name]),
  );
  const knownVersions = new Set(WORKFLOW_MIGRATIONS.map((migration) => migration.version));
  for (const version of applied.keys()) {
    if (!knownVersions.has(version)) {
      throw new Error(`Workflow database migration ${version} is newer than this runtime`);
    }
  }

  for (const migration of WORKFLOW_MIGRATIONS) {
    const appliedName = applied.get(migration.version);
    if (appliedName !== undefined) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Workflow migration ${migration.version} name mismatch: expected ${migration.name}, found ${appliedName}`,
        );
      }
      continue;
    }

    const migrate = db.transaction(() => {
      for (const statement of migration.statements) db.run(statement);
      db.run(
        "INSERT INTO workflow_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, now()],
      );
    });
    migrate.immediate();
  }
}
