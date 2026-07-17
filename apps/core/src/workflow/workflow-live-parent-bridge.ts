import { lilacEventTypes, outReqTopic, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { env } from "@stanley2058/lilac-utils";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { type ChildToolState, renderSubagentDisplay } from "../tools/subagent";
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

export type WorkflowLiveParentCompletionIdentity = Omit<WorkflowLiveParentCompletion, "finalText">;

type ParentSignal = {
  version: number;
  waiters: Set<() => void>;
  onActivity?: () => void;
};

type LiveParentTarget = Extract<WorkflowRun["completionTarget"], { kind: "live_parent" }>;
type ChildOutputMessage = Awaited<ReturnType<LilacBus["fetchTopic"]>>["messages"][number]["msg"];

type ChildActivityForwarding = {
  runId: string;
  parentRequestId: string;
  children: Map<string, ChildToolState>;
  updateSeq: number;
  acceptingLive: boolean;
  subscriptions: Map<string, { stop(): Promise<void> }>;
  subscriptionStarts: Map<string, Promise<void>>;
  publicationTail: Promise<void>;
  stopPromise: Promise<void> | null;
};

function isTerminalRun(run: WorkflowRun): boolean {
  return ["succeeded", "failed", "rejected", "cancelled"].includes(run.state);
}

function toCompletionIdentity(
  run: WorkflowRun,
  store: DurableWorkflowStore,
): WorkflowLiveParentCompletionIdentity {
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
  return {
    runId: run.runId,
    parentToolCallId: run.completionTarget.parentToolCallId,
    childRequestId: run.completionTarget.childRequestId,
    profile: run.completionTarget.profile,
    sessionName: run.completionTarget.sessionName,
    status,
    ok: status === "resolved",
    ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
  };
}

async function toCompletion(
  run: WorkflowRun,
  store: DurableWorkflowStore,
  dataDir: string,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<WorkflowLiveParentCompletion> {
  const identity = toCompletionIdentity(run, store);
  if (run.completionTarget.kind !== "live_parent") {
    throw new Error(`Workflow run ${run.runId} has no live-parent completion target`);
  }
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
    ...identity,
    finalText,
  };
}

export class WorkflowLiveParentBridge {
  private readonly logger = createLogger({ module: "workflow-live-parent-bridge" });
  private readonly parents = new Map<string, ParentSignal>();
  private readonly protectedParents = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly childActivitySubscriptions = new Map<string, ChildActivityForwarding>();
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
      [...this.childActivitySubscriptions.values()].map(async (forwarding) =>
        this.stopChildActivity(forwarding),
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
    const signal: ParentSignal = { version: 0, waiters: new Set(), onActivity: input.onActivity };
    this.parents.set(input.parentRequestId, signal);
    this.notify(signal);
    const runsById = new Map<string, WorkflowRun>();
    for (const run of this.input.store.listActiveLiveParentRuns(input.parentRequestId)) {
      runsById.set(run.runId, run);
    }
    for (const run of this.input.store.listPendingLiveParentCompletions(
      input.parentRequestId,
      1_000,
      input.recoverSynchronousDeliveries,
    )) {
      runsById.set(run.runId, run);
    }
    const ready = Promise.all(
      [...runsById.values()].map(async (run) => {
        if (isTerminalRun(run)) await this.reconcileTerminalChildActivity(run, signal);
        else await this.ensureChildActivityForwarding(run, signal);
      }),
    ).then(() => {});
    let closed = false;

    return {
      ready,
      snapshot: () => {
        const durable = this.input.store.getLiveParentDeliverySnapshot(
          input.parentRequestId,
          input.recoverSynchronousDeliveries,
        );
        return {
          signalVersion: signal.version,
          hasPendingCompletions: durable.pendingCompletionCount > 0,
          hasOutstandingRuns: durable.outstandingRunCount > 0,
        };
      },
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
      listPendingIdentities: (): WorkflowLiveParentCompletionIdentity[] =>
        this.input.store
          .listPendingLiveParentCompletions(
            input.parentRequestId,
            1_000,
            input.recoverSynchronousDeliveries,
          )
          .map((run) => toCompletionIdentity(run, this.input.store)),
      listPendingSettledAsync: async (): Promise<
        Array<
          | { loaded: true; completion: WorkflowLiveParentCompletion }
          | { loaded: false; identity: WorkflowLiveParentCompletionIdentity; error: unknown }
        >
      > =>
        await Promise.all(
          this.input.store
            .listPendingLiveParentCompletions(
              input.parentRequestId,
              1_000,
              input.recoverSynchronousDeliveries,
            )
            .map(async (run) => {
              const identity = toCompletionIdentity(run, this.input.store);
              try {
                return {
                  loaded: true as const,
                  completion: await toCompletion(
                    run,
                    this.input.store,
                    this.input.dataDir ?? env.dataDir,
                    this.input.toolResultArtifacts,
                  ),
                };
              } catch (error) {
                return { loaded: false as const, identity, error };
              }
            }),
        ),
      acknowledge: async (runIds: readonly string[]) => {
        const now = this.now();
        for (const runId of runIds) {
          this.input.store.markLiveParentCompletionDelivered(runId, now);
          await this.stopChildActivityForRun(runId);
        }
      },
      recordMaterializationFailure: (runId: string, error: string): number | null =>
        this.input.store.recordLiveParentCompletionMaterializationFailure({
          runId,
          error,
          now: this.now(),
        }),
      clearMaterializationFailure: (runId: string): boolean =>
        this.input.store.clearLiveParentCompletionMaterializationFailure(runId, this.now()),
      waitForSignalSince: async (version: number, abortSignal?: AbortSignal) => {
        if (closed || signal.version !== version || abortSignal?.aborted) return;
        await new Promise<void>((resolve) => {
          const finish = () => {
            signal.waiters.delete(finish);
            abortSignal?.removeEventListener("abort", finish);
            resolve();
          };
          if (closed || signal.version !== version || abortSignal?.aborted) {
            finish();
            return;
          }
          signal.waiters.add(finish);
          abortSignal?.addEventListener("abort", finish, { once: true });
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
    const waiters = [...signal.waiters];
    signal.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private async handleRunEvent(runId: string): Promise<void> {
    const run = this.input.store.getRun(runId);
    if (!run || run.completionTarget.kind !== "live_parent") return;
    const signal = this.parents.get(run.completionTarget.parentRequestId);
    if (signal) {
      if (isTerminalRun(run)) {
        await this.reconcileTerminalChildActivity(run, signal);
        this.notify(signal);
        return;
      }

      const forwarding = await this.ensureChildActivityForwarding(run, signal);
      this.notify(signal);
      if (run.state === "running" || run.state === "blocked") {
        await this.publishParentDisplay(
          forwarding,
          run.completionTarget,
          this.buildFallbackDisplay(forwarding.runId, run.completionTarget, run.state),
        );
      }
      return;
    }
    if (
      this.fallbacksEnabled &&
      !this.protectedParents.has(run.completionTarget.parentRequestId) &&
      isTerminalRun(run)
    ) {
      await this.fallback(run);
    }
  }

  private async ensureChildActivityForwarding(
    run: WorkflowRun,
    signal: ParentSignal,
  ): Promise<ChildActivityForwarding> {
    if (run.completionTarget.kind !== "live_parent") {
      throw new Error(`Workflow run ${run.runId} has no live-parent completion target`);
    }
    const target = run.completionTarget;
    let forwarding = this.childActivitySubscriptions.get(run.runId);
    if (!forwarding) {
      forwarding = this.createChildActivityForwarding(run.runId, target);
      this.childActivitySubscriptions.set(run.runId, forwarding);
    }
    await Promise.all(
      this.resolveChildRequestIds(run, target).map(async (childRequestId) => {
        await this.ensureChildOutputSubscription(forwarding, target, signal, childRequestId);
      }),
    );
    return forwarding;
  }

  private async ensureChildOutputSubscription(
    forwarding: ChildActivityForwarding,
    target: LiveParentTarget,
    signal: ParentSignal,
    childRequestId: string,
  ): Promise<void> {
    if (!forwarding.acceptingLive) return;
    if (forwarding.subscriptions.has(childRequestId)) return;
    const existingStart = forwarding.subscriptionStarts.get(childRequestId);
    if (existingStart) return await existingStart;

    const start = (async () => {
      const subscription = await this.input.bus.subscribeTopic(
        outReqTopic(childRequestId),
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async (message, context) => {
          try {
            await this.handleChildActivity(forwarding, target, signal, childRequestId, message);
          } finally {
            await context.commit();
          }
        },
      );
      forwarding.subscriptions.set(childRequestId, subscription);
    })();
    forwarding.subscriptionStarts.set(childRequestId, start);
    try {
      await start;
    } finally {
      if (forwarding.subscriptionStarts.get(childRequestId) === start) {
        forwarding.subscriptionStarts.delete(childRequestId);
      }
    }
  }

  private createChildActivityForwarding(
    runId: string,
    target: LiveParentTarget,
  ): ChildActivityForwarding {
    return {
      runId,
      parentRequestId: target.parentRequestId,
      children: new Map(),
      updateSeq: 0,
      acceptingLive: true,
      subscriptions: new Map(),
      subscriptionStarts: new Map(),
      publicationTail: Promise.resolve(),
      stopPromise: null,
    };
  }

  private resolveChildRequestIds(run: WorkflowRun, target: LiveParentTarget): string[] {
    const requestIds = new Set([target.childRequestId]);
    for (const operation of this.input.store.listOperations(run.runId, { limit: 1_000 })) {
      if (operation.kind === "agent" && operation.requestId !== null) {
        requestIds.add(operation.requestId);
      }
    }
    return [...requestIds];
  }

  private async handleChildActivity(
    forwarding: ChildActivityForwarding,
    target: LiveParentTarget,
    signal: ParentSignal,
    childRequestId: string,
    message: ChildOutputMessage,
  ): Promise<void> {
    if (message.headers?.request_id !== childRequestId || !forwarding.acceptingLive) {
      return;
    }
    if (
      message.type !== lilacEventTypes.EvtAgentOutputActivity &&
      message.type !== lilacEventTypes.EvtAgentOutputDeltaText &&
      message.type !== lilacEventTypes.EvtAgentOutputDeltaReasoning &&
      message.type !== lilacEventTypes.EvtAgentOutputToolCall
    ) {
      return;
    }

    this.notify(signal);
    if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
      this.recordChildTool(forwarding, message);
      await this.publishParentDisplay(forwarding, target);
      return;
    }

    if (forwarding.children.size === 0) {
      const detail = this.childActivityDetail(message);
      await this.publishParentDisplay(
        forwarding,
        target,
        this.buildFallbackDisplay(forwarding.runId, target, "running", detail),
      );
    }
  }

  private childActivityDetail(message: ChildOutputMessage): string | undefined {
    if (message.type === lilacEventTypes.EvtAgentOutputDeltaText) {
      return `output: ${message.data.delta.replaceAll(/\s+/gu, " ").trim()}`;
    }
    if (message.type === lilacEventTypes.EvtAgentOutputDeltaReasoning) return "reasoning activity";
    if (message.type === lilacEventTypes.EvtAgentOutputActivity) {
      return `${message.data.source} activity`;
    }
    return undefined;
  }

  private recordChildTool(
    forwarding: ChildActivityForwarding,
    message: Extract<ChildOutputMessage, { type: typeof lilacEventTypes.EvtAgentOutputToolCall }>,
  ): void {
    const existing = forwarding.children.get(message.data.toolCallId);
    const preserveTerminal = existing?.status === "done" && message.data.status !== "end";
    const next: ChildToolState = {
      toolCallId: message.data.toolCallId,
      status: message.data.status === "end" || preserveTerminal ? "done" : "running",
      ok:
        message.data.status === "end"
          ? message.data.ok === true
          : preserveTerminal
            ? (existing.ok ?? false)
            : (existing?.ok ?? null),
      display: message.data.display,
      updatedSeq: ++forwarding.updateSeq,
    };
    forwarding.children.set(next.toolCallId, next);
  }

  private async publishParentDisplay(
    forwarding: ChildActivityForwarding,
    target: LiveParentTarget,
    fallbackDisplay?: string,
    force = false,
  ): Promise<void> {
    const publish = forwarding.publicationTail.then(async () => {
      if (!force && !forwarding.acceptingLive) return;
      const selection = this.resolveChildModelSelection(forwarding.runId);
      const display =
        forwarding.children.size > 0
          ? renderSubagentDisplay({
              profile: target.profile,
              children: forwarding.children,
              ...(selection?.model ? { model: selection.model } : {}),
              ...(selection?.reasoning ? { reasoning: selection.reasoning } : {}),
            })
          : fallbackDisplay;
      if (!display) return;
      await this.input.bus.publish(
        lilacEventTypes.EvtAgentOutputToolCall,
        {
          toolCallId: target.parentToolCallId,
          status: "update",
          display,
        },
        {
          headers: {
            request_id: target.parentRequestId,
            session_id: target.parentSessionId,
            request_client: target.parentRequestClient,
          },
        },
      );
    });
    forwarding.publicationTail = publish.catch((error: unknown) => {
      this.logger.warn(
        "live-parent subagent progress publish failed",
        { runId: forwarding.runId },
        error,
      );
    });
    await forwarding.publicationTail;
  }

  private resolveChildModelSelection(runId: string):
    | {
        model: string;
        reasoning?: "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
      }
    | undefined {
    const requestIds = this.input.store
      .listOperations(runId, { limit: 1_000 })
      .flatMap((operation) =>
        operation.kind === "agent" && operation.requestId ? [operation.requestId] : [],
      )
      .reverse();
    for (const requestId of requestIds) {
      const policy = this.input.store.getWorkflowRequestDispatchPolicy(requestId);
      if (!policy) continue;
      const reasoning = policy.resolvedModelRequest.reasoning;
      return {
        model: policy.resolvedModelRequest.modelId,
        ...(reasoning ? { reasoning } : {}),
      };
    }
    return undefined;
  }

  private buildFallbackDisplay(
    runId: string,
    target: LiveParentTarget,
    state: string,
    detail?: string,
  ): string {
    const selection = this.resolveChildModelSelection(runId);
    const model = selection
      ? `${selection.model}${selection.reasoning ? ` [${selection.reasoning}]` : ""}`
      : null;
    return `subagent (${[target.profile, model, state, detail?.slice(0, 160) ?? null]
      .filter((part): part is string => part !== null)
      .join("; ")})`;
  }

  private async reconcileTerminalChildActivity(
    run: WorkflowRun,
    signal: ParentSignal,
  ): Promise<void> {
    if (run.completionTarget.kind !== "live_parent") return;
    const target = run.completionTarget;
    const forwarding =
      this.childActivitySubscriptions.get(run.runId) ??
      this.createChildActivityForwarding(run.runId, target);
    forwarding.acceptingLive = false;
    await this.stopChildActivity(forwarding);

    try {
      forwarding.children.clear();
      forwarding.updateSeq = 0;
      for (const childRequestId of this.resolveChildRequestIds(run, target)) {
        const topic = outReqTopic(childRequestId);
        const watermark = await this.input.bus.getTopicWatermark(topic);
        if (!watermark) continue;
        let cursor: string | undefined;
        let reachedWatermark = false;
        while (!reachedWatermark) {
          const batch = await this.input.bus.fetchTopic(topic, {
            offset: cursor ? { type: "cursor", cursor } : { type: "begin" },
            limit: 1_000,
          });
          for (const entry of batch.messages) {
            if (
              entry.msg.headers?.request_id === childRequestId &&
              entry.msg.type === lilacEventTypes.EvtAgentOutputToolCall
            ) {
              this.recordChildTool(forwarding, entry.msg);
            }
            if (entry.cursor === watermark) {
              reachedWatermark = true;
              break;
            }
          }
          const previous = cursor;
          cursor = batch.next;
          if (reachedWatermark || batch.messages.length === 0 || !cursor || cursor === previous) {
            break;
          }
        }
      }

      const terminalState = run.state === "succeeded" ? "resolved" : run.state;
      const fallbackDisplay = this.buildFallbackDisplay(run.runId, target, terminalState);

      if (this.parents.get(target.parentRequestId) === signal) {
        await this.publishParentDisplay(forwarding, target, fallbackDisplay, true);
      }
    } finally {
      if (this.childActivitySubscriptions.get(run.runId) === forwarding) {
        this.childActivitySubscriptions.delete(run.runId);
      }
    }
  }

  private async stopChildActivity(forwarding: ChildActivityForwarding): Promise<void> {
    if (forwarding.stopPromise) return await forwarding.stopPromise;
    forwarding.acceptingLive = false;
    forwarding.stopPromise = (async () => {
      await Promise.all(
        [...forwarding.subscriptionStarts.values()].map(async (start) => start.catch(() => {})),
      );
      await Promise.all(
        [...forwarding.subscriptions.values()].map(async (subscription) => {
          await subscription.stop().catch((error: unknown) => {
            this.logger.warn(
              "live-parent child activity subscription stop failed",
              { runId: forwarding.runId },
              error,
            );
          });
        }),
      );
      await forwarding.publicationTail;
    })();
    await forwarding.stopPromise;
  }

  private async stopChildActivityForRun(runId: string): Promise<void> {
    const forwarding = this.childActivitySubscriptions.get(runId);
    if (!forwarding) return;
    this.childActivitySubscriptions.delete(runId);
    await this.stopChildActivity(forwarding);
  }

  private async stopChildActivityForParent(parentRequestId: string): Promise<void> {
    const matching = [...this.childActivitySubscriptions.entries()].filter(
      ([, forwarding]) => forwarding.parentRequestId === parentRequestId,
    );
    for (const [runId, forwarding] of matching) {
      this.childActivitySubscriptions.delete(runId);
      await this.stopChildActivity(forwarding);
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
