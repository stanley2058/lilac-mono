import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { GithubApiError } from "../github/github-api";
import { SurfaceMessageNotFoundError, type SurfaceAdapter } from "../surface/adapter";
import { GithubMessageCreatedError } from "../surface/github/github-adapter";
import type { ContentOpts, MsgRef, SessionRef } from "../surface/types";
import { DurableWorkflowStore } from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";
import type { WorkflowSurfaceActionKind } from "./workflow-domain";
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

const WORKFLOW_CARD_TEXT_LIMIT = 4_000;

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

function limitContentText(content: ContentOpts): ContentOpts {
  return content.text && content.text.length > WORKFLOW_CARD_TEXT_LIMIT
    ? { ...content, text: content.text.slice(0, WORKFLOW_CARD_TEXT_LIMIT) }
    : content;
}

function retryAt(now: number, retryCount: number): number {
  return now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8));
}

export class WorkflowProgressProjector implements WorkflowProgressCardService {
  private readonly logger = createLogger({ module: "workflow-progress-projector" });
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly actions = new Map<string, CachedActions>();
  private readonly actionRotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectionInFlight = new Map<string, Promise<MsgRef | null>>();
  private subscription: { stop(): Promise<void> } | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private actionOutboxDrain: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      adapters: ReadonlyMap<"discord" | "github", SurfaceAdapter>;
      subscriptionId: string;
      now?: () => number;
      coalesceMs?: number;
      minEditIntervalMs?: number;
      retryIntervalMs?: number;
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
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
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
  }

  requestProjection(runId: string): void {
    if (this.stopping || this.timers.has(runId)) return;
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
    const messageRef = await this.project(runId, true);
    if (!messageRef) {
      throw new Error(`Workflow run ${runId} has no supported durable progress target`);
    }
    return messageRef;
  }

  async reconcile(): Promise<void> {
    for (const run of this.input.store.listRunsNeedingProjectionReconciliation(1_000)) {
      await this.project(run.runId, false, true).catch((error: unknown) => {
        this.logger.warn("Workflow startup projection reconciliation failed", {
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
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
    const drain = this.drainPendingActionOutboxProjections();
    this.actionOutboxDrain = drain;
    const clearDrain = () => {
      if (this.actionOutboxDrain === drain) this.actionOutboxDrain = null;
    };
    void drain.then(clearDrain, clearDrain);
    return drain;
  }

  private async drainPendingActionOutboxProjections(): Promise<void> {
    for (const entry of this.input.store.listPendingActionOutboxProjections()) {
      try {
        await this.project(entry.runId);
        if (
          !this.input.store.markActionOutboxProjected({
            outboxId: entry.outboxId,
            now: this.input.now?.() ?? Date.now(),
          })
        ) {
          throw new Error("Workflow action outbox projection was already completed");
        }
      } catch (error) {
        this.logger.warn("Workflow action outbox projection failed", {
          outboxId: entry.outboxId,
          runId: entry.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
      return await this.projectRun(runId, requireMessage, verifyExisting);
    })();
    this.projectionInFlight.set(runId, projection);
    const clearProjection = () => {
      if (this.projectionInFlight.get(runId) === projection) {
        this.projectionInFlight.delete(runId);
      }
    };
    void projection.then(clearProjection, clearProjection);
    return await projection;
  }

  private issueActions(
    runId: string,
    view: Awaited<ReturnType<typeof buildWorkflowProgressView>>,
    messageRef: MsgRef | null,
    now: number,
  ): CachedActions {
    const expectedUserId = view.run.origin.userId;
    const expectedPlatform = view.run.origin.client;
    const key = `${view.run.state}:${expectedPlatform}:${expectedUserId}:${view.availableActions.join(",")}`;
    const cached = this.actions.get(runId);
    if (cached?.key === key && cached.expiresAt > now + 60_000) return cached;

    this.input.store.expireActiveSurfaceActions(runId, now);
    const ids = new Map<WorkflowSurfaceActionKind, string>();
    const recordIds: string[] = [];
    const expiresAt = now + 86_400_000;
    if (
      expectedUserId &&
      (expectedPlatform === "discord" || expectedPlatform === "github") &&
      expectedPlatform === view.run.progressTarget?.platform
    ) {
      for (const kind of view.availableActions) {
        const token = crypto.randomUUID();
        const actionId = `wfaction:${crypto.randomUUID()}`;
        if (
          !this.input.store.createSurfaceAction({
            actionId,
            tokenSha256: sha256(token),
            runId,
            kind,
            expectedPlatform,
            expectedUserId,
            expectedMessageRef: messageRef,
            expiresAt: now + 86_400_000,
            consumedAt: null,
            consumedByPlatform: null,
            consumedByUserId: null,
            createdAt: now,
          })
        ) {
          continue;
        }
        ids.set(kind, token);
        recordIds.push(actionId);
      }
    }
    const next = { key, ids, recordIds, expiresAt };
    this.actions.set(runId, next);
    return next;
  }

  private writeFailure(
    binding: NonNullable<ReturnType<DurableWorkflowStore["getSurfaceBinding"]>>,
    error: unknown,
    now: number,
    overrides?: Partial<Pick<typeof binding, "messageRef" | "lastRenderedSha256">>,
  ): void {
    const retryCount = binding.retryCount + 1;
    this.input.store.upsertSurfaceBinding({
      ...binding,
      ...overrides,
      lastError: error instanceof Error ? error.message : String(error),
      retryCount,
      nextAttemptAt: retryAt(now, retryCount),
      updatedAt: now,
    });
  }

  private scheduleActionRotation(runId: string, issued: CachedActions, now: number): void {
    const prior = this.actionRotationTimers.get(runId);
    if (prior) clearTimeout(prior);
    this.actionRotationTimers.delete(runId);
    if (issued.recordIds.length === 0) return;
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

  private async projectRun(
    runId: string,
    requireMessage: boolean,
    verifyExisting: boolean,
  ): Promise<MsgRef | null> {
    const run = this.input.store.getRun(runId);
    if (run?.progressTarget === null) {
      if (requireMessage) {
        throw new Error(`Workflow run ${runId} has no supported durable progress target`);
      }
      return null;
    }

    const now = this.input.now?.() ?? Date.now();
    const view = await buildWorkflowProgressView({
      store: this.input.store,
      runId,
      now,
    });
    const target = view.run.progressTarget;
    if (!target || (target.platform !== "discord" && target.platform !== "github")) {
      throw new Error(`Workflow run ${runId} has no supported durable progress target`);
    }
    const adapter = this.input.adapters.get(target.platform);
    if (!adapter) throw new Error(`Workflow progress adapter is unavailable: ${target.platform}`);

    let existing = this.input.store.getSurfaceBinding(runId);
    if (!existing) {
      existing = {
        runId,
        target,
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.input.store.upsertSurfaceBinding(existing);
    }

    let messageRef = existing.messageRef ? asMsgRef(existing.messageRef) : null;
    if (
      messageRef &&
      (verifyExisting || (existing.nextAttemptAt !== null && existing.nextAttemptAt <= now))
    ) {
      try {
        const found = await adapter.readMsg(messageRef);
        existing = {
          ...existing,
          messageRef: found ? existing.messageRef : null,
          lastRenderedSha256: found ? existing.lastRenderedSha256 : null,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          updatedAt: now,
        };
        this.input.store.upsertSurfaceBinding(existing);
        if (!found) messageRef = null;
      } catch (error) {
        this.writeFailure(existing, error, now);
        throw error;
      }
    }

    const issued = this.issueActions(runId, view, messageRef, now);
    const content = limitContentText(
      renderWorkflowProgressView({
        view,
        platform: target.platform,
        actions: toSurfaceActions({ view, actionIds: issued.ids }),
      }),
    );
    const renderedSha256 = sha256(
      JSON.stringify({
        text: content.text,
        actions: content.actions,
        revision: view.revision.sourceSha256,
      }),
    );
    if (messageRef && existing.lastRenderedSha256 === renderedSha256) return messageRef;

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
      this.input.store.commitSurfaceProjection({
        binding: {
          ...existing,
          target,
          messageRef: projectedRef,
          lastRenderedSha256: renderedSha256,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
          updatedAt: now,
        },
        actionIds: issued.recordIds,
      });
      this.lastEditAt.set(runId, now);
      this.scheduleActionRotation(runId, issued, now);
      return projectedRef;
    } catch (error) {
      const createdRef = error instanceof GithubMessageCreatedError ? error.messageRef : null;
      const editTargetMissing =
        messageRef !== null &&
        (error instanceof SurfaceMessageNotFoundError ||
          (error instanceof GithubApiError && error.status === 404));
      this.writeFailure(existing, error, now, {
        messageRef: editTargetMissing ? null : (createdRef ?? messageRef),
        lastRenderedSha256: editTargetMissing ? null : existing.lastRenderedSha256,
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
