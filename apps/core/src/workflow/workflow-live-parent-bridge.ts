import { captureError } from "../shared/error-capture";
import {
  lilacEventTypes,
  outReqTopic,
  type Cursor,
  type DecodedLilacMessageForTopic,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type EventFetchContractInvalid,
  type EventFetchTransportFailed,
  type EventPublishContractInvalid,
  type EventPublishTransportFailed,
  type EventTopicOperationFailed,
  type EventTopicOperationUnsupported,
  type LilacBus,
  type OutReqTopic,
} from "@stanley2058/lilac-event-bus";
import { createLogger, formatTaggedErrorForLog, isPanic } from "@stanley2058/lilac-utils";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  CORE_TOOL_RESULT_RESOURCE_URI_PREFIX,
  type ToolResultArtifactStore,
} from "../artifacts/tool-result-artifact-store";
import { type ChildToolState, renderSubagentDisplay } from "../tools/subagent";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import {
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
} from "./durable-workflow-store";
import type { WorkflowRun } from "./workflow-domain";
import {
  adaptWorkflowArtifactResultToException,
  readWorkflowValueArtifact,
} from "./workflow-artifact-store";
import { formatWorkflowErrorForLog } from "./workflow-error-log";
import { workflowConsumerId } from "./workflow-consumer-id";
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
  publishToolStatus?: (update: {
    toolCallId: string;
    status: "update";
    display: string;
  }) => Promise<void>;
};

type LiveParentTarget = Extract<WorkflowRun["completionTarget"], { kind: "live_parent" }>;
type ChildOutputMessage = DecodedLilacMessageForTopic<OutReqTopic>;

type ResultSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

type ChildOutputBatch = {
  messages: Array<{ msg: ChildOutputMessage; cursor: Cursor }>;
  next?: Cursor;
};

type WorkflowLiveParentTopicError = EventTopicOperationFailed | EventTopicOperationUnsupported;
type WorkflowLiveParentPublishError = EventPublishContractInvalid | EventPublishTransportFailed;

export class WorkflowLiveParentRunEventFailed extends TaggedError(
  "WorkflowLiveParentRunEventFailed",
)<{
  readonly cause: unknown;
  readonly runId: string;
  readonly message: string;
}> {}

export class WorkflowLiveParentChildActivityFailed extends TaggedError(
  "WorkflowLiveParentChildActivityFailed",
)<{
  readonly cause: unknown;
  readonly runId: string;
  readonly childRequestId: string;
  readonly message: string;
}> {}

export type WorkflowLiveParentDeliveryError =
  | WorkflowLiveParentRunEventFailed
  | WorkflowLiveParentChildActivityFailed;

export function applyWorkflowLiveParentDeliveryPolicy(
  error: WorkflowLiveParentDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowLiveParentRunEventFailed":
    case "WorkflowLiveParentChildActivityFailed":
      return "park-pending";
  }
}

async function captureRunEvent(
  runId: string,
  handle: () => Promise<void | ResultType<void, WorkflowLiveParentTopicError>>,
): Promise<ResultType<void, WorkflowLiveParentRunEventFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        const handled = await handle();
        if (handled) {
          return handled
            .map(() => undefined)
            .mapError(
              (cause) =>
                new WorkflowLiveParentRunEventFailed({
                  cause,
                  runId,
                  message: "Live-parent workflow event handling failed",
                }),
            );
        }
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      preserveToolPanic(cause);
      return Result.err(
        new WorkflowLiveParentRunEventFailed({
          cause,
          runId,
          message: "Live-parent workflow event handling failed",
        }),
      );
    }
    return attempt.value;
  }
}

async function captureChildActivity(
  runId: string,
  childRequestId: string,
  handle: () => Promise<void>,
): Promise<ResultType<void, WorkflowLiveParentChildActivityFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        await handle();
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      preserveToolPanic(cause);
      return Result.err(
        new WorkflowLiveParentChildActivityFailed({
          cause,
          runId,
          childRequestId,
          message: "Live-parent child activity handling failed",
        }),
      );
    }
    return attempt.value;
  }
}

