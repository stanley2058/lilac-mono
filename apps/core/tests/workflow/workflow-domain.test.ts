import { describe, expect, it } from "bun:test";

import {
  canTransitionWorkflowApproval,
  canTransitionWorkflowOperation,
  canTransitionWorkflowRun,
  canTransitionWorkflowTrigger,
  canTransitionWorkflowWait,
  normalizeWorkflowCapabilityProfile,
  workflowApprovalSchema,
  workflowOperationSchema,
  workflowRevisionSchema,
  workflowRunSchema,
  workflowSurfaceActionSchema,
  workflowSurfaceBindingSchema,
  workflowTriggerSchema,
  workflowWaitSchema,
} from "../../src/workflow/workflow-domain";

const HASH = "a".repeat(64);

function capabilities() {
  return {
    agents: {
      profiles: ["self", "explore", "self"],
      models: ["inherit", "fast", "inherit"],
      editing: false,
      isolation: "shared" as const,
      maxConcurrent: 2,
      maxTotal: 8,
    },
    maxNestingDepth: 4,
    maxWallTimeMs: 60_000,
    operationIdleTimeoutMs: 10_000,
    waits: ["sleep", "reply", "sleep"] as const,
    surfaceSends: false,
    externalTools: false,
    safety: { originatingMode: "trusted" as const, escalation: "none" as const },
  };
}

describe("durable workflow domain", () => {
  it("normalizes capability sets and enforces safety invariants", () => {
    const normalized = normalizeWorkflowCapabilityProfile(capabilities());
    expect(normalized.agents.profiles).toEqual(["explore", "self"]);
    expect(normalized.agents.models).toEqual(["fast", "inherit"]);
    expect(normalized.waits).toEqual(["reply", "sleep"]);
    expect(() =>
      workflowRevisionSchema.parse({
        revisionId: "invalid",
        canonicalProjectId: "project-1",
        canonicalWorkspaceRoot: "/workspace",
        scope: "project",
        normalizedPath: "audit.js",
        name: "audit",
        snapshotArtifactId: "artifact-1",
        sourceSha256: HASH,
        inputSchemaSha256: HASH,
        capabilitySha256: HASH,
        metadata: { name: "audit", description: "Audit" },
        inputSchema: {},
        capabilities: capabilities(),
        limits: {
          maxSourceBytes: 1,
          maxInputBytes: 1,
          maxOperationOutputBytes: 1,
          maxResultBytes: 1,
        },
        runtimeVersion: "v1",
        createdAt: 1,
      }),
    ).toThrow("sorted and unique");

    expect(() =>
      normalizeWorkflowCapabilityProfile({
        ...capabilities(),
        agents: { ...capabilities().agents, editing: true },
      }),
    ).toThrow("worktree isolation");
    expect(() =>
      normalizeWorkflowCapabilityProfile({
        ...capabilities(),
        agents: { ...capabilities().agents, maxConcurrent: 9 },
      }),
    ).toThrow("maxConcurrent");
  });

  it("validates all persisted entity contracts and rejects extra fields", () => {
    const revision = workflowRevisionSchema.parse({
      revisionId: "rev-1",
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: "audit.js",
      name: "audit",
      snapshotArtifactId: "artifact-1",
      sourceSha256: HASH,
      inputSchemaSha256: HASH,
      capabilitySha256: HASH,
      metadata: { name: "audit", description: "Audit the project" },
      inputSchema: { type: "object", additionalProperties: false },
      capabilities: normalizeWorkflowCapabilityProfile(capabilities()),
      limits: {
        maxSourceBytes: 10_000,
        maxInputBytes: 10_000,
        maxOperationOutputBytes: 10_000,
        maxResultBytes: 10_000,
      },
      runtimeVersion: "quickjs-v1",
      createdAt: 1,
    });
    const approval = workflowApprovalSchema.parse({
      approvalId: "approval-1",
      revisionId: revision.revisionId,
      state: "pending",
      expectedReviewerPlatform: "discord",
      expectedReviewerUserId: "user-1",
      firstRunId: "run-1",
      decisionActorPlatform: null,
      decisionActorUserId: null,
      decisionSource: null,
      expiresAt: null,
      decidedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const run = workflowRunSchema.parse({
      runId: "run-1",
      revisionId: revision.revisionId,
      approvalId: approval.approvalId,
      state: "awaiting_review",
      inputSchemaSnapshot: revision.inputSchema,
      args: { directory: "src" },
      argsSha256: HASH,
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
      createdAt: 1,
      startedAt: null,
      updatedAt: 1,
      terminalAt: null,
    });
    const operation = workflowOperationSchema.parse({
      runId: run.runId,
      operationId: "operation-1",
      callSiteId: "call-1",
      parentOperationId: null,
      phase: "audit",
      label: "Inspect routes",
      kind: "agent",
      input: { prompt: "inspect" },
      inputSha256: HASH,
      state: "queued",
      attempt: 0,
      requestId: null,
      output: null,
      resultArtifactId: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 1,
      startedAt: null,
      updatedAt: 1,
      terminalAt: null,
    });
    expect(
      workflowWaitSchema.parse({
        runId: run.runId,
        operationId: operation.operationId,
        state: "pending",
        match: { kind: "sleep" },
        matchKey: "sleep:100",
        dueAt: 100,
        deadlineAt: null,
        resolverCursor: null,
        result: null,
        resolvedBy: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null,
      }).state,
    ).toBe("pending");
    expect(
      workflowTriggerSchema.parse({
        triggerId: "trigger-1",
        revisionId: revision.revisionId,
        state: "active",
        definition: { kind: "timestamp", at: 100 },
        args: {},
        argsSha256: HASH,
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
        nextFireAt: 100,
        lastFireAt: null,
        lastRunId: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 1,
        updatedAt: 1,
      }).definition.kind,
    ).toBe("timestamp");
    expect(
      workflowSurfaceBindingSchema.parse({
        runId: run.runId,
        target: { platform: "discord", channelId: "channel-1", replyToMessageId: null },
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        repairGeneration: 0,
        renderedRepairGeneration: 0,
        createdAt: 1,
        updatedAt: 1,
      }).runId,
    ).toBe(run.runId);
    expect(
      workflowSurfaceActionSchema.parse({
        actionId: "action-1",
        tokenSha256: HASH,
        runId: run.runId,
        approvalId: approval.approvalId,
        kind: "approve",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: null,
        expiresAt: 1_000,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 1,
      }).kind,
    ).toBe("approve");

    expect(() => workflowRunSchema.parse({ ...run, unexpected: true })).toThrow();
  });

  it("defines legal, terminal, and idempotent state transitions", () => {
    expect(canTransitionWorkflowRun("awaiting_review", "queued")).toBe(true);
    expect(canTransitionWorkflowRun("queued", "succeeded")).toBe(false);
    expect(canTransitionWorkflowRun("succeeded", "running")).toBe(false);
    expect(canTransitionWorkflowRun("running", "running")).toBe(true);
    expect(canTransitionWorkflowApproval("pending", "approved")).toBe(true);
    expect(canTransitionWorkflowApproval("revoked", "approved")).toBe(false);
    expect(canTransitionWorkflowOperation("failed", "queued")).toBe(true);
    expect(canTransitionWorkflowOperation("succeeded", "queued")).toBe(false);
    expect(canTransitionWorkflowWait("claimed", "pending")).toBe(true);
    expect(canTransitionWorkflowWait("resolved", "pending")).toBe(false);
    expect(canTransitionWorkflowTrigger("paused", "active")).toBe(true);
    expect(canTransitionWorkflowTrigger("cancelled", "active")).toBe(false);
  });
});
