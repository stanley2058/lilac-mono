import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowTrigger,
} from "../../src/workflow/workflow-domain";

function dbPath(label: string): string {
  return join(tmpdir(), `lilac-workflow-${label}-${crypto.randomUUID()}.sqlite`);
}

function revision(id = "revision-1"): WorkflowRevision {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 2, maxTotal: 8 },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10_000,
    waits: ["reply", "sleep"],
  });
  const limits = {
    maxSourceBytes: 10_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: 10_000,
    maxResultBytes: 10_000,
  };
  return {
    revisionId: id,
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifactId: `artifact-${id}`,
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "audit", description: "Audit the project" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: 10,
  };
}

function run(id = "run-1", revisionId = "revision-1"): WorkflowRun {
  return {
    runId: id,
    revisionId,
    state: "queued",
    inputSchemaSnapshot: { type: "object", additionalProperties: false },
    args: {},
    argsSha256: canonicalJsonSha256({}),
    origin: {
      requestId: "request-1",
      sessionId: "session-1",
      client: "discord",
      userId: "user-1",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "detached" },
    progressTarget: null,
    terminalDetail: null,
    result: null,
    resultArtifactId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 10,
    startedAt: null,
    updatedAt: 10,
    terminalAt: null,
  };
}

function operation(runId: string, operationId: string): WorkflowOperation {
  const input = { prompt: "inspect", options: { profile: "general", cwd: "/workspace" } };
  return {
    runId,
    operationId,
    callSiteId: `call-${operationId}`,
    parentOperationId: null,
    phase: null,
    label: null,
    kind: "agent",
    input,
    inputSha256: canonicalJsonSha256(input),
    state: "queued",
    attempt: 0,
    requestId: null,
    output: null,
    resultArtifactId: null,
    error: null,
    usage: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 11,
    startedAt: null,
    updatedAt: 11,
    terminalAt: null,
  };
}

function downgradeSchemaToV21(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("ALTER TABLE workflow_request_dispatches RENAME TO workflow_request_dispatches_v23");
  db.run(`CREATE TABLE workflow_request_dispatches (
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
    UNIQUE (run_id, operation_id)
  )`);
  db.run(`INSERT INTO workflow_request_dispatches (
    request_id, run_id, operation_id, session_id, platform, policy_json, expires_at,
    owner_id, owner_heartbeat_at, active, created_at, updated_at, prompt_published_at,
    dispatch_epoch
  ) SELECT request_id, run_id, operation_id, session_id, platform, policy_json,
    9007199254740991, owner_id, owner_heartbeat_at, active, created_at, updated_at,
    prompt_published_at, dispatch_epoch FROM workflow_request_dispatches_v23`);
  db.run("DROP TABLE workflow_request_dispatches_v23");
  db.run(`CREATE INDEX idx_workflow_request_dispatches_active
    ON workflow_request_dispatches(active, owner_heartbeat_at, expires_at)`);
  db.run("DROP TRIGGER workflow_completion_delivery_after_run_insert");
  db.run("ALTER TABLE workflow_completion_deliveries RENAME TO workflow_completion_deliveries_v22");
  db.run(`CREATE TABLE workflow_completion_deliveries (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    parent_request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'fallback')),
    delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO workflow_completion_deliveries (
    run_id, parent_request_id, state, delivered_at, created_at, updated_at
  ) SELECT run_id, parent_request_id, state, delivered_at, created_at, updated_at
    FROM workflow_completion_deliveries_v22`);
  db.run("DROP TABLE workflow_completion_deliveries_v22");
  db.run(`CREATE INDEX idx_workflow_completion_deliveries_parent_state
    ON workflow_completion_deliveries(parent_request_id, state, created_at, run_id)`);
  db.run(`CREATE TRIGGER workflow_completion_delivery_after_run_insert
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
    END`);
  db.run("DELETE FROM workflow_schema_migrations WHERE version >= 22");
}

