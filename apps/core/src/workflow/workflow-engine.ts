import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import {
  lilacEventTypes,
  outReqTopic,
  type LilacBus,
  type RequestLifecycleState,
} from "@stanley2058/lilac-event-bus";
import { createLogger, type DurableResolvedModelRequest } from "@stanley2058/lilac-utils";

import {
  DurableWorkflowStore,
  type WorkflowRequestTerminalReceipt,
} from "./durable-workflow-store";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256,
  validateWorkflowArgs,
  WORKFLOW_RUNTIME_VERSION,
} from "./workflow-definition";
import {
  jsonValueSchema,
  type JsonValue,
  type WorkflowOperation,
  type WorkflowOperationState,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowUsage,
} from "./workflow-domain";
import {
  startWorkflowSandbox,
  type WorkflowSandboxCall,
  type WorkflowSandboxRun,
} from "./workflow-sandbox";
import { compileWorkflowSource } from "./workflow-source-compiler";
import {
  readWorkflowValueArtifact,
  WORKFLOW_INLINE_VALUE_BYTES,
  writeWorkflowValueArtifact,
} from "./workflow-artifact-store";
import type { WorkflowRequestPolicy } from "./workflow-request-authority";
import {
  resolveWorkflowAgentOperationInput,
  resolvedWorkflowAgentInputSchema,
  workflowPipelineOptionsSchema,
  workflowWaitForReplyOptionsSchema,
  type ResolvedWorkflowAgentInput,
} from "./workflow-operation-policy";

const WORKFLOW_LEASE_STALE_MS = 60_000;
const WORKFLOW_REQUEST_LEASE_STALE_MS = 30_000;

const phaseInputSchema = z.strictObject({ name: z.string().min(1).max(200) });
const parallelInputSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});
const pipelineInputSchema = z.strictObject({
  items: z.array(jsonValueSchema).max(10_000),
  options: workflowPipelineOptionsSchema,
});
const sleepInputSchema = z.union([z.number().finite().nonnegative(), z.string().min(1).max(100)]);

type AgentRequestResult = {
  state: "resolved" | "failed" | "cancelled" | "timed_out";
  output: string;
  detail: string | null;
  usage: WorkflowUsage | null;
  source?: "receipt" | "terminal_receipt" | "terminal_without_receipt";
};

type ResolvedAgentSelection = {
  model: string;
  reasoning: NonNullable<ResolvedWorkflowAgentInput["options"]["reasoning"]> | null;
  request: DurableResolvedModelRequest;
};

const TERMINAL_RECEIPT_WAIT_MS = 250;
const IDLE_CANCEL_QUIESCENCE_WAIT_MS = 10_000;

type ActiveRun = {
  controller: AbortController;
  sandbox: WorkflowSandboxRun;
  promise: Promise<void>;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function isTerminalOperation(state: WorkflowOperationState): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

function operationId(pathValue: string): string {
  return `wfop:${sha256(pathValue).slice(0, 40)}`;
}

export function workflowAgentRequestId(
  runId: string,
  operationIdValue: string,
  attempt: number,
): string {
  return `wfr:${sha256(runId).slice(0, 20)}:${operationIdValue.slice(-20)}:${attempt}`;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 16_384);
}

