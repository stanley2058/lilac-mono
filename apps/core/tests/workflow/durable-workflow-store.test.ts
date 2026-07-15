import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { sha256 } from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowCapabilityProfile,
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
  type WorkflowApproval,
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowSurfaceAction,
  type WorkflowSurfaceBinding,
  type WorkflowTrigger,
  type WorkflowWait,
} from "../../src/workflow/workflow-domain";
import { buildWorkflowProgressView } from "../../src/workflow/workflow-progress-view";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function dbPath(label: string): string {
  return join(tmpdir(), `lilac-workflow-${label}-${crypto.randomUUID()}.sqlite`);
}

function revision(id = "revision-1", sourceHash = HASH_A): WorkflowRevision {
  return {
    revisionId: id,
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifactId: `artifact-${id}`,
    sourceSha256: sourceHash,
    inputSchemaSha256: HASH_A,
    capabilitySha256: HASH_B,
    metadata: { name: "audit", description: "Audit the project" },
    inputSchema: { type: "object", additionalProperties: false },
    capabilities: normalizeWorkflowCapabilityProfile({
      agents: {
        profiles: ["explore"],
        models: ["inherit"],
        editing: false,
        isolation: "shared",
        maxConcurrent: 2,
        maxTotal: 8,
      },
      maxNestingDepth: 4,
      maxWallTimeMs: 60_000,
      operationIdleTimeoutMs: 10_000,
      waits: ["reply", "sleep"],
      surfaceSends: false,
      externalTools: false,
      safety: { originatingMode: "trusted", escalation: "none" },
    }),
    limits: {
      maxSourceBytes: 10_000,
      maxInputBytes: 10_000,
      maxOperationOutputBytes: 10_000,
      maxResultBytes: 10_000,
      maxRuntimeMemoryBytes: 256 * 1024 * 1024,
    },
    runtimeVersion: "runtime-v1",
    createdAt: 10,
  };
}

function approval(runId: string, id = "approval-1", revisionId = "revision-1"): WorkflowApproval {
  return {
    approvalId: id,
    revisionId,
    state: "pending",
    expectedReviewerPlatform: "discord",
    expectedReviewerUserId: "user-1",
    firstRunId: runId,
    decisionActorPlatform: null,
    decisionActorUserId: null,
    decisionSource: null,
    expiresAt: null,
    decidedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: 10,
    updatedAt: 10,
  };
}