function downgradeSchemaToV20(db: Database): void {
  downgradeSchemaToV21(db);
  db.run("DELETE FROM workflow_schema_migrations WHERE version = 21");
  db.run(`CREATE TABLE workflow_approvals (
    approval_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, state TEXT NOT NULL
  )`);
  db.run("ALTER TABLE workflow_runs ADD COLUMN approval_id TEXT");
  db.run("ALTER TABLE workflow_runs ADD COLUMN origin_safety_mode TEXT NOT NULL DEFAULT 'trusted'");
  db.run("CREATE INDEX idx_workflow_runs_approval_state ON workflow_runs(approval_id, state)");
  db.run("ALTER TABLE workflow_surface_actions ADD COLUMN approval_id TEXT");
  db.run("ALTER TABLE workflow_request_dispatches RENAME TO workflow_request_dispatches_v21");
  db.run(`CREATE TABLE workflow_request_dispatches (
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
    prompt_published_at INTEGER,
    dispatch_epoch TEXT,
    UNIQUE (run_id, operation_id)
  )`);
  db.run("DROP TABLE workflow_request_dispatches_v21");
  db.run(`CREATE TABLE workflow_worktree_outputs (
    run_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL,
    worktree_path TEXT NOT NULL, base_commit TEXT, artifact_id TEXT, patch_sha256 TEXT,
    bytes INTEGER, cleanup_error TEXT, prepared_at INTEGER NOT NULL, captured_at INTEGER,
    cleaned_at INTEGER, PRIMARY KEY (run_id, operation_id)
  )`);
  db.run(`UPDATE workflow_revisions SET
    capabilities_json = json_set(capabilities_json, '$.safety', json('{"originatingMode":"trusted","escalation":"none"}')),
    limits_json = json_set(limits_json, '$.maxRuntimeMemoryBytes', 268435456),
    runtime_version = 'lilac-workflow-js-v3'`);
}

