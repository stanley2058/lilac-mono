import fs from "node:fs/promises";
import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { isPanic, opaqueErrorMessage } from "@stanley2058/lilac-utils";

import type {
  SubagentDelegationHandle,
  SubagentDelegationOutcome,
  SubagentDelegationRegistration,
  TrustedSubagentDelegationRegistration,
} from "../tools/subagent";
import { HEARTBEAT_SESSION_ID } from "../heartbeat/common";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import { DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS, DurableWorkflowStore } from "./durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  validateWorkflowSourceUnchecked,
  validateWorkflowArgsUnchecked,
  WORKFLOW_RUNTIME_VERSION,
} from "./workflow-definition";
import { WorkflowDefinitionStore } from "./workflow-definition-store";
import type { WorkflowCompletionTarget, WorkflowRevision, WorkflowRun } from "./workflow-domain";
import { readWorkflowValueArtifact } from "./workflow-artifact-store";
import { resolveWorkflowSubagentToolResult } from "./workflow-subagent-output";

class WorkflowSubagentDispatchFailed extends TaggedError("WorkflowSubagentDispatchFailed")<{
  readonly message: string;
}> {}

type WorkflowSubagentDispatchResult<T> = ResultType<T, WorkflowSubagentDispatchFailed>;

function subagentDispatchFailure(message: string): WorkflowSubagentDispatchFailed {
  return new WorkflowSubagentDispatchFailed({ message });
}

function workflowSubagentFinalText(result: WorkflowRun["result"]): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

async function captureSubagentExternal<T>(
  effect: () => T | Promise<T>,
): Promise<WorkflowSubagentDispatchResult<T>> {
  const [settled] = await Promise.allSettled([Promise.resolve().then(effect)]);
  if (settled.status === "rejected") {
    if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
    const cause =
      settled.reason instanceof Error
        ? settled.reason
        : new Error("Opaque workflow subagent dispatch failure");
    return Result.err(
      subagentDispatchFailure(opaqueErrorMessage(cause, "Workflow subagent dispatch failed")),
    );
  }
  return Result.ok(settled.value);
}

function adaptWorkflowSubagentResultToHost<T>(result: WorkflowSubagentDispatchResult<T>): T {
  return adaptToolResultToHost(result);
}

const GENERATED_WORKFLOW_NAME = "subagent-delegate";

function generatedSource(input: {
  profile: SubagentDelegationRegistration["profile"];
  model?: string;
  reasoning?: string;
  idleTimeoutMs: number;
}): string {
  const operationIdleTimeoutMs = Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(1_000, Math.trunc(input.idleTimeoutMs)),
  );
  return `import { defineWorkflow } from "@lilac/workflow";

export default defineWorkflow({
  name: "${GENERATED_WORKFLOW_NAME}",
  description: "Generated one-agent delegation run",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["task", "profile"],
    properties: {
      task: { type: "string", minLength: 1 },
      profile: { type: "string", const: ${JSON.stringify(input.profile)} },
    },
  },
  resources: {
    agents: {
      maxConcurrent: 1,
      maxTotal: 1,
    },
    waits: [],
    maxNestingDepth: 1,
    operationIdleTimeoutMs: ${operationIdleTimeoutMs},
  },
  limits: {
    maxSourceBytes: 262144,
    maxInputBytes: 262144,
    maxOperationOutputBytes: 1048576,
    maxResultBytes: 1048576,
  },
  async run({ args, agent }) {
    return agent(args.task, {
      profile: args.profile,
      ${input.model ? `model: ${JSON.stringify(input.model)},` : ""}
      ${input.reasoning ? `reasoning: ${JSON.stringify(input.reasoning)},` : ""}
      label: "subagent " + args.profile,
    });
  },
});
`;
}

