import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { GithubApiError } from "../github/github-api";
import { SurfaceMessageNotFoundError, type SurfaceAdapter } from "../surface/adapter";
import { GithubMessageCreatedError } from "../surface/github/github-adapter";
import type { ContentOpts, MsgRef, SessionRef } from "../surface/types";
import { DurableWorkflowStore } from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";
import type { WorkflowRevision, WorkflowSurfaceActionKind } from "./workflow-domain";
import {
  buildWorkflowProgressView,
  renderWorkflowProgressView,
  toSurfaceActions,
} from "./workflow-progress-view";

export interface WorkflowProgressCardService {
  ensureInitialCard(runId: string): Promise<MsgRef>;
  requestProjection(runId: string): void;
}

type CachedActions = {
  key: string;
  ids: Map<WorkflowSurfaceActionKind, string>;
  recordIds: string[];
  expiresAt: number;
};

class ProjectionClaimUnavailableError extends Error {}

function asSessionRef(platform: "discord" | "github", channelId: string): SessionRef {
  return { platform, channelId };
}

function asSupportedMsgRef(
  platform: "discord" | "github",
  channelId: string,
  messageId: string,
): MsgRef {
  return platform === "discord"
    ? { platform, channelId, messageId }
    : { platform, channelId, messageId };
}

function asMsgRef(input: {
  platform: string;
  channelId: string;
  messageId: string;
}): MsgRef | null {
  if (input.platform === "discord") {
    return { platform: "discord", channelId: input.channelId, messageId: input.messageId };
  }
  if (input.platform === "github") {
    return { platform: "github", channelId: input.channelId, messageId: input.messageId };
  }
  return null;
}

