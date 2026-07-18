import { describe, expect, it } from "bun:test";

import {
  canTransitionWorkflowOperation,
  canTransitionWorkflowRun,
  canTransitionWorkflowTrigger,
  canTransitionWorkflowWait,
  normalizeWorkflowResourcePolicy,
  workflowOperationSchema,
  workflowRevisionSchema,
  workflowRunSchema,
  workflowSurfaceActionSchema,
  workflowSurfaceBindingSchema,
  workflowTriggerSchema,
  workflowWaitSchema,
} from "../../src/workflow/workflow-domain";

const HASH = "a".repeat(64);

function resources() {
  return {
    agents: {
      maxConcurrent: 2,
      maxTotal: 8,
    },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10_000,
    waits: ["sleep", "reply", "sleep"] as const,
  };
}

describe("durable workflow domain", () => {
  it("normalizes durability controls and enforces resource invariants", () => {
    const normalized = normalizeWorkflowResourcePolicy(resources());
    expect(normalized.agents).toEqual({ maxConcurrent: 2, maxTotal: 8 });
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
        resourcePolicySha256: HASH,
        metadata: { name: "audit", description: "Audit" },
        inputSchema: {},
        resources: resources(),
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
      normalizeWorkflowResourcePolicy({
        ...resources(),
        agents: { ...resources().agents, tools: ["read_file"] },
      }),
    ).toThrow("Unrecognized key");
    expect(() =>
      normalizeWorkflowResourcePolicy({
        ...resources(),
        agents: { ...resources().agents, maxConcurrent: 9 },
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
      resourcePolicySha256: HASH,
      metadata: { name: "audit", description: "Audit the project" },
      inputSchema: { type: "object", additionalProperties: false },
      resources: normalizeWorkflowResourcePolicy(resources()),
      limits: {
        maxSourceBytes: 10_000,
        maxInputBytes: 10_000,
        maxOperationOutputBytes: 10_000,
        maxResultBytes: 10_000,
      },
      runtimeVersion: "quickjs-v1",
      createdAt: 1,
    });
    const run = workflowRunSchema.parse({
      runId: "run-1",
      revisionId: revision.revisionId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args: { directory: "src" },
      argsSha256: HASH,
      origin: {
        requestId: "request-1",
        sessionId: "session-1",
        client: "discord",
        userId: "user-1",
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
        createdAt: 1,
        updatedAt: 1,
      }).runId,
    ).toBe(run.runId);
    expect(
      workflowSurfaceActionSchema.parse({
        actionId: "action-1",
        tokenSha256: HASH,
        runId: run.runId,
        kind: "pause",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: null,
        expiresAt: 1_000,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 1,
      }).kind,
    ).toBe("pause");

    expect(() => workflowRunSchema.parse({ ...run, unexpected: true })).toThrow();
  });

  it("defines legal, terminal, and idempotent state transitions", () => {
    expect(canTransitionWorkflowRun("queued", "running")).toBe(true);
    expect(canTransitionWorkflowRun("queued", "succeeded")).toBe(false);
    expect(canTransitionWorkflowRun("succeeded", "running")).toBe(false);
    expect(canTransitionWorkflowRun("running", "running")).toBe(true);
    expect(canTransitionWorkflowOperation("failed", "queued")).toBe(true);
    expect(canTransitionWorkflowOperation("succeeded", "queued")).toBe(false);
    expect(canTransitionWorkflowWait("claimed", "pending")).toBe(true);
    expect(canTransitionWorkflowWait("resolved", "pending")).toBe(false);
    expect(canTransitionWorkflowTrigger("paused", "active")).toBe(true);
    expect(canTransitionWorkflowTrigger("cancelled", "active")).toBe(false);
  });
});
