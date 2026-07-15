import type {
  SubagentDelegationHandle,
  SubagentDelegationOutcome,
  SubagentDelegationRegistration,
} from "../tools/subagent";
import { DurableWorkflowStore } from "./durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  validateWorkflowSource,
  validateWorkflowArgs,
  WORKFLOW_RUNTIME_VERSION,
} from "./workflow-definition";
import { WorkflowDefinitionStore } from "./workflow-definition-store";
import type {
  WorkflowApproval,
  WorkflowCompletionTarget,
  WorkflowProgressTarget,
  WorkflowRevision,
  WorkflowRun,
} from "./workflow-domain";

const GENERATED_WORKFLOW_NAME = "subagent-delegate";

export type WorkflowSubagentPolicy = {
  editing: boolean;
  externalTools: boolean;
};

function generatedSource(input: {
  profile: SubagentDelegationRegistration["profile"];
  model: string;
  editing: boolean;
  externalTools: boolean;
  idleTimeoutMs: number;
}): string {
  const operationIdleTimeoutMs = Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(1_000, Math.trunc(input.idleTimeoutMs)),
  );
  const maxWallTimeMs = Math.min(
    7 * 24 * 60 * 60 * 1_000,
    Math.max(60_000, operationIdleTimeoutMs * 12),
  );
  return `import { defineWorkflow } from "@lilac/workflow";

export default defineWorkflow({
  name: "${GENERATED_WORKFLOW_NAME}",
  description: "Generated one-agent delegation run",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["task", "profile", "model"],
    properties: {
      task: { type: "string", minLength: 1 },
      profile: { type: "string", const: ${JSON.stringify(input.profile)} },
      model: { type: "string", const: ${JSON.stringify(input.model)} },
    },
  },
  capabilities: {
    agents: {
      profiles: [${JSON.stringify(input.profile)}],
      models: [${JSON.stringify(input.model)}],
      maxConcurrent: 1,
      maxTotal: 1,
      editing: ${input.editing},
      isolation: "shared",
    },
    waits: [],
    maxNestingDepth: 1,
    maxWallTimeMs: ${maxWallTimeMs},
    operationIdleTimeoutMs: ${operationIdleTimeoutMs},
    surfaceSends: false,
    externalTools: ${input.externalTools},
    safety: { escalation: "none" },
  },
  limits: {
    maxSourceBytes: 262144,
    maxInputBytes: 262144,
    maxOperationOutputBytes: 1048576,
    maxResultBytes: 1048576,
    maxRuntimeMemoryBytes: 268435456,
  },
  async run({ args, agent }) {
    return agent(args.task, {
      profile: args.profile,
      model: args.model,
      label: "subagent " + args.profile,
    });
  },
});
`;
}

function completionStatus(
  run: WorkflowRun,
  store: DurableWorkflowStore,
): SubagentDelegationOutcome {
  if (run.state === "succeeded") {
    const finalText = typeof run.result === "string" ? run.result : JSON.stringify(run.result);
    return { status: "resolved", finalText };
  }
  if (run.state === "cancelled") {
    return {
      status: "cancelled",
      finalText: "",
      detail: run.terminalDetail ?? "subagent cancelled",
    };
  }
  const timedOut = store
    .listOperations(run.runId, { limit: 1_000 })
    .some((operation) => operation.state === "timed_out");
  return {
    status: timedOut ? "timeout" : "failed",
    finalText: "",
    detail: run.terminalDetail ?? (timedOut ? "subagent timed out" : "subagent failed"),
  };
}

export class WorkflowSubagentDispatcher {
  private constructor(
    private readonly input: {
      store: DurableWorkflowStore;
      definitions: WorkflowDefinitionStore;
      now?: () => number;
      pollMs?: number;
      onRunCreated?: (run: WorkflowRun) => Promise<void>;
      onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
    },
  ) {}

  static async create(input: {
    store: DurableWorkflowStore;
    workspaceRoot: string;
    dataDir: string;
    now?: () => number;
    pollMs?: number;
    onRunCreated?: (run: WorkflowRun) => Promise<void>;
    onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
  }): Promise<WorkflowSubagentDispatcher> {
    const definitions = await WorkflowDefinitionStore.create({
      workspaceRoot: input.workspaceRoot,
      dataDir: input.dataDir,
    });
    return new WorkflowSubagentDispatcher({ ...input, definitions });
  }

