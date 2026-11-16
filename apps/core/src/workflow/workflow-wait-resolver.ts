import { captureError } from "../shared/error-capture";
import {
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import {
  createLogger,
  formatTaggedErrorForLog,
  isPanic,
  opaqueErrorMessage,
} from "@stanley2058/lilac-utils";

import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import { DurableWorkflowStore, type DurableWorkflowReadError } from "./durable-workflow-store";
import type { WorkflowWait } from "./workflow-domain";
import { matchWorkflowReplyWait, workflowReplyMatchKey } from "./workflow-waits";

const WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS = 1_000;

class WorkflowWaitResolverLeaseLost extends TaggedError("WorkflowWaitResolverLeaseLost")<{
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverCheckpointNotAdvanced extends TaggedError(
  "WorkflowWaitResolverCheckpointNotAdvanced",
)<{
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverLeaseAcquisitionStopped extends TaggedError(
  "WorkflowWaitResolverLeaseAcquisitionStopped",
)<{ readonly message: string }> {}

class WorkflowWaitResolverLeaseAcquisitionTimedOut extends TaggedError(
  "WorkflowWaitResolverLeaseAcquisitionTimedOut",
)<{ readonly message: string }> {}

class WorkflowWaitResolverSubscriptionStartFailed extends TaggedError(
  "WorkflowWaitResolverSubscriptionStartFailed",
)<{
  readonly cause: EventDeliveryStartFailed;
  readonly message: string;
}> {}

class WorkflowWaitResolverStartupLeaseLost extends TaggedError(
  "WorkflowWaitResolverStartupLeaseLost",
)<{ readonly message: string }> {}

class WorkflowWaitResolverConsumerGroupRetirementFailed extends TaggedError(
  "WorkflowWaitResolverConsumerGroupRetirementFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class WorkflowWaitResolverStartupStopped extends TaggedError("WorkflowWaitResolverStartupStopped")<{
  readonly message: string;
}> {}

class WorkflowWaitResolverTrimFailed extends TaggedError("WorkflowWaitResolverTrimFailed")<{
  readonly cause: unknown;
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverBarrierPublishFailed extends TaggedError(
  "WorkflowWaitResolverBarrierPublishFailed",
)<{
  readonly cause: unknown;
  readonly barrierId: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverWakeupPublishFailed extends TaggedError(
  "WorkflowWaitResolverWakeupPublishFailed",
)<{
  readonly cause: unknown;
  readonly runId: string;
  readonly operationId: string;
  readonly message: string;
}> {}

type WorkflowWaitResolverLeaseAcquisitionError =
  | WorkflowWaitResolverLeaseAcquisitionStopped
  | WorkflowWaitResolverLeaseAcquisitionTimedOut;
type WorkflowWaitResolverActivationError =
  | WorkflowWaitResolverLeaseAcquisitionError
  | WorkflowWaitResolverSubscriptionStartFailed
  | WorkflowWaitResolverStartupLeaseLost
  | WorkflowWaitResolverConsumerGroupRetirementFailed
  | WorkflowWaitResolverStartupStopped;

type WorkflowWaitResolverDeliveryError =
  | WorkflowWaitResolverLeaseLost
  | WorkflowWaitResolverCheckpointNotAdvanced
  | DurableWorkflowReadError;

type WorkflowWaitResolverSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function workflowWaitResolverDeliveryPolicy(
  error: WorkflowWaitResolverDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowWaitResolverLeaseLost":
    case "WorkflowWaitResolverCheckpointNotAdvanced":
      return "stop";
    case "UnsupportedVersion":
    case "MalformedSerialization":
    case "CorruptPersistedFields":
      return "dead-letter";
    case "DurableWorkflowSqliteDriverFailure":
      return "park-pending";
  }
}

function adaptWorkflowWaitResolverStartResultToHost(
  started: ResultType<void, WorkflowWaitResolverActivationError>,
): void {
  adaptToolResultToHost(started);
}

function adaptWorkflowWaitResolverStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  adaptToolResultToHost(stopped);
}

export class WorkflowWaitResolver {
  private readonly logger = createLogger({ module: "workflow-wait-resolver" });
  private readonly workerId = `workflow-wait-resolver:${process.pid}:${crypto.randomUUID()}`;
  private subscription: WorkflowWaitResolverSubscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private leaseOwned = false;
  private nextLeaseHeartbeatAt: number | null = null;
  private stopping = true;
  private recoveryTask: Promise<ResultType<void, never>> | null = null;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      now?: () => number;
      pollMs?: number;
      leaseStaleMs?: number;
      leaseHeartbeatMs?: number;
      leaseAcquireTimeoutMs?: number;
      leaseRetryMs?: number;
      subscriptionRecoveryRetryMs?: number;
      confirmLegacyGroupSingleVersionRollout?: boolean;
    },
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    adaptWorkflowWaitResolverStartResultToHost(await this.startWorkflowWaitResolverResult());
  }

  private async startWorkflowWaitResolverResult(): Promise<
    ResultType<void, WorkflowWaitResolverActivationError>
  > {
    const activated = await this.activateSubscriptionResult();
    const activationError = activated.match({
      ok: () => null,
      err: (error) => error,
    });
    if (activationError) return Result.err(activationError);
    this.startTimer();
    await this.reconcileTimers();
    return Result.ok(undefined);
  }

  private async acquireLeaseResult(): Promise<
    ResultType<void, WorkflowWaitResolverLeaseAcquisitionError>
  > {
    const acquireDeadline = Date.now() + (this.input.leaseAcquireTimeoutMs ?? 7_500);
    while (!this.leaseOwned) {
      if (this.stopping) {
        return Result.err(
          new WorkflowWaitResolverLeaseAcquisitionStopped({
            message: "Workflow wait resolver stopped during lease acquisition",
          }),
        );
      }
      const now = this.now();
      this.leaseOwned = this.input.store.claimWorkflowWaitResolverLease({
        ownerId: this.workerId,
        now,
        staleBefore: now - (this.input.leaseStaleMs ?? 5_000),
      });
      if (this.leaseOwned) {
        this.nextLeaseHeartbeatAt =
          now + (this.input.leaseHeartbeatMs ?? WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS);
        break;
      }
      if (Date.now() >= acquireDeadline) {
        return Result.err(
          new WorkflowWaitResolverLeaseAcquisitionTimedOut({
            message: "Timed out waiting for the ordered workflow wait resolver lease",
          }),
        );
      }
      await Bun.sleep(this.input.leaseRetryMs ?? 100);
    }
    return Result.ok(undefined);
  }

  private async startWorkflowWaitSubscriptionResult(
    checkpoint: string | null,
  ): Promise<ResultType<WorkflowWaitResolverSubscription, EventDeliveryStartFailed>> {
    const [settled] = await Promise.allSettled([
      this.input.bus.subscribeTopic(
        "evt.adapter",
        {
          mode: "tail",
          offset: checkpoint ? { type: "cursor", cursor: checkpoint } : { type: "begin" },
          batch: { maxWaitMs: 500 },
        },
        async (message, context): Promise<ResultType<void, WorkflowWaitResolverDeliveryError>> => {
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          if (message.type === lilacEventTypes.EvtAdapterMessageCreated) {
            const resolved = await this.resolveAdapterEvent(message.data, context.cursor);
            const resolutionError = resolved.match({
              ok: () => null,
              err: (error) => error,
            });
            if (resolutionError) return Result.err(resolutionError);
          } else if (message.type === lilacEventTypes.EvtWorkflowWaitResolverBarrier) {
            this.input.store.markWaitExpiryBarrierProcessed(
              message.data.barrierId,
              context.cursor,
              this.now(),
            );
          }
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          if (
            !this.input.store.advanceWorkflowWaitResolverCheckpoint({
              ownerId: this.workerId,
              topic: "evt.adapter",
              cursor: context.cursor,
              now: this.now(),
            })
          ) {
            return Result.err(
              new WorkflowWaitResolverCheckpointNotAdvanced({
                cursor: context.cursor,
                message: "Workflow wait resolver checkpoint was not advanced",
              }),
            );
          }
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          const trimmed = await this.captureWorkflowWaitResolverTrim(context.cursor);
          trimmed.match({
            ok: () => undefined,
            err: (error) =>
              this.logger.error(
                "Workflow adapter stream reclamation failed",
                formatTaggedErrorForLog(error),
              ),
          });
          return Result.ok(undefined);
        },
        workflowWaitResolverDeliveryPolicy,
      ),
    ]);
    if (settled.status === "rejected") {
      this.releaseLease();
      if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
      const cause =
        settled.reason instanceof Error
          ? settled.reason
          : new Error("Opaque workflow wait subscription failure");
      return adaptToolResultToHost(
        Result.err(
          new Error(opaqueErrorMessage(cause, "Workflow wait subscription failed to start")),
        ),
      );
    }
    return settled.value;
  }

  private async captureWorkflowWaitResolverTrim(
    cursor: string,
  ): Promise<ResultType<void, WorkflowWaitResolverTrimFailed>> {
    const trimmed = await this.input.bus.trimTopicBeforeCheckpoint("evt.adapter", cursor, 100);
    return trimmed
      .map(() => undefined)
      .mapError(
        (cause) =>
          new WorkflowWaitResolverTrimFailed({
            cause,
            cursor,
            message: "Workflow adapter stream reclamation failed",
          }),
      );
  }

  private async captureWorkflowWaitResolverConsumerGroupRetirement(
    subscription: WorkflowWaitResolverSubscription,
  ): Promise<ResultType<void, WorkflowWaitResolverConsumerGroupRetirementFailed>> {
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          const retired = await this.input.bus.retireTopicConsumerGroup(
            "evt.adapter",
            this.input.subscriptionId,
            this.input.confirmLegacyGroupSingleVersionRollout ?? false,
          );
          return retired
            .map(() => undefined)
            .mapError(
              (cause) =>
                new WorkflowWaitResolverConsumerGroupRetirementFailed({
                  cause,
                  message: "Workflow wait resolver consumer-group retirement failed",
                }),
            );
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        if (Panic.is(cause)) {
          const stopped = await subscription.stop();
          stopped.match({
            ok: () => undefined,
            err: (error) =>
              this.logger.error(
                "Workflow wait resolver subscription cleanup failed",
                formatTaggedErrorForLog(error),
              ),
          });
          this.releaseLease();
          preserveToolPanic(cause);
        }
        return Result.err(
          new WorkflowWaitResolverConsumerGroupRetirementFailed({
            cause,
            message: "Workflow wait resolver consumer-group retirement failed",
          }),
        );
      }
      return attempt.value;
    }
  }

  private async failWorkflowWaitResolverActivation(
    subscription: WorkflowWaitResolverSubscription,
    error: WorkflowWaitResolverActivationError,
  ): Promise<ResultType<void, WorkflowWaitResolverActivationError>> {
    const stopped = await subscription.stop();
    stopped.match({
      ok: () => undefined,
      err: (stopError) =>
        this.logger.error(
          "Workflow wait resolver subscription cleanup failed",
          formatTaggedErrorForLog(stopError),
        ),
    });
    this.releaseLease();
    return Result.err(error);
  }

  private async activateSubscriptionResult(): Promise<
    ResultType<void, WorkflowWaitResolverActivationError>
  > {
    const lease = await this.acquireLeaseResult();
    const leaseError = lease.match({
      ok: () => null,
      err: (error) => error,
    });
    if (leaseError) return Result.err(leaseError);
    const checkpoint = this.input.store.getWorkflowWaitResolverCheckpoint("evt.adapter");
    const started = await this.startWorkflowWaitSubscriptionResult(checkpoint);
    const startOutcome = started.match<
      | { readonly kind: "ok"; readonly subscription: WorkflowWaitResolverSubscription }
      | { readonly kind: "error"; readonly error: EventDeliveryStartFailed }
    >({
      ok: (subscription) => ({ kind: "ok", subscription }),
      err: (error) => ({ kind: "error", error }),
    });
    if (startOutcome.kind === "error") {
      this.releaseLease();
      return Result.err(
        new WorkflowWaitResolverSubscriptionStartFailed({
          cause: startOutcome.error,
          message: "Workflow wait resolver subscription failed to start",
        }),
      );
    }
    const { subscription } = startOutcome;
    if (!this.ensureLeaseOwnership(this.now())) {
      return this.failWorkflowWaitResolverActivation(
        subscription,
        new WorkflowWaitResolverStartupLeaseLost({
          message: "Ordered workflow wait resolver lease was lost during startup",
        }),
      );
    }
    const retired = await this.captureWorkflowWaitResolverConsumerGroupRetirement(subscription);
    const retirementError = retired.match({
      ok: () => null,
      err: (error) => error,
    });
    if (retirementError)
      return this.failWorkflowWaitResolverActivation(subscription, retirementError);
    if (this.stopping) {
      return this.failWorkflowWaitResolverActivation(
        subscription,
        new WorkflowWaitResolverStartupStopped({
          message: "Workflow wait resolver stopped during subscription startup",
        }),
      );
    }
    this.subscription = subscription;
    this.observeSubscription(subscription);
    return Result.ok(undefined);
  }

  private startTimer(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => void this.reconcileTimers(), this.input.pollMs ?? 250);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private releaseLease(): void {
    if (this.leaseOwned) this.input.store.releaseWorkflowWaitResolverLease(this.workerId);
    this.leaseOwned = false;
    this.nextLeaseHeartbeatAt = null;
  }

  private observeSubscription(subscription: WorkflowWaitResolverSubscription): void {
    void subscription.done.then((result) =>
      this.handleSubscriptionTermination(subscription, result),
    );
  }

  private handleSubscriptionTermination(
    subscription: WorkflowWaitResolverSubscription,
    result: ResultType<void, EventDeliveryDoneError>,
  ): void {
    if (this.stopping || this.subscription !== subscription) return;
    this.subscription = null;
    this.stopTimer();
    this.releaseLease();
    result.match({
      ok: () =>
        this.logger.error("Workflow wait resolver subscription terminated unexpectedly", {
          error: "Subscription completed without being stopped",
        }),
      err: (error) =>
        this.logger.error(
          "Workflow wait resolver subscription terminated unexpectedly",
          formatTaggedErrorForLog(error),
        ),
    });
    const recovery = this.recoverSubscriptionResult().finally(() => {
      if (this.recoveryTask === recovery) this.recoveryTask = null;
    });
    this.recoveryTask = recovery;
  }

  private async recoverSubscriptionResult(): Promise<ResultType<void, never>> {
    const retryMs = Math.max(0, this.input.subscriptionRecoveryRetryMs ?? 100);
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      const activated = await this.activateSubscriptionResult();
      const activationError = activated.match({
        ok: () => null,
        err: (error) => error,
      });
      if (!activationError) {
        if (this.stopping) return Result.ok(undefined);
        this.startTimer();
        await this.reconcileTimers();
        return Result.ok(undefined);
      }
      if (this.stopping) return Result.ok(undefined);
      this.logger.warn("Workflow wait resolver subscription recovery failed", {
        attempt,
        ...formatTaggedErrorForLog(activationError),
      });
      await Bun.sleep(Math.min(retryMs * 2 ** Math.min(attempt - 1, 10), 30_000));
    }
    return Result.ok(undefined);
  }

  async stop(): Promise<void> {
    adaptWorkflowWaitResolverStopResultToHost(await this.stopWorkflowWaitResolverResult());
  }

  private async stopWorkflowWaitSubscriptionResult(
    subscription: WorkflowWaitResolverSubscription,
  ): Promise<ResultType<void, EventDeliveryStopFailed>> {
    return await subscription.stop().finally(() => {
      this.releaseLease();
    });
  }

  private async stopWorkflowWaitResolverResult(): Promise<
    ResultType<void, EventDeliveryStopFailed>
  > {
    this.stopping = true;
    this.stopTimer();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) {
      const stopped = await this.stopWorkflowWaitSubscriptionResult(subscription);
      const stopError = stopped.match({
        ok: () => null,
        err: (error) => error,
      });
      if (stopError) return Result.err(stopError);
      const done = await subscription.done;
      done.match({
        ok: () => undefined,
        err: (error) => {
          if (error._tag !== "EventDeliveryStopped") {
            this.logger.error(
              "Workflow wait resolver subscription terminated",
              formatTaggedErrorForLog(error),
            );
          }
        },
      });
    } else {
      this.releaseLease();
    }
    await this.recoveryTask;
    return Result.ok(undefined);
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private leaseLost(cursor: string): WorkflowWaitResolverLeaseLost {
    return new WorkflowWaitResolverLeaseLost({
      cursor,
      message: "Ordered workflow wait resolver lease was lost during delivery",
    });
  }

  private ensureLeaseOwnership(now: number): boolean {
    if (!this.leaseOwned) return false;
    const refreshDue = this.nextLeaseHeartbeatAt === null || now >= this.nextLeaseHeartbeatAt;
    const owned = refreshDue
      ? this.input.store.refreshWorkflowWaitResolverLease(this.workerId, now)
      : this.input.store.isWorkflowWaitResolverLeaseOwner(this.workerId);
    if (!owned) {
      this.leaseOwned = false;
      this.nextLeaseHeartbeatAt = null;
      return false;
    }
    if (refreshDue) {
      this.nextLeaseHeartbeatAt =
        now + (this.input.leaseHeartbeatMs ?? WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS);
    }
    return true;
  }

  async resolveAdapterEvent(
    event: EvtAdapterMessageCreatedData,
    cursor: string,
  ): Promise<ResultType<void, DurableWorkflowReadError>> {
    const key = workflowReplyMatchKey(event.platform, event.channelId);
    const candidates = this.input.store.listActiveWaitsByMatchKey("reply", key);
    const activeWaits = candidates.match<
      | { readonly kind: "ok"; readonly waits: WorkflowWait[] }
      | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
    >({
      ok: (waits) => ({ kind: "ok", waits }),
      err: (error) => ({ kind: "error", error }),
    });
    if (activeWaits.kind === "error") return Result.err(activeWaits.error);
    for (const candidate of activeWaits.waits) {
      const result = matchWorkflowReplyWait(candidate, event);
      if (result === null) continue;
      const now = this.now();
      if (!this.ensureLeaseOwnership(now)) return Result.ok(undefined);
      const resolved = this.input.store.resolveReplyWaitAndSuppress({
        runId: candidate.runId,
        operationId: candidate.operationId,
        platform: event.platform,
        channelId: event.channelId,
        messageId: event.messageId,
        eventTs: event.ts,
        cursor,
        result,
        now,
      });
      if (resolved) await this.publishWakeupAdvisory(resolved);
    }
    return Result.ok(undefined);
  }

  async reconcileTimers(): Promise<void> {
    const reconciled = await this.reconcileTimersResult();
    reconciled.match({
      ok: () => undefined,
      err: (error) =>
        this.logger.error(
          "Workflow wait timer reconciliation failed",
          formatTaggedErrorForLog(error),
        ),
    });
  }

  private async captureWorkflowWaitResolverBarrierPublication(
    barrierId: string,
    now: number,
  ): Promise<ResultType<{ readonly cursor: string }, WorkflowWaitResolverBarrierPublishFailed>> {
    const published = await this.input.bus.publish(lilacEventTypes.EvtWorkflowWaitResolverBarrier, {
      barrierId,
      ts: now,
    });
    return published
      .map((value) => ({ cursor: value.cursor }))
      .mapError(
        (cause) =>
          new WorkflowWaitResolverBarrierPublishFailed({
            cause,
            barrierId,
            message: "Workflow wait resolver barrier publication failed",
          }),
      );
  }

  private async reconcileTimersResult(): Promise<
    ResultType<void, WorkflowWaitResolverBarrierPublishFailed | DurableWorkflowReadError>
  > {
    if (this.polling) return Result.ok(undefined);
    this.polling = true;
    const outcome = await (async () => {
      const now = this.now();
      if (!this.ensureLeaseOwnership(now))
        return { status: "return", value: Result.ok(undefined) } as const;
      const candidates = this.input.store.listDueWaits(now);
      const dueWaits = candidates.match<
        | { readonly kind: "ok"; readonly waits: WorkflowWait[] }
        | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
      >({
        ok: (waits) => ({ kind: "ok", waits }),
        err: (error) => ({ kind: "error", error }),
      });
      if (dueWaits.kind === "error")
        return { status: "return", value: Result.err(dueWaits.error) } as const;
      for (const candidate of dueWaits.waits) {
        if (candidate.match.kind === "reply") {
          if (!this.ensureLeaseOwnership(this.now()))
            return { status: "return", value: Result.ok(undefined) } as const;
          const barrier = this.input.store.prepareWaitExpiryBarrier({
            runId: candidate.runId,
            operationId: candidate.operationId,
            barrierId: `wfbarrier:${crypto.randomUUID()}`,
            now,
            retryBefore: now - 5_000,
          });
          if (!barrier) continue;
          if (barrier.shouldPublish) {
            if (!this.ensureLeaseOwnership(this.now()))
              return { status: "return", value: Result.ok(undefined) } as const;
            const published = await this.captureWorkflowWaitResolverBarrierPublication(
              barrier.barrierId,
              now,
            );
            const publication = published.match<
              | { readonly kind: "ok"; readonly cursor: string }
              | {
                  readonly kind: "error";
                  readonly error: WorkflowWaitResolverBarrierPublishFailed;
                }
            >({
              ok: ({ cursor }) => ({ kind: "ok", cursor }),
              err: (error) => ({ kind: "error", error }),
            });
            if (publication.kind === "error")
              return { status: "return", value: Result.err(publication.error) } as const;
            if (!this.ensureLeaseOwnership(this.now()))
              return { status: "return", value: Result.ok(undefined) } as const;
            this.input.store.recordWaitExpiryBarrierCursor(
              barrier.barrierId,
              publication.cursor,
              this.now(),
            );
          }
          if (!barrier.processed) continue;
        }
        const runResult = this.input.store.getRun(candidate.runId);
        const runOutcome = runResult.match<
          | { readonly kind: "ok"; readonly ownerId: string | null | undefined }
          | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
        >({
          ok: (run) => ({ kind: "ok", ownerId: run?.claimedBy }),
          err: (error) => ({ kind: "error", error }),
        });
        if (runOutcome.kind === "error")
          return { status: "return", value: Result.err(runOutcome.error) } as const;
        const runOwnerId = runOutcome.ownerId;
        if (!runOwnerId) continue;
        if (!this.ensureLeaseOwnership(this.now()))
          return { status: "return", value: Result.ok(undefined) } as const;
        const claimed = this.input.store.tryClaimWait({
          runId: candidate.runId,
          operationId: candidate.operationId,
          claimerId: this.workerId,
          runOwnerId,
          now,
        });
        if (!claimed) continue;
        const isSleep =
          claimed.match.kind === "sleep" && claimed.dueAt !== null && claimed.dueAt <= now;
        const isExpired = claimed.deadlineAt !== null && claimed.deadlineAt <= now;
        if (!isSleep && !isExpired) {
          if (!this.ensureLeaseOwnership(this.now()))
            return { status: "return", value: Result.ok(undefined) } as const;
          this.input.store.transitionWait({
            runId: claimed.runId,
            operationId: claimed.operationId,
            from: "claimed",
            to: "pending",
            now,
            runOwnerId,
          });
          continue;
        }
        const to = isSleep ? "resolved" : "expired";
        if (!this.ensureLeaseOwnership(this.now()))
          return { status: "return", value: Result.ok(undefined) } as const;
        const changed = this.input.store.transitionWait({
          runId: claimed.runId,
          operationId: claimed.operationId,
          from: "claimed",
          to,
          now,
          result: isSleep ? { kind: "sleep", dueAt: claimed.dueAt, resolvedAt: now } : null,
          resolvedBy: `${to}:${now}`,
          runOwnerId,
        });
        if (changed) await this.publishWakeupAdvisory(claimed);
      }
      return { status: "return", value: Result.ok(undefined) } as const;
    })().finally(() => {
      this.polling = false;
    });
    return outcome.value;
  }

  private async captureWorkflowWaitResolverWakeupPublication(
    wait: WorkflowWait,
  ): Promise<ResultType<void, WorkflowWaitResolverWakeupPublishFailed | DurableWorkflowReadError>> {
    const runResult = this.input.store.getRun(wait.runId);
    const runOutcome = runResult.match<
      | { readonly kind: "ok"; readonly run: { runId: string; revisionId: string } | null }
      | { readonly kind: "error"; readonly error: DurableWorkflowReadError }
    >({
      ok: (run) => ({ kind: "ok", run }),
      err: (error) => ({ kind: "error", error }),
    });
    if (runOutcome.kind === "error") return Result.err(runOutcome.error);
    const { run } = runOutcome;
    if (!run) return Result.ok(undefined);
    const published = await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: run.runId,
      revisionId: run.revisionId,
      reason: "operation_changed",
      ts: this.now(),
    });
    return published
      .map(() => undefined)
      .mapError(
        (cause) =>
          new WorkflowWaitResolverWakeupPublishFailed({
            cause,
            runId: wait.runId,
            operationId: wait.operationId,
            message: "Workflow wait wakeup publication failed after durable resolution",
          }),
      );
  }

  private async publishWakeupAdvisory(wait: WorkflowWait): Promise<void> {
    if (!this.ensureLeaseOwnership(this.now())) return;
    const published = await this.captureWorkflowWaitResolverWakeupPublication(wait);
    published.match({
      ok: () => undefined,
      err: (error) =>
        this.logger.warn("Workflow wait wakeup publication failed after durable resolution", {
          runId: wait.runId,
          operationId: wait.operationId,
          ...formatTaggedErrorForLog(error),
        }),
    });
  }
}