function requireSubscriptionStart(
  started: ResultType<ResultSubscription, EventDeliveryStartFailed>,
): ResultSubscription {
  return adaptToolResultToHost(started);
}

function requireSubscriptionStop(stopped: ResultType<void, EventDeliveryStopFailed>): void {
  adaptToolResultToHost(stopped);
}

function requireChildOutputBatch(
  fetched: ResultType<ChildOutputBatch, EventFetchContractInvalid | EventFetchTransportFailed>,
): ChildOutputBatch {
  return adaptToolResultToHost(fetched);
}

type ChildActivityForwarding = {
  runId: string;
  parentRequestId: string;
  children: Map<string, ChildToolState>;
  updateSeq: number;
  acceptingLive: boolean;
  subscriptions: Map<string, ResultSubscription>;
  subscriptionStarts: Map<string, Promise<void>>;
  publicationTail: Promise<void>;
  publishToolStatus: ParentSignal["publishToolStatus"];
  hasPublishedActivity: boolean;
  trailingActivityPublication: { display: string } | null;
  stopPromise: Promise<void> | null;
};

function isTerminalRun(run: WorkflowRun): boolean {
  return ["succeeded", "failed", "rejected", "cancelled"].includes(run.state);
}

function toCompletionStatus(
  state: WorkflowRun["state"],
  timedOut: boolean,
): WorkflowLiveParentCompletion["status"] {
  switch (state) {
    case "succeeded":
      return "resolved";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "running":
    case "blocked":
    case "paused":
    case "failed":
      return timedOut ? "timeout" : "failed";
  }
}