export class WorkflowProgressProjector implements WorkflowProgressCardService {
  private readonly logger = createLogger({ module: "workflow-progress-projector" });
  private readonly ownerId = `workflow-progress-projector:${process.pid}:${crypto.randomUUID()}`;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly actions = new Map<string, CachedActions>();
  private readonly actionRotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscription: { stop(): Promise<void> } | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private actionOutboxDrain: Promise<void> | null = null;
  private readonly projectionClaims = new Map<string, string>();
  private readonly projectionInFlight = new Map<string, Promise<MsgRef>>();
  private stopping = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      adapters: ReadonlyMap<"discord" | "github", SurfaceAdapter>;
      subscriptionId: string;
      loadSource?: (revision: WorkflowRevision) => Promise<string | null>;
      now?: () => number;
      coalesceMs?: number;
      minEditIntervalMs?: number;
      claimStaleMs?: number;
      claimHeartbeatMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.subscription = await this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 1_000 },
      },
      async (message, context) => {
        if (
          message.type === lilacEventTypes.EvtWorkflowRunChanged ||
          message.type === lilacEventTypes.EvtWorkflowOperationChanged ||
          message.type === lilacEventTypes.EvtWorkflowProgressRequested ||
          message.type === lilacEventTypes.EvtWorkflowUsageChanged ||
          message.type === lilacEventTypes.EvtWorkflowResultReady
        ) {
          this.requestProjection(message.data.runId);
        } else if (
          message.type === lilacEventTypes.EvtWorkflowApprovalChanged &&
          message.data.runId
        ) {
          this.requestProjection(message.data.runId);
        }
        await context.commit();
      },
    );

    await this.drainActionOutboxProjections();
    await this.reconcile();
    this.retryTimer = setInterval(() => {
      this.retryDue();
      void this.drainActionOutboxProjections();
    }, 1_000);
    this.retryTimer.unref?.();
    this.claimTimer = setInterval(
      () => this.refreshProjectionClaims(),
      this.input.claimHeartbeatMs ?? 10_000,
    );
    this.claimTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    if (this.claimTimer) clearInterval(this.claimTimer);
    this.claimTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.actionRotationTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.actionRotationTimers.clear();
    await this.subscription?.stop();
    this.subscription = null;
    await this.actionOutboxDrain;
    while (this.projectionInFlight.size > 0) {
      await Promise.allSettled(this.projectionInFlight.values());
    }
    for (const [runId, claimToken] of this.projectionClaims) {
      this.input.store.releaseSurfaceProjectionClaim({
        runId,
        ownerId: this.ownerId,
        claimToken,
      });
    }
    this.projectionClaims.clear();
  }

  requestProjection(runId: string): void {
    if (this.stopping) return;
    if (this.timers.has(runId)) return;
    const now = this.input.now?.() ?? Date.now();
    const last = this.lastEditAt.get(runId) ?? 0;
    const delay = Math.max(
      this.input.coalesceMs ?? 250,
      last + (this.input.minEditIntervalMs ?? 1_000) - now,
    );
    const timer = setTimeout(
      () => {
        this.timers.delete(runId);
        void this.project(runId).catch((error: unknown) => {
          this.logger.warn("Workflow projection failed", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof ProjectionClaimUnavailableError) this.requestProjection(runId);
        });
      },
      Math.max(0, delay),
    );
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  async ensureInitialCard(runId: string): Promise<MsgRef> {
    return await this.project(runId, true);
  }

  async reconcile(): Promise<void> {
    const boundRunIds = new Set<string>();
    for (const binding of this.input.store.listSurfaceBindings({ limit: 1_000 })) {
      const run = this.input.store.getRun(binding.runId);
      if (!run) continue;
      boundRunIds.add(run.runId);
      await this.project(run.runId, false, true).catch((error: unknown) => {
        if (error instanceof ProjectionClaimUnavailableError) this.requestProjection(run.runId);
      });
    }
    for (const run of this.input.store.listRunsMissingSurfaceBindings(1_000)) {
      if (boundRunIds.has(run.runId)) continue;
      await this.project(run.runId).catch((error: unknown) => {
        if (error instanceof ProjectionClaimUnavailableError) this.requestProjection(run.runId);
      });
    }
  }

  private retryDue(): void {
    const now = this.input.now?.() ?? Date.now();
    for (const binding of this.input.store.listSurfaceBindings({ dueBefore: now, limit: 1_000 })) {
      this.requestProjection(binding.runId);
    }
  }

  private drainActionOutboxProjections(): Promise<void> {
    if (this.actionOutboxDrain) return this.actionOutboxDrain;
    const drain = this.drainClaimedActionOutboxProjections();
    this.actionOutboxDrain = drain;
    void drain.then(
      () => {
        if (this.actionOutboxDrain === drain) this.actionOutboxDrain = null;
      },
      () => {
        if (this.actionOutboxDrain === drain) this.actionOutboxDrain = null;
      },
    );
    return drain;
  }

  private async drainClaimedActionOutboxProjections(): Promise<void> {
    const now = this.input.now?.() ?? Date.now();
    const claimToken = crypto.randomUUID();
    const entries = this.input.store.claimPendingActionOutboxProjections({
      ownerId: this.ownerId,
      claimToken,
      now,
      staleBefore: now - (this.input.claimStaleMs ?? 30_000),
    });
    const heartbeat = setInterval(() => {
      this.input.store.refreshActionOutboxProjectionClaims({
        ownerId: this.ownerId,
        claimToken,
        now: this.input.now?.() ?? Date.now(),
      });
    }, this.input.claimHeartbeatMs ?? 10_000);
    heartbeat.unref?.();
    try {
      for (const entry of entries) {
        try {
          await this.project(entry.runId);
          if (
            !this.input.store.markActionOutboxProjected({
              outboxId: entry.outboxId,
              ownerId: this.ownerId,
              claimToken,
              now: this.input.now?.() ?? Date.now(),
            })
          ) {
            throw new Error("Workflow action projection lost its fenced outbox claim");
          }
        } catch (error) {
          this.input.store.releaseActionOutboxProjectionClaim({
            outboxId: entry.outboxId,
            ownerId: this.ownerId,
            claimToken,
          });
          this.logger.warn("Workflow action outbox projection failed", {
            outboxId: entry.outboxId,
            runId: entry.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async project(
    runId: string,
    requireMessage = false,
    verifyExisting = false,
  ): Promise<MsgRef> {
    const previous = this.projectionInFlight.get(runId);
    let projection: Promise<MsgRef>;
    projection = (async () => {
      if (previous) await previous.catch(() => undefined);
      return await this.projectWithClaim(runId, requireMessage, verifyExisting);
    })();
    this.projectionInFlight.set(runId, projection);
    void projection.then(
      () => {
        if (this.projectionInFlight.get(runId) === projection) {
          this.projectionInFlight.delete(runId);
        }
      },
      () => {
        if (this.projectionInFlight.get(runId) === projection) {
          this.projectionInFlight.delete(runId);
        }
      },
    );
    return await projection;
  }

  private async projectWithClaim(
    runId: string,
    requireMessage: boolean,
    verifyExisting: boolean,
  ): Promise<MsgRef> {
    const heldClaim = this.projectionClaims.get(runId);
    if (!heldClaim) this.actions.delete(runId);
    const claimToken = heldClaim ?? crypto.randomUUID();
    const now = this.input.now?.() ?? Date.now();
    const claimed = heldClaim
      ? this.input.store.refreshSurfaceProjectionClaim({
          runId,
          ownerId: this.ownerId,
          claimToken,
          now,
        })
      : this.input.store.claimSurfaceProjection({
          runId,
          ownerId: this.ownerId,
          claimToken,
          now,
          staleBefore: now - (this.input.claimStaleMs ?? 30_000),
        });
    if (!claimed) {
      this.projectionClaims.delete(runId);
      this.actions.delete(runId);
      throw new ProjectionClaimUnavailableError(
        `Workflow progress projection is already claimed: ${runId}`,
      );
    }
    this.projectionClaims.set(runId, claimToken);
    const heartbeat = setInterval(() => {
      if (
        !this.input.store.refreshSurfaceProjectionClaim({
          runId,
          ownerId: this.ownerId,
          claimToken,
          now: this.input.now?.() ?? Date.now(),
        })
      ) {
        this.projectionClaims.delete(runId);
        this.actions.delete(runId);
      }
    }, this.input.claimHeartbeatMs ?? 10_000);
    heartbeat.unref?.();
    try {
      return await this.projectOwned(runId, claimToken, requireMessage, verifyExisting);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private refreshProjectionClaims(): void {
    const now = this.input.now?.() ?? Date.now();
    for (const [runId, claimToken] of this.projectionClaims) {
      if (
        !this.input.store.refreshSurfaceProjectionClaim({
          runId,
          ownerId: this.ownerId,
          claimToken,
          now,
        })
      ) {
        this.projectionClaims.delete(runId);
        this.actions.delete(runId);
      }
    }
  }

  private issueActions(
    runId: string,
    view: Awaited<ReturnType<typeof buildWorkflowProgressView>>,
    messageRef: MsgRef | null,
    now: number,
    claimToken: string,
  ): CachedActions {
    const isReview = view.availableActions.some((kind) => kind === "approve" || kind === "reject");
    const expectedUserId = isReview
      ? (view.approval?.expectedReviewerUserId ?? null)
      : view.run.origin.userId;
    const expectedPlatform = isReview
      ? (view.approval?.expectedReviewerPlatform ?? null)
      : view.run.origin.client;
    const key = `${view.run.state}:${view.approval?.state ?? "none"}:${expectedPlatform}:${expectedUserId}:${view.availableActions.join(",")}`;
    const cached = this.actions.get(runId);
    if (cached?.key === key && cached.expiresAt > now + 60_000) return cached;

    this.assertFencedWrite(
      runId,
      this.input.store.expireActiveSurfaceActionsFenced(runId, now, {
        ownerId: this.ownerId,
        claimToken,
      }),
    );
    const ids = new Map<WorkflowSurfaceActionKind, string>();
    const recordIds: string[] = [];
    let expiresAt = now + 86_400_000;
    if (
      expectedUserId &&
      (expectedPlatform === "discord" || expectedPlatform === "github") &&
      expectedPlatform === view.run.progressTarget?.platform
    ) {
      for (const kind of view.availableActions) {
        const token = crypto.randomUUID();
        const actionId = `wfaction:${crypto.randomUUID()}`;
        const created = this.input.store.createSurfaceActionFenced(
          {
            actionId,
            tokenSha256: sha256(token),
            runId,
            approvalId:
              kind === "approve" || kind === "reject" ? (view.approval?.approvalId ?? null) : null,
            kind,
            expectedPlatform,
            expectedUserId,
            expectedMessageRef: messageRef,
            expiresAt:
              now + (kind === "approve" || kind === "reject" ? 7 * 86_400_000 : 86_400_000),
            consumedAt: null,
            consumedByPlatform: null,
            consumedByUserId: null,
            createdAt: now,
          },
          { ownerId: this.ownerId, claimToken },
        );
        if (!created) {
          this.refreshClaim(runId, claimToken);
          continue;
        }
        ids.set(kind, token);
        recordIds.push(actionId);
        expiresAt = Math.min(
          expiresAt,
          now + (kind === "approve" || kind === "reject" ? 7 * 86_400_000 : 86_400_000),
        );
      }
    }
    const next = { key, ids, recordIds, expiresAt };
    this.actions.set(runId, next);
    return next;
  }

  private assertFencedWrite(runId: string, changed: boolean): void {
    if (!changed) {
      this.projectionClaims.delete(runId);
      this.actions.delete(runId);
      throw new ProjectionClaimUnavailableError(`Workflow projection claim was lost: ${runId}`);
    }
  }

  private refreshClaim(runId: string, claimToken: string): void {
    this.assertFencedWrite(
      runId,
      this.input.store.refreshSurfaceProjectionClaim({
        runId,
        ownerId: this.ownerId,
        claimToken,
        now: this.input.now?.() ?? Date.now(),
      }),
    );
  }

  private writeBinding(
    binding: Parameters<DurableWorkflowStore["upsertSurfaceBinding"]>[0],
    claimToken: string,
  ): void {
    this.assertFencedWrite(
      binding.runId,
      this.input.store.upsertSurfaceBindingFenced(binding, {
        ownerId: this.ownerId,
        claimToken,
      }),
    );
  }

  private async repairAfterIoClaimLoss(
    runId: string,
    adapter: SurfaceAdapter,
    orphanRef: MsgRef | null,
  ): Promise<void> {
    this.actions.delete(runId);
    this.input.store.markSurfaceBindingRepairRequired(runId, this.input.now?.() ?? Date.now());
    if (!orphanRef) return;
    const currentRef = this.input.store.getSurfaceBinding(runId)?.messageRef;
    if (
      currentRef?.platform === orphanRef.platform &&
      currentRef.channelId === orphanRef.channelId &&
      currentRef.messageId === orphanRef.messageId
    ) {
      return;
    }
    try {
      await adapter.deleteMsg(orphanRef);
    } catch (error) {
      this.logger.warn("Failed to delete stale workflow projection orphan", {
        runId,
        platform: orphanRef.platform,
        channelId: orphanRef.channelId,
        messageId: orphanRef.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async projectOwned(
    runId: string,
    claimToken: string,
    requireMessage = false,
    verifyExisting = false,
  ): Promise<MsgRef> {
    const now = this.input.now?.() ?? Date.now();
    const view = await buildWorkflowProgressView({
      store: this.input.store,
      runId,
      now,
      loadSource: this.input.loadSource,
    });
    const target = view.run.progressTarget;
    if (!target || (target.platform !== "discord" && target.platform !== "github")) {
      throw new Error(`Workflow run ${runId} has no supported durable progress target`);
    }
    const adapter = this.input.adapters.get(target.platform);
    if (!adapter) throw new Error(`Workflow progress adapter is unavailable: ${target.platform}`);

    let existing = this.input.store.getSurfaceBinding(runId);
    let messageRef = existing?.messageRef ? asMsgRef(existing.messageRef) : null;
    if (existing?.repairRequired) this.actions.delete(runId);
    const retryBinding = existing;
    if (
      messageRef &&
      retryBinding &&
      (verifyExisting || (retryBinding.nextAttemptAt !== null && retryBinding.nextAttemptAt <= now))
    ) {
      let found;
      try {
        this.refreshClaim(runId, claimToken);
        found = await adapter.readMsg(messageRef);
        this.refreshClaim(runId, claimToken);
      } catch (error) {
        if (error instanceof ProjectionClaimUnavailableError) throw error;
        this.refreshClaim(runId, claimToken);
        const retryCount = retryBinding.retryCount + 1;
        this.writeBinding(
          {
            ...retryBinding,
            lastError: error instanceof Error ? error.message : String(error),
            retryCount,
            nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
            updatedAt: now,
          },
          claimToken,
        );
        throw error;
      }
      existing = {
        ...retryBinding,
        messageRef: found ? retryBinding.messageRef : null,
        lastRenderedSha256: found ? retryBinding.lastRenderedSha256 : null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        updatedAt: now,
      };
      this.writeBinding(existing, claimToken);
      if (!found) messageRef = null;
    }
    const issued = this.issueActions(runId, view, messageRef, now, claimToken);
    const surfaceActions = toSurfaceActions({ view, actionIds: issued.ids });
    const rendered = renderWorkflowProgressView({
      view,
      platform: target.platform,
      actions: surfaceActions,
    });
    const content: ContentOpts = rendered;
    const renderedSha256 = sha256(
      JSON.stringify({
        text: rendered.text,
        actions: rendered.actions,
        revision: view.revision.sourceSha256,
      }),
    );

    if (!existing) {
      this.writeBinding(
        {
          runId,
          target,
          messageRef: null,
          lastRenderedSha256: null,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          repairRequired: false,
          createdAt: now,
          updatedAt: now,
        },
        claimToken,
      );
    }
    if (
      messageRef &&
      !existing?.repairRequired &&
      existing?.lastRenderedSha256 === renderedSha256
    ) {
      return messageRef;
    }

    try {
      this.refreshClaim(runId, claimToken);
      const projectedRef = messageRef
        ? (await adapter.editMsg(messageRef, content), messageRef)
        : await adapter.sendMsg(
            asSessionRef(target.platform, target.channelId),
            content,
            target.replyToMessageId
              ? {
                  replyTo: asSupportedMsgRef(
                    target.platform,
                    target.channelId,
                    target.replyToMessageId,
                  ),
                  silent: true,
                }
              : { silent: true },
          );
      try {
        this.refreshClaim(runId, claimToken);
      } catch (error) {
        if (error instanceof ProjectionClaimUnavailableError) {
          await this.repairAfterIoClaimLoss(runId, adapter, messageRef ? null : projectedRef);
        }
        throw error;
      }
      if (!messageRef) {
        this.assertFencedWrite(
          runId,
          this.input.store.bindSurfaceActionsFenced(runId, issued.recordIds, projectedRef, {
            ownerId: this.ownerId,
            claimToken,
          }),
        );
      }
      this.writeBinding(
        {
          runId,
          target,
          messageRef: projectedRef,
          lastRenderedSha256: renderedSha256,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          repairRequired: false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        claimToken,
      );
      this.lastEditAt.set(runId, now);
      const priorRotation = this.actionRotationTimers.get(runId);
      if (priorRotation) clearTimeout(priorRotation);
      if (issued.recordIds.length > 0) {
        const timer = setTimeout(
          () => {
            this.actionRotationTimers.delete(runId);
            this.requestProjection(runId);
          },
          Math.max(1_000, issued.expiresAt - now - 60_000),
        );
        timer.unref?.();
        this.actionRotationTimers.set(runId, timer);
      }
      return projectedRef;
    } catch (error) {
      if (error instanceof ProjectionClaimUnavailableError) throw error;
      const createdRef = error instanceof GithubMessageCreatedError ? error.messageRef : null;
      try {
        this.refreshClaim(runId, claimToken);
      } catch (claimError) {
        if (claimError instanceof ProjectionClaimUnavailableError) {
          await this.repairAfterIoClaimLoss(runId, adapter, createdRef);
        }
        throw claimError;
      }
      const editTargetMissing =
        messageRef !== null &&
        ((error instanceof GithubApiError && error.status === 404) ||
          error instanceof SurfaceMessageNotFoundError);
      if (createdRef) {
        this.assertFencedWrite(
          runId,
          this.input.store.bindSurfaceActionsFenced(runId, issued.recordIds, createdRef, {
            ownerId: this.ownerId,
            claimToken,
          }),
        );
      }
      const retryCount = (existing?.retryCount ?? 0) + 1;
      this.writeBinding(
        {
          runId,
          target,
          messageRef: editTargetMissing ? null : (createdRef ?? messageRef),
          lastRenderedSha256: editTargetMissing ? null : (existing?.lastRenderedSha256 ?? null),
          lastError: error instanceof Error ? error.message : String(error),
          retryCount,
          nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
          repairRequired: existing?.repairRequired ?? false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        claimToken,
      );
      if (requireMessage) {
        if (createdRef) return createdRef;
        throw new Error(
          `Workflow run ${runId} was persisted, but its initial progress card could not be created: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }
}
