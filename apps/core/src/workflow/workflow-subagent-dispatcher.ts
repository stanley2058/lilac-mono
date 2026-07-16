import fs from "node:fs/promises";
import path from "node:path";

import type {
  SubagentDelegationHandle,
  SubagentDelegationOutcome,
  SubagentDelegationRegistration,
  TrustedSubagentDelegationRegistration,
} from "../tools/subagent";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
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
import { readWorkflowValueArtifact } from "./workflow-artifact-store";
import { resolveWorkflowSubagentToolResult } from "./workflow-subagent-output";

const GENERATED_WORKFLOW_NAME = "subagent-delegate";

export type WorkflowSubagentPolicy = {
  editing: boolean;
  level2Callables: readonly string[];
};

function generatedSource(input: {
  profile: SubagentDelegationRegistration["profile"];
  model: string;
  reasoning: string;
  editing: boolean;
  level2Callables: readonly string[];
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
      reasoning: [${JSON.stringify(input.reasoning)}],
      allowedRoots: ["project"],
      tools: ${JSON.stringify(input.profile === "explore" ? ["batch", "glob", "grep", "read_file"] : ["apply_patch", "bash", "batch", "glob", "grep", "read_file"])},
      executables: ${JSON.stringify(input.profile === "explore" ? "none" : "trusted-container")},
      maxConcurrent: 1,
      maxTotal: 1,
      editing: ${JSON.stringify(input.editing ? ["shared"] : [])},
      delegation: false,
    },
    level2: { callables: ${JSON.stringify(input.level2Callables)} },
    surfaces: { origin: [] },
    waits: [],
    maxNestingDepth: 1,
    maxWallTimeMs: ${maxWallTimeMs},
    operationIdleTimeoutMs: ${operationIdleTimeoutMs},
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
      reasoning: ${JSON.stringify(input.reasoning)},
      editing: ${input.editing},
      ${input.editing ? 'isolation: "shared",' : ""}
      executables: ${JSON.stringify(input.profile === "explore" ? "none" : "trusted-container")},
      level2Callables: ${JSON.stringify(input.level2Callables)},
      surfaceOriginOperations: [],
      label: "subagent " + args.profile,
    });
  },
});
`;
}

async function completionStatus(
  run: WorkflowRun,
  store: DurableWorkflowStore,
  dataDir: string,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<SubagentDelegationOutcome> {
  if (run.state === "succeeded") {
    const revision = store.getRevision(run.revisionId);
    if (!revision) throw new Error(`Subagent workflow revision disappeared: ${run.revisionId}`);
    const result = run.resultArtifactId
      ? await readWorkflowValueArtifact({
          dataDir,
          artifactId: run.resultArtifactId,
          maxBytes: revision.limits.maxResultBytes,
        })
      : run.result;
    const rawFinalText = typeof result === "string" ? result : JSON.stringify(result);
    const finalText =
      run.completionTarget.kind === "live_parent"
        ? await resolveWorkflowSubagentToolResult({
            finalText: rawFinalText,
            childSessionId: run.completionTarget.childSessionId,
            artifacts: toolResultArtifacts,
          })
        : rawFinalText;
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
  private readonly definitionsStores = new Map<string, Promise<WorkflowDefinitionStore>>();

  private constructor(
    private readonly input: {
      store: DurableWorkflowStore;
      dataDir: string;
      toolResultArtifacts?: ToolResultArtifactStore;
      now?: () => number;
      pollMs?: number;
      onRunCreated?: (run: WorkflowRun) => Promise<void>;
      onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
    },
  ) {}

  static create(input: {
    store: DurableWorkflowStore;
    dataDir: string;
    toolResultArtifacts?: ToolResultArtifactStore;
    now?: () => number;
    pollMs?: number;
    onRunCreated?: (run: WorkflowRun) => Promise<void>;
    onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
  }): WorkflowSubagentDispatcher {
    return new WorkflowSubagentDispatcher(input);
  }

  private async definitions(projectRoot: string): Promise<WorkflowDefinitionStore> {
    const requestedRoot = path.resolve(projectRoot);
    const stats = await fs.lstat(requestedRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Subagent workflow project root must be a real directory: ${requestedRoot}`);
    }
    const canonicalRoot = await fs.realpath(requestedRoot);
    let definitions = this.definitionsStores.get(canonicalRoot);
    if (!definitions) {
      definitions = WorkflowDefinitionStore.create({
        workspaceRoot: canonicalRoot,
        dataDir: this.input.dataDir,
      });
      this.definitionsStores.set(canonicalRoot, definitions);
      definitions.catch(() => this.definitionsStores.delete(canonicalRoot));
    }
    return await definitions;
  }

  async delegate(
    registration: TrustedSubagentDelegationRegistration,
    policy: WorkflowSubagentPolicy,
  ): Promise<SubagentDelegationHandle> {
    const definitions = await this.definitions(registration.projectRoot);
    const now = this.input.now?.() ?? Date.now();
    const model = registration.modelOverride ?? "inherit";
    const reasoning = registration.reasoningOverride ?? "provider-default";
    const source = generatedSource({
      profile: registration.profile,
      model,
      reasoning,
      editing: policy.editing,
      level2Callables: policy.level2Callables,
      idleTimeoutMs: registration.idleTimeoutMs,
    });
    const validation = validateWorkflowSource({
      name: GENERATED_WORKFLOW_NAME,
      source,
      safetyMode: "trusted",
    });
    const snapshot = await definitions.createSnapshot(source, validation.sourceSha256);
    const revisionId = `wfrev:subagent:${sha256(
      [
        definitions.canonicalProjectId,
        validation.sourceSha256,
        validation.inputSchemaSha256,
        validation.capabilitySha256,
        WORKFLOW_RUNTIME_VERSION,
      ].join(":"),
    ).slice(0, 48)}`;
    const revision: WorkflowRevision = {
      revisionId,
      canonicalProjectId: definitions.canonicalProjectId,
      canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
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
    const fallbackProgressTarget: WorkflowProgressTarget | null = {
      platform: registration.fallbackSurface.platform,
      channelId: registration.fallbackSurface.sessionId,
      replyToMessageId: null,
    };
    const completionTarget: WorkflowCompletionTarget = {
      kind: "live_parent",
      parentRequestId: registration.parentRequestId,
      parentSessionId: registration.parentSessionId,
      parentRequestClient: registration.fallbackSurface.platform,
      parentToolCallId: registration.parentToolCallId,
      childRequestId: registration.childRequestId,
      childSessionId: registration.childSessionId,
      profile: registration.profile,
      sessionName: registration.sessionName,
      depth: registration.depth,
      reasoning: registration.reasoningOverride ?? null,
      fallbackToSurface: fallbackProgressTarget !== null,
      fallbackProgressTarget,
      deferredDelivery: registration.mode === "deferred",
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
        sessionId: registration.fallbackSurface.sessionId,
        client: registration.fallbackSurface.platform,
        userId: registration.fallbackSurface.userId,
        safetyMode: "trusted",
        projectCwd: definitions.canonicalWorkspaceRoot,
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
    const waitForCompletion = () => this.waitForCompletion(runId, registration.mode === "sync");

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
        const cancelled = this.input.store.cancelRunAndChildren({
          runId,
          now: this.input.now?.() ?? Date.now(),
          detail,
        });
        if (cancelled?.state === "cancelled") {
          await this.input.onRunCancelled?.(cancelled, current.state);
        }
      },
    };
  }

  private async waitForCompletion(
    runId: string,
    acknowledgeSynchronousDelivery: boolean,
  ): Promise<SubagentDelegationOutcome> {
    while (true) {
      const run = this.input.store.getRun(runId);
      if (!run) throw new Error(`Subagent workflow run disappeared: ${runId}`);
      if (["succeeded", "failed", "rejected", "cancelled"].includes(run.state)) {
        const completion = await completionStatus(
          run,
          this.input.store,
          this.input.dataDir,
          this.input.toolResultArtifacts,
        );
        if (acknowledgeSynchronousDelivery) {
          this.input.store.markLiveParentCompletionDelivered(
            runId,
            this.input.now?.() ?? Date.now(),
          );
        }
        return completion;
      }
      await Bun.sleep(this.input.pollMs ?? 100);
    }
  }
}
