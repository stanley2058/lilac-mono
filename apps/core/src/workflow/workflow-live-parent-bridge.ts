import { lilacEventTypes, outReqTopic, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { env } from "@stanley2058/lilac-utils";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowRun } from "./workflow-domain";
import { readWorkflowValueArtifact } from "./workflow-artifact-store";
import { resolveWorkflowSubagentToolResult } from "./workflow-subagent-output";

export type WorkflowLiveParentCompletion = {
  runId: string;
  parentToolCallId: string;
  childRequestId: string;
  profile: "explore" | "general" | "self";
  sessionName: string;
  status: "resolved" | "failed" | "cancelled" | "timeout";
  ok: boolean;
  finalText: string;
  detail?: string;
};

type ParentSignal = {
  version: number;
  waiters: Array<() => void>;
  onActivity?: () => void;
};

async function toCompletion(
  run: WorkflowRun,
  store: DurableWorkflowStore,
  dataDir: string,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<WorkflowLiveParentCompletion> {
  if (run.completionTarget.kind !== "live_parent") {
    throw new Error(`Workflow run ${run.runId} has no live-parent completion target`);
  }
  const timedOut = store
    .listOperations(run.runId, { limit: 1_000 })
    .some((operation) => operation.state === "timed_out");
  const status =
    run.state === "succeeded"
      ? "resolved"
      : run.state === "cancelled"
        ? "cancelled"
        : timedOut
          ? "timeout"
          : "failed";
  const revision = store.getRevision(run.revisionId);
  const result =
    run.state === "succeeded" && run.resultArtifactId && revision
      ? await readWorkflowValueArtifact({
          dataDir,
          artifactId: run.resultArtifactId,
          maxBytes: revision.limits.maxResultBytes,
        })
      : run.result;
  const rawFinalText =
    run.state === "succeeded" ? (typeof result === "string" ? result : JSON.stringify(result)) : "";
  const finalText = await resolveWorkflowSubagentToolResult({
    finalText: rawFinalText,
    childSessionId: run.completionTarget.childSessionId,
    artifacts: toolResultArtifacts,
  });
  return {
    runId: run.runId,
    parentToolCallId: run.completionTarget.parentToolCallId,
    childRequestId: run.completionTarget.childRequestId,
    profile: run.completionTarget.profile,
    sessionName: run.completionTarget.sessionName,
    status,
    ok: status === "resolved",
    finalText,
    ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
  };
}

export class WorkflowLiveParentBridge {
  private readonly logger = createLogger({ module: "workflow-live-parent-bridge" });
  private readonly parents = new Map<string, ParentSignal>();
  private readonly protectedParents = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly childActivitySubscriptions = new Map<
    string,
    { runId: string; parentRequestId: string; stop(): Promise<void> }
  >();
  private subscription: { stop(): Promise<void> } | null = null;
  private fallbacksEnabled = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      dataDir?: string;
      toolResultArtifacts?: ToolResultArtifactStore;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    this.subscription = await this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 250 },
      },
      async (message, context) => {
        if (
          message.type === lilacEventTypes.EvtWorkflowResultReady ||
          message.type === lilacEventTypes.EvtWorkflowOperationChanged ||
          message.type === lilacEventTypes.EvtWorkflowRunChanged
        ) {
          await this.handleRunEvent(message.data.runId);
        }
        await context.commit();
      },
    );
  }

  async stop(): Promise<void> {
    await this.subscription?.stop();
    this.subscription = null;
    for (const signal of this.parents.values()) this.notify(signal);
    this.parents.clear();
    for (const timer of this.protectedParents.values()) clearTimeout(timer);
    this.protectedParents.clear();
    await Promise.all(
      [...this.childActivitySubscriptions.values()].map(async (subscription) =>
        subscription.stop(),
      ),
    );
    this.childActivitySubscriptions.clear();
  }

  async enableFallbacks(options?: {
    protectedParentRequestIds?: readonly string[];
    protectionMs?: number;
  }): Promise<void> {
    this.fallbacksEnabled = true;
    for (const parentRequestId of options?.protectedParentRequestIds ?? []) {
      if (this.parents.has(parentRequestId) || this.protectedParents.has(parentRequestId)) continue;
      const timer = setTimeout(() => {
        this.protectedParents.delete(parentRequestId);
        void this.fallbackParentCompletions(parentRequestId);
      }, options?.protectionMs ?? 120_000);
      timer.unref?.();
      this.protectedParents.set(parentRequestId, timer);
    }
    for (const run of this.input.store.listOrphanedLiveParentCompletions()) {
      const parentRequestId =
        run.completionTarget.kind === "live_parent" ? run.completionTarget.parentRequestId : "";
      if (!this.parents.has(parentRequestId) && !this.protectedParents.has(parentRequestId)) {
        await this.fallback(run);
      }
    }
  }

  registerParent(input: {
    parentRequestId: string;
    onActivity?: () => void;
    recoverSynchronousDeliveries?: boolean;
  }) {
    const existing = this.parents.get(input.parentRequestId);
    if (existing)
      throw new Error(`Live workflow parent is already registered: ${input.parentRequestId}`);
    const protection = this.protectedParents.get(input.parentRequestId);
    if (protection) clearTimeout(protection);
    this.protectedParents.delete(input.parentRequestId);
    const signal: ParentSignal = { version: 0, waiters: [], onActivity: input.onActivity };
    this.parents.set(input.parentRequestId, signal);
    this.notify(signal);
    const ready = Promise.all(
      this.input.store
        .listActiveLiveParentRuns(input.parentRequestId)
        .map(async (run) => await this.ensureChildActivityForwarding(run, signal)),
    ).then(() => {});
    let closed = false;

    return {
      ready,
      snapshot: () => ({
        signalVersion: signal.version,
        hasPendingCompletions:
          this.input.store.listPendingLiveParentCompletions(
            input.parentRequestId,
            1,
            input.recoverSynchronousDeliveries,
          ).length > 0,
        hasOutstandingRuns:
          this.input.store.listActiveLiveParentRuns(input.parentRequestId, 1).length > 0,
      }),
      listPending: (): WorkflowLiveParentCompletion[] =>
        this.input.store
          .listPendingLiveParentCompletions(
            input.parentRequestId,
            1_000,
            input.recoverSynchronousDeliveries,
          )
          .map((run) => {
            if (run.resultArtifactId) {
              throw new Error("Artifact-backed completion requires listPendingAsync");
            }
            if (
              typeof run.result === "string" &&
              run.result.includes("Complete output: tool-result://")
            ) {
              throw new Error("Tool-result-backed completion requires listPendingAsync");
            }
            if (run.completionTarget.kind !== "live_parent") {
              throw new Error(`Workflow run ${run.runId} has no live-parent completion target`);
            }
            const status =
              run.state === "succeeded"
                ? "resolved"
                : run.state === "cancelled"
                  ? "cancelled"
                  : "failed";
            return {
              runId: run.runId,
              parentToolCallId: run.completionTarget.parentToolCallId,
              childRequestId: run.completionTarget.childRequestId,
              profile: run.completionTarget.profile,
              sessionName: run.completionTarget.sessionName,
              status,
              ok: status === "resolved",
              finalText:
                run.state === "succeeded"
                  ? typeof run.result === "string"
                    ? run.result
                    : JSON.stringify(run.result)
                  : "",
              ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
            };
          }),
      listPendingAsync: async (): Promise<WorkflowLiveParentCompletion[]> =>
        await Promise.all(
          this.input.store
            .listPendingLiveParentCompletions(
              input.parentRequestId,
              1_000,
              input.recoverSynchronousDeliveries,
            )
            .map(
              async (run) =>
                await toCompletion(
                  run,
                  this.input.store,
                  this.input.dataDir ?? env.dataDir,
                  this.input.toolResultArtifacts,
                ),
            ),
        ),
      acknowledge: async (runIds: readonly string[]) => {
        const now = this.now();
        for (const runId of runIds) {
          this.input.store.markLiveParentCompletionDelivered(runId, now);
          await this.stopChildActivityForRun(runId);
        }
      },
      waitForSignalSince: async (version: number) => {
        if (closed || signal.version !== version) return;
        await new Promise<void>((resolve) => {
          if (closed || signal.version !== version) resolve();
          else signal.waiters.push(resolve);
        });
      },
      cancelAll: async (detail: string) => {
        const runs = this.input.store.listActiveLiveParentRuns(input.parentRequestId);
        for (const run of runs) await this.cancelRun(run, detail);
        for (const completion of this.input.store.listPendingLiveParentCompletions(
          input.parentRequestId,
          1_000,
          true,
        )) {
          this.input.store.markLiveParentCompletionDelivered(completion.runId, this.now());
          await this.stopChildActivityForRun(completion.runId);
        }
        this.notify(signal);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (this.parents.get(input.parentRequestId) === signal) {
          this.parents.delete(input.parentRequestId);
        }
        this.notify(signal);
        await this.stopChildActivityForParent(input.parentRequestId);
      },
    };
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private notify(signal: ParentSignal): void {
    signal.version += 1;
    signal.onActivity?.();
    const waiters = signal.waiters.splice(0, signal.waiters.length);
    for (const waiter of waiters) waiter();
  }

  private async handleRunEvent(runId: string): Promise<void> {
    const run = this.input.store.getRun(runId);
    if (!run || run.completionTarget.kind !== "live_parent") return;
    await this.stopTerminalChildActivities(run);
    const signal = this.parents.get(run.completionTarget.parentRequestId);
    if (signal) {
      if (["succeeded", "failed", "rejected", "cancelled"].includes(run.state)) {
        await this.stopChildActivityForRun(run.runId);
      } else {
        await this.ensureChildActivityForwarding(run, signal);
      }
      this.notify(signal);
      if (run.state === "running" || run.state === "blocked") {
        const recent = this.input.store.listOperations(run.runId, { limit: 1_000 }).at(-1);
        const detail = recent
          ? `; ${recent.label ?? recent.kind}: ${recent.state}`.slice(0, 180)
          : "";
        await this.input.bus
          .publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId: run.completionTarget.parentToolCallId,
              status: "update",
              display: `subagent (${run.completionTarget.profile}; ${run.state}${detail})`,
            },
            {
              headers: {
                request_id: run.completionTarget.parentRequestId,
                session_id: run.completionTarget.parentSessionId,
                request_client: run.completionTarget.parentRequestClient,
              },
            },
          )
          .catch((error: unknown) => {
            this.logger.warn("live-parent subagent progress publish failed", { runId }, error);
          });
      }
      return;
    }
    if (
      this.fallbacksEnabled &&
      !this.protectedParents.has(run.completionTarget.parentRequestId) &&
      ["succeeded", "failed", "rejected", "cancelled"].includes(run.state)
    ) {
      await this.fallback(run);
    }
  }

  private async ensureChildActivityForwarding(
    run: WorkflowRun,
    signal: ParentSignal,
  ): Promise<void> {
    if (run.completionTarget.kind !== "live_parent") return;
    const target = run.completionTarget;
    const childRequestId = this.input.store
      .listOperations(run.runId, { limit: 1_000 })
      .filter(
        (operation) =>
          operation.kind === "agent" &&
          operation.requestId !== null &&
          !["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state),
      )
      .at(-1)?.requestId;
    if (!childRequestId || this.childActivitySubscriptions.has(childRequestId)) return;
    const subscription = await this.input.bus.subscribeTopic(
      outReqTopic(childRequestId),
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
      async (message, context) => {
        if (
          message.type === lilacEventTypes.EvtAgentOutputActivity ||
          message.type === lilacEventTypes.EvtAgentOutputDeltaText ||
          message.type === lilacEventTypes.EvtAgentOutputDeltaReasoning ||
          message.type === lilacEventTypes.EvtAgentOutputToolCall
        ) {
          this.notify(signal);
          const detail =
            message.type === lilacEventTypes.EvtAgentOutputToolCall
              ? message.data.display
              : message.type === lilacEventTypes.EvtAgentOutputDeltaText
                ? `output: ${message.data.delta.replaceAll(/\s+/gu, " ").trim()}`
                : message.type === lilacEventTypes.EvtAgentOutputDeltaReasoning
                  ? "reasoning activity"
                  : `${message.data.source} activity`;
          await this.input.bus.publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId: target.parentToolCallId,
              status: "update",
              display: `subagent (${target.profile}; ${detail.slice(0, 160)})`,
            },
            {
              headers: {
                request_id: target.parentRequestId,
                session_id: target.parentSessionId,
                request_client: target.parentRequestClient,
              },
            },
          );
        }
        await context.commit();
      },
    );
    this.childActivitySubscriptions.set(childRequestId, {
      runId: run.runId,
      parentRequestId: target.parentRequestId,
      stop: () => subscription.stop(),
    });
  }

  private async stopChildActivityForRun(runId: string): Promise<void> {
    const matching = [...this.childActivitySubscriptions.entries()].filter(
      ([, subscription]) => subscription.runId === runId,
    );
    for (const [requestId, subscription] of matching) {
      this.childActivitySubscriptions.delete(requestId);
      await subscription.stop();
    }
  }

  private async stopTerminalChildActivities(run: WorkflowRun): Promise<void> {
    const terminalRequestIds = new Set(
      this.input.store
        .listOperations(run.runId, { limit: 1_000 })
        .flatMap((operation) =>
          operation.kind === "agent" &&
          operation.requestId !== null &&
          ["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state)
            ? [operation.requestId]
            : [],
        ),
    );
    for (const requestId of terminalRequestIds) {
      const subscription = this.childActivitySubscriptions.get(requestId);
      if (!subscription) continue;
      this.childActivitySubscriptions.delete(requestId);
      await subscription.stop();
    }
  }

  private async stopChildActivityForParent(parentRequestId: string): Promise<void> {
    const matching = [...this.childActivitySubscriptions.entries()].filter(
      ([, subscription]) => subscription.parentRequestId === parentRequestId,
    );
    for (const [requestId, subscription] of matching) {
      this.childActivitySubscriptions.delete(requestId);
      await subscription.stop();
    }
  }

  private async fallbackParentCompletions(parentRequestId: string): Promise<void> {
    if (this.parents.has(parentRequestId)) return;
    for (const run of this.input.store.listPendingLiveParentCompletions(
      parentRequestId,
      1_000,
      true,
    )) {
      await this.fallback(run);
    }
  }

  private async fallback(run: WorkflowRun): Promise<void> {
    await toCompletion(
      run,
      this.input.store,
      this.input.dataDir ?? env.dataDir,
      this.input.toolResultArtifacts,
    );
    if (run.completionTarget.kind !== "live_parent") return;
    const parentRequestId = run.completionTarget.parentRequestId;
    // Parent ownership is process-local. With no await before the immediate SQLite transaction,
    // registerParent cannot interleave with this recheck in this runtime. Cross-runtime ownership
    // would require a durable parent lease, which this single-runtime bridge does not provide.
    if (this.parents.has(parentRequestId) || this.protectedParents.has(parentRequestId)) return;
    const updated = this.input.store.activateLiveParentFallback(run.runId, this.now());
    if (!updated) return;
    await this.stopChildActivityForRun(run.runId);
    if (updated.progressTarget) {
      await this.input.bus
        .publish(lilacEventTypes.EvtWorkflowProgressRequested, {
          runId: updated.runId,
          revisionId: updated.revisionId,
          reason: "reconcile",
          ts: this.now(),
        })
        .catch((error: unknown) => {
          this.logger.warn(
            "live-parent fallback progress publish failed; projector reconciliation will recover",
            { runId: updated.runId },
            error,
          );
        });
    }
  }

  private async cancelRun(run: WorkflowRun, detail: string): Promise<void> {
    const cancelled = this.input.store.cancelRunAndChildren({
      runId: run.runId,
      now: this.now(),
      detail,
    });
    if (cancelled?.state !== "cancelled") return;
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: run.runId,
      revisionId: run.revisionId,
      state: "cancelled",
      previousState: run.state,
      detail,
      ts: this.now(),
    });
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
      runId: run.runId,
      revisionId: run.revisionId,
      state: "cancelled",
      summary: detail,
      ts: this.now(),
    });
  }
}