  async delegate(
    registration: SubagentDelegationRegistration,
    policy: WorkflowSubagentPolicy,
  ): Promise<SubagentDelegationHandle> {
    const now = this.input.now?.() ?? Date.now();
    const model = registration.modelOverride ?? "inherit";
    const source = generatedSource({
      profile: registration.profile,
      model,
      editing: policy.editing,
      externalTools: policy.externalTools,
      idleTimeoutMs: registration.idleTimeoutMs,
    });
    const validation = validateWorkflowSource({
      name: GENERATED_WORKFLOW_NAME,
      source,
      safetyMode: "trusted",
    });
    const snapshot = await this.input.definitions.createSnapshot(source, validation.sourceSha256);
    const revisionId = `wfrev:subagent:${sha256(
      [
        this.input.definitions.canonicalProjectId,
        validation.sourceSha256,
        validation.inputSchemaSha256,
        validation.capabilitySha256,
        WORKFLOW_RUNTIME_VERSION,
      ].join(":"),
    ).slice(0, 48)}`;
    const revision: WorkflowRevision = {
      revisionId,
      canonicalProjectId: this.input.definitions.canonicalProjectId,
      canonicalWorkspaceRoot: this.input.definitions.canonicalWorkspaceRoot,
      scope: "project",
      normalizedPath: ".lilac/internal/subagent-delegate.js",
      name: GENERATED_WORKFLOW_NAME,
      snapshotArtifactId: snapshot.artifactId,
      sourceSha256: validation.sourceSha256,
      inputSchemaSha256: validation.inputSchemaSha256,
      capabilitySha256: validation.capabilitySha256,
      metadata: validation.metadata,
      inputSchema: validation.inputSchema,
      capabilities: validation.capabilities,
      limits: validation.limits,
      runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      createdAt: now,
    };
    const args = validateWorkflowArgs({
      inputSchema: revision.inputSchema,
      args: { task: registration.task, profile: registration.profile, model },
      maxInputBytes: revision.limits.maxInputBytes,
    });
    const runId = `wfrun:subagent:${crypto.randomUUID()}`;
    const fallbackProgressTarget: WorkflowProgressTarget | null =
      registration.parentRequestClient === "discord" ||
      registration.parentRequestClient === "github"
        ? {
            platform: registration.parentRequestClient,
            channelId: registration.parentSessionId,
            replyToMessageId: null,
          }
        : null;
    const completionTarget: WorkflowCompletionTarget = {
      kind: "live_parent",
      parentRequestId: registration.parentRequestId,
      parentSessionId: registration.parentSessionId,
      parentRequestClient: registration.parentHeaders.request_client,
      parentToolCallId: registration.parentToolCallId,
      childRequestId: registration.childRequestId,
      childSessionId: registration.childSessionId,
      profile: registration.profile,
      sessionName: registration.sessionName,
      depth: registration.depth,
      reasoning: registration.reasoningOverride ?? null,
      fallbackToSurface: fallbackProgressTarget !== null,
      fallbackProgressTarget,
    };
    const approvalId = `wfapproval:internal:${sha256(revisionId).slice(0, 48)}`;
    const approval: WorkflowApproval = {
      approvalId,
      revisionId,
      state: "approved",
      expectedReviewerPlatform: null,
      expectedReviewerUserId: null,
      firstRunId: runId,
      decisionActorPlatform: null,
      decisionActorUserId: null,
      decisionSource: "internal trusted subagent delegation",
      expiresAt: null,
      decidedAt: now,
      revokedAt: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now,
    };
    const requestedRun: WorkflowRun = {
      runId,
      revisionId,
      approvalId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args,
      argsSha256: canonicalJsonSha256(args),
      origin: {
        requestId: registration.parentRequestId,
        sessionId: registration.parentSessionId,
        client: registration.parentHeaders.request_client,
        userId: null,
        safetyMode: "trusted",
        projectCwd: this.input.definitions.canonicalWorkspaceRoot,
      },
      completionTarget,
      progressTarget: null,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      terminalAt: null,
    };
    const { run } = this.input.store.createApprovedInvocation({
      revision,
      run: requestedRun,
      approval,
    });
    await this.input.onRunCreated?.(run);
    const waitForCompletion = () => this.waitForCompletion(runId);

    return {
      runId,
      get completion() {
        return waitForCompletion();
      },
      cancel: async (detail) => {
        const current = this.input.store.getRun(runId);
        if (!current || ["succeeded", "failed", "rejected", "cancelled"].includes(current.state)) {
          return;
        }
        if (
          this.input.store.transitionRun({
            runId,
            from: current.state,
            to: "cancelled",
            now: this.input.now?.() ?? Date.now(),
            detail,
          })
        ) {
          const cancelled = this.input.store.getRun(runId);
          if (cancelled) await this.input.onRunCancelled?.(cancelled, current.state);
        }
      },
    };
  }

  private async waitForCompletion(runId: string): Promise<SubagentDelegationOutcome> {
    while (true) {
      const run = this.input.store.getRun(runId);
      if (!run) throw new Error(`Subagent workflow run disappeared: ${runId}`);
      if (["succeeded", "failed", "rejected", "cancelled"].includes(run.state)) {
        return completionStatus(run, this.input.store);
      }
      await Bun.sleep(this.input.pollMs ?? 100);
    }
  }
}