function toCompletionIdentity(
  run: WorkflowRun,
  store: DurableWorkflowStore,
): WorkflowLiveParentCompletionIdentity {
  if (run.completionTarget.kind !== "live_parent") {
    return adaptToolResultToHost(
      Result.err(
        new WorkflowLiveParentRunEventFailed({
          cause: null,
          runId: run.runId,
          message: `Workflow run ${run.runId} has no live-parent completion target`,
        }),
      ),
    );
  }
  const operations = store.listOperations(run.runId, { limit: 1_000 });
  const readEntries = operations.match({
    ok: (value) => () => value,
    err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
  });
  const entries = readEntries();
  const timedOut = entries.some((operation) => operation.state === "timed_out");
  const status = toCompletionStatus(run.state, timedOut);
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
  blobStore: BlobStore,
  toolResultArtifacts?: ToolResultArtifactStore,
): Promise<WorkflowLiveParentCompletion> {
  const identity = toCompletionIdentity(run, store);
  if (run.completionTarget.kind !== "live_parent") {
    return adaptToolResultToHost(
      Result.err(
        new WorkflowLiveParentRunEventFailed({
          cause: null,
          runId: run.runId,
          message: `Workflow run ${run.runId} has no live-parent completion target`,
        }),
      ),
    );
  }
  const revision = adaptToolResultToHost(store.getRevision(run.revisionId));
  let result = run.result;
  if (run.state === "succeeded" && run.resultArtifact && revision) {
    const loaded = await readWorkflowValueArtifact({
      blobStore,
      reference: run.resultArtifact,
      maxBytes: revision.limits.maxResultBytes,
    });
    result = adaptWorkflowArtifactResultToException(loaded);
  }
  let rawFinalText = "";
  if (run.state === "succeeded") {
    rawFinalText = typeof result === "string" ? result : JSON.stringify(result);
  }
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
  private subscription: ResultSubscription | null = null;
  private orphanHandlingEnabled = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      blobStore: BlobStore;
      toolResultArtifacts?: ToolResultArtifactStore;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    const started = await this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: workflowConsumerId(this.input.subscriptionId),
        batch: { maxWaitMs: 250 },
      },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtWorkflowResultReady ||
          message.type === lilacEventTypes.EvtWorkflowOperationChanged ||
          message.type === lilacEventTypes.EvtWorkflowRunChanged
        ) {
          return await captureRunEvent(message.data.runId, async () => {
            return await this.handleRunEvent(message.data.runId);
          });
        }
        return Result.ok(undefined);
      },
      applyWorkflowLiveParentDeliveryPolicy,
    );
    this.subscription = requireSubscriptionStart(started);
    this.observeSubscriptionDone(this.subscription, { scope: "workflow" });
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      requireSubscriptionStop(await this.subscription.stop());
    }
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

  async enableOrphanHandling(options?: {
    protectedParentRequestIds?: readonly string[];
    protectionMs?: number;
  }): Promise<void> {
    this.orphanHandlingEnabled = true;
    for (const parentRequestId of options?.protectedParentRequestIds ?? []) {
      if (this.parents.has(parentRequestId) || this.protectedParents.has(parentRequestId)) continue;
      const timer = setTimeout(() => {
        this.protectedParents.delete(parentRequestId);
        void (async () => {
          const [settled] = await Promise.allSettled([this.reconcileOrphans()]);
          if (settled.status === "rejected") {
            if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
            const error =
              settled.reason instanceof Error
                ? settled.reason
                : new Error("Opaque live-parent orphan reconciliation failure");
            this.logger.error(
              "live-parent orphan reconciliation failed after parent protection expired",
              { parentRequestId, ...formatWorkflowErrorForLog(error) },
            );
          }
        })();
      }, options?.protectionMs ?? 120_000);
      timer.unref?.();
      this.protectedParents.set(parentRequestId, timer);
    }
    await this.reconcileOrphans();
  }

  registerParent(input: {
    parentRequestId: string;
    onActivity?: () => void;
    publishToolStatus?: ParentSignal["publishToolStatus"];
    recoverSynchronousDeliveries?: boolean;
  }) {
    const existing = this.parents.get(input.parentRequestId);
    if (existing)
      throw new Error(`Live workflow parent is already registered: ${input.parentRequestId}`);
    const signal: ParentSignal = {
      version: 0,
      waiters: new Set(),
      onActivity: input.onActivity,
      publishToolStatus: input.publishToolStatus,
    };
    const runsById = new Map<string, WorkflowRun>();
    const activeRuns = this.input.store.listActiveLiveParentRuns(input.parentRequestId);
    const readActiveRuns = activeRuns.match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const active = readActiveRuns();
    for (const run of active) {
      runsById.set(run.runId, run);
    }
    const pendingRuns = this.input.store.listPendingLiveParentCompletions(
      input.parentRequestId,
      1_000,
      input.recoverSynchronousDeliveries,
    );
    const readPendingRuns = pendingRuns.match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const pending = readPendingRuns();
    for (const run of pending) {
      runsById.set(run.runId, run);
    }
    const protection = this.protectedParents.get(input.parentRequestId);
    if (protection) clearTimeout(protection);
    this.protectedParents.delete(input.parentRequestId);
    this.parents.set(input.parentRequestId, signal);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (this.parents.get(input.parentRequestId) === signal) {
        this.parents.delete(input.parentRequestId);
      }
      this.notify(signal);
      await this.stopChildActivityForParent(input.parentRequestId);
    };
    const ready = Promise.resolve()
      .then(async () => {
        if (closed) return;
        this.notify(signal);
        const preparations = await Promise.allSettled(
          [...runsById.values()].map(async (run) => {
            if (isTerminalRun(run)) {
              const reconciled = await this.reconcileTerminalChildActivity(run, signal);
              const reconciliationError = reconciled.match({
                ok: () => null,
                err: (error) => error,
              });
              if (reconciliationError) {
                adaptToolResultToHost(
                  Result.err(
                    new WorkflowLiveParentRunEventFailed({
                      cause: reconciliationError,
                      runId: run.runId,
                      message: "Live-parent terminal child activity reconciliation failed",
                    }),
                  ),
                );
              }
            } else await this.ensureChildActivityForwarding(run, signal);
          }),
        );
        const failed =
          preparations.find(
            (outcome) => outcome.status === "rejected" && isPanic(outcome.reason),
          ) ?? preparations.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })
      .catch(async (error: unknown) => {
        const [cleanup] = await Promise.allSettled([close()]);
        if (isPanic(error)) preserveToolPanic(error);
        if (cleanup.status === "rejected" && isPanic(cleanup.reason)) {
          preserveToolPanic(cleanup.reason);
        }
        throw error;
      });

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
      listPending: (): WorkflowLiveParentCompletion[] => {
        const listed = this.input.store.listPendingLiveParentCompletions(
          input.parentRequestId,
          1_000,
          input.recoverSynchronousDeliveries,
        );
        const readRuns = listed.match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const runs = readRuns();
        return runs.map((run) => {
          if (run.resultArtifact) {
            throw new Error("Artifact-backed completion requires listPendingAsync");
          }
          if (
            typeof run.result === "string" &&
            (run.result.includes("Complete output: tool-result://") ||
              run.result.includes(`Complete output: ${CORE_TOOL_RESULT_RESOURCE_URI_PREFIX}`))
          ) {
            throw new Error("Tool-result-backed completion requires listPendingAsync");
          }
          if (run.completionTarget.kind !== "live_parent") {
            throw new Error(`Workflow run ${run.runId} has no live-parent completion target`);
          }
          const status = toCompletionStatus(run.state, false);
          let finalText = "";
          if (run.state === "succeeded") {
            finalText = typeof run.result === "string" ? run.result : JSON.stringify(run.result);
          }
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
        });
      },
      listPendingAsync: async (): Promise<WorkflowLiveParentCompletion[]> => {
        const listed = this.input.store.listPendingLiveParentCompletions(
          input.parentRequestId,
          1_000,
          input.recoverSynchronousDeliveries,
        );
        const readRuns = listed.match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const runs = readRuns();
        return await Promise.all(
          runs.map(
            async (run) =>
              await toCompletion(
                run,
                this.input.store,
                this.input.blobStore,
                this.input.toolResultArtifacts,
              ),
          ),
        );
      },
      listPendingIdentities: (): WorkflowLiveParentCompletionIdentity[] => {
        const listed = this.input.store.listPendingLiveParentCompletions(
          input.parentRequestId,
          1_000,
          input.recoverSynchronousDeliveries,
        );
        const readRuns = listed.match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const runs = readRuns();
        return runs.map((run) => toCompletionIdentity(run, this.input.store));
      },
      isPending: (runId: string): boolean =>
        this.input.store.getLiveParentDeliveryState(runId) === "pending",
      listPendingSettledAsync: async (): Promise<
        Array<
          | { loaded: true; completion: WorkflowLiveParentCompletion }
          | { loaded: false; identity: WorkflowLiveParentCompletionIdentity; error: unknown }
        >
      > => {
        const listed = this.input.store.listPendingLiveParentCompletions(
          input.parentRequestId,
          1_000,
          input.recoverSynchronousDeliveries,
        );
        const readRuns = listed.match({
          ok: (value) => () => value,
          err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
        });
        const runs = readRuns();
        return await Promise.all(
          runs.map(async (run) => {
            const identity = toCompletionIdentity(run, this.input.store);
            const [settled] = await Promise.allSettled([
              toCompletion(
                run,
                this.input.store,
                this.input.blobStore,
                this.input.toolResultArtifacts,
              ),
            ]);
            if (settled.status === "fulfilled") {
              return {
                loaded: true as const,
                completion: settled.value,
              };
            }
            return { loaded: false as const, identity, error: settled.reason };
          }),
        );
      },
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
        const transitions = this.input.store.cancelLiveParentRunsAndSuppress({
          parentRequestId: input.parentRequestId,
          now: this.now(),
          detail,
        });
        for (const transition of transitions) {
          await this.stopChildActivityForRun(transition.run.runId);
          const published = await this.publishRunCancelled(
            transition.run,
            transition.previousState,
            detail,
          );
          adaptToolResultToHost(published);
        }
        this.notify(signal);
      },
      close,
    };
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private logProgressPublicationFailure(runId: string, error: Error): void {
    this.logger.warn(
      "live-parent subagent progress publish failed",
      { runId },
      formatWorkflowErrorForLog(error),
    );
  }

  private notify(signal: ParentSignal): void {
    signal.version += 1;
    signal.onActivity?.();
    const waiters = [...signal.waiters];
    signal.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private async handleRunEvent(
    runId: string,
  ): Promise<ResultType<void, WorkflowLiveParentTopicError>> {
    const runResult = this.input.store.getRun(runId);
    const readRun = runResult.match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const run = readRun();
    if (!run || run.completionTarget.kind !== "live_parent") return Result.ok(undefined);
    const signal = this.parents.get(run.completionTarget.parentRequestId);
    if (signal) {
      if (isTerminalRun(run)) {
        const reconciled = await this.reconcileTerminalChildActivity(run, signal);
        const reconciliationError = reconciled.match({
          ok: () => null,
          err: (error) => error,
        });
        if (reconciliationError) return Result.err(reconciliationError);
        this.notify(signal);
        return Result.ok(undefined);
      }

      const forwarding = await this.ensureChildActivityForwarding(run, signal);
      this.notify(signal);
      if (run.state === "running" || run.state === "blocked") {
        await this.publishParentDisplay(
          forwarding,
          run.completionTarget,
          this.buildFallbackDisplay(forwarding.runId, run.completionTarget, run.state),
          false,
          true,
        );
      }
      return Result.ok(undefined);
    }
    if (
      this.orphanHandlingEnabled &&
      !this.protectedParents.has(run.completionTarget.parentRequestId)
    ) {
      await this.reconcileOrphans();
    }
    return Result.ok(undefined);
  }

  private async ensureChildActivityForwarding(
    run: WorkflowRun,
    signal: ParentSignal,
  ): Promise<ChildActivityForwarding> {
    if (run.completionTarget.kind !== "live_parent") {
      return adaptToolResultToHost(
        Result.err(
          new WorkflowLiveParentRunEventFailed({
            cause: null,
            runId: run.runId,
            message: `Workflow run ${run.runId} has no live-parent completion target`,
          }),
        ),
      );
    }
    const target = run.completionTarget;
    let forwarding = this.childActivitySubscriptions.get(run.runId);
    if (!forwarding) {
      forwarding = this.createChildActivityForwarding(run.runId, target, signal.publishToolStatus);
      this.childActivitySubscriptions.set(run.runId, forwarding);
    } else {
      forwarding.publishToolStatus = signal.publishToolStatus;
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
      const started = await this.input.bus.subscribeTopic(
        outReqTopic(childRequestId),
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async (message) =>
          await captureChildActivity(forwarding.runId, childRequestId, async () => {
            await this.handleChildActivity(forwarding, target, signal, childRequestId, message);
          }),
        applyWorkflowLiveParentDeliveryPolicy,
      );
      const subscription = requireSubscriptionStart(started);
      forwarding.subscriptions.set(childRequestId, subscription);
      this.observeSubscriptionDone(subscription, {
        scope: "child",
        runId: forwarding.runId,
        childRequestId,
      });
    })();
    forwarding.subscriptionStarts.set(childRequestId, start);
    await start.finally(() => {
      if (forwarding.subscriptionStarts.get(childRequestId) === start) {
        forwarding.subscriptionStarts.delete(childRequestId);
      }
    });
  }

  private createChildActivityForwarding(
    runId: string,
    target: LiveParentTarget,
    publishToolStatus?: ParentSignal["publishToolStatus"],
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
      publishToolStatus,
      hasPublishedActivity: false,
      trailingActivityPublication: null,
      stopPromise: null,
    };
  }

  private resolveChildRequestIds(run: WorkflowRun, target: LiveParentTarget): string[] {
    const requestIds = new Set([target.childRequestId]);
    const operations = this.input.store.listOperations(run.runId, { limit: 1_000 });
    const readEntries = operations.match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const entries = readEntries();
    for (const operation of entries) {
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
        false,
        true,
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
    let ok: boolean | null;
    if (message.data.status === "end") {
      ok = message.data.ok === true;
    } else if (preserveTerminal) {
      ok = existing.ok ?? false;
    } else {
      ok = existing?.ok ?? null;
    }
    const next: ChildToolState = {
      toolCallId: message.data.toolCallId,
      status: message.data.status === "end" || preserveTerminal ? "done" : "running",
      ok,
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
    coalesceActivity = false,
  ): Promise<void> {
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

    if (coalesceActivity && forwarding.hasPublishedActivity) {
      const trailing = forwarding.trailingActivityPublication;
      if (trailing) {
        trailing.display = display;
        await forwarding.publicationTail;
        return;
      }
    }

    const publication = { display };
    if (coalesceActivity) {
      if (forwarding.hasPublishedActivity) forwarding.trailingActivityPublication = publication;
      else forwarding.hasPublishedActivity = true;
    } else {
      forwarding.trailingActivityPublication = null;
    }

    const publish = forwarding.publicationTail.then(async () => {
      if (forwarding.trailingActivityPublication === publication) {
        forwarding.trailingActivityPublication = null;
      }
      if (!force && !forwarding.acceptingLive) return;
      const update = {
        toolCallId: target.parentToolCallId,
        status: "update" as const,
        display: publication.display,
      };
      if (forwarding.publishToolStatus) {
        await forwarding.publishToolStatus(update);
        return;
      }
      const published = await this.input.bus.publish(
        lilacEventTypes.EvtAgentOutputToolCall,
        update,
        {
          headers: {
            request_id: target.parentRequestId,
            session_id: target.parentSessionId,
            request_client: target.parentRequestClient,
          },
        },
      );
      published.match({
        ok: () => undefined,
        err: (error) => this.logProgressPublicationFailure(forwarding.runId, error),
      });
    });
    forwarding.publicationTail = (async () => {
      const [settled] = await Promise.allSettled([publish]);
      if (settled.status === "rejected") {
        if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
        const error =
          settled.reason instanceof Error
            ? settled.reason
            : new Error("Opaque live-parent progress publication failure");
        this.logProgressPublicationFailure(forwarding.runId, error);
      }
    })();
    await forwarding.publicationTail;
  }

  private resolveChildModelSelection(runId: string):
    | {
        model: string;
        reasoning?: "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
      }
    | undefined {
    const operations = this.input.store.listOperations(runId, { limit: 1_000 });
    const readEntries = operations.match({
      ok: (value) => () => value,
      err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
    });
    const entries = readEntries();
    const requestIds = entries
      .flatMap((operation) =>
        operation.kind === "agent" && operation.requestId ? [operation.requestId] : [],
      )
      .reverse();
    for (const requestId of requestIds) {
      const policyResult = this.input.store.getWorkflowRequestDispatchPolicy(requestId);
      const readPolicy = policyResult.match({
        ok: (value) => () => value,
        err: (error) => () => signalDurableWorkflowReadErrorToHost(error),
      });
      const policy = readPolicy();
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
    let model: string | null = null;
    if (selection) {
      model = selection.model;
      if (selection.reasoning) model += ` [${selection.reasoning}]`;
    }
    return `subagent (${[target.profile, model, state, detail?.slice(0, 160) ?? null]
      .filter((part): part is string => part !== null)
      .join("; ")})`;
  }

  private async reconcileTerminalChildActivity(
    run: WorkflowRun,
    signal: ParentSignal,
  ): Promise<ResultType<void, WorkflowLiveParentTopicError>> {
    if (run.completionTarget.kind !== "live_parent") return Result.ok(undefined);
    const target = run.completionTarget;
    const forwarding =
      this.childActivitySubscriptions.get(run.runId) ??
      this.createChildActivityForwarding(run.runId, target, signal.publishToolStatus);
    forwarding.acceptingLive = false;
    await this.stopChildActivity(forwarding);

    const outcome = await (async () => {
      forwarding.children.clear();
      forwarding.updateSeq = 0;
      for (const childRequestId of this.resolveChildRequestIds(run, target)) {
        const topic = outReqTopic(childRequestId);
        const watermarkResult = await this.input.bus.getTopicWatermark(topic);
        const watermarkOutcome = watermarkResult.match<
          | { readonly kind: "ok"; readonly watermark: string | null }
          | { readonly kind: "error"; readonly error: WorkflowLiveParentTopicError }
        >({
          ok: (watermark) => ({ kind: "ok", watermark }),
          err: (error) => ({ kind: "error", error }),
        });
        if (watermarkOutcome.kind === "error")
          return { status: "return", value: Result.err(watermarkOutcome.error) } as const;
        const { watermark } = watermarkOutcome;
        if (!watermark) continue;
        let cursor: string | undefined;
        let reachedWatermark = false;
        while (!reachedWatermark) {
          const batch = requireChildOutputBatch(
            await this.input.bus.fetchTopic(topic, {
              offset: cursor ? { type: "cursor", cursor } : { type: "begin" },
              limit: 1_000,
            }),
          );
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
      return { status: "return", value: Result.ok(undefined) } as const;
    })().finally(() => {
      if (this.childActivitySubscriptions.get(run.runId) === forwarding) {
        this.childActivitySubscriptions.delete(run.runId);
      }
    });
    return outcome.value;
  }

  private async stopChildActivity(forwarding: ChildActivityForwarding): Promise<void> {
    if (forwarding.stopPromise) return await forwarding.stopPromise;
    forwarding.acceptingLive = false;
    forwarding.stopPromise = (async () => {
      await Promise.allSettled(forwarding.subscriptionStarts.values());
      await Promise.all(
        [...forwarding.subscriptions.values()].map(async (subscription) => {
          const stopped = await subscription.stop();
          stopped.match({
            ok: () => undefined,
            err: (error) =>
              this.logger.warn("live-parent child activity subscription stop failed", {
                runId: forwarding.runId,
                ...formatTaggedErrorForLog(error),
              }),
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

  private observeSubscriptionDone(
    subscription: ResultSubscription,
    context:
      | { readonly scope: "workflow" }
      | { readonly scope: "child"; readonly runId: string; readonly childRequestId: string },
  ): void {
    void subscription.done.then((done) => {
      done.match({
        ok: () => undefined,
        err: (error) => {
          switch (error._tag) {
            case "EventDeliveryTransportFailed":
            case "EventDeliveryStopped":
              this.logger.warn("live-parent event subscription ended", {
                ...context,
                ...formatTaggedErrorForLog(error),
              });
          }
        },
      });
    });
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

  private async reconcileOrphans(): Promise<void> {
    const resolvableParentRequestIds = [...this.parents.keys(), ...this.protectedParents.keys()];
    const orphaned = this.input.store.reconcileOrphanedLiveParentRuns({
      resolvableParentRequestIds,
      now: this.now(),
      detail: "Orphaned subagent: parent request could not be restored",
    });
    for (const transition of orphaned) {
      await this.stopChildActivityForRun(transition.run.runId);
      if (!transition.cancelled) continue;
      const published = await this.publishRunCancelled(
        transition.run,
        transition.previousState,
        transition.run.terminalDetail ?? "Orphaned subagent",
      );
      published.match({
        ok: () => undefined,
        err: (error) =>
          this.logger.warn("orphaned workflow cancellation event publication failed", {
            runId: transition.run.runId,
            ...formatTaggedErrorForLog(error),
          }),
      });
    }
    if (orphaned.length > 0) {
      this.logger.warn("orphaned live-parent subagent workflows", {
        runIds: orphaned.map((transition) => transition.run.runId),
        cancelledCount: orphaned.filter((transition) => transition.cancelled).length,
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
    const published = await this.publishRunCancelled(cancelled, run.state, detail);
    adaptToolResultToHost(published);
  }

  private async publishRunCancelled(
    run: WorkflowRun,
    previousState: WorkflowRun["state"],
    detail: string,
  ): Promise<ResultType<void, WorkflowLiveParentPublishError>> {
    return Result.gen(async function* (this: WorkflowLiveParentBridge) {
      yield* Result.await(
        this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
          runId: run.runId,
          revisionId: run.revisionId,
          state: "cancelled",
          previousState,
          detail,
          ts: this.now(),
        }),
      );
      yield* Result.await(
        this.input.bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
          runId: run.runId,
          revisionId: run.revisionId,
          state: "cancelled",
          summary: detail,
          ts: this.now(),
        }),
      );
      return Result.ok(undefined);
    }, this);
  }
}
