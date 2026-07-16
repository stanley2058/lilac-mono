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
  type WorkflowRevision,
  type WorkflowRun,
} from "../../src/workflow/workflow-domain";

function dbPath(label: string): string {
  return join(tmpdir(), `lilac-workflow-${label}-${crypto.randomUUID()}.sqlite`);
}

function revision(id = "revision-1"): WorkflowRevision {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 2, maxTotal: 8 },
    maxNestingDepth: 4,
    maxWallTimeMs: 60_000,
    operationIdleTimeoutMs: 10_000,
    waits: ["reply", "sleep"],
    safety: { originatingMode: "trusted", escalation: "none" },
  });
  const limits = {
    maxSourceBytes: 10_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: 10_000,
    maxResultBytes: 10_000,
    maxRuntimeMemoryBytes: 256 * 1024 * 1024,
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
      safetyMode: "trusted",
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

describe("durable workflow store trusted auto-run schema", () => {
  it("creates and claims trusted queued invocations without approvals or shared-editor leases", () => {
    const file = dbPath("trusted-auto-run");
    const store = new DurableWorkflowStore(file);
    try {
      const created = store.createInvocation({ revision: revision(), run: run() });
      expect(created.run.state).toBe("queued");
      expect(
        store.tryClaimTrustedRun({ runId: "run-1", claimerId: "worker-1", now: 20 })?.state,
      ).toBe("running");
      expect(store.listMigrations().at(-1)).toMatchObject({
        version: 20,
        name: "profile-native trusted auto-run clean break",
      });
    } finally {
      store.close();
    }

    const db = new Database(file);
    try {
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflow_approvals").get()
          ?.count,
      ).toBe(0);
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_shared_editor_leases'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });

  it("archives and quarantines incompatible v19 executable state without reconstructing authority", () => {
    const file = dbPath("v19-clean-break");
    new DurableWorkflowStore(file).close();
    const db = new Database(file);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM workflow_schema_migrations WHERE version = 20");
    db.run("DROP TABLE workflow_legacy_audit_records");
    db.run(`CREATE TABLE workflow_shared_editor_leases (
      authority_root TEXT PRIMARY KEY, run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, heartbeat_at INTEGER NOT NULL, acquired_at INTEGER NOT NULL
    )`);
    db.run(
      `INSERT INTO workflow_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "old-revision",
        "project-1",
        "/workspace",
        "project",
        "old.js",
        "old",
        "workflow-source:old",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        JSON.stringify({ name: "old", description: "old" }),
        JSON.stringify({ type: "object", additionalProperties: false }),
        JSON.stringify({
          agents: {
            profiles: [],
            models: [],
            reasoning: [],
            allowedRoots: [],
            tools: [],
            executables: "trusted",
            editing: [],
            delegation: false,
            maxConcurrent: 1,
            maxTotal: 1,
          },
          level2: { callables: [] },
          surfaces: { origin: [] },
          maxNestingDepth: 1,
          maxWallTimeMs: 1000,
          operationIdleTimeoutMs: 1000,
          waits: [],
          safety: { originatingMode: "trusted", escalation: "none" },
        }),
        JSON.stringify({
          maxSourceBytes: 1000,
          maxInputBytes: 1000,
          maxOperationOutputBytes: 1000,
          maxResultBytes: 1000,
          maxRuntimeMemoryBytes: 268435456,
        }),
        "lilac-workflow-js-v2",
        1,
      ],
    );
    const insertRun = (id: string, state: "running" | "succeeded") =>
      db.run(
        `INSERT INTO workflow_runs VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "old-revision",
          state,
          JSON.stringify({ type: "object", additionalProperties: false }),
          "{}",
          "d".repeat(64),
          "request-old",
          "session-old",
          "discord",
          "user-old",
          "trusted",
          "/workspace",
          JSON.stringify({ kind: "detached" }),
          state === "succeeded" ? "completed" : null,
          state === "succeeded" ? "{}" : null,
          state === "running" ? "worker-old" : null,
          state === "running" ? 2 : null,
          1,
          state === "running" ? 2 : 1,
          2,
          state === "succeeded" ? 2 : null,
        ],
      );
    insertRun("old-active-run", "running");
    insertRun("old-terminal-run", "succeeded");
    db.run(
      `INSERT INTO workflow_operations (
        run_id, operation_id, call_site_id, parent_operation_id, phase, label, kind,
        input_json, input_sha256, state, attempt, request_id, output_json, result_artifact_id,
        error, usage_json, claimed_by, claimed_at, created_at, started_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, 'agent', '{}', ?, 'running', 0, ?, NULL, NULL,
        NULL, NULL, ?, 2, 1, 2, 2, NULL)`,
      [
        "old-active-run",
        "old-operation",
        "old-call-site",
        "f".repeat(64),
        "old-dispatch-request",
        "worker-old",
      ],
    );
    db.run(
      `INSERT INTO workflow_request_dispatches (
        request_id, run_id, operation_id, token_sha256, session_id, platform, canonical_cwd,
        policy_json, expires_at, owner_id, owner_heartbeat_at, active, created_at, updated_at,
        prompt_published_at, dispatch_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 10000, ?, 2, 1, 1, 2, 2, ?)`,
      [
        "old-dispatch-request",
        "old-active-run",
        "old-operation",
        "0".repeat(64),
        "workflow:old",
        "unknown",
        "/workspace",
        "runner-old",
        "old-dispatch-epoch",
      ],
    );
    db.run(
      `INSERT INTO workflow_request_terminal_receipts (
         request_id, run_id, operation_id, dispatch_epoch, state, detail, created_at,
         output_json, result_artifact_id, usage_json
       ) VALUES (?, ?, ?, ?, 'failed', 'legacy receipt', 2, NULL, NULL, NULL)`,
      ["old-terminal-receipt", "old-terminal-run", "standalone-operation", "old-epoch"],
    );
    db.run(
      `INSERT INTO workflow_triggers (
        trigger_id, revision_id, state, kind, definition_json, args_json, args_sha256,
        scheduling_policy_json, progress_target_json, next_fire_at, last_fire_at, last_run_id,
        claimed_by, claimed_at, created_at, updated_at, origin_json, completion_target_json
      ) VALUES (?, ?, 'active', 'cron', ?, '{}', ?, ?, NULL, 100, NULL, NULL, NULL, NULL, 1, 2, ?, ?)`,
      [
        "old-trigger",
        "old-revision",
        JSON.stringify({ kind: "cron", expression: "* * * * *", timezone: null }),
        "e".repeat(64),
        JSON.stringify({ skipMissed: true, overlap: "coalesce" }),
        JSON.stringify({
          requestId: null,
          sessionId: "session-old",
          client: "discord",
          userId: "user-old",
          safetyMode: "trusted",
          projectCwd: "/workspace",
        }),
        JSON.stringify({ kind: "detached" }),
      ],
    );
    db.close();

    const migrated = new DurableWorkflowStore(file);
    try {
      expect(migrated.getRun("old-active-run")).toBeNull();
      expect(migrated.getRevision("old-revision")).toBeNull();
      expect(migrated.getTrigger("old-trigger")).toBeNull();
      expect(migrated.listMigrations().at(-1)?.version).toBe(20);
    } finally {
      migrated.close();
    }

    const inspected = new Database(file);
    try {
      const reasons = inspected
        .query<{ record_kind: string; record_id: string; reason: string }, []>(
          "SELECT record_kind, record_id, reason FROM workflow_quarantine ORDER BY record_kind, record_id",
        )
        .all();
      expect(reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ record_kind: "run", record_id: "old-active-run" }),
          expect.objectContaining({
            record_kind: "operation",
            record_id: "old-active-run:old-operation",
          }),
          expect.objectContaining({ record_kind: "trigger", record_id: "old-trigger" }),
        ]),
      );
      expect(
        inspected
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM workflow_request_dispatches WHERE request_id = 'old-dispatch-request'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        inspected
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM workflow_legacy_audit_records",
          )
          .get()?.count,
      ).toBe(5);
      expect(
        inspected
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM workflow_request_terminal_receipts WHERE request_id = 'old-terminal-receipt'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        inspected
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM workflow_legacy_audit_records WHERE record_kind = 'terminal_receipt' AND record_id = 'old-terminal-receipt'",
          )
          .get()?.count,
      ).toBe(1);
      expect(
        inspected
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_shared_editor_leases'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      inspected.close();
      rmSync(file, { force: true });
    }
  });
});