export class WorkflowEngine {
  private readonly logger = createLogger({ module: "workflow-engine" });
  private readonly workerId = `workflow-engine:${process.pid}:${crypto.randomUUID()}`;
  private readonly active = new Map<string, ActiveRun>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private wakeSubscription: { stop(): Promise<void> } | null = null;
  private tickPromise: Promise<void> | null = null;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      dataDir: string;
      subscriptionId: string;
      now?: () => number;
      pollMs?: number;
      receiptPollMs?: number;
      loadSnapshot?: (revision: WorkflowRevision) => Promise<string>;
      compileSource?: (source: string, sourceSha256: string) => string;
      beforePromptPublication?: (input: {
        requestId: string;
        runId: string;
        operationId: string;
        dispatchEpoch: string;
        runOwnerId: string;
      }) => Promise<void>;
      createDispatchEpoch?: () => string;
      validateAgentSelection?: (input: {
        profile: "explore" | "general" | "self";
        model?: string;
        reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
      }) => void | ResolvedAgentSelection | Promise<void | ResolvedAgentSelection>;
      dispatchAgentRequest?: (input: {
        run: WorkflowRun;
        revision: WorkflowRevision;
        operation: WorkflowOperation;
        prompt: string;
        profile: "explore" | "general" | "self";
        model?: string;
        reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
        policy: WorkflowRequestPolicy;
        requestId: string;
        agentCwd: string;
        signal: AbortSignal;
        reconcile: boolean;
        dispatchEpoch: string;
        sessionId: string;
        publishRequest: boolean;
      }) => Promise<AgentRequestResult>;
    },
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.wakeSubscription = await this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 500 },
      },
      async (_message, context) => {
        void this.requestTick();
        await context.commit();
      },
    );
    for (const run of this.input.store.listRuns({ state: "running", limit: 1_000 })) {
      await this.claimAndLaunch(run, WORKFLOW_LEASE_STALE_MS);
    }
    for (const run of this.input.store.listRuns({ state: "blocked", limit: 1_000 })) {
      if (this.input.store.getManualReconciliationDetail(run.runId)) continue;
      this.input.store.transitionRun({
        runId: run.runId,
        from: "blocked",
        to: "queued",
        now: this.now(),
        detail: "Replaying durable workflow wait after restart",
      });
    }
    await this.requestTick();
    this.timer = setInterval(() => void this.requestTick(), this.input.pollMs ?? 250);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const failures: unknown[] = [];
    const subscription = this.wakeSubscription;
    this.wakeSubscription = null;
    if (subscription) {
      const settled = await Promise.allSettled([Promise.resolve().then(() => subscription.stop())]);
      if (settled[0]?.status === "rejected") failures.push(settled[0].reason);
    }
    if (this.tickPromise) {
      const settled = await Promise.allSettled([this.tickPromise]);
      if (settled[0]?.status === "rejected") failures.push(settled[0].reason);
    }
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort("shutdown");
    const cancellations = await Promise.allSettled(
      [...this.active.entries()].flatMap(([runId, run]) => [
        Promise.resolve().then(() => run.sandbox.cancel()),
        Promise.resolve().then(() => this.stopAgentRequests(runId)),
      ]),
    );
    for (const cancellation of cancellations) {
      if (cancellation.status === "rejected") failures.push(cancellation.reason);
    }
    await Promise.allSettled(active.map((run) => run.promise));
    this.active.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Workflow engine stop failed while cancelling active work",
      );
    }
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private requestTick(): Promise<void> {
    this.tickPromise ??= this.tick().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const cancellations: Promise<void>[] = [];
    for (const [runId, active] of this.active) {
      const run = this.input.store.getRun(runId);
      if (!run || run.state === "cancelled" || run.state === "paused") {
        active.controller.abort(run?.state ?? "run_missing");
        cancellations.push(
          Promise.resolve().then(() => active.sandbox.cancel()),
          Promise.resolve().then(() => this.stopAgentRequests(runId)),
        );
      } else {
        if (!this.input.store.refreshRunClaim(runId, this.workerId, this.now())) {
          active.controller.abort("workflow lease lost");
          cancellations.push(Promise.resolve().then(() => active.sandbox.cancel()));
        }
      }
    }
    const settledCancellations = await Promise.allSettled(cancellations);
    const cancellationFailures = settledCancellations
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cancellationFailures.length > 0) {
      this.logger.error(
        "Workflow cancellation reconciliation failed",
        new AggregateError(cancellationFailures, "One or more workflow cancellations failed"),
      );
    }
    for (const run of this.input.store.listRuns({ state: "queued", limit: 1_000 })) {
      await this.claimAndLaunch(run);
    }
  }

  private async claimAndLaunch(run: WorkflowRun, staleAfterMs?: number): Promise<void> {
    if (this.active.has(run.runId) || this.stopping) return;
    const claimed = this.input.store.tryClaimRun({
      runId: run.runId,
      claimerId: this.workerId,
      now: this.now(),
      staleAfterMs,
    });
    if (!claimed) return;
    const controller = new AbortController();
    let sandbox: WorkflowSandboxRun;
    try {
      sandbox = await this.createSandbox(claimed, controller.signal);
    } catch (error) {
      await this.finishRun(claimed, "failed", null, boundedError(error));
      return;
    }
    const promise = this.runSandbox(claimed, sandbox, controller.signal).finally(() => {
      this.active.delete(claimed.runId);
    });
    this.active.set(claimed.runId, { controller, sandbox, promise });
  }

  private async loadSnapshot(revision: WorkflowRevision): Promise<string> {
    if (this.input.loadSnapshot) return await this.input.loadSnapshot(revision);
    const snapshotPath = path.join(
      this.input.dataDir,
      "workflow-snapshots",
      `${revision.sourceSha256}.js`,
    );
    const stats = await fs.lstat(snapshotPath);
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new Error("Invalid workflow snapshot file");
    const source = await fs.readFile(snapshotPath, "utf8");
    if (sha256(source) !== revision.sourceSha256)
      throw new Error("Workflow snapshot hash mismatch");
    if (revision.snapshotArtifactId !== `workflow-source:${revision.sourceSha256}`) {
      throw new Error("Workflow snapshot artifact identity mismatch");
    }
    return source;
  }

  private async createSandbox(run: WorkflowRun, signal: AbortSignal): Promise<WorkflowSandboxRun> {
    const revision = this.input.store.getRevision(run.revisionId);
    if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
    this.assertPersistedIntegrity(run, revision);
    if (revision.runtimeVersion !== WORKFLOW_RUNTIME_VERSION) {
      throw new Error(`Unsupported workflow runtime: ${revision.runtimeVersion}`);
    }
    const source = await this.loadSnapshot(revision);
    this.assertPersistedIntegrity(run, revision);
    const compiled = (this.input.compileSource ?? compileWorkflowSource)(
      source,
      revision.sourceSha256,
    );
    const semaphore = new Semaphore(revision.resources.agents.maxConcurrent);
    return startWorkflowSandbox({
      source: compiled,
      args: run.args,
      signal,
      onCall: (call) => this.handleCall(run.runId, revision, call, semaphore, signal),
    });
  }

  private assertPersistedIntegrity(run: WorkflowRun, revision: WorkflowRevision): void {
    if (revision.revisionId.startsWith("wfr:")) {
      const expectedRevisionId = `wfr:${canonicalJsonSha256(
        jsonValueSchema.parse({
          canonicalProjectId: revision.canonicalProjectId,
          canonicalWorkspaceRoot: revision.canonicalWorkspaceRoot,
          scope: revision.scope,
          normalizedPath: revision.normalizedPath,
          sourceSha256: revision.sourceSha256,
          inputSchemaSha256: revision.inputSchemaSha256,
          resourcePolicySha256: revision.resourcePolicySha256,
          runtimeVersion: revision.runtimeVersion,
        }),
      )}`;
      if (revision.revisionId !== expectedRevisionId) {
        throw new Error("Persisted workflow revision identity hash mismatch");
      }
    }
    if (canonicalJsonSha256(revision.inputSchema) !== revision.inputSchemaSha256) {
      throw new Error("Persisted workflow input schema hash mismatch");
    }
    if (
      canonicalJsonSha256(
        jsonValueSchema.parse({ resources: revision.resources, limits: revision.limits }),
      ) !== revision.resourcePolicySha256
    ) {
      throw new Error("Persisted workflow resource policy hash mismatch");
    }
    const args = validateWorkflowArgs({
      inputSchema: revision.inputSchema,
      args: run.args,
      maxInputBytes: revision.limits.maxInputBytes,
    });
    if (
      canonicalJsonSha256(args) !== run.argsSha256 ||
      canonicalJsonSha256(run.inputSchemaSnapshot) !== revision.inputSchemaSha256
    ) {
      throw new Error("Persisted workflow invocation hash mismatch");
    }
    if (
      run.origin.projectCwd !== revision.canonicalWorkspaceRoot ||
      path.resolve(run.origin.projectCwd) !== revision.canonicalWorkspaceRoot
    ) {
      throw new Error("Persisted workflow project cwd does not match its approved revision");
    }
  }

  private async runSandbox(
    run: WorkflowRun,
    sandbox: WorkflowSandboxRun,
    signal: AbortSignal,
  ): Promise<void> {
    await this.publishRun(run, "running", "queued");
    try {
      const result = await sandbox.result;
      if (signal.aborted || this.stopping) return;
      const revision = this.input.store.getRevision(run.revisionId);
      if (!revision) throw new Error("Workflow revision disappeared");
      if (Buffer.byteLength(canonicalJson(result), "utf8") > revision.limits.maxResultBytes) {
        throw new Error(`Workflow result exceeds ${revision.limits.maxResultBytes} bytes`);
      }
      await this.finishRun(run, "succeeded", result, "Workflow completed");
    } catch (error) {
      if (this.stopping) return;
      const current = this.input.store.getRun(run.runId);
      if (!current || current.state === "cancelled" || current.state === "paused") return;
      await this.finishRun(run, "failed", null, boundedError(error));
    }
  }

  private async handleCall(
    runId: string,
    revision: WorkflowRevision,
    call: WorkflowSandboxCall,
    semaphore: Semaphore,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const run = this.input.store.getRun(runId);
    if (!run || run.state !== "running" || run.claimedBy !== this.workerId || signal.aborted)
      throw new Error("Workflow is not running");
    if (call.depth > revision.resources.maxNestingDepth) {
      throw new Error(`Workflow nesting exceeds ${revision.resources.maxNestingDepth}`);
    }
    const id = operationId(call.path);
    const parentOperationId = call.parentPath ? operationId(call.parentPath) : null;
    const input =
      call.kind === "agent"
        ? await resolveWorkflowAgentOperationInput({
            value: call.input,
            canonicalWorkspaceRoot: revision.canonicalWorkspaceRoot,
          })
        : jsonValueSchema.parse(call.input);
    const inputSha256 = canonicalJsonSha256(input);
    const persistedKind =
      call.kind === "waitForReply" || call.kind === "sleep" ? "wait" : call.kind;
    const existing = this.input.store.getOperation(runId, id);
    this.validateOperationInput(call.kind, input);
    if (existing) {
      if (
        existing.callSiteId !== call.callSiteId ||
        existing.kind !== persistedKind ||
        existing.inputSha256 !== inputSha256
      ) {
        throw new Error(`Workflow replay diverged at ${call.callSiteId}`);
      }
      if (existing.state === "succeeded") {
        if (existing.resultArtifactId) {
          return await readWorkflowValueArtifact({
            dataDir: this.input.dataDir,
            artifactId: existing.resultArtifactId,
            maxBytes: revision.limits.maxOperationOutputBytes,
          });
        }
        return existing.output;
      }
      if (isTerminalOperation(existing.state)) {
        throw new Error(existing.error ?? `Cached operation ${existing.state}`);
      }
      if (call.kind === "waitForReply" || call.kind === "sleep") {
        return await this.waitDurably(run, revision, existing, call.kind, input, signal);
      }
      if (existing.kind === "agent") {
        const agentInput = resolvedWorkflowAgentInputSchema.parse(input);
        return await semaphore.use(() =>
          this.dispatchAgentSafely(run, revision, existing, agentInput, signal, true),
        );
      }
      return await this.completeStructuralOperation(run, revision, existing);
    }

    if (call.kind === "agent") {
      if (this.input.store.countOperations(runId, "agent") >= revision.resources.agents.maxTotal) {
        throw new Error(`Workflow agent total exceeds ${revision.resources.agents.maxTotal}`);
      }
      const options = resolvedWorkflowAgentInputSchema.parse(input).options;
      await this.input.validateAgentSelection?.({
        profile: options.profile,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      });
    }
    const parsedLabel =
      call.kind === "agent"
        ? (resolvedWorkflowAgentInputSchema.parse(input).options.label ?? null)
        : call.kind === "waitForReply"
          ? (workflowWaitForReplyOptionsSchema.parse(input).prompt ?? "Waiting for reply")
          : call.kind === "sleep"
            ? "Sleeping"
            : null;
    const operation: WorkflowOperation = {
      runId,
      operationId: id,
      callSiteId: call.callSiteId,
      parentOperationId,
      phase: call.phase,
      label: parsedLabel,
      kind: persistedKind,
      input,
      inputSha256,
      state: "queued",
      attempt: 0,
      requestId: null,
      output: null,
      resultArtifactId: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: this.now(),
      startedAt: null,
      updatedAt: this.now(),
      terminalAt: null,
    };
    if (!this.input.store.createOperation(operation, this.workerId)) {
      throw new Error(`Failed to journal workflow operation ${id}`);
    }
    await this.publishOperation(revision, operation, "queued");
    if (call.kind === "waitForReply" || call.kind === "sleep") {
      return await this.waitDurably(run, revision, operation, call.kind, input, signal);
    }
    if (call.kind === "agent") {
      const agentInput = resolvedWorkflowAgentInputSchema.parse(input);
      return await semaphore.use(() =>
        this.dispatchAgentSafely(run, revision, operation, agentInput, signal, false),
      );
    }
    if (call.kind === "phase") phaseInputSchema.parse(input);
    else if (call.kind === "parallel") parallelInputSchema.parse(input);
    else pipelineInputSchema.parse(input);
    return await this.completeStructuralOperation(run, revision, operation);
  }

  private validateOperationInput(kind: WorkflowSandboxCall["kind"], input: JsonValue): void {
    if (kind === "agent") resolvedWorkflowAgentInputSchema.parse(input);
    else if (kind === "phase") phaseInputSchema.parse(input);
    else if (kind === "parallel") parallelInputSchema.parse(input);
    else if (kind === "pipeline") pipelineInputSchema.parse(input);
    else if (kind === "waitForReply") workflowWaitForReplyOptionsSchema.parse(input);
    else sleepInputSchema.parse(input);
  }

  private async waitDurably(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    kind: "waitForReply" | "sleep",
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const waitKind = kind === "waitForReply" ? "reply" : "sleep";
    if (!revision.resources.waits.includes(waitKind)) {
      throw new Error(`Workflow wait is not enabled by resource policy: ${waitKind}`);
    }
    const now = this.now();
    const operationCreatedAt = operation.createdAt;
    let wait = this.input.store.getWait(run.runId, operation.operationId);
    if (!wait) {
      if (kind === "waitForReply") {
        const options = workflowWaitForReplyOptionsSchema.parse(input);
        const platform = options.platform ?? run.origin.client;
        const channelId = options.channelId ?? run.origin.sessionId;
        if (!platform || !channelId) {
          throw new Error(
            "waitForReply requires a platform and channelId or an originating session",
          );
        }
        if (
          platform !== "discord" ||
          platform !== run.origin.client ||
          channelId !== run.origin.sessionId ||
          !run.origin.userId ||
          (options.fromUserId !== undefined && options.fromUserId !== run.origin.userId)
        ) {
          throw new Error(
            "waitForReply is limited to the authenticated originating Discord session and user",
          );
        }
        wait = {
          runId: run.runId,
          operationId: operation.operationId,
          state: "pending",
          match: {
            kind: "reply",
            platform,
            channelId,
            messageId: options.messageId ?? null,
            fromUserId: options.fromUserId ?? run.origin.userId,
          },
          matchKey: `${platform}:${channelId}`,
          dueAt: null,
          deadlineAt:
            options.timeoutMs === undefined ? null : operationCreatedAt + options.timeoutMs,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
      } else {
        const value = sleepInputSchema.parse(input);
        const parsedTimestamp = typeof value === "string" ? Date.parse(value) : null;
        if (typeof value === "string" && !Number.isFinite(parsedTimestamp)) {
          throw new Error(`Invalid sleep timestamp: ${value}`);
        }
        const dueAt =
          typeof value === "string"
            ? (parsedTimestamp ?? now)
            : value >= 100_000_000_000
              ? Math.trunc(value)
              : operationCreatedAt + Math.trunc(value);
        wait = {
          runId: run.runId,
          operationId: operation.operationId,
          state: "pending",
          match: { kind: "sleep" },
          matchKey: `sleep:${dueAt}`,
          dueAt,
          deadlineAt: null,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
      }
      if (!this.input.store.createWait(wait, this.workerId)) {
        const concurrentlyCreated = this.input.store.getWait(run.runId, operation.operationId);
        if (!concurrentlyCreated) {
          throw new Error(`Failed to journal workflow wait ${operation.operationId}`);
        }
        wait = concurrentlyCreated;
      }
    } else if (
      (kind === "waitForReply" && wait.match.kind !== "reply") ||
      (kind === "sleep" && wait.match.kind !== "sleep")
    ) {
      throw new Error(`Workflow wait replay diverged at ${operation.callSiteId}`);
    }

    let current = this.input.store.getOperation(run.runId, operation.operationId) ?? operation;
    for (const next of ["dispatched", "running", "blocked"] as const) {
      if (
        (next === "dispatched" && current.state !== "queued") ||
        (next === "running" && current.state !== "dispatched") ||
        (next === "blocked" && current.state !== "running")
      ) {
        continue;
      }
      this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: current.state,
        to: next,
        now: this.now(),
      });
      await this.publishOperation(revision, operation, next, current.state);
      current = this.input.store.getOperation(run.runId, operation.operationId) ?? current;
    }
    while (!signal.aborted) {
      wait = this.input.store.getWait(run.runId, operation.operationId);
      if (!wait) throw new Error("Durable workflow wait disappeared");
      if (wait.state === "resolved" || wait.state === "expired" || wait.state === "cancelled") {
        const latest = this.input.store.getOperation(run.runId, operation.operationId);
        if (wait.state === "resolved") {
          if (latest?.state === "blocked") {
            this.input.store.transitionOperation({
              runOwnerId: this.workerId,
              runId: run.runId,
              operationId: operation.operationId,
              from: "blocked",
              to: "succeeded",
              now: this.now(),
              output: wait.result,
            });
            await this.publishOperation(revision, operation, "succeeded", "blocked");
          }
          return wait.result;
        }
        if (latest?.state === "blocked") {
          const terminalState = wait.state === "expired" ? "timed_out" : "cancelled";
          this.input.store.transitionOperation({
            runOwnerId: this.workerId,
            runId: run.runId,
            operationId: operation.operationId,
            from: "blocked",
            to: terminalState,
            now: this.now(),
            error: wait.state === "expired" ? "Reply wait timed out" : "Wait cancelled",
          });
          await this.publishOperation(revision, operation, terminalState, "blocked");
        }
        throw new Error(wait.state === "expired" ? "Reply wait timed out" : "Wait cancelled");
      }
      await Bun.sleep(this.input.pollMs ?? 250);
    }
    throw new Error("Workflow wait interrupted");
  }

  private async completeStructuralOperation(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
  ): Promise<JsonValue> {
    let current = operation;
    const transitions: WorkflowOperationState[] =
      current.state === "queued"
        ? ["dispatched", "running", "succeeded"]
        : current.state === "dispatched"
          ? ["running", "succeeded"]
          : current.state === "running"
            ? ["succeeded"]
            : [];
    for (const to of transitions) {
      const changed = this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: current.state,
        to,
        now: this.now(),
        output: to === "succeeded" ? null : undefined,
      });
      if (!changed) throw new Error(`Failed structural operation transition to ${to}`);
      await this.publishOperation(revision, operation, to, current.state);
      current = this.input.store.getOperation(run.runId, operation.operationId) ?? current;
    }
    return null;
  }

  private async dispatchAgent(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    input: ResolvedWorkflowAgentInput,
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<JsonValue> {
    const { profile, model, reasoning } = input.options;
    const expectedRequestId = workflowAgentRequestId(
      run.runId,
      operation.operationId,
      operation.attempt,
    );
    if (operation.requestId && operation.requestId !== expectedRequestId) {
      throw new Error("Persisted workflow operation request ID is not deterministic");
    }
    const reqId = expectedRequestId;
    let current = this.input.store.getOperation(run.runId, operation.operationId) ?? operation;
    const sessionId =
      run.completionTarget.kind === "live_parent"
        ? run.completionTarget.childSessionId
        : `workflow:${run.runId}:${operation.operationId}`;
    let adoptedTerminalReceipt = false;
    let ambiguousTerminalResult = false;
    const adoptReceipt = async (
      receipt: WorkflowRequestTerminalReceipt,
    ): Promise<AgentRequestResult> => {
      if (
        receipt.requestId !== reqId ||
        receipt.runId !== run.runId ||
        receipt.operationId !== operation.operationId ||
        current.requestId !== reqId
      ) {
        throw new Error("Workflow terminal receipt does not match its deterministic operation");
      }
      adoptedTerminalReceipt = true;
      return await this.adoptTerminalReceipt(receipt, revision);
    };
    let result: AgentRequestResult;
    const handoff = this.input.store.getWorkflowRequestDispatchHandoff({
      requestId: reqId,
      now: this.now(),
      staleAfterMs: WORKFLOW_REQUEST_LEASE_STALE_MS,
    });
    if (handoff.status === "receipt") {
      result = await adoptReceipt(handoff.receipt);
    } else {
      const agentCwd = input.options.cwd;
      const liveOwner = reconcile && handoff.status === "live";
      const durableHandoff = handoff.status === "live" || handoff.status === "stale";
      const resolvedSelection = durableHandoff
        ? {
            model: handoff.policy.resolvedModelRequest.spec,
            reasoning: handoff.policy.resolvedModelRequest.reasoning ?? null,
            request: handoff.policy.resolvedModelRequest,
          }
        : await this.input.validateAgentSelection?.({
            profile,
            ...(model ? { model } : {}),
            ...(reasoning ? { reasoning } : {}),
          });
      const concreteSelection = resolvedSelection ?? {
        model: model ?? `profile-native:${profile}`,
        reasoning: reasoning ?? null,
        request: {
          spec: model ?? `profile-native:${profile}`,
          provider: "unresolved",
          modelId: model ?? `profile-native:${profile}`,
          ...(reasoning ? { reasoning } : {}),
          reasoningDisplay: "simple",
        },
      };
      const dispatchEpoch = liveOwner
        ? handoff.dispatchEpoch
        : (this.input.createDispatchEpoch?.() ?? crypto.randomUUID());
      const newlyResolvedPolicy = {
        runId: run.runId,
        operationId: operation.operationId,
        dispatchEpoch,
        profile,
        model: model ?? null,
        reasoning: reasoning ?? null,
        resolvedModelRequest: concreteSelection.request,
        cwd: agentCwd,
        originSession: {
          requestId: run.origin.requestId,
          sessionId: run.origin.sessionId,
          client: run.origin.client,
          userId: run.origin.userId,
        },
      } satisfies WorkflowRequestPolicy;
      const policy: WorkflowRequestPolicy = durableHandoff
        ? { ...handoff.policy, dispatchEpoch }
        : newlyResolvedPolicy;
      if (
        handoff.status === "live" &&
        canonicalJson(jsonValueSchema.parse(policy)) !==
          canonicalJson(jsonValueSchema.parse(handoff.policy))
      ) {
        throw new Error(
          "Live workflow dispatch policy diverged from its durable operation identity",
        );
      }
      let racedReceipt: WorkflowRequestTerminalReceipt | null = null;
      if (!liveOwner) {
        const dispatched = this.input.store.authorizeAgentDispatch({
          requestId: reqId,
          runId: run.runId,
          operationId: operation.operationId,
          runOwnerId: this.workerId,
          sessionId,
          platform: "unknown",
          policy,
          now: this.now(),
          staleOwnerBefore: this.now() - WORKFLOW_REQUEST_LEASE_STALE_MS,
        });
        if (!dispatched) {
          racedReceipt = this.input.store.getWorkflowRequestTerminalReceipt(reqId);
          if (!racedReceipt) throw new Error("Workflow dispatch authorization was rejected");
        }
      }
      if (racedReceipt) {
        result = await adoptReceipt(racedReceipt);
      } else {
        if (current.state === "queued") {
          await this.publishOperation(revision, operation, "dispatched", "queued");
          current = this.input.store.getOperation(run.runId, operation.operationId) ?? current;
        }
        const request = {
          run,
          revision,
          operation: current,
          prompt: input.prompt,
          profile,
          model,
          reasoning,
          policy,
          requestId: reqId,
          agentCwd,
          signal,
          reconcile,
          dispatchEpoch,
          sessionId,
          publishRequest: !liveOwner,
        };
        result = this.input.dispatchAgentRequest
          ? await this.input.dispatchAgentRequest(request)
          : await this.waitForAgentRequest(request);
      }
      adoptedTerminalReceipt ||=
        result.source === "receipt" || result.source === "terminal_receipt";
      if (
        result.source === "terminal_without_receipt" ||
        (result.source === "terminal_receipt" && result.state === "cancelled")
      ) {
        ambiguousTerminalResult = true;
        this.input.store.blockAmbiguousTerminalLifecycleOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        });
      } else if (
        adoptedTerminalReceipt &&
        result.state === "cancelled" &&
        this.input.store.blockAmbiguousPausedCancelledOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        })
      ) {
        ambiguousTerminalResult = true;
      }
    }
    if (
      ambiguousTerminalResult ||
      (adoptedTerminalReceipt &&
        result.state === "cancelled" &&
        this.input.store.blockAmbiguousPausedCancelledOperation({
          runId: run.runId,
          operationId: operation.operationId,
          requestId: reqId,
          runOwnerId: this.workerId,
          now: this.now(),
        }))
    ) {
      throw new Error(
        "Workflow terminal lifecycle is ambiguous and requires manual reconciliation",
      );
    }
    let latest = this.input.store.getOperation(run.runId, operation.operationId);
    if (this.stopping) {
      throw new Error("Workflow engine stopped for durable recovery");
    }
    if (signal.aborted && this.input.store.getRun(run.runId)?.state === "paused") {
      throw new Error("Workflow operation paused for durable replay");
    }
    if (this.input.store.getRun(run.runId)?.claimedBy !== this.workerId) {
      throw new Error("Workflow operation lease was lost before completion");
    }
    if (!latest || isTerminalOperation(latest.state)) {
      if (latest?.state === "succeeded") return latest.output;
      throw new Error(latest?.error ?? "Agent operation ended");
    }
    if (latest.state === "queued" && adoptedTerminalReceipt) {
      const transitioned = this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: "queued",
        to: "dispatched",
        now: this.now(),
      });
      if (!transitioned) throw new Error("Receipt-backed operation could not resume its journal");
      await this.publishOperation(revision, operation, "dispatched", "queued");
      latest = this.input.store.getOperation(run.runId, operation.operationId) ?? latest;
    }
    const nextState =
      result.state === "resolved"
        ? "succeeded"
        : result.state === "timed_out"
          ? "timed_out"
          : result.state === "cancelled"
            ? "cancelled"
            : "failed";
    if (result.state === "resolved" && !result.output) {
      throw new Error("Agent request resolved without captured final output");
    }
    const outputBytes = Buffer.byteLength(canonicalJson(result.output), "utf8");
    if (outputBytes > revision.limits.maxOperationOutputBytes) {
      throw new Error(`Agent output exceeds ${revision.limits.maxOperationOutputBytes} bytes`);
    }
    const resultArtifactId =
      result.state === "resolved" && outputBytes > WORKFLOW_INLINE_VALUE_BYTES
        ? await writeWorkflowValueArtifact({
            dataDir: this.input.dataDir,
            value: result.output,
            maxBytes: revision.limits.maxOperationOutputBytes,
          })
        : null;
    if (latest.state === "dispatched" && result.state === "resolved") {
      this.input.store.transitionOperation({
        runOwnerId: this.workerId,
        runId: run.runId,
        operationId: operation.operationId,
        from: "dispatched",
        to: "running",
        now: this.now(),
      });
      await this.publishOperation(revision, operation, "running", "dispatched");
    }
    const terminalFrom =
      this.input.store.getOperation(run.runId, operation.operationId)?.state ?? latest.state;
    const terminalized = this.input.store.terminalizeOperationAndExpireRequest({
      runOwnerId: this.workerId,
      runId: run.runId,
      operationId: operation.operationId,
      requestId: reqId,
      from: terminalFrom,
      to: nextState,
      now: this.now(),
      output: resultArtifactId ? null : result.output || null,
      resultArtifactId,
      error: result.state === "resolved" ? null : (result.detail ?? result.state),
      usage: result.usage,
    });
    if (!terminalized) throw new Error("Agent operation terminal transition lost its fenced lease");
    await this.publishOperation(revision, operation, nextState, terminalFrom);
    if (result.usage) await this.publishUsage(run, revision, operation.operationId);
    if (nextState !== "succeeded") throw new Error(result.detail ?? `Agent request ${nextState}`);
    return result.output;
  }

  private async dispatchAgentSafely(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    input: ResolvedWorkflowAgentInput,
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<JsonValue> {
    try {
      return await this.dispatchAgent(run, revision, operation, input, signal, reconcile);
    } catch (error) {
      if (this.stopping) throw error;
      const currentRun = this.input.store.getRun(run.runId);
      if (currentRun?.claimedBy !== this.workerId) throw error;
      if (signal.aborted && currentRun?.state === "paused") throw error;
      const current = this.input.store.getOperation(run.runId, operation.operationId);
      if (current && !isTerminalOperation(current.state)) {
        const state = signal.aborted ? "cancelled" : "failed";
        if (current.state === "queued" && state === "failed") {
          this.input.store.transitionOperation({
            runOwnerId: this.workerId,
            runId: run.runId,
            operationId: operation.operationId,
            from: "queued",
            to: "dispatched",
            now: this.now(),
          });
        }
        const from =
          this.input.store.getOperation(run.runId, operation.operationId)?.state ?? current.state;
        this.input.store.transitionOperation({
          runOwnerId: this.workerId,
          runId: run.runId,
          operationId: operation.operationId,
          from,
          to: state,
          now: this.now(),
          error: boundedError(error),
        });
        await this.publishOperation(revision, operation, state, from);
      }
      throw error;
    }
  }

  private async waitForAgentRequest(input: {
    run: WorkflowRun;
    revision: WorkflowRevision;
    operation: WorkflowOperation;
    prompt: string;
    profile: "explore" | "general" | "self";
    model?: string;
    reasoning?: ResolvedWorkflowAgentInput["options"]["reasoning"];
    policy: WorkflowRequestPolicy;
    requestId: string;
    agentCwd: string;
    signal: AbortSignal;
    reconcile: boolean;
    dispatchEpoch: string;
    sessionId: string;
    publishRequest: boolean;
  }): Promise<AgentRequestResult> {
    let output = "";
    let usage: WorkflowUsage | null = null;
    let lifecycle: RequestLifecycleState | null = null;
    let detail: string | null = null;
    let settled = false;
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleCancellationTimer: ReturnType<typeof setTimeout> | null = null;
    let receiptTimer: ReturnType<typeof setTimeout> | null = null;
    let readingReceipt = false;
    let settle: (value: AgentRequestResult) => void = () => {};
    const result = new Promise<AgentRequestResult>((resolve) => (settle = resolve));
    const finishResult = (value: AgentRequestResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (idleCancellationTimer) clearTimeout(idleCancellationTimer);
      if (receiptTimer) clearTimeout(receiptTimer);
      settle(value);
    };
    const finish = (state: AgentRequestResult["state"]): void => {
      if (state === "resolved" && lifecycle === "resolved" && !output) return;
      finishResult({ state, output, detail, usage });
    };
    const readExactReceipt = (): WorkflowRequestTerminalReceipt | null => {
      const receipt = this.input.store.getWorkflowRequestTerminalReceipt(input.requestId);
      if (!receipt) return null;
      if (
        receipt.requestId !== input.requestId ||
        receipt.runId !== input.run.runId ||
        receipt.operationId !== input.operation.operationId ||
        receipt.dispatchEpoch !== input.dispatchEpoch
      ) {
        throw new Error("Terminal lifecycle receipt does not match its exact workflow dispatch");
      }
      return receipt;
    };
    const adoptReceipt = async (
      receipt: WorkflowRequestTerminalReceipt,
      source: "receipt" | "terminal_receipt",
    ): Promise<void> => {
      const adopted = await this.adoptTerminalReceipt(receipt, input.revision);
      finishResult({
        ...adopted,
        ...(idleTimedOut
          ? { state: "timed_out" as const, detail: "Agent operation idle timeout" }
          : {}),
        source,
      });
    };
    const pollReceipt = async (): Promise<void> => {
      if (settled || readingReceipt || this.stopping) return;
      readingReceipt = true;
      try {
        const receipt = readExactReceipt();
        if (!receipt) return;
        await adoptReceipt(receipt, "receipt");
      } catch (error) {
        finishResult({
          state: "failed",
          output: "",
          detail: boundedError(error),
          usage: null,
          source: "terminal_without_receipt",
        });
      } finally {
        readingReceipt = false;
      }
    };
    const scheduleReceiptPoll = (): void => {
      if (settled || this.stopping) return;
      receiptTimer = setTimeout(async () => {
        await pollReceipt();
        scheduleReceiptPoll();
      }, this.input.receiptPollMs ?? 25);
      receiptTimer.unref?.();
    };
    const publishIdleCancellation = async (): Promise<void> => {
      while (!settled && idleTimedOut && !this.stopping && !input.signal.aborted) {
        try {
          await this.input.bus.publish(
            lilacEventTypes.CmdRequestMessage,
            { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
            {
              headers: {
                request_id: input.requestId,
                session_id: input.sessionId,
                request_client: "unknown",
                workflow_dispatch_epoch: input.dispatchEpoch,
              },
            },
          );
          return;
        } catch {
          await Bun.sleep(100);
        }
      }
    };
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || idleTimedOut) return;
        idleTimedOut = true;
        idleCancellationTimer = setTimeout(() => {
          finishResult({
            state: "timed_out",
            output: "",
            detail:
              "Agent operation idle cancellation did not reach an exact terminal receipt after process-tree quiescence wait",
            usage,
            source: "terminal_without_receipt",
          });
        }, IDLE_CANCEL_QUIESCENCE_WAIT_MS);
        idleCancellationTimer.unref?.();
        void publishIdleCancellation();
      }, input.revision.resources.operationIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const resetIdle = (): void => {
      if (!idleTimedOut) armIdle();
    };
    const suffix = `${input.requestId}:${crypto.randomUUID()}`;
    const handleOutputMessage = async (
      message: Awaited<ReturnType<LilacBus["fetchTopic"]>>["messages"][number]["msg"],
    ): Promise<void> => {
      if (
        message.headers?.request_id !== input.requestId ||
        message.headers?.workflow_dispatch_epoch !== input.dispatchEpoch
      ) {
        return;
      }
      resetIdle();
      if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) output += message.data.delta;
      if (message.type === lilacEventTypes.EvtAgentOutputResponseText) {
        output = message.data.finalText;
        usage = message.data.usage ?? null;
      }
    };
    const handleLifecycleMessage = async (
      message: Awaited<ReturnType<LilacBus["fetchTopic"]>>["messages"][number]["msg"],
    ): Promise<void> => {
      if (
        message.type !== lilacEventTypes.EvtRequestLifecycleChanged ||
        message.headers?.request_id !== input.requestId ||
        message.headers?.workflow_dispatch_epoch !== input.dispatchEpoch
      ) {
        return;
      }
      resetIdle();
      lifecycle = message.data.state;
      detail = message.data.detail ?? null;
      const current = this.input.store.getOperation(input.run.runId, input.operation.operationId);
      if (message.data.state === "running" && current?.state === "dispatched") {
        this.input.store.transitionOperation({
          runOwnerId: this.workerId,
          runId: input.run.runId,
          operationId: input.operation.operationId,
          from: "dispatched",
          to: "running",
          now: this.now(),
        });
        await this.publishOperation(input.revision, input.operation, "running", "dispatched");
      }
      const terminalState = message.data.state;
      if (
        terminalState !== "resolved" &&
        terminalState !== "failed" &&
        terminalState !== "cancelled"
      ) {
        return;
      }

      readingReceipt = true;
      try {
        const deadline = Date.now() + TERMINAL_RECEIPT_WAIT_MS;
        while (!settled && !this.stopping) {
          const receipt = readExactReceipt();
          if (receipt) {
            if (receipt.state !== terminalState) {
              throw new Error(
                `Terminal lifecycle state ${terminalState} does not match durable receipt state ${receipt.state}`,
              );
            }
            await adoptReceipt(receipt, "terminal_receipt");
            return;
          }
          if (Date.now() >= deadline) break;
          await Bun.sleep(10);
        }
        finishResult({
          state: terminalState,
          output: "",
          detail: detail ?? "Terminal lifecycle arrived without its exact durable receipt",
          usage,
          source: "terminal_without_receipt",
        });
      } catch (error) {
        finishResult({
          state: terminalState,
          output: "",
          detail: boundedError(error),
          usage,
          source: "terminal_without_receipt",
        });
      } finally {
        readingReceipt = false;
      }
    };
    const outSub = await this.input.bus.subscribeTopic(
      outReqTopic(input.requestId),
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 100 } },
      async (message, context) => {
        await handleOutputMessage(message);
        await context.commit();
      },
    );
    const evtSub = await this.input.bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: `workflow-request:${suffix}`,
        consumerId: suffix,
        ephemeral: true,
        offset: { type: "begin" },
        batch: { maxWaitMs: 100 },
      },
      async (message, context) => {
        await handleLifecycleMessage(message);
        await context.commit();
      },
    );
    const abort = (): void => {
      if (input.signal.reason !== "workflow lease lost" && input.signal.reason !== "shutdown") {
        void this.input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
          {
            headers: {
              request_id: input.requestId,
              session_id: input.sessionId,
              request_client: "unknown",
            },
          },
        );
      }
      finish("cancelled");
    };
    input.signal.addEventListener("abort", abort, { once: true });
    armIdle();
    await pollReceipt();
    scheduleReceiptPoll();
    if (input.reconcile || input.publishRequest) {
      let outputCursor: string | undefined;
      do {
        const batch = await this.input.bus.fetchTopic(outReqTopic(input.requestId), {
          offset: outputCursor ? { type: "cursor", cursor: outputCursor } : { type: "begin" },
          limit: 1_000,
        });
        for (const entry of batch.messages) await handleOutputMessage(entry.msg);
        const previous = outputCursor;
        outputCursor = batch.next;
        if (batch.messages.length < 1_000 || !outputCursor || outputCursor === previous) break;
      } while (!settled);

      let lifecycleCursor: string | undefined;
      do {
        const batch = await this.input.bus.fetchTopic("evt.request", {
          offset: lifecycleCursor ? { type: "cursor", cursor: lifecycleCursor } : { type: "begin" },
          limit: 1_000,
        });
        for (const entry of batch.messages) await handleLifecycleMessage(entry.msg);
        const previous = lifecycleCursor;
        lifecycleCursor = batch.next;
        if (batch.messages.length < 1_000 || !lifecycleCursor || lifecycleCursor === previous)
          break;
      } while (!settled);
    }
    if (input.publishRequest && !settled) {
      await this.input.beforePromptPublication?.({
        requestId: input.requestId,
        runId: input.run.runId,
        operationId: input.operation.operationId,
        dispatchEpoch: input.dispatchEpoch,
        runOwnerId: this.workerId,
      });
      const publicationClaimed = this.input.store.claimWorkflowRequestPromptPublication({
        requestId: input.requestId,
        runId: input.run.runId,
        operationId: input.operation.operationId,
        runOwnerId: this.workerId,
        now: this.now(),
      });
      if (!publicationClaimed) {
        try {
          const receipt = this.input.store.getWorkflowRequestTerminalReceipt(input.requestId);
          if (!receipt) {
            throw new Error("Workflow prompt publication was rejected without a terminal receipt");
          }
          return await this.adoptTerminalReceipt(receipt, input.revision);
        } finally {
          input.signal.removeEventListener("abort", abort);
          await Promise.all([outSub.stop(), evtSub.stop()]);
        }
      }
      const liveParent =
        input.run.completionTarget.kind === "live_parent" ? input.run.completionTarget : null;
      await this.input.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          queue: "prompt",
          messages: [{ role: "user", content: input.prompt }],
          ...(input.model ? { modelOverride: input.model } : {}),
          raw: {
            workflow: {
              runId: input.run.runId,
              operationId: input.operation.operationId,
              dispatchEpoch: input.dispatchEpoch,
            },
            subagent: {
              profile: input.profile,
              depth: liveParent?.depth ?? 1,
              ...(input.reasoning ? { reasoning: input.reasoning } : {}),
              ...(liveParent
                ? {
                    parentRequestId: liveParent.parentRequestId,
                    parentToolCallId: liveParent.parentToolCallId,
                  }
                : {}),
            },
          },
        },
        {
          headers: {
            request_id: input.requestId,
            session_id: input.sessionId,
            request_client: "unknown",
            workflow_run_id: input.run.runId,
            workflow_operation_id: input.operation.operationId,
            workflow_dispatch_epoch: input.dispatchEpoch,
          },
        },
      );
    }
    const terminal = await result;
    input.signal.removeEventListener("abort", abort);
    await Promise.all([outSub.stop(), evtSub.stop()]);
    return terminal;
  }

  private async adoptTerminalReceipt(
    receipt: WorkflowRequestTerminalReceipt,
    revision: WorkflowRevision,
  ): Promise<AgentRequestResult> {
    const storedOutput = receipt.resultArtifactId
      ? await readWorkflowValueArtifact({
          dataDir: this.input.dataDir,
          artifactId: receipt.resultArtifactId,
          maxBytes: revision.limits.maxOperationOutputBytes,
        })
      : receipt.output;
    if (receipt.state === "resolved" && typeof storedOutput !== "string") {
      throw new Error("Resolved workflow terminal receipt has no adoptable text output");
    }
    return {
      state: receipt.state,
      output: typeof storedOutput === "string" ? storedOutput : "",
      detail: receipt.detail,
      usage: receipt.usage,
      source: "receipt",
    };
  }

  private async stopAgentRequests(runId: string): Promise<void> {
    const target = this.input.store.getRun(runId)?.completionTarget;
    const operations = this.input.store
      .listOperations(runId, { limit: 1_000 })
      .filter((operation) => operation.kind === "agent" && operation.requestId !== null);
    const cancellations = await Promise.allSettled(
      operations.map((operation) => {
        const requestId = operation.requestId;
        if (!requestId) throw new Error("Agent operation is missing its request ID");
        return Promise.resolve().then(() =>
          this.input.bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              queue: "interrupt",
              messages: [],
              raw: { cancel: true, cancelQueued: true, requiresActive: false },
            },
            {
              headers: {
                request_id: requestId,
                session_id:
                  target?.kind === "live_parent"
                    ? target.childSessionId
                    : `workflow:${runId}:${operation.operationId}`,
                request_client: "unknown",
              },
            },
          ),
        );
      }),
    );
    const failures = cancellations
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to cancel agent requests for workflow ${runId}`);
    }
  }

  private async finishRun(
    original: WorkflowRun,
    state: "succeeded" | "failed",
    result: JsonValue,
    detail: string,
  ): Promise<void> {
    const current = this.input.store.getRun(original.runId);
    if (!current || current.state !== "running" || current.claimedBy !== this.workerId) return;
    const revision = this.input.store.getRevision(current.revisionId);
    if (!revision) throw new Error(`Workflow revision not found: ${current.revisionId}`);
    let finalState = state;
    let finalResult = result;
    let finalDetail = detail;
    const activeOperations = this.input.store
      .listOperations(current.runId, { limit: 1_000 })
      .filter((operation) => !isTerminalOperation(operation.state));
    if (state === "succeeded" && activeOperations.length > 0) {
      finalState = "failed";
      finalResult = null;
      finalDetail = "Workflow returned with outstanding unawaited host operations";
    }
    const resultBytes = Buffer.byteLength(canonicalJson(finalResult), "utf8");
    const resultArtifactId =
      finalState === "succeeded" && resultBytes > WORKFLOW_INLINE_VALUE_BYTES
        ? await writeWorkflowValueArtifact({
            dataDir: this.input.dataDir,
            value: finalResult,
            maxBytes: revision.limits.maxResultBytes,
          })
        : null;
    const changed = this.input.store.terminalizeRun({
      runId: current.runId,
      from: "running",
      to: finalState,
      ownerId: this.workerId,
      now: this.now(),
      detail: finalDetail,
      result: resultArtifactId ? null : finalResult,
      resultArtifactId,
    });
    if (!changed) throw new Error("Workflow terminal transition lost its fenced lease");
    if (finalState === "failed") {
      for (const operation of activeOperations) {
        if (!operation.requestId) continue;
        await this.input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
          {
            headers: {
              request_id: operation.requestId,
              session_id:
                current.completionTarget.kind === "live_parent"
                  ? current.completionTarget.childSessionId
                  : `workflow:${current.runId}:${operation.operationId}`,
              request_client: "unknown",
            },
          },
        );
      }
    }
    const updated = this.input.store.getRun(current.runId);
    if (!updated) return;
    await this.publishRun(updated, finalState, "running");
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
      runId: updated.runId,
      revisionId: updated.revisionId,
      state: finalState,
      summary: finalDetail.slice(0, 1_000),
      ts: this.now(),
    });
  }

  private async publishRun(
    run: WorkflowRun,
    state: WorkflowRun["state"],
    previousState?: WorkflowRun["state"],
  ): Promise<void> {
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: run.runId,
      revisionId: run.revisionId,
      state,
      previousState,
      ts: this.now(),
    });
  }

  private async publishOperation(
    revision: WorkflowRevision,
    operation: WorkflowOperation,
    state: WorkflowOperationState,
    previousState?: WorkflowOperationState,
  ): Promise<void> {
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
      runId: operation.runId,
      revisionId: revision.revisionId,
      operationId: operation.operationId,
      kind: operation.kind,
      state,
      previousState,
      phase: operation.phase ?? undefined,
      label: operation.label ?? undefined,
      ts: this.now(),
    });
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: operation.runId,
      revisionId: revision.revisionId,
      reason: "operation_changed",
      ts: this.now(),
    });
  }

  private async publishUsage(
    run: WorkflowRun,
    revision: WorkflowRevision,
    operationIdValue: string,
  ): Promise<void> {
    const operations = this.input.store.listOperations(run.runId, { limit: 1_000 });
    const aggregate = operations.reduce(
      (usage, operation) => ({
        inputTokens: usage.inputTokens + (operation.usage?.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (operation.usage?.outputTokens ?? 0),
        totalTokens: usage.totalTokens + (operation.usage?.totalTokens ?? 0),
        agentCount: usage.agentCount + (operation.kind === "agent" ? 1 : 0),
        activeAgents:
          usage.activeAgents +
          (operation.kind === "agent" && ["dispatched", "running"].includes(operation.state)
            ? 1
            : 0),
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 0, activeAgents: 0 },
    );
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowUsageChanged, {
      runId: run.runId,
      revisionId: revision.revisionId,
      operationId: operationIdValue,
      usage: aggregate,
      ts: this.now(),
    });
  }
}
