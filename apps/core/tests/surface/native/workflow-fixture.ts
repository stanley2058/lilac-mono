import type { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import type {
  WorkflowOperation,
  WorkflowRevision,
  WorkflowRun,
} from "../../../src/workflow/workflow-domain";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../../src/workflow/workflow-definition";
import { normalizeWorkflowResourcePolicy } from "../../workflow/workflow-store-test-helpers";
import { workflowArtifactReferenceForTest } from "../../workflow/workflow-test-blob-store";

/** Seeds one top-level workflow run. Pass `threadId` to bind it to a native conversation. */
export function seedNativeWorkflowRun(
  workflows: DurableWorkflowStore,
  options: {
    id: string;
    name: string;
    state: WorkflowRun["state"];
    threadId?: string;
    platform?: "discord";
    createdAt: number;
    completed?: number;
    total?: number;
    result?: WorkflowRun["result"];
    detail?: string;
  },
) {
  const resources = normalizeWorkflowResourcePolicy({
    // Seeding stops at the run's agent cap, so the cap covers every seeded step.
    agents: { maxConcurrent: 2, maxTotal: Math.max(4, options.total ?? 0) },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10000,
    waits: [],
  });
  const limits: WorkflowRevision["limits"] = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  const revision: WorkflowRevision = {
    revisionId: `revision-${options.id}`,
    canonicalProjectId: "native-workflow-view",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: `${options.id}.js`,
    name: options.name,
    snapshotArtifact: workflowArtifactReferenceForTest(`workflow-source:${"a".repeat(64)}`),
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: options.name, description: options.name },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: options.createdAt,
  };
  workflows.createRevision(revision);
  const terminal = ["succeeded", "failed", "cancelled"].includes(options.state);
  const channelId = options.threadId ?? (options.platform ? "external-channel" : undefined);
  const run: WorkflowRun = {
    runId: `wfrun:${options.id}`,
    revisionId: revision.revisionId,
    state: "running",
    inputSchemaSnapshot: {},
    args: {},
    argsSha256: canonicalJsonSha256({}),
    origin: {
      requestId: `request-${options.id}`,
      sessionId: channelId ?? `session-${options.id}`,
      client: options.threadId ? "native" : (options.platform ?? null),
      userId: "owner",
      projectCwd: "/workspace",
    },
    completionTarget: channelId ? { kind: "durable_surface" } : { kind: "detached" },
    progressTarget: channelId
      ? {
          platform: options.threadId ? "native" : options.platform!,
          channelId,
          replyToMessageId: null,
        }
      : null,
    terminalDetail: null,
    result: null,
    resultArtifact: null,
    claimedBy: "test-worker",
    claimedAt: options.createdAt,
    createdAt: options.createdAt,
    startedAt: options.createdAt,
    updatedAt: options.createdAt,
    terminalAt: null,
  };
  workflows.createRun(run);
  const unfinishedState = terminal ? "cancelled" : "queued";
  for (let index = 0; index < (options.total ?? 0); index += 1) {
    const done = index < (options.completed ?? 0);
    const operation: WorkflowOperation = {
      runId: run.runId,
      operationId: `agent-${index}`,
      callSiteId: `agent-${index}`,
      parentOperationId: null,
      phase: null,
      label: `Step ${index + 1}`,
      kind: "agent",
      input: { prompt: "Work", options: { profile: "general", cwd: "/workspace" } },
      inputSha256: "c".repeat(64),
      state: done ? "succeeded" : unfinishedState,
      attempt: 0,
      requestId: `wfr:${options.id}:agent-${index}:0`,
      output: null,
      resultArtifact: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: options.createdAt,
      startedAt: done || terminal ? options.createdAt : null,
      updatedAt: options.createdAt,
      terminalAt: done || terminal ? options.createdAt : null,
    };
    if (!workflows.createOperation(operation, "test-worker"))
      throw new Error("Could not seed workflow operation");
  }
  // Operations can only be added to a claimed running run, so move to the final state last.
  if (options.state !== "running")
    workflows.transitionRun({
      runId: run.runId,
      from: "running",
      to: options.state,
      now: options.createdAt + 60_000,
      detail: options.detail,
      result: options.result,
    });
  return run;
}
