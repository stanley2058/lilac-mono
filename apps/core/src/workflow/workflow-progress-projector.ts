import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { GithubApiError } from "../github/github-api";
import { isMarkedGithubAgentComment } from "../github/github-comment-marker";
import {
  hasAuthoritativeSelfMessageProvider,
  SurfaceMessageNotFoundError,
  type SurfaceAdapter,
} from "../surface/adapter";
import { GithubMessageCreatedError } from "../surface/github/github-adapter";
import type { ContentOpts, MsgRef, SessionRef, SurfaceMessage } from "../surface/types";
import {
  DurableWorkflowStore,
  type WorkflowSurfaceProjectionOrphan,
} from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";
import type {
  WorkflowRevision,
  WorkflowSurfaceActionKind,
  WorkflowSurfaceBinding,
} from "./workflow-domain";
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
  repairGeneration: number;
};

class ProjectionClaimUnavailableError extends Error {}
class ProjectionRepairChangedError extends ProjectionClaimUnavailableError {}
class ProjectionDiscoveryIncompleteError extends Error {}

const WORKFLOW_CARD_TEXT_LIMIT = 4_000;
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 10;
const DISCOVERY_TIMEOUT_MS = 5_000;

function workflowCardId(runId: string): string {
  return sha256(`workflow-progress-card:${runId}`);
}

function workflowCardMarker(
  runId: string,
  platform: "discord" | "github",
  repairGeneration: number,
): string {
  const id = workflowCardId(runId);
  return platform === "github"
    ? `<!-- lilac-workflow-card:${id}:generation:${repairGeneration} -->`
    : `[\u200B](https://lilac.invalid/.well-known/workflow-card/${id}?generation=${repairGeneration})`;
}

function workflowCardGeneration(
  text: string,
  runId: string,
  platform: "discord" | "github",
): number | null {
  const id = workflowCardId(runId);
  const prefix =
    platform === "github"
      ? `<!-- lilac-workflow-card:${id}:generation:`
      : `https://lilac.invalid/.well-known/workflow-card/${id}?generation=`;
  const suffix = platform === "github" ? " -->" : ")";
  const start = text.indexOf(prefix);
  if (start < 0) return null;
  const valueStart = start + prefix.length;
  const valueEnd = text.indexOf(suffix, valueStart);
  if (valueEnd < valueStart) return null;
  const value = text.slice(valueStart, valueEnd);
  if (!/^\d+$/u.test(value)) return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : null;
}

function workflowSupersededMarker(runId: string, platform: "discord" | "github"): string {
  const id = sha256(`workflow-progress-card:${runId}`);
  return platform === "github"
    ? `<!-- lilac-workflow-card-superseded:${id} -->`
    : `[\u200B](https://lilac.invalid/.well-known/workflow-card-superseded/${id})`;
}

function withWorkflowCardMarker(
  content: ContentOpts,
  runId: string,
  platform: "discord" | "github",
  repairGeneration: number,
): ContentOpts {
  const marker = workflowCardMarker(runId, platform, repairGeneration);
  const suffix = `${content.text ? "\n" : ""}${marker}`;
  const text = (content.text ?? "").slice(0, WORKFLOW_CARD_TEXT_LIMIT - suffix.length);
  return { ...content, text: `${text}${suffix}` };
}