async function completionStatus(
  run: WorkflowRun,
  store: DurableWorkflowStore,
  blobStore: BlobStore,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<WorkflowSubagentDispatchResult<SubagentDelegationOutcome>> {
  if (run.state === "succeeded") {
    return Result.gen(async function* () {
      const revision = yield* store
        .getRevision(run.revisionId)
        .mapError((error) => subagentDispatchFailure(error.message));
      if (!revision) {
        return Result.err(
          subagentDispatchFailure(`Subagent workflow revision disappeared: ${run.revisionId}`),
        );
      }
      let result = run.result;
      if (run.resultArtifact) {
        result = yield* Result.await(
          readWorkflowValueArtifact({
            blobStore,
            reference: run.resultArtifact,
            maxBytes: revision.limits.maxResultBytes,
          }).then((loaded) => loaded.mapError((error) => subagentDispatchFailure(error.message))),
        );
      }
      const rawFinalText = workflowSubagentFinalText(result);
      let finalText = rawFinalText;
      if (run.completionTarget.kind === "live_parent") {
        const childSessionId = run.completionTarget.childSessionId;
        finalText = yield* Result.await(
          captureSubagentExternal(() =>
            resolveWorkflowSubagentToolResult({
              finalText: rawFinalText,
              childSessionId,
              artifacts: toolResultArtifacts,
            }),
          ),
        );
      }
      return Result.ok({ status: "resolved" as const, finalText });
    });
  }
  if (run.state === "cancelled") {
    return Result.ok({
      status: "cancelled",
      finalText: "",
      detail: run.terminalDetail ?? "subagent cancelled",
    });
  }
  const operations = store.listOperations(run.runId, { limit: 1_000 });
  return operations
    .mapError((error) => subagentDispatchFailure(error.message))
    .map((entries) => {
      const timedOut = entries.some((operation) => operation.state === "timed_out");
      return {
        status: timedOut ? ("timeout" as const) : ("failed" as const),
        finalText: "",
        detail: run.terminalDetail ?? (timedOut ? "subagent timed out" : "subagent failed"),
      };
    });
}

export class WorkflowSubagentDispatcher {
  private readonly definitionsStores = new Map<
    string,
    Promise<WorkflowSubagentDispatchResult<WorkflowDefinitionStore>>
  >();

  private constructor(
    private readonly input: {
      store: DurableWorkflowStore;
      dataDir: string;
      blobStore: BlobStore;
      toolResultArtifacts?: ToolResultArtifactStore;
      now?: () => number;
      pollMs?: number;
      getMaxActiveRuns?: () => number | Promise<number>;
      onRunCreated?: (run: WorkflowRun) => Promise<void>;
      onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
    },
  ) {}

  static create(input: {
    store: DurableWorkflowStore;
    dataDir: string;
    blobStore: BlobStore;
    toolResultArtifacts?: ToolResultArtifactStore;
    now?: () => number;
    pollMs?: number;
    getMaxActiveRuns?: () => number | Promise<number>;
    onRunCreated?: (run: WorkflowRun) => Promise<void>;
    onRunCancelled?: (run: WorkflowRun, previousState: WorkflowRun["state"]) => Promise<void>;
  }): WorkflowSubagentDispatcher {
    return new WorkflowSubagentDispatcher(input);
  }

  private async definitions(
    projectRoot: string,
  ): Promise<WorkflowSubagentDispatchResult<WorkflowDefinitionStore>> {
    const requestedRoot = path.resolve(projectRoot);
    const inspected = await captureSubagentExternal(async () => ({
      stats: await fs.lstat(requestedRoot),
      canonicalRoot: await fs.realpath(requestedRoot),
    }));
    return Result.gen(async function* (this: WorkflowSubagentDispatcher) {
      const { stats, canonicalRoot } = yield* inspected;
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        return Result.err(
          subagentDispatchFailure(
            `Subagent workflow project root must be a real directory: ${requestedRoot}`,
          ),
        );
      }
      let definitions = this.definitionsStores.get(canonicalRoot);
      if (!definitions) {
        definitions = WorkflowDefinitionStore.createResult({
          workspaceRoot: canonicalRoot,
          dataDir: this.input.dataDir,
          blobStore: this.input.blobStore,
          workflowStore: this.input.store,
        }).then((created) =>
          created.mapError((error) => {
            this.definitionsStores.delete(canonicalRoot);
            return subagentDispatchFailure(error.message);
          }),
        );
        this.definitionsStores.set(canonicalRoot, definitions);
      }
      return Result.ok(yield* Result.await(definitions));
    }, this);
  }

  async delegate(
    registration: TrustedSubagentDelegationRegistration,
  ): Promise<SubagentDelegationHandle> {
    return adaptWorkflowSubagentResultToHost(await this.delegateResult(registration));
  }

  private async delegateResult(
    registration: TrustedSubagentDelegationRegistration,
  ): Promise<WorkflowSubagentDispatchResult<SubagentDelegationHandle>> {
    return Result.gen(async function* (this: WorkflowSubagentDispatcher) {
      const definitions = yield* Result.await(this.definitions(registration.projectRoot));
      const now = this.input.now?.() ?? Date.now();
      const source = generatedSource({
        profile: registration.profile,
        ...(registration.modelOverride ? { model: registration.modelOverride } : {}),
        ...(registration.reasoningOverride ? { reasoning: registration.reasoningOverride } : {}),
        idleTimeoutMs: registration.idleTimeoutMs,
      });
      const validation = yield* validateWorkflowSourceUnchecked({
        name: GENERATED_WORKFLOW_NAME,
        source,
      }).mapError((error) => subagentDispatchFailure(error.message));
      const snapshot = yield* Result.await(
        definitions
          .createSnapshotResult(source, validation.sourceSha256)
          .then((created) => created.mapError((error) => subagentDispatchFailure(error.message))),
      );
      const revisionId = `wfrev:subagent:${sha256(
        [
          definitions.canonicalProjectId,
          validation.sourceSha256,
          validation.inputSchemaSha256,
          validation.resourcePolicySha256,
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
        snapshotArtifact: snapshot.artifact,
        sourceSha256: validation.sourceSha256,
        inputSchemaSha256: validation.inputSchemaSha256,
        resourcePolicySha256: validation.resourcePolicySha256,
        metadata: validation.metadata,
        inputSchema: validation.inputSchema,
        resources: validation.resources,
        limits: validation.limits,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
        createdAt: now,
      };
      const args = yield* validateWorkflowArgsUnchecked({
        inputSchema: revision.inputSchema,
        args: { task: registration.task, profile: registration.profile },
        maxInputBytes: revision.limits.maxInputBytes,
      }).mapError((error) => subagentDispatchFailure(error.message));
      const runId = `wfrun:subagent:${crypto.randomUUID()}`;
      const completionTarget: WorkflowCompletionTarget = {
        kind: "live_parent",
        parentRequestId: registration.parentRequestId,
        parentSessionId: registration.parentSessionId,
        parentRequestClient: registration.fallbackSurface?.platform ?? "unknown",
        parentToolCallId: registration.parentToolCallId,
        childRequestId: registration.childRequestId,
        childSessionId: registration.childSessionId,
        profile: registration.profile,
        sessionName: registration.sessionName,
        title: registration.title,
        stableNamedContinuation: registration.stableNamedContinuation,
        depth: registration.depth,
        reasoning: registration.reasoningOverride ?? null,
        fallbackToSurface: false,
        fallbackProgressTarget: null,
        deferredDelivery: registration.mode === "deferred",
      };
      const requestedRun: WorkflowRun = {
        runId,
        revisionId,
        state: "queued",
        inputSchemaSnapshot: revision.inputSchema,
        args,
        argsSha256: canonicalJsonSha256(args),
        origin: {
          requestId: registration.parentRequestId,
          sessionId: registration.fallbackSurface?.sessionId ?? HEARTBEAT_SESSION_ID,
          client: registration.fallbackSurface?.platform ?? "unknown",
          userId: registration.fallbackSurface?.userId ?? null,
          projectCwd: definitions.canonicalWorkspaceRoot,
        },
        completionTarget,
        progressTarget: null,
        terminalDetail: null,
        result: null,
        resultArtifact: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        terminalAt: null,
      };
      const maxActiveRuns = yield* Result.await(
        captureSubagentExternal(
          async () => (await this.input.getMaxActiveRuns?.()) ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
        ),
      );
      const invocation = yield* this.input.store
        .createInvocation({
          revision,
          run: requestedRun,
          maxActiveRuns,
        })
        .mapError((error) => subagentDispatchFailure(error.message));
      if (invocation.status === "rejected_capacity") {
        return Result.err(
          subagentDispatchFailure(
            `Subagent delegation was not created because global workflow capacity is full (${invocation.activeRuns}/${invocation.limit} active runs); wait for a workflow to finish or cancel one, then retry`,
          ),
        );
      }
      const { run } = invocation;
      yield* Result.await(captureSubagentExternal(async () => this.input.onRunCreated?.(run)));
      const waitForCompletion = async () =>
        adaptWorkflowSubagentResultToHost(
          await this.waitForCompletion(runId, registration.mode === "sync"),
        );

      return Result.ok({
        runId,
        get completion() {
          return waitForCompletion();
        },
        cancel: async (detail: string) => {
          adaptWorkflowSubagentResultToHost(await this.cancel(runId, detail));
        },
      });
    }, this);
  }

  private async waitForCompletion(
    runId: string,
    acknowledgeSynchronousDelivery: boolean,
  ): Promise<WorkflowSubagentDispatchResult<SubagentDelegationOutcome>> {
    return Result.gen(async function* (this: WorkflowSubagentDispatcher) {
      const initialRun = yield* this.input.store
        .getRun(runId)
        .mapError((error) => subagentDispatchFailure(error.message));
      if (!initialRun) {
        return Result.err(subagentDispatchFailure(`Subagent workflow run disappeared: ${runId}`));
      }
      const revision = yield* this.input.store
        .getRevision(initialRun.revisionId)
        .mapError((error) => subagentDispatchFailure(error.message));
      if (!revision) {
        return Result.err(
          subagentDispatchFailure(
            `Subagent workflow revision disappeared: ${initialRun.revisionId}`,
          ),
        );
      }
      const preDispatchDeadline = initialRun.createdAt + revision.resources.operationIdleTimeoutMs;

      while (true) {
        const run = yield* this.input.store
          .getRun(runId)
          .mapError((error) => subagentDispatchFailure(error.message));
        if (!run) {
          return Result.err(subagentDispatchFailure(`Subagent workflow run disappeared: ${runId}`));
        }
        if (["succeeded", "failed", "cancelled"].includes(run.state)) {
          const completion = yield* Result.await(
            completionStatus(
              run,
              this.input.store,
              this.input.blobStore,
              this.input.toolResultArtifacts,
            ),
          );
          if (acknowledgeSynchronousDelivery) {
            this.input.store.markLiveParentCompletionDelivered(
              runId,
              this.input.now?.() ?? Date.now(),
            );
          }
          return Result.ok(completion);
        }

        const operations = yield* this.input.store
          .listOperations(runId, { limit: 1_000 })
          .mapError((error) => subagentDispatchFailure(error.message));
        const hasDispatchedAgentOperation = operations.some(
          (operation) => operation.kind === "agent" && operation.state !== "queued",
        );
        if (
          !hasDispatchedAgentOperation &&
          (this.input.now?.() ?? Date.now()) >= preDispatchDeadline
        ) {
          const cancelled = this.input.store.cancelRunAndChildren({
            runId,
            now: this.input.now?.() ?? Date.now(),
            detail: "Subagent idle timeout before agent dispatch",
          });
          if (cancelled?.state === "cancelled") {
            yield* Result.await(
              captureSubagentExternal(async () =>
                this.input.onRunCancelled?.(cancelled, run.state),
              ),
            );
            return Result.ok({
              status: "timeout" as const,
              finalText: "",
              detail: "Subagent idle timeout before agent dispatch",
            });
          }
          continue;
        }
        await Bun.sleep(this.input.pollMs ?? 100);
      }
    }, this);
  }

  private async cancel(
    runId: string,
    detail: string,
  ): Promise<WorkflowSubagentDispatchResult<void>> {
    return Result.gen(async function* (this: WorkflowSubagentDispatcher) {
      const current = yield* this.input.store
        .getRun(runId)
        .mapError((error) => subagentDispatchFailure(error.message));
      if (!current || ["succeeded", "failed", "cancelled"].includes(current.state)) {
        return Result.ok(undefined);
      }
      const cancelled = this.input.store.cancelRunAndChildren({
        runId,
        now: this.input.now?.() ?? Date.now(),
        detail,
      });
      if (cancelled?.state === "cancelled") {
        yield* Result.await(
          captureSubagentExternal(async () =>
            this.input.onRunCancelled?.(cancelled, current.state),
          ),
        );
      }
      return Result.ok(undefined);
    }, this);
  }
}