describe("durable workflow store minimal dispatch schema", () => {
  it("bounds reconciliation to active runs and terminal runs missing bindings", () => {
    const file = dbPath("active-progress-targets");
    const store = new DurableWorkflowStore(file);
    const progressTarget = {
      platform: "discord" as const,
      channelId: "channel-1",
      replyToMessageId: null,
    };
    try {
      const rev = revision();
      store.createInvocation({
        revision: rev,
        run: { ...run("active-a"), progressTarget, updatedAt: 11 },
      });
      store.createRun({ ...run("active-b"), progressTarget, updatedAt: 12 });
      store.createRun({ ...run("terminal"), progressTarget, updatedAt: 9 });
      store.createRun({ ...run("without-target"), updatedAt: 8 });
      expect(
        store.transitionRun({
          runId: "terminal",
          from: "queued",
          to: "cancelled",
          now: 13,
        }),
      ).toBe(true);

      expect(store.listRunsNeedingProjectionReconciliation(1).map((item) => item.runId)).toEqual([
        "active-a",
      ]);
      expect(store.listRunsNeedingProjectionReconciliation().map((item) => item.runId)).toEqual([
        "active-a",
        "active-b",
        "terminal",
      ]);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });

  it("creates and claims queued invocations without approval or safety semantics", () => {
    const file = dbPath("minimal-dispatch");
    const store = new DurableWorkflowStore(file);
    try {
      const created = store.createInvocation({ revision: revision(), run: run() });
      expect(created).toMatchObject({ status: "accepted", run: { state: "queued" } });
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 })?.state).toBe(
        "running",
      );
      expect(store.listMigrations().at(-1)).toMatchObject({
        version: 23,
        name: "unbounded workflow v4 contract",
      });
    } finally {
      store.close();
    }

    const db = new Database(file);
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain("workflow_approvals");
      expect(tables).not.toContain("workflow_worktree_outputs");
      expect(tables).not.toContain("workflow_surface_projection_claims");
      expect(tables).not.toContain("workflow_surface_projection_orphans");
      expect(tables).not.toContain("workflow_missing_surface_bindings");
      expect(tables).not.toContain("workflow_projection_reconciliation_state");
      const runColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(workflow_runs)")
        .all()
        .map((row) => row.name);
      expect(runColumns).not.toContain("approval_id");
      expect(runColumns).not.toContain("origin_safety_mode");
      const dispatchColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(workflow_request_dispatches)")
        .all()
        .map((row) => row.name);
      expect(dispatchColumns).not.toContain("token_sha256");
      expect(dispatchColumns).not.toContain("canonical_cwd");
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(workflow_surface_bindings)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "run_id",
        "target_json",
        "message_ref_json",
        "last_rendered_sha256",
        "last_error",
        "retry_count",
        "next_attempt_at",
        "created_at",
        "updated_at",
      ]);
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(workflow_action_outbox)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "outbox_id",
        "action_id",
        "run_id",
        "event_type",
        "payload_json",
        "published_at",
        "projected_at",
        "attempt_count",
        "next_attempt_at",
        "last_error",
        "created_at",
        "updated_at",
      ]);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });

  it("atomically enforces the global active-run cap and admits after terminalization", () => {
    const file = dbPath("active-run-cap");
    const store = new DurableWorkflowStore(file);
    const rejectedRevision = {
      ...revision("revision-rejected"),
      normalizedPath: "rejected.js",
    };
    try {
      expect(
        store.createInvocation({
          revision: revision("revision-active"),
          run: run("run-active", "revision-active"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({ status: "accepted" });
      expect(store.countActiveRuns()).toBe(1);

      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toEqual({ status: "rejected_capacity", activeRuns: 1, limit: 1 });
      expect(store.getRun("run-rejected")).toBeNull();
      expect(store.getRevision("revision-rejected")).toBeNull();

      expect(
        store.transitionRun({
          runId: "run-active",
          from: "queued",
          to: "cancelled",
          now: 20,
        }),
      ).toBe(true);
      expect(store.countActiveRuns()).toBe(0);
      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({ status: "accepted", run: { runId: "run-rejected" } });
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });

  it("reuses an idempotent invocation at capacity and rejects a new key without rows", () => {
    const file = dbPath("active-run-cap-idempotency");
    const store = new DurableWorkflowStore(file);
    const fingerprintSha256 = "f".repeat(64);
    try {
      const first = store.createInvocation({
        revision: revision("revision-first"),
        run: run("run-first", "revision-first"),
        idempotency: { key: "existing-key", fingerprintSha256 },
        maxActiveRuns: 1,
      });
      expect(first).toMatchObject({ status: "accepted", run: { runId: "run-first" } });

      expect(
        store.createInvocation({
          revision: revision("revision-replay"),
          run: run("run-replay", "revision-replay"),
          idempotency: { key: "existing-key", fingerprintSha256 },
          maxActiveRuns: 1,
        }),
      ).toMatchObject({ status: "accepted", run: { runId: "run-first" } });
      expect(
        store.createInvocation({
          revision: revision("revision-new"),
          run: run("run-new", "revision-new"),
          idempotency: { key: "new-key", fingerprintSha256: "e".repeat(64) },
          maxActiveRuns: 1,
        }),
      ).toEqual({ status: "rejected_capacity", activeRuns: 1, limit: 1 });
      expect(store.getRun("run-replay")).toBeNull();
      expect(store.getRun("run-new")).toBeNull();
      expect(store.getRevision("revision-replay")).toBeNull();
      expect(store.getRevision("revision-new")).toBeNull();
    } finally {
      store.close();
    }

    const db = new Database(file);
    try {
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM workflow_invocation_receipts",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });

  it("migrates v20 through v4 and archives the incompatible execution history", () => {
    const file = dbPath("v20-minimal-contract");
    const store = new DurableWorkflowStore(file);
    const rev = revision();
    store.createInvocation({ revision: rev, run: run("active-run") });
    store.tryClaimRun({ runId: "active-run", claimerId: "old-worker", now: 20 });
    store.createOperation(operation("active-run", "active-operation"), "old-worker");

    store.createInvocation({ revision: rev, run: run("terminal-run") });
    store.tryClaimRun({ runId: "terminal-run", claimerId: "old-worker", now: 20 });
    store.createOperation(operation("terminal-run", "terminal-operation"), "old-worker");
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "queued",
      to: "dispatched",
      runOwnerId: "old-worker",
      now: 21,
    });
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "dispatched",
      to: "running",
      runOwnerId: "old-worker",
      now: 22,
    });
    store.transitionOperation({
      runId: "terminal-run",
      operationId: "terminal-operation",
      from: "running",
      to: "succeeded",
      runOwnerId: "old-worker",
      now: 23,
      output: "complete",
    });
    store.terminalizeRun({
      runId: "terminal-run",
      from: "running",
      to: "succeeded",
      ownerId: "old-worker",
      now: 24,
      detail: "complete",
      result: { ok: true },
      resultArtifactId: null,
    });
    store.createInvocation({ revision: rev, run: run("rejected-run") });
    const trigger: WorkflowTrigger = {
      triggerId: "active-trigger",
      revisionId: rev.revisionId,
      state: "active",
      definition: { kind: "timestamp", at: 100 },
      args: {},
      argsSha256: canonicalJsonSha256({}),
      schedulingPolicy: { skipMissed: true, overlap: "coalesce" },
      origin: run().origin,
      completionTarget: { kind: "detached" },
      progressTarget: null,
      nextFireAt: 100,
      lastFireAt: null,
      lastRunId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 10,
      updatedAt: 10,
    };
    store.createTriggerInvocation({
      trigger,
      idempotency: { key: "active-trigger", fingerprintSha256: "c".repeat(64) },
    });
    store.close();

    const legacy = new Database(file);
    downgradeSchemaToV20(legacy);
    legacy.run(
      `UPDATE workflow_runs
       SET state = 'rejected', terminal_detail = 'approval rejected', terminal_at = 25
       WHERE run_id = 'rejected-run'`,
    );
    legacy.run(
      `UPDATE workflow_operations SET state = 'running', request_id = 'active-request',
       claimed_by = 'old-worker', claimed_at = 20 WHERE run_id = 'active-run'`,
    );
    legacy.run(
      `INSERT INTO workflow_request_dispatches (
         request_id, run_id, operation_id, token_sha256, session_id, platform,
         canonical_cwd, policy_json, expires_at, owner_id, owner_heartbeat_at,
         active, created_at, updated_at, prompt_published_at, dispatch_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, 20, 1, 20, 20, 20, ?)`,
      [
        "active-request",
        "active-run",
        "active-operation",
        "0".repeat(64),
        "workflow:active",
        "unknown",
        "/workspace",
        JSON.stringify({
          profile: "general",
          model: null,
          reasoning: null,
          resolvedModelRequest: {
            spec: "profile-native:general",
            provider: "test",
            modelId: "general",
            reasoningDisplay: "simple",
          },
          canonicalCwd: "/workspace",
        }),
        "runner-old",
        "old-dispatch-epoch",
      ],
    );
    legacy.run(
      `INSERT INTO workflow_request_terminal_receipts (
         request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
         output_json, result_artifact_id, usage_json
       ) VALUES ('terminal-request', 'terminal-run', 'terminal-operation', 'terminal-epoch',
          'resolved', 'complete', 24, '"complete"', NULL, NULL)`,
    );
    legacy.run(
      `INSERT INTO workflow_request_dispatches (
         request_id, run_id, operation_id, token_sha256, session_id, platform,
         canonical_cwd, policy_json, expires_at, active, created_at, updated_at,
         prompt_published_at, dispatch_epoch
       ) VALUES ('legacy-terminal-dispatch', 'terminal-run', 'terminal-operation', ?,
         'workflow:terminal', 'unknown', '/workspace', '{not-json', 24, 0, 20, 24, 20,
         'legacy-terminal-epoch')`,
      ["1".repeat(64)],
    );
    legacy.close();

    const migrated = new DurableWorkflowStore(file);
    try {
      expect(migrated.getRun("active-run")).toBeNull();
      expect(migrated.getOperation("active-run", "active-operation")).toBeNull();
      expect(migrated.getTrigger("active-trigger")).toBeNull();
      expect(migrated.getRun("terminal-run")).toBeNull();
      expect(migrated.getRun("rejected-run")).toBeNull();
      expect(migrated.getWorkflowRequestTerminalReceipt("terminal-request")).toBeNull();
      expect(migrated.getWorkflowRequestDispatchPolicy("active-request")).toBeNull();
      expect(migrated.getWorkflowRequestDispatchPolicy("legacy-terminal-dispatch")).toBeNull();
    } finally {
      migrated.close();
    }

    const inspected = new Database(file);
    try {
      const quarantine = inspected
        .query<{ record_kind: string; record_id: string }, []>(
          "SELECT record_kind, record_id FROM workflow_quarantine",
        )
        .all();
      expect(quarantine).toEqual(
        expect.arrayContaining([
          { record_kind: "run", record_id: "active-run" },
          { record_kind: "operation", record_id: "active-run:active-operation" },
          { record_kind: "trigger", record_id: "active-trigger" },
        ]),
      );
      const audit = inspected
        .query<{ record_kind: string; record_id: string }, []>(
          "SELECT record_kind, record_id FROM workflow_legacy_audit_records",
        )
        .all();
      expect(audit).toEqual(
        expect.arrayContaining([
          { record_kind: "revision", record_id: "revision-1" },
          { record_kind: "run", record_id: "active-run" },
          { record_kind: "run", record_id: "terminal-run" },
          { record_kind: "trigger", record_id: "active-trigger" },
          { record_kind: "terminal_receipt", record_id: "terminal-request" },
        ]),
      );
      expect(
        inspected
          .query<{ active: number }, []>(
            "SELECT active FROM workflow_request_dispatches WHERE request_id = 'active-request'",
          )
          .get()?.active,
      ).toBeUndefined();
      expect(
        inspected
          .query<{ name: string }, []>("PRAGMA table_info(workflow_request_dispatches)")
          .all()
          .map((column) => column.name),
      ).not.toContain("expires_at");
    } finally {
      inspected.close();
      rmSync(file, { force: true });
    }
  });

  it("pins the exact resolved model request across dispatch epochs", () => {
    const file = dbPath("resolved-model-pinning");
    const store = new DurableWorkflowStore(file);
    try {
      store.createInvocation({ revision: revision(), run: run() });
      store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 });
      store.createOperation(operation("run-1", "operation-1"), "worker-1");
      const policy = {
        runId: "run-1",
        operationId: "operation-1",
        dispatchEpoch: "a".repeat(32),
        profile: "general" as const,
        model: null,
        reasoning: null,
        resolvedModelRequest: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "simple" as const,
        },
        cwd: "/workspace",
        originSession: {
          requestId: "request-1",
          sessionId: "session-1",
          client: "discord" as const,
          userId: "user-1",
        },
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy,
          now: 21,
          staleOwnerBefore: 21,
        }),
      ).toMatchObject({ state: "dispatched" });
      expect(store.getWorkflowRequestDispatchPolicy("agent-request")).toEqual(policy);
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: {
            ...policy,
            dispatchEpoch: "b".repeat(32),
            resolvedModelRequest: {
              ...policy.resolvedModelRequest,
              spec: "provider/model-b",
              modelId: "model-b",
            },
          },
          now: 22,
          staleOwnerBefore: 22,
        }),
      ).toBeNull();
      expect(store.getWorkflowRequestDispatchPolicy("agent-request")).toEqual(policy);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
});
