import type { NativeStore } from "../../../src/surface/native/store";
import type { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import type {
  WorkflowRun,
  WorkflowRevision,
  WorkflowOperation,
} from "../../../src/workflow/workflow-domain";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../../src/workflow/workflow-definition";
import { workflowSourceArtifactReferenceForTest } from "../../workflow/workflow-test-blob-store";

export function seedNativeSubagent(
  store: NativeStore,
  workflows: DurableWorkflowStore,
  threadId: string,
  options: {
    id?: string;
    parentRequestId?: string;
    parentSessionId?: string;
    /** Reuse a child session to seed a follow-up run. */
    childSessionId?: string;
    title?: string;
  } = {},
) {
  const input = store.listCanonicalRequestIds(threadId).unwrap().at(-1)!;
  const id = options.id ?? crypto.randomUUID();
  const now = Date.now();
  const resources: WorkflowRevision["resources"] = {
    agents: { maxConcurrent: 2, maxTotal: 4 },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10000,
    waits: [],
  };
  const limits: WorkflowRevision["limits"] = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  const revision: WorkflowRevision = {
    revisionId: `revision-${id}`,
    canonicalProjectId: "native-stream-test",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: `${id}.js`,
    name: "Research",
    snapshotArtifact: workflowSourceArtifactReferenceForTest(id),
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "Research", description: "Inspect shared streaming" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: now,
  };
  workflows.createRevision(revision);
  const run: WorkflowRun = {
    runId: `wfrun:subagent:${id}`,
    revisionId: revision.revisionId,
    state: "running",
    inputSchemaSnapshot: {},
    args: {},
    argsSha256: canonicalJsonSha256({}),
    origin: {
      requestId: input,
      sessionId: `native:${threadId}`,
      client: "native",
      userId: "owner",
      projectCwd: "/workspace",
    },
    completionTarget: {
      kind: "live_parent",
      parentRequestId: options.parentRequestId ?? input,
      parentSessionId: options.parentSessionId ?? `native:${threadId}`,
      parentRequestClient: "native",
      parentToolCallId: `spawn-${id}`,
      childRequestId: `child-${id}`,
      childSessionId: options.childSessionId ?? `child-session-${id}`,
      profile: "general",
      sessionName: "Research",
      ...(options.title ? { title: options.title } : {}),
      depth: options.parentRequestId ? 2 : 1,
      reasoning: null,
      fallbackToSurface: false,
      fallbackProgressTarget: null,
      deferredDelivery: true,
    },
    progressTarget: null,
    terminalDetail: null,
    result: null,
    resultArtifact: null,
    claimedBy: "test-worker",
    claimedAt: now,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    terminalAt: null,
  };
  workflows.createRun(run);
  const operation: WorkflowOperation = {
    runId: run.runId,
    operationId: "agent",
    callSiteId: "agent",
    parentOperationId: null,
    phase: null,
    label: null,
    kind: "agent",
    input: { prompt: "Research the question", options: { profile: "general", cwd: "/workspace" } },
    inputSha256: "c".repeat(64),
    state: "running",
    attempt: 0,
    requestId: `wfr:${id}:agent:0`,
    output: null,
    resultArtifact: null,
    error: null,
    usage: null,
    claimedBy: "test-worker",
    claimedAt: now,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    terminalAt: null,
  };
  if (!workflows.createOperation(operation, "test-worker"))
    throw new Error("Could not seed child operation");
  return {
    run,
    operation,
    requestId: operation.requestId!,
    sessionId:
      run.completionTarget.kind === "live_parent" ? run.completionTarget.childSessionId : "",
    parentToolCallId: `spawn-${id}`,
  };
}
