import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { env } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowRun } from "./workflow-domain";
import { readWorkflowValueArtifact } from "./workflow-artifact-store";

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
        ? typeof result === "string"
          ? result
          : JSON.stringify(result)
        : "",
    ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
  };
}

export class WorkflowLiveParentBridge {
  private readonly logger = createLogger({ module: "workflow-live-parent-bridge" });
  private readonly parents = new Map<string, ParentSignal>();
  private readonly protectedParents = new Map<string, ReturnType<typeof setTimeout>>();
  private subscription: { stop(): Promise<void> } | null = null;
  private fallbacksEnabled = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      dataDir?: string;
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

  registerParent(input: { parentRequestId: string; onActivity?: () => void }) {
    const existing = this.parents.get(input.parentRequestId);
    if (existing)
      throw new Error(`Live workflow parent is already registered: ${input.parentRequestId}`);
    const protection = this.protectedParents.get(input.parentRequestId);
    if (protection) clearTimeout(protection);
    this.protectedParents.delete(input.parentRequestId);
    const signal: ParentSignal = { version: 0, waiters: [], onActivity: input.onActivity };
    this.parents.set(input.parentRequestId, signal);
    this.notify(signal);
    let closed = false;

    return {
      snapshot: () => ({
        signalVersion: signal.version,
        hasPendingCompletions:
          this.input.store.listPendingLiveParentCompletions(input.parentRequestId, 1).length > 0,
        hasOutstandingRuns:
          this.input.store.listActiveLiveParentRuns(input.parentRequestId, 1).length > 0,
      }),
      listPending: (): WorkflowLiveParentCompletion[] =>
        this.input.store.listPendingLiveParentCompletions(input.parentRequestId).map((run) => {
          if (run.resultArtifactId) {
            throw new Error("Artifact-backed completion requires listPendingAsync");
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
            .listPendingLiveParentCompletions(input.parentRequestId)
            .map(
              async (run) =>
                await toCompletion(run, this.input.store, this.input.dataDir ?? env.dataDir),
            ),
        ),
      acknowledge: (runIds: readonly string[]) => {
        const now = this.now();
        for (const runId of runIds) this.input.store.markLiveParentCompletionDelivered(runId, now);
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
        )) {
          this.input.store.markLiveParentCompletionDelivered(completion.runId, this.now());
        }
        this.notify(signal);
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.parents.get(input.parentRequestId) === signal) {
          this.parents.delete(input.parentRequestId);
        }
        this.notify(signal);
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
    const signal = this.parents.get(run.completionTarget.parentRequestId);
    if (signal) {
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

  private async fallbackParentCompletions(parentRequestId: string): Promise<void> {
    if (this.parents.has(parentRequestId)) return;
    for (const run of this.input.store.listPendingLiveParentCompletions(parentRequestId)) {
      await this.fallback(run);
    }
  }

  private async fallback(run: WorkflowRun): Promise<void> {
    const updated = this.input.store.activateLiveParentFallback(run.runId, this.now());
    if (!updated) return;
    if (updated.progressTarget) {
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: updated.runId,
        revisionId: updated.revisionId,
        reason: "reconcile",
        ts: this.now(),
      });
    }
  }

  private async cancelRun(run: WorkflowRun, detail: string): Promise<void> {
    if (
      !this.input.store.transitionRun({
        runId: run.runId,
        from: run.state,
        to: "cancelled",
        now: this.now(),
        detail,
      })
    ) {
      return;
    }
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