function run(id: string, revisionId = "revision-1"): WorkflowRun {
  return {
    runId: id,
    revisionId,
    approvalId: null,
    state: "awaiting_review",
    inputSchemaSnapshot: { type: "object", additionalProperties: false },
    args: { directory: "src" },
    argsSha256: HASH_A,
    origin: {
      requestId: "request-1",
      sessionId: "session-1",
      client: "discord",
      userId: "user-1",
      safetyMode: "trusted",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "durable_surface" },
    progressTarget: { platform: "discord", channelId: "channel-1", replyToMessageId: null },
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

function operation(runId = "run-1", id = "operation-1"): WorkflowOperation {
  return {
    runId,
    operationId: id,
    callSiteId: `call-${id}`,
    parentOperationId: null,
    phase: "audit",
    label: "Inspect",
    kind: "agent",
    input: { prompt: "inspect" },
    inputSha256: HASH_A,
    state: "queued",
    attempt: 0,
    requestId: null,
    output: null,
    resultArtifactId: null,
    error: null,
    usage: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 10,
    startedAt: null,
    updatedAt: 10,
    terminalAt: null,
  };
}

describe("DurableWorkflowStore", () => {
  it("authorizes dispatch atomically and rejects forged, revoked, or live-owned requests", () => {
    const path = dbPath("dispatch-authority");
    const store = new DurableWorkflowStore(path);
    try {
      const invocation = store.createInvocation({
        revision: revision(),
        run: run("run-authority"),
        pendingApproval: approval("run-authority"),
      });
      store.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "pending",
        to: "approved",
        now: 11,
      });
      expect(
        store.tryClaimApprovedRun({
          runId: invocation.run.runId,
          claimerId: "engine-1",
          now: 12,
        }),
      ).not.toBeNull();
      expect(store.createOperation(operation(invocation.run.runId), "engine-1")).toBe(true);
      const token = crypto.randomUUID() + crypto.randomUUID();
      const policy = {
        runId: invocation.run.runId,
        operationId: "operation-1",
        dispatchEpoch: "dispatch-epoch-0001",
        profile: "explore" as const,
        safetyMode: "trusted" as const,
        editing: false,
        isolation: "shared" as const,
        externalTools: false,
        surfaceSends: false,
        subagents: false,
        canonicalWorkspaceRoot: "/workspace",
        canonicalCwd: "/workspace",
        canonicalProjectId: "project-1",
        originSessionId: "session-1",
        originClient: "discord" as const,
        revisionId: "revision-1",
        sourceSha256: HASH_A,
        inputSchemaSha256: HASH_A,
        capabilitySha256: HASH_B,
        argsSha256: HASH_A,
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "wfr:request-1",
          runId: invocation.run.runId,
          operationId: "operation-1",
          runOwnerId: "engine-1",
          token,
          sessionId: "workflow:run-authority:operation-1",
          platform: "unknown",
          policy,
          now: 13,
          expiresAt: 1_000,
          staleOwnerBefore: 0,
        }),
      ).toMatchObject({ state: "dispatched", requestId: "wfr:request-1" });
      expect(
        store.claimWorkflowRequestPromptPublication({
          requestId: "wfr:request-1",
          runId: invocation.run.runId,
          operationId: "operation-1",
          runOwnerId: "engine-1",
          now: 13,
        }),
      ).toBe(true);
      expect(
        store.recordWorkflowRequestTerminal({
          requestId: "wfr:request-1",
          runId: invocation.run.runId,
          operationId: "operation-1",
          dispatchEpoch: "stale-dispatch-epoch",
          ownerId: "runner-1",
          state: "resolved",
          now: 14,
        }),
      ).toBe(false);
      expect(
        store.authorizeWorkflowRequest({
          requestId: "wfr:request-1",
          token: "forged-token-that-is-long-enough-to-parse",
          sessionId: "workflow:run-authority:operation-1",
          platform: "unknown",
          now: 14,
        }),
      ).toBeNull();
      expect(
        store.claimWorkflowRequest({
          requestId: "wfr:request-1",
          token,
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner-1",
          now: 14,
        }),
      ).toBe(true);
      expect(
        store.claimWorkflowRequest({
          requestId: "wfr:request-1",
          token,
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner-2",
          now: 15,
        }),
      ).toBe(false);
      expect(store.releaseWorkflowRequestClaim("wfr:request-1", "runner-1", 15)).toBe(true);
      expect(
        store.claimWorkflowRequest({
          requestId: "wfr:request-1",
          token,
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner-2",
          now: 16,
        }),
      ).toBe(true);
      expect(store.expireWorkflowRequest("wfr:request-1", 16, "runner-1")).toBe(false);
      expect(
        store.authorizeWorkflowRequest({
          requestId: "wfr:request-1",
          token,
          sessionId: "workflow:run-authority:operation-1",
          platform: "unknown",
          now: 16,
        }),
      ).not.toBeNull();
      const replacementToken = crypto.randomUUID() + crypto.randomUUID();
      const replacementPolicy = { ...policy, dispatchEpoch: "dispatch-epoch-0002" };
      expect(
        store.authorizeAgentDispatch({
          requestId: "wfr:request-1",
          runId: invocation.run.runId,
          operationId: "operation-1",
          runOwnerId: "engine-1",
          token: replacementToken,
          sessionId: "workflow:run-authority:operation-1",
          platform: "unknown",
          policy: replacementPolicy,
          now: 100,
          expiresAt: 1_000,
          staleOwnerBefore: 99,
        }),
      ).not.toBeNull();
      expect(
        store.recordWorkflowRequestTerminal({
          requestId: "wfr:request-1",
          runId: invocation.run.runId,
          operationId: "operation-1",
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner-2",
          state: "resolved",
          output: "stale output",
          now: 101,
        }),
      ).toBe(false);
      expect(store.getWorkflowRequestTerminalReceipt("wfr:request-1")).toBeNull();
      store.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "approved",
        to: "revoked",
        now: 101,
      });
      expect(
        store.authorizeWorkflowRequest({
          requestId: "wfr:request-1",
          token,
          sessionId: "workflow:run-authority:operation-1",
          platform: "unknown",
          now: 17,
        }),
      ).toBeNull();
      expect(store.getRun(invocation.run.runId)?.state).toBe("paused");
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("tombstones the exact terminal epoch before a restored snapshot can rerun it", () => {
    const path = dbPath("terminal-receipt-rerun");
    const store = new DurableWorkflowStore(path);
    try {
      const invocation = store.createInvocation({
        revision: revision(),
        run: run("run-terminal-rerun"),
        pendingApproval: approval("run-terminal-rerun"),
      });
      store.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "pending",
        to: "approved",
        now: 11,
      });
      store.tryClaimApprovedRun({ runId: invocation.run.runId, claimerId: "engine", now: 12 });
      store.createOperation(operation(invocation.run.runId), "engine");
      const token = crypto.randomUUID() + crypto.randomUUID();
      const policy = {
        runId: invocation.run.runId,
        operationId: "operation-1",
        dispatchEpoch: "dispatch-epoch-terminal-rerun",
        profile: "explore" as const,
        safetyMode: "trusted" as const,
        editing: false,
        isolation: "shared" as const,
        externalTools: false,
        surfaceSends: false,
        subagents: false,
        canonicalWorkspaceRoot: "/workspace",
        canonicalCwd: "/workspace",
        canonicalProjectId: "project-1",
        originSessionId: "session-1",
        originClient: "discord" as const,
        revisionId: "revision-1",
        sourceSha256: HASH_A,
        inputSchemaSha256: HASH_A,
        capabilitySha256: HASH_B,
        argsSha256: HASH_A,
      };
      const requestId = "wfr:terminal-rerun";
      const dispatchInput = {
        requestId,
        runId: invocation.run.runId,
        operationId: "operation-1",
        runOwnerId: "engine",
        token,
        sessionId: "workflow:run-terminal-rerun:operation-1",
        platform: "unknown",
        policy,
        now: 13,
        expiresAt: 1_000,
        staleOwnerBefore: 0,
      };
      expect(store.authorizeAgentDispatch(dispatchInput)).not.toBeNull();
      expect(
        store.claimWorkflowRequestPromptPublication({
          requestId,
          runId: invocation.run.runId,
          operationId: "operation-1",
          runOwnerId: "engine",
          now: 14,
        }),
      ).toBe(true);
      expect(
        store.claimWorkflowRequest({
          requestId,
          token,
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner",
          now: 15,
        }),
      ).toBe(true);
      expect(
        store.recordWorkflowRequestTerminal({
          requestId,
          runId: invocation.run.runId,
          operationId: "operation-1",
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "runner",
          state: "resolved",
          output: "durable result",
          now: 16,
        }),
      ).toBe(true);

      expect(store.getActiveWorkflowRequestDispatchEpoch(requestId, 16)).toBeNull();
      expect(
        store.authorizeWorkflowRequest({
          requestId,
          token,
          sessionId: dispatchInput.sessionId,
          platform: "unknown",
          now: 16,
        }),
      ).toBeNull();
      expect(
        store.claimWorkflowRequest({
          requestId,
          token,
          dispatchEpoch: policy.dispatchEpoch,
          ownerId: "restored-runner",
          now: 17,
        }),
      ).toBe(false);
      expect(store.authorizeAgentDispatch({ ...dispatchInput, now: 17 })).toBeNull();
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("fences operation and wait writes after run ownership takeover", () => {
    const path = dbPath("owned-child-fencing");
    const store = new DurableWorkflowStore(path);
    try {
      const invocation = store.createInvocation({
        revision: revision(),
        run: run("run-fenced"),
        pendingApproval: approval("run-fenced"),
      });
      store.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "pending",
        to: "approved",
        now: 2,
      });
      store.tryClaimApprovedRun({ runId: "run-fenced", claimerId: "owner-old", now: 3 });
      expect(store.createOperation(operation("run-fenced"), "owner-old")).toBe(true);
      store.tryClaimApprovedRun({
        runId: "run-fenced",
        claimerId: "owner-new",
        now: 100,
        staleAfterMs: 50,
      });
      expect(
        store.transitionOperation({
          runOwnerId: "owner-old",
          runId: "run-fenced",
          operationId: "operation-1",
          from: "queued",
          to: "dispatched",
          now: 101,
        }),
      ).toBe(false);
      expect(
        store.transitionOperation({
          runOwnerId: "owner-new",
          runId: "run-fenced",
          operationId: "operation-1",
          from: "queued",
          to: "dispatched",
          now: 102,
        }),
      ).toBe(true);
      expect(
        store.terminalizeOperationAndExpireRequest({
          runOwnerId: "owner-old",
          runId: "run-fenced",
          operationId: "operation-1",
          requestId: "wfr:stale",
          from: "dispatched",
          to: "failed",
          now: 102,
          error: "stale worker",
        }),
      ).toBe(false);
      expect(store.getOperation("run-fenced", "operation-1")?.state).toBe("dispatched");
      expect(
        store.createWait(
          {
            runId: "run-fenced",
            operationId: "operation-1",
            state: "pending",
            match: { kind: "sleep" },
            matchKey: "sleep",
            dueAt: 200,
            deadlineAt: null,
            resolverCursor: null,
            result: null,
            resolvedBy: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 102,
            updatedAt: 102,
            resolvedAt: null,
          },
          "owner-old",
        ),
      ).toBe(false);
      expect(
        store.createWait(
          {
            runId: "run-fenced",
            operationId: "operation-1",
            state: "pending",
            match: { kind: "sleep" },
            matchKey: "sleep",
            dueAt: 200,
            deadlineAt: null,
            resolverCursor: null,
            result: null,
            resolvedBy: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 102,
            updatedAt: 102,
            resolvedAt: null,
          },
          "owner-new",
        ),
      ).toBe(true);
      expect(
        store.terminalizeRun({
          runId: "run-fenced",
          from: "running",
          to: "failed",
          ownerId: "owner-old",
          now: 103,
          detail: "stale owner",
          result: null,
          resultArtifactId: null,
        }),
      ).toBe(false);
      expect(store.getRun("run-fenced")?.claimedBy).toBe("owner-new");
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("tracks explicit migrations and reopens an existing schema", () => {
    const path = dbPath("migration");
    try {
      const first = new DurableWorkflowStore(path);
      expect(first.listMigrations()).toEqual([
        { version: 1, name: "initial durable workflow schema", appliedAt: expect.any(Number) },
        {
          version: 2,
          name: "durable waits and trigger invocation context",
          appliedAt: expect.any(Number),
        },
        {
          version: 3,
          name: "durable live-parent completion delivery",
          appliedAt: expect.any(Number),
        },
        {
          version: 4,
          name: "workflow authority and incremental hardening",
          appliedAt: expect.any(Number),
        },
        {
          version: 5,
          name: "scheduled run admission tracking",
          appliedAt: expect.any(Number),
        },
        {
          version: 6,
          name: "round 2 trigger and delivery durability",
          appliedAt: expect.any(Number),
        },
        {
          version: 7,
          name: "round 4 request and adapter stream linearization",
          appliedAt: expect.any(Number),
        },
        {
          version: 8,
          name: "round 5 terminal adoption and durable workflow actions",
          appliedAt: expect.any(Number),
        },
        {
          version: 9,
          name: "round 6 recoverable streams and fenced projection",
          appliedAt: expect.any(Number),
        },
        {
          version: 10,
          name: "round 7 blocking legacy receipt quarantine",
          appliedAt: expect.any(Number),
        },
        {
          version: 11,
          name: "round 8 projection repair marker",
          appliedAt: expect.any(Number),
        },
        {
          version: 12,
          name: "round 9 generational projection repair",
          appliedAt: expect.any(Number),
        },
        {
          version: 13,
          name: "round 12 incremental projection discovery",
          appliedAt: expect.any(Number),
        },
        {
          version: 14,
          name: "round 15 canonical manual reconciliation state",
          appliedAt: expect.any(Number),
        },
      ]);
      expect(first.createRevision(revision())).toBe(true);
      first.close();

      const reopened = new DurableWorkflowStore(path);
      expect(reopened.listMigrations()).toHaveLength(14);
      expect(reopened.getRevision("revision-1")?.name).toBe("audit");
      reopened.close();

      const db = new Database(path, { readonly: true });
      const names = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(names).toContain("workflow_revisions");
      expect(names).toContain("workflow_surface_actions");
      expect(names).toContain("workflow_schema_migrations");
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_workflow_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("idx_workflow_runs_state_updated");
      expect(indexes).toContain("idx_workflow_operations_claim");
      expect(indexes).toContain("idx_workflow_waits_match");
      expect(indexes).toContain("idx_workflow_triggers_due");
      db.close();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("migrates the Round 8 repair marker to an unrendered repair generation", () => {
    const path = dbPath("round-8-repair-upgrade");
    const initial = new DurableWorkflowStore(path);
    try {
      expect(initial.createRevision(revision())).toBe(true);
      expect(initial.createRun(run("run-repair"))).toBe(true);
      initial.upsertSurfaceBinding({
        runId: "run-repair",
        target: { platform: "discord", channelId: "channel-1", replyToMessageId: null },
        messageRef: { platform: "discord", channelId: "channel-1", messageId: "card-1" },
        lastRenderedSha256: HASH_A,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        repairGeneration: 0,
        renderedRepairGeneration: 0,
        sendMayHaveSucceeded: false,
        discoveryCursor: null,
        createdAt: 10,
        updatedAt: 10,
      });
    } finally {
      initial.close();
    }

    const legacy = new Database(path);
    legacy.run("UPDATE workflow_surface_bindings SET repair_required = 1");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN discovery_scanned_entries");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN discovery_before_message_id");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN discovery_page");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN send_may_have_succeeded");
    legacy.run("DELETE FROM workflow_schema_migrations WHERE version = 13");
    legacy.run("DROP TABLE workflow_surface_projection_orphans");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN rendered_repair_generation");
    legacy.run("ALTER TABLE workflow_surface_bindings DROP COLUMN repair_generation");
    legacy.run("DELETE FROM workflow_schema_migrations WHERE version = 12");
    legacy.close();

    const upgraded = new DurableWorkflowStore(path);
    try {
      expect(upgraded.getSurfaceBinding("run-repair")).toMatchObject({
        repairGeneration: 1,
        renderedRepairGeneration: 0,
      });
      expect(upgraded.listMigrations()).toHaveLength(14);
    } finally {
      upgraded.close();
      rmSync(path, { force: true });
    }
  });

  it("quarantines upgraded resolved receipts that have no adoptable payload", () => {
    const path = dbPath("legacy-terminal-receipt");
    try {
      const initialized = new DurableWorkflowStore(path);
      const invocation = initialized.createInvocation({
        revision: revision(),
        run: run("legacy-run"),
        pendingApproval: approval("legacy-run"),
      });
      initialized.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "pending",
        to: "approved",
        now: 11,
      });
      initialized.tryClaimApprovedRun({ runId: "legacy-run", claimerId: "engine", now: 12 });
      initialized.createOperation(operation("legacy-run", "legacy-operation"), "engine");
      initialized.close();
      const db = new Database(path);
      db.run(
        `INSERT INTO workflow_request_terminal_receipts (
           request_id, run_id, operation_id, dispatch_epoch, state, detail,
           output_json, result_artifact_id, usage_json, created_at
         ) VALUES (?, ?, ?, ?, 'resolved', NULL, NULL, NULL, NULL, ?)`,
        ["legacy-request", "legacy-run", "legacy-operation", "legacy-epoch-0001", 10],
      );
      db.close();

      const upgraded = new DurableWorkflowStore(path);
      expect(upgraded.getWorkflowRequestTerminalReceipt("legacy-request")).toBeNull();
      expect(upgraded.getRun("legacy-run")).toMatchObject({
        state: "paused",
        claimedBy: null,
        terminalDetail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(upgraded.getOperation("legacy-run", "legacy-operation")).toMatchObject({
        state: "blocked",
        claimedBy: null,
        error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(
        upgraded.claimWorkflowRequestPromptPublication({
          requestId: "legacy-request",
          runId: "legacy-run",
          operationId: "legacy-operation",
          runOwnerId: "engine",
          now: 20,
        }),
      ).toBe(false);
      upgraded.close();
      const verified = new Database(path, { readonly: true });
      expect(
        verified
          .query<{ quarantine_reason: string }, [string]>(
            `SELECT quarantine_reason FROM workflow_request_terminal_receipt_quarantine
             WHERE request_id = ?`,
          )
          .get("legacy-request"),
      ).toEqual({ quarantine_reason: "legacy_resolved_receipt_missing_payload" });
      verified.close();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("rejects direct and surface resume for canonical manual reconciliation state", async () => {
    const path = dbPath("manual-reconciliation-resume");
    const store = new DurableWorkflowStore(path);
    try {
      const invocation = store.createInvocation({
        revision: revision(),
        run: run("run-manual"),
        pendingApproval: approval("run-manual"),
      });
      store.transitionApproval({
        approvalId: invocation.approval.approvalId,
        from: "pending",
        to: "approved",
        now: 11,
      });
      store.tryClaimApprovedRun({ runId: "run-manual", claimerId: "engine", now: 12 });
      store.createOperation(operation("run-manual"), "engine");
      expect(
        store.authorizeAgentDispatch({
          requestId: "wfr:manual",
          runId: "run-manual",
          operationId: "operation-1",
          runOwnerId: "engine",
          token: "manual-reconciliation-token-123456",
          sessionId: "workflow:run-manual:operation-1",
          platform: "unknown",
          policy: {
            runId: "run-manual",
            operationId: "operation-1",
            dispatchEpoch: "manual-dispatch-epoch",
            profile: "explore",
            safetyMode: "trusted",
            editing: false,
            isolation: "shared",
            externalTools: false,
            surfaceSends: false,
            subagents: false,
            canonicalWorkspaceRoot: "/workspace",
            canonicalCwd: "/workspace",
            canonicalProjectId: "project-1",
            originSessionId: "session-1",
            originClient: "discord",
            revisionId: "revision-1",
            sourceSha256: HASH_A,
            inputSchemaSha256: HASH_A,
            capabilitySha256: HASH_B,
            argsSha256: HASH_A,
          },
          now: 13,
          expiresAt: 1_000,
          staleOwnerBefore: 0,
        }),
      ).not.toBeNull();
      expect(
        store.blockAmbiguousTerminalLifecycleOperation({
          runId: "run-manual",
          operationId: "operation-1",
          requestId: "wfr:manual",
          runOwnerId: "engine",
          now: 14,
        }),
      ).toBe(true);
      expect(store.getManualReconciliationDetail("run-manual")).toBe(
        WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      );

      expect(
        store.transitionRun({
          runId: "run-manual",
          from: "paused",
          to: "queued",
          now: 15,
        }),
      ).toBe(false);
      const messageRef = {
        platform: "discord" as const,
        channelId: "channel-1",
        messageId: "card-manual",
      };
      const resumeToken = "manual-resume-token-123456";
      expect(
        store.createSurfaceAction({
          actionId: "manual-resume",
          tokenSha256: sha256(resumeToken),
          runId: "run-manual",
          approvalId: null,
          kind: "resume",
          expectedPlatform: "discord",
          expectedUserId: "user-1",
          expectedMessageRef: messageRef,
          expiresAt: 1_000,
          consumedAt: null,
          consumedByPlatform: null,
          consumedByUserId: null,
          createdAt: 15,
        }),
      ).toBe(true);
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(resumeToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 16,
        }).status,
      ).toBe("stale");
      expect(store.getRun("run-manual")).toMatchObject({
        state: "paused",
        terminalDetail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(store.getOperation("run-manual", "operation-1")).toMatchObject({
        state: "blocked",
        attempt: 0,
        requestId: "wfr:manual",
        error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(
        (await buildWorkflowProgressView({ store, runId: "run-manual" })).availableActions,
      ).toEqual(["cancel"]);
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("creates revision, approval, and run transactionally and reuses active approval", () => {
    const path = dbPath("invocation");
    const store = new DurableWorkflowStore(path);
    try {
      const first = store.createInvocation({
        revision: revision(),
        run: run("run-1"),
        pendingApproval: approval("run-1"),
      });
      expect(first.revisionCreated).toBe(true);
      expect(first.approvalCreated).toBe(true);
      expect(first.run.approvalId).toBe("approval-1");
      expect(first.run.state).toBe("awaiting_review");

      const second = store.createInvocation({
        revision: revision(),
        run: run("run-2"),
        pendingApproval: approval("run-2", "approval-unused"),
      });
      expect(second.revisionCreated).toBe(false);
      expect(second.approvalCreated).toBe(false);
      expect(second.approval.approvalId).toBe("approval-1");
      expect(store.listRuns({ approvalId: "approval-1" })).toHaveLength(2);

      expect(
        store.transitionApproval({
          approvalId: "approval-1",
          from: "pending",
          to: "approved",
          now: 20,
          actorPlatform: "discord",
          actorUserId: "user-1",
          source: "message-1",
        }),
      ).toBe(true);
      expect(store.listRuns({ state: "queued" })).toHaveLength(2);
      expect(
        store.transitionApproval({
          approvalId: "approval-1",
          from: "pending",
          to: "approved",
          now: 21,
        }),
      ).toBe(true);

      expect(() =>
        store.createInvocation({
          revision: revision("revision-rollback", "c".repeat(64)),
          run: run("run-1", "revision-rollback"),
          pendingApproval: approval("run-1", "approval-rollback", "revision-rollback"),
        }),
      ).toThrow("already exists");
      expect(store.getRevision("revision-rollback")).toBeNull();
      expect(store.getApproval("approval-rollback")).toBeNull();
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("supports normalized CRUD, transitions, claims, tolerant reads, and one-shot actions", () => {
    const path = dbPath("crud");
    const store = new DurableWorkflowStore(path);
    try {
      store.createInvocation({
        revision: revision(),
        run: run("run-1"),
        pendingApproval: approval("run-1"),
      });
      store.transitionApproval({
        approvalId: "approval-1",
        from: "pending",
        to: "approved",
        now: 20,
      });

      expect(store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 30 })?.state).toBe(
        "running",
      );
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "worker-2", now: 31 })).toBeNull();
      expect(
        store.tryClaimRun({
          runId: "run-1",
          claimerId: "worker-2",
          now: 100,
          staleAfterMs: 50,
        })?.claimedBy,
      ).toBe("worker-2");

      expect(store.createOperation(operation(), "worker-2")).toBe(true);
      expect(store.createOperation(operation(), "worker-2")).toBe(false);
      expect(
        store.tryClaimOperation({
          runId: "run-1",
          operationId: "operation-1",
          claimerId: "worker-1",
          runOwnerId: "worker-2",
          now: 110,
        })?.state,
      ).toBe("dispatched");
      expect(
        store.tryClaimOperation({
          runId: "run-1",
          operationId: "operation-1",
          claimerId: "worker-2",
          runOwnerId: "worker-2",
          now: 111,
        }),
      ).toBeNull();
      expect(
        store.transitionOperation({
          runOwnerId: "worker-2",
          runId: "run-1",
          operationId: "operation-1",
          from: "dispatched",
          to: "running",
          now: 120,
          requestId: "wfr:run-1:operation-1:0",
        }),
      ).toBe(true);

      const wait: WorkflowWait = {
        runId: "run-1",
        operationId: "operation-1",
        state: "pending",
        match: {
          kind: "reply",
          platform: "discord",
          channelId: "channel-1",
          messageId: null,
          fromUserId: "user-1",
        },
        matchKey: "discord:channel-1",
        dueAt: null,
        deadlineAt: 1_000,
        resolverCursor: null,
        result: null,
        resolvedBy: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 120,
        updatedAt: 120,
        resolvedAt: null,
      };
      expect(store.createWait(wait, "worker-2")).toBe(true);
      expect(store.listWaits({ matchKind: "reply", matchKey: "discord:channel-1" })).toHaveLength(
        1,
      );
      expect(
        store.tryClaimWait({
          runId: "run-1",
          operationId: "operation-1",
          claimerId: "resolver-1",
          runOwnerId: "worker-2",
          now: 130,
        })?.state,
      ).toBe("claimed");
      expect(
        store.transitionWait({
          runOwnerId: "worker-2",
          runId: "run-1",
          operationId: "operation-1",
          from: "claimed",
          to: "resolved",
          now: 140,
          result: { text: "approved" },
          resolvedBy: "message-2",
        }),
      ).toBe(true);
      expect(
        store.transitionWait({
          runOwnerId: "worker-2",
          runId: "run-1",
          operationId: "operation-1",
          from: "claimed",
          to: "resolved",
          now: 141,
        }),
      ).toBe(true);

      const trigger: WorkflowTrigger = {
        triggerId: "trigger-1",
        revisionId: "revision-1",
        state: "active",
        definition: { kind: "timestamp", at: 200 },
        args: {},
        argsSha256: HASH_A,
        schedulingPolicy: { skipMissed: true, overlap: "coalesce" },
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
        nextFireAt: 200,
        lastFireAt: null,
        lastRunId: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 150,
        updatedAt: 150,
      };
      expect(store.createTrigger(trigger)).toBe(true);
      expect(store.listTriggers({ state: "active", dueBefore: 199 })).toHaveLength(0);
      expect(
        store.tryClaimDueTrigger({ triggerId: "trigger-1", claimerId: "scheduler-1", now: 200 })
          ?.claimedBy,
      ).toBe("scheduler-1");
      expect(
        store.tryClaimDueTrigger({ triggerId: "trigger-1", claimerId: "scheduler-2", now: 201 }),
      ).toBeNull();

      const binding: WorkflowSurfaceBinding = {
        runId: "run-1",
        target: { platform: "discord", channelId: "channel-1", replyToMessageId: null },
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: 210,
        repairGeneration: 0,
        renderedRepairGeneration: 0,
        sendMayHaveSucceeded: false,
        discoveryCursor: null,
        createdAt: 150,
        updatedAt: 150,
      };
      store.upsertSurfaceBinding(binding);
      store.upsertSurfaceBinding({
        ...binding,
        messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
        lastRenderedSha256: HASH_B,
        nextAttemptAt: null,
        updatedAt: 220,
      });
      expect(store.getSurfaceBinding("run-1")?.lastRenderedSha256).toBe(HASH_B);

      const action: WorkflowSurfaceAction = {
        actionId: "action-1",
        tokenSha256: HASH_A,
        runId: "run-1",
        approvalId: "approval-1",
        kind: "cancel",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
        expiresAt: 1_000,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 200,
      };
      expect(store.createSurfaceAction(action)).toBe(true);
      expect(
        store.consumeSurfaceAction({
          tokenSha256: HASH_A,
          platform: "discord",
          userId: "other",
          now: 230,
        }),
      ).toBeNull();
      expect(
        store.consumeSurfaceAction({
          tokenSha256: HASH_A,
          platform: "discord",
          userId: "user-1",
          now: 230,
        })?.consumedAt,
      ).toBe(230);
      expect(
        store.consumeSurfaceAction({
          tokenSha256: HASH_A,
          platform: "discord",
          userId: "user-1",
          now: 231,
        }),
      ).toBeNull();

      expect(
        store.transitionOperation({
          runOwnerId: "worker-2",
          runId: "run-1",
          operationId: "operation-1",
          from: "running",
          to: "succeeded",
          now: 240,
          output: "complete",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "run-1",
          from: "running",
          to: "succeeded",
          now: 250,
          result: "done",
        }),
      ).toBe(true);
      expect(
        store.transitionRun({ runId: "run-1", from: "running", to: "succeeded", now: 251 }),
      ).toBe(true);

      const corrupt = new Database(path);
      corrupt.run("UPDATE workflow_operations SET input_json = 'not-json' WHERE operation_id = ?", [
        "operation-1",
      ]);
      corrupt.close();
      expect(store.listOperations("run-1")).toEqual([]);
      expect(() => store.getOperation("run-1", "operation-1")).toThrow("Invalid workflow JSON");

      expect(store.deleteSurfaceAction("action-1")).toBe(true);
      expect(store.deleteSurfaceBinding("run-1")).toBe(true);
      expect(store.deleteTrigger("trigger-1")).toBe(true);
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });

  it("atomically authorizes, applies, rejects stale actions, and pauses runs on revocation", () => {
    const path = dbPath("surface-actions");
    const store = new DurableWorkflowStore(path);
    try {
      store.createInvocation({
        revision: revision(),
        run: run("run-1"),
        pendingApproval: approval("run-1"),
      });
      store.createInvocation({
        revision: revision(),
        run: run("run-2"),
        pendingApproval: approval("run-2", "unused-approval"),
      });
      const token = "opaque-action-token-123456";
      const messageRef = {
        platform: "discord" as const,
        channelId: "channel-1",
        messageId: "card-1",
      };
      expect(
        store.createSurfaceAction({
          actionId: "approve-action",
          tokenSha256: sha256(token),
          runId: "run-1",
          approvalId: "approval-1",
          kind: "approve",
          expectedPlatform: "discord",
          expectedUserId: "user-1",
          expectedMessageRef: messageRef,
          expiresAt: 1_000,
          consumedAt: null,
          consumedByPlatform: null,
          consumedByUserId: null,
          createdAt: 10,
        }),
      ).toBe(true);

      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(token),
          platform: "discord",
          userId: "attacker",
          messageRef,
          now: 20,
        }).status,
      ).toBe("unauthorized");
      expect(store.getSurfaceAction("approve-action")?.consumedAt).toBeNull();
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(token),
          platform: "discord",
          userId: "user-1",
          messageRef: { ...messageRef, messageId: "copied-card" },
          now: 21,
        }).status,
      ).toBe("unauthorized");

      const applied = store.applySurfaceAction({
        tokenSha256: sha256(token),
        platform: "discord",
        userId: "user-1",
        messageRef,
        sourceMessageId: "interaction-1",
        now: 22,
      });
      expect(applied).toMatchObject({ status: "applied", runIds: ["run-1", "run-2"] });
      expect(store.listRuns({ state: "queued" })).toHaveLength(2);
      expect(store.getApproval("approval-1")).toMatchObject({
        state: "approved",
        decisionActorUserId: "user-1",
      });
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(token),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 23,
        }).status,
      ).toBe("consumed");

      const staleToken = "opaque-stale-token-123456";
      store.createSurfaceAction({
        actionId: "stale-action",
        tokenSha256: sha256(staleToken),
        runId: "run-1",
        approvalId: "approval-1",
        kind: "approve",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: messageRef,
        expiresAt: 1_000,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 23,
      });
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(staleToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 24,
        }).status,
      ).toBe("stale");

      expect(
        store.tryClaimApprovedRun({ runId: "run-1", claimerId: "surface-engine", now: 24 }),
      ).not.toBeNull();
      expect(store.createOperation(operation("run-1"), "surface-engine")).toBe(true);
      const dispatchToken = "surface-pause-dispatch-token-123456";
      expect(
        store.authorizeAgentDispatch({
          requestId: "wfr:surface-pause",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "surface-engine",
          token: dispatchToken,
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: {
            runId: "run-1",
            operationId: "operation-1",
            dispatchEpoch: "dispatch-epoch-pause",
            profile: "explore",
            safetyMode: "trusted",
            editing: false,
            isolation: "shared",
            externalTools: false,
            surfaceSends: false,
            subagents: false,
            canonicalWorkspaceRoot: "/workspace",
            canonicalCwd: "/workspace",
            canonicalProjectId: "project-1",
            originSessionId: "session-1",
            originClient: "discord",
            revisionId: "revision-1",
            sourceSha256: HASH_A,
            inputSchemaSha256: HASH_A,
            capabilitySha256: HASH_B,
            argsSha256: HASH_A,
          },
          now: 24,
          expiresAt: 1_000,
          staleOwnerBefore: 0,
        }),
      ).not.toBeNull();

      for (const [kind, expectedState] of [
        ["pause", "paused"],
        ["resume", "queued"],
      ] as const) {
        const runToken = `opaque-${kind}-token-123456`;
        store.createSurfaceAction({
          actionId: `${kind}-action`,
          tokenSha256: sha256(runToken),
          runId: "run-1",
          approvalId: null,
          kind,
          expectedPlatform: "discord",
          expectedUserId: "user-1",
          expectedMessageRef: messageRef,
          expiresAt: 1_000,
          consumedAt: null,
          consumedByPlatform: null,
          consumedByUserId: null,
          createdAt: 24,
        });
        expect(
          store.applySurfaceAction({
            tokenSha256: sha256(runToken),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 24,
          }).status,
        ).toBe("applied");
        expect(store.getRun("run-1")?.state).toBe(expectedState);
        if (kind === "pause") {
          expect(store.getOperation("run-1", "operation-1")).toMatchObject({
            state: "dispatched",
            attempt: 0,
            requestId: "wfr:surface-pause",
          });
          expect(
            store.authorizeWorkflowRequest({
              requestId: "wfr:surface-pause",
              token: dispatchToken,
              sessionId: "workflow:run-1:operation-1",
              platform: "unknown",
              now: 25,
            }),
          ).toBeNull();
        }
      }

      expect(
        store.transitionApproval({
          approvalId: "approval-1",
          from: "approved",
          to: "revoked",
          now: 25,
          reason: "policy changed",
        }),
      ).toBe(true);
      expect(store.listRuns({ state: "paused" })).toHaveLength(2);

      store.createInvocation({
        revision: revision("revision-2", "e".repeat(64)),
        run: run("run-3", "revision-2"),
        pendingApproval: approval("run-3", "approval-2", "revision-2"),
      });
      const rejectToken = "opaque-reject-token-123456";
      store.createSurfaceAction({
        actionId: "reject-action",
        tokenSha256: sha256(rejectToken),
        runId: "run-3",
        approvalId: "approval-2",
        kind: "reject",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: messageRef,
        expiresAt: 1_000,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 26,
      });
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(rejectToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 27,
        }).status,
      ).toBe("applied");
      expect(store.getApproval("approval-2")?.state).toBe("rejected");
      expect(store.getRun("run-3")).toMatchObject({
        state: "rejected",
        terminalDetail: "Rejected by reviewer",
        terminalAt: 27,
      });
    } finally {
      store.close();
      rmSync(path, { force: true });
    }
  });
});