function isProjectionMessageMissing(error: unknown): boolean {
  return (
    error instanceof SurfaceMessageNotFoundError ||
    (error instanceof GithubApiError && error.status === 404)
  );
}

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
  private readonly remoteVerificationRequested = new Set<string>();
  private readonly lastRemoteVerificationAt = new Map<string, number>();
  private subscription: { stop(): Promise<void> } | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private actionOutboxDrain: Promise<void> | null = null;
  private readonly projectionClaims = new Map<string, string>();
  private readonly projectionInFlight = new Map<string, Promise<MsgRef | null>>();
  private lastMissingBindingReconcileAt = 0;
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
      remoteVerificationIntervalMs?: number;
      retryIntervalMs?: number;
      missingBindingReconcileIntervalMs?: number;
      missingBindingReconcileBatchSize?: number;
      afterExternalIo?: (input: {
        runId: string;
        kind: "send" | "edit";
        messageRef: MsgRef;
      }) => Promise<void>;
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
    }, this.input.retryIntervalMs ?? 1_000);
    this.retryTimer.unref?.();
    this.lastMissingBindingReconcileAt = this.input.now?.() ?? Date.now();
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
    this.remoteVerificationRequested.clear();
    this.lastRemoteVerificationAt.clear();
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
        const verifyExisting = this.remoteVerificationRequested.delete(runId);
        void this.project(runId, false, verifyExisting).catch((error: unknown) => {
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
    const messageRef = await this.project(runId, true);
    if (!messageRef) {
      throw new Error(`Workflow run ${runId} has no supported durable progress target`);
    }
    return messageRef;
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
    for (const run of this.input.store.takeRunsMissingSurfaceBindingReconciliationPage({
      limit: this.input.missingBindingReconcileBatchSize ?? 1_000,
      now: this.input.now?.() ?? Date.now(),
    })) {
      if (boundRunIds.has(run.runId)) continue;
      await this.project(run.runId).catch((error: unknown) => {
        if (error instanceof ProjectionClaimUnavailableError) this.requestProjection(run.runId);
      });
    }
  }

  private retryDue(): void {
    const now = this.input.now?.() ?? Date.now();
    const verificationInterval = this.input.remoteVerificationIntervalMs ?? 60_000;
    for (const binding of this.input.store.listSurfaceBindings({ limit: 1_000 })) {
      if (binding.nextAttemptAt !== null && binding.nextAttemptAt <= now) {
        this.requestProjection(binding.runId);
      }
      if ((this.lastRemoteVerificationAt.get(binding.runId) ?? 0) + verificationInterval <= now) {
        this.remoteVerificationRequested.add(binding.runId);
        this.requestProjection(binding.runId);
      }
    }
    for (const orphan of this.input.store.listPendingSurfaceProjectionOrphans({
      dueBefore: now,
      limit: 1_000,
    })) {
      this.requestProjection(orphan.runId);
    }
    if (
      this.lastMissingBindingReconcileAt +
        (this.input.missingBindingReconcileIntervalMs ?? 5_000) <=
      now
    ) {
      this.lastMissingBindingReconcileAt = now;
      const missing = this.input.store.takeRunsMissingSurfaceBindingReconciliationPage({
        limit: this.input.missingBindingReconcileBatchSize ?? 1_000,
        now,
      });
      for (const run of missing) {
        this.requestProjection(run.runId);
      }
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
  ): Promise<MsgRef | null> {
    const previous = this.projectionInFlight.get(runId);
    let projection: Promise<MsgRef | null>;
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
  ): Promise<MsgRef | null> {
    const run = this.input.store.getRun(runId);
    if (run?.progressTarget === null) {
      this.releaseProjectionClaim(runId);
      if (requireMessage) {
        throw new Error(`Workflow run ${runId} has no supported durable progress target`);
      }
      return null;
    }
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

  private releaseProjectionClaim(runId: string): void {
    const claimToken = this.projectionClaims.get(runId);
    if (claimToken) {
      this.input.store.releaseSurfaceProjectionClaim({
        runId,
        ownerId: this.ownerId,
        claimToken,
      });
    }
    this.projectionClaims.delete(runId);
    this.actions.delete(runId);
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
    repairGeneration: number,
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
    if (
      cached?.key === key &&
      cached.repairGeneration === repairGeneration &&
      cached.expiresAt > now + 60_000
    ) {
      return cached;
    }

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
    const next = { key, ids, recordIds, expiresAt, repairGeneration };
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

  private sameMessageRef(left: WorkflowSurfaceBinding["messageRef"], right: MsgRef): boolean {
    return (
      left?.platform === right.platform &&
      left.channelId === right.channelId &&
      left.messageId === right.messageId
    );
  }

  private async cleanupProjectionOrphan(
    adapter: SurfaceAdapter,
    orphan: WorkflowSurfaceProjectionOrphan,
  ): Promise<void> {
    const currentRef = this.input.store.getSurfaceBinding(orphan.runId)?.messageRef ?? null;
    if (this.sameMessageRef(currentRef, orphan.messageRef)) {
      this.input.store.completeSurfaceProjectionOrphan(orphan.messageRef);
      return;
    }
    const superseded: ContentOpts = {
      text: `This workflow progress card was superseded.\n${workflowSupersededMarker(
        orphan.runId,
        orphan.messageRef.platform,
      )}`,
      actions: [],
    };
    try {
      if (orphan.messageRef.platform === "discord") {
        try {
          await adapter.deleteMsg(orphan.messageRef);
        } catch (error) {
          if (isProjectionMessageMissing(error)) {
            this.input.store.completeSurfaceProjectionOrphan(orphan.messageRef);
            return;
          }
          await adapter.editMsg(orphan.messageRef, superseded);
        }
      } else {
        await adapter.editMsg(orphan.messageRef, superseded);
      }
      this.input.store.completeSurfaceProjectionOrphan(orphan.messageRef);
    } catch (error) {
      if (isProjectionMessageMissing(error)) {
        this.input.store.completeSurfaceProjectionOrphan(orphan.messageRef);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.input.store.recordSurfaceProjectionOrphanFailure({
        messageRef: orphan.messageRef,
        error: message,
        now: this.input.now?.() ?? Date.now(),
      });
      throw error;
    }
  }

  private async persistAndCleanupOrphan(
    runId: string,
    adapter: SurfaceAdapter,
    orphanRef: MsgRef,
  ): Promise<void> {
    const now = this.input.now?.() ?? Date.now();
    this.input.store.recordSurfaceProjectionOrphan({ runId, messageRef: orphanRef, now });
    try {
      await this.cleanupProjectionOrphan(adapter, {
        runId,
        messageRef: orphanRef,
        attemptCount: 0,
        nextAttemptAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      this.logger.warn("Failed to clean stale workflow projection orphan", {
        runId,
        platform: orphanRef.platform,
        channelId: orphanRef.channelId,
        messageId: orphanRef.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async repairAfterIoClaimLoss(runId: string, orphanRef: MsgRef | null): Promise<void> {
    this.actions.delete(runId);
    if (orphanRef) {
      const now = this.input.now?.() ?? Date.now();
      this.input.store.recordSurfaceProjectionOrphan({ runId, messageRef: orphanRef, now });
    }
    this.input.store.requestSurfaceBindingRepair(runId, this.input.now?.() ?? Date.now());
  }

  private async processPendingOrphans(
    runId: string,
    adapter: SurfaceAdapter,
    claimToken: string,
  ): Promise<void> {
    for (const orphan of this.input.store.listPendingSurfaceProjectionOrphans({
      runId,
      dueBefore: this.input.now?.() ?? Date.now(),
      limit: 1_000,
    })) {
      this.refreshClaim(runId, claimToken);
      await this.cleanupProjectionOrphan(adapter, orphan);
      this.refreshClaim(runId, claimToken);
    }
  }

  private async listWorkflowCardCandidates(
    target: { platform: "discord" | "github"; channelId: string },
    adapter: SurfaceAdapter,
    runId: string,
    claimToken: string,
    cursor: WorkflowSurfaceBinding["discoveryCursor"],
  ): Promise<{
    candidates: Array<{ message: SurfaceMessage; generation: number }>;
    exhaustive: boolean;
    nextCursor: WorkflowSurfaceBinding["discoveryCursor"];
  }> {
    const startedAt = Date.now();
    const initialCursor = cursor ?? { page: 1, beforeMessageId: null, scannedEntries: 0 };
    const messages = new Map<string, SurfaceMessage>();
    let page = cursor?.page ?? 1;
    let beforeMessageId = cursor?.beforeMessageId ?? undefined;
    let scannedEntries = cursor?.scannedEntries ?? 0;
    let exhaustive = false;
    const self = target.platform === "discord" ? await adapter.getSelf() : null;
    const authoritativeProvider = hasAuthoritativeSelfMessageProvider(adapter) ? adapter : null;
    let verifyAuthor: ((message: SurfaceMessage) => boolean) | null = null;
    if (target.platform === "github") {
      if (!authoritativeProvider) {
        return { candidates: [], exhaustive: false, nextCursor: initialCursor };
      }
      const verifierResolution = await Promise.race([
        authoritativeProvider.resolveAuthoritativeSelfMessageVerifier().then((verify) => ({
          verify,
        })),
        Bun.sleep(DISCOVERY_TIMEOUT_MS).then(() => null),
      ]);
      if (verifierResolution === null) {
        return { candidates: [], exhaustive: false, nextCursor: initialCursor };
      }
      verifyAuthor = verifierResolution.verify;
    }
    for (let passPage = 0; passPage < DISCOVERY_MAX_PAGES; passPage += 1) {
      const remainingMs = DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      this.refreshClaim(runId, claimToken);
      const batch = await Promise.race([
        adapter.listMsg(asSessionRef(target.platform, target.channelId), {
          limit: DISCOVERY_PAGE_SIZE,
          ...(target.platform === "github" ? { page } : { beforeMessageId }),
        }),
        Bun.sleep(remainingMs).then(() => null),
      ]);
      if (batch === null) break;
      this.refreshClaim(runId, claimToken);
      scannedEntries += batch.length;
      let added = 0;
      for (const message of batch) {
        const key = `${message.ref.platform}:${message.ref.channelId}:${message.ref.messageId}`;
        if (!messages.has(key)) added += 1;
        messages.set(key, message);
      }
      if (batch.length < DISCOVERY_PAGE_SIZE) {
        exhaustive = true;
        break;
      }
      if (added === 0) break;
      if (target.platform === "discord") {
        const nextBefore = batch.at(-1)?.ref.messageId;
        if (!nextBefore || nextBefore === beforeMessageId) break;
        beforeMessageId = nextBefore;
      } else {
        page += 1;
      }
      if (Date.now() - startedAt >= DISCOVERY_TIMEOUT_MS) break;
    }

    const candidates: Array<{ message: SurfaceMessage; generation: number }> = [];
    let validationTimedOut = false;
    for (const message of messages.values()) {
      if (Date.now() - startedAt >= DISCOVERY_TIMEOUT_MS) {
        validationTimedOut = true;
        break;
      }
      if (
        message.ref.platform !== target.platform ||
        message.ref.channelId !== target.channelId ||
        (target.platform === "github"
          ? !isMarkedGithubAgentComment(message.text) || !verifyAuthor?.(message)
          : message.userId !== self?.userId)
      ) {
        continue;
      }
      const generation = workflowCardGeneration(message.text, runId, target.platform);
      if (generation !== null) candidates.push({ message, generation });
    }
    return {
      candidates,
      exhaustive: exhaustive && !validationTimedOut,
      nextCursor: validationTimedOut
        ? initialCursor
        : exhaustive
          ? null
          : { page, beforeMessageId: beforeMessageId ?? null, scannedEntries },
    };
  }

  private async discoverWorkflowCards(
    runId: string,
    target: { platform: "discord" | "github"; channelId: string },
    adapter: SurfaceAdapter,
    claimToken: string,
    expectedGeneration: number,
    cursor: WorkflowSurfaceBinding["discoveryCursor"],
  ): Promise<{
    canonical: MsgRef | null;
    duplicates: MsgRef[];
    exhaustive: boolean;
    nextCursor: WorkflowSurfaceBinding["discoveryCursor"];
  }> {
    const discovery = await this.listWorkflowCardCandidates(
      target,
      adapter,
      runId,
      claimToken,
      cursor,
    );
    const candidates = discovery.candidates;
    candidates.sort((left, right) => {
      const leftCurrent = left.generation === expectedGeneration ? 1 : 0;
      const rightCurrent = right.generation === expectedGeneration ? 1 : 0;
      return (
        rightCurrent - leftCurrent ||
        right.generation - left.generation ||
        right.message.ts - left.message.ts
      );
    });
    return {
      canonical: candidates.at(0)?.message.ref ?? null,
      duplicates: candidates.slice(1).map((candidate) => candidate.message.ref),
      exhaustive: discovery.exhaustive,
      nextCursor: discovery.nextCursor,
    };
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
          repairGeneration: 0,
          renderedRepairGeneration: 0,
          sendMayHaveSucceeded: false,
          discoveryCursor: null,
          createdAt: now,
          updatedAt: now,
        },
        claimToken,
      );
      existing = this.input.store.getSurfaceBinding(runId);
      if (!existing) throw new Error(`Workflow progress binding disappeared: ${runId}`);
    }
    await this.processPendingOrphans(runId, adapter, claimToken);
    existing = this.input.store.getSurfaceBinding(runId) ?? existing;
    let messageRef = existing?.messageRef ? asMsgRef(existing.messageRef) : null;
    if (
      this.actions.get(runId)?.repairGeneration !== existing.repairGeneration ||
      existing.repairGeneration !== existing.renderedRepairGeneration
    ) {
      this.actions.delete(runId);
    }
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
        this.lastRemoteVerificationAt.set(runId, now);
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
      let verifiedBinding = retryBinding;
      if (
        found &&
        workflowCardGeneration(found.text, runId, target.platform) !== retryBinding.repairGeneration
      ) {
        this.input.store.ensureSurfaceBindingRepair(runId, now);
        this.actions.delete(runId);
        verifiedBinding = this.input.store.getSurfaceBinding(runId) ?? retryBinding;
      }
      existing = {
        ...verifiedBinding,
        messageRef: found ? verifiedBinding.messageRef : null,
        lastRenderedSha256: found ? verifiedBinding.lastRenderedSha256 : null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        updatedAt: now,
      };
      this.writeBinding(existing, claimToken);
      if (!found) messageRef = null;
    }
    if (!messageRef && existing.sendMayHaveSucceeded) {
      const discovered = await this.discoverWorkflowCards(
        runId,
        { platform: target.platform, channelId: target.channelId },
        adapter,
        claimToken,
        existing.repairGeneration,
        existing.discoveryCursor,
      );
      if (discovered.canonical) {
        messageRef = discovered.canonical;
        existing = {
          ...existing,
          messageRef: discovered.canonical,
          lastRenderedSha256: null,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          sendMayHaveSucceeded: false,
          discoveryCursor: null,
          updatedAt: now,
        };
        this.writeBinding(existing, claimToken);
        for (const duplicate of discovered.duplicates) {
          this.input.store.recordSurfaceProjectionOrphan({
            runId,
            messageRef: duplicate,
            now,
          });
        }
        await this.processPendingOrphans(runId, adapter, claimToken);
      } else if (!discovered.exhaustive) {
        const retryCount = existing.retryCount + 1;
        this.writeBinding(
          {
            ...existing,
            lastError: "Workflow card discovery did not exhaust bounded surface history",
            retryCount,
            nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
            discoveryCursor: discovered.nextCursor,
            updatedAt: now,
          },
          claimToken,
        );
        throw new ProjectionDiscoveryIncompleteError(
          `Workflow card discovery is incomplete: ${runId}`,
        );
      } else {
        existing = {
          ...existing,
          sendMayHaveSucceeded: false,
          discoveryCursor: null,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          updatedAt: now,
        };
        this.writeBinding(existing, claimToken);
      }
    }
    existing = this.input.store.getSurfaceBinding(runId) ?? existing;
    const repairGeneration = existing.repairGeneration;
    const issued = this.issueActions(runId, view, messageRef, now, claimToken, repairGeneration);
    const surfaceActions = toSurfaceActions({ view, actionIds: issued.ids });
    const rendered = renderWorkflowProgressView({
      view,
      platform: target.platform,
      actions: surfaceActions,
    });
    const content = withWorkflowCardMarker(rendered, runId, target.platform, repairGeneration);
    const renderedSha256 = sha256(
      JSON.stringify({
        text: content.text,
        actions: content.actions,
        revision: view.revision.sourceSha256,
      }),
    );

    if (
      messageRef &&
      existing.repairGeneration === existing.renderedRepairGeneration &&
      existing.lastRenderedSha256 === renderedSha256
    ) {
      return messageRef;
    }

    try {
      this.refreshClaim(runId, claimToken);
      const sentNewMessage = messageRef === null;
      if (sentNewMessage) {
        existing = {
          ...existing,
          sendMayHaveSucceeded: true,
          discoveryCursor: { page: 1, beforeMessageId: null, scannedEntries: 0 },
          updatedAt: now,
        };
        this.writeBinding(existing, claimToken);
      }
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
      await this.input.afterExternalIo?.({
        runId,
        kind: sentNewMessage ? "send" : "edit",
        messageRef: projectedRef,
      });
      try {
        this.refreshClaim(runId, claimToken);
      } catch (error) {
        if (error instanceof ProjectionClaimUnavailableError) {
          await this.repairAfterIoClaimLoss(runId, sentNewMessage ? projectedRef : null);
        }
        throw error;
      }
      const committed = this.input.store.commitSurfaceProjectionFenced({
        binding: {
          runId,
          target,
          messageRef: projectedRef,
          lastRenderedSha256: renderedSha256,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          repairGeneration,
          renderedRepairGeneration: repairGeneration,
          sendMayHaveSucceeded: false,
          discoveryCursor: null,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
        actionIds: issued.recordIds,
        ownerId: this.ownerId,
        claimToken,
        expectedRepairGeneration: repairGeneration,
      });
      if (!committed) {
        try {
          this.refreshClaim(runId, claimToken);
        } catch (error) {
          if (error instanceof ProjectionClaimUnavailableError) {
            await this.repairAfterIoClaimLoss(runId, sentNewMessage ? projectedRef : null);
          }
          throw error;
        }
        this.actions.delete(runId);
        if (sentNewMessage) await this.persistAndCleanupOrphan(runId, adapter, projectedRef);
        throw new ProjectionRepairChangedError(
          `Workflow projection repair generation changed during external I/O: ${runId}`,
        );
      }
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
          await this.repairAfterIoClaimLoss(runId, createdRef);
        }
        throw claimError;
      }
      const editTargetMissing =
        messageRef !== null &&
        ((error instanceof GithubApiError && error.status === 404) ||
          error instanceof SurfaceMessageNotFoundError);
      const latestBinding = this.input.store.getSurfaceBinding(runId) ?? existing;
      const retryCount = latestBinding.retryCount + 1;
      this.writeBinding(
        {
          runId,
          target,
          messageRef: editTargetMissing ? null : (createdRef ?? messageRef),
          lastRenderedSha256: editTargetMissing ? null : latestBinding.lastRenderedSha256,
          lastError: error instanceof Error ? error.message : String(error),
          retryCount,
          nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
          repairGeneration: latestBinding.repairGeneration,
          renderedRepairGeneration: latestBinding.renderedRepairGeneration,
          sendMayHaveSucceeded: latestBinding.sendMayHaveSucceeded,
          discoveryCursor: latestBinding.discoveryCursor,
          createdAt: latestBinding.createdAt,
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
