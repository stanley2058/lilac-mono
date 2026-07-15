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
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly actions = new Map<string, CachedActions>();
  private readonly actionRotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscription: { stop(): Promise<void> } | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private drainingActionOutbox = false;

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
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.actionRotationTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.actionRotationTimers.clear();
    await this.subscription?.stop();
    this.subscription = null;
  }

  requestProjection(runId: string): void {
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
      if (binding?.messageRef) {
        const boundRef = asMsgRef(binding.messageRef);
        const adapter = boundRef ? this.input.adapters.get(boundRef.platform) : undefined;
        let exists;
        try {
          exists = adapter && boundRef ? await adapter.readMsg(boundRef) : null;
        } catch (error) {
          const now = this.input.now?.() ?? Date.now();
          const retryCount = binding.retryCount + 1;
          this.input.store.upsertSurfaceBinding({
            ...binding,
            lastError: error instanceof Error ? error.message : String(error),
            retryCount,
            nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
            updatedAt: now,
          });
          continue;
        }
        if (!exists) {
          this.input.store.upsertSurfaceBinding({
            ...binding,
            messageRef: null,
            lastRenderedSha256: null,
            updatedAt: this.input.now?.() ?? Date.now(),
          });
        }
      }
      await this.project(run.runId).catch(() => undefined);
    }
    for (const run of this.input.store.listRunsMissingSurfaceBindings(1_000)) {
      if (boundRunIds.has(run.runId)) continue;
      await this.project(run.runId).catch(() => undefined);
    }
  }

  private retryDue(): void {
    const now = this.input.now?.() ?? Date.now();
    for (const binding of this.input.store.listSurfaceBindings({ dueBefore: now, limit: 1_000 })) {
      this.requestProjection(binding.runId);
    }
  }

  private async drainActionOutboxProjections(): Promise<void> {
    if (this.drainingActionOutbox) return;
    this.drainingActionOutbox = true;
    try {
      for (const entry of this.input.store.listPendingActionOutboxProjections()) {
        try {
          await this.project(entry.runId);
          this.input.store.markActionOutboxProjected(
            entry.outboxId,
            this.input.now?.() ?? Date.now(),
          );
        } catch (error) {
          this.logger.warn("Workflow action outbox projection failed", {
            outboxId: entry.outboxId,
            runId: entry.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.drainingActionOutbox = false;
    }
  }

  private issueActions(
    runId: string,
    view: Awaited<ReturnType<typeof buildWorkflowProgressView>>,
    messageRef: MsgRef | null,
    now: number,
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

    this.input.store.expireActiveSurfaceActions(runId, now);
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
        const created = this.input.store.createSurfaceAction({
          actionId,
          tokenSha256: sha256(token),
          runId,
          approvalId:
            kind === "approve" || kind === "reject" ? (view.approval?.approvalId ?? null) : null,
          kind,
          expectedPlatform,
          expectedUserId,
          expectedMessageRef: messageRef,
          expiresAt: now + (kind === "approve" || kind === "reject" ? 7 * 86_400_000 : 86_400_000),
          consumedAt: null,
          consumedByPlatform: null,
          consumedByUserId: null,
          createdAt: now,
        });
        if (!created) continue;
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

  private async project(runId: string, requireMessage = false): Promise<MsgRef> {
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
    const retryBinding = existing;
    if (
      messageRef &&
      retryBinding &&
      retryBinding.nextAttemptAt !== null &&
      retryBinding.nextAttemptAt <= now
    ) {
      let found;
      try {
        found = await adapter.readMsg(messageRef);
      } catch (error) {
        const retryCount = retryBinding.retryCount + 1;
        this.input.store.upsertSurfaceBinding({
          ...retryBinding,
          lastError: error instanceof Error ? error.message : String(error),
          retryCount,
          nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
          updatedAt: now,
        });
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
      this.input.store.upsertSurfaceBinding(existing);
      if (!found) messageRef = null;
    }
    const issued = this.issueActions(runId, view, messageRef, now);
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
      this.input.store.upsertSurfaceBinding({
        runId,
        target,
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (messageRef && existing?.lastRenderedSha256 === renderedSha256) return messageRef;

    try {
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
      if (!messageRef) this.input.store.bindSurfaceActions(issued.recordIds, projectedRef);
      this.input.store.upsertSurfaceBinding({
        runId,
        target,
        messageRef: projectedRef,
        lastRenderedSha256: renderedSha256,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
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
      const createdRef = error instanceof GithubMessageCreatedError ? error.messageRef : null;
      const editTargetMissing =
        messageRef !== null &&
        ((error instanceof GithubApiError && error.status === 404) ||
          error instanceof SurfaceMessageNotFoundError);
      if (createdRef) this.input.store.bindSurfaceActions(issued.recordIds, createdRef);
      const retryCount = (existing?.retryCount ?? 0) + 1;
      this.input.store.upsertSurfaceBinding({
        runId,
        target,
        messageRef: editTargetMissing ? null : (createdRef ?? messageRef),
        lastRenderedSha256: editTargetMissing ? null : (existing?.lastRenderedSha256 ?? null),
        lastError: error instanceof Error ? error.message : String(error),
        retryCount,
        nextAttemptAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8)),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
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
