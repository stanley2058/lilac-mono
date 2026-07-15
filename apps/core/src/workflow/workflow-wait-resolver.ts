import {
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowWait } from "./workflow-domain";
import { matchWorkflowReplyWait, workflowReplyMatchKey } from "./workflow-waits";

export class WorkflowWaitResolver {
  private readonly logger = createLogger({ module: "workflow-wait-resolver" });
  private readonly workerId = `workflow-wait-resolver:${process.pid}:${crypto.randomUUID()}`;
  private subscription: { stop(): Promise<void> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      now?: () => number;
      pollMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    this.subscription = await this.input.bus.subscribeTopic(
      "evt.adapter",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "begin" },
        batch: { maxWaitMs: 500 },
      },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAdapterMessageCreated) {
          await this.resolveAdapterEvent(message.data, context.cursor);
        }
        this.input.store.advanceAdapterStreamWatermark({
          topic: "evt.adapter",
          cursor: context.cursor,
          now: this.now(),
        });
        await context.commit();
      },
    );
    await this.catchUpHistoricalReplies();
    this.timer = setInterval(() => void this.reconcileTimers(), this.input.pollMs ?? 250);
    this.timer.unref?.();
    await this.reconcileTimers();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.subscription?.stop();
    this.subscription = null;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private async catchUpHistoricalReplies(): Promise<void> {
    let cursor: string | undefined;
    while (true) {
      const batch = await this.input.bus.fetchTopic("evt.adapter", {
        offset: cursor ? { type: "cursor", cursor } : { type: "begin" },
        limit: 1_000,
      });
      for (const entry of batch.messages) {
        if (entry.msg.type === lilacEventTypes.EvtAdapterMessageCreated) {
          await this.resolveAdapterEvent(entry.msg.data, entry.cursor);
        }
        this.input.store.advanceAdapterStreamWatermark({
          topic: "evt.adapter",
          cursor: entry.cursor,
          now: this.now(),
        });
      }
      const previous = cursor;
      cursor = batch.next;
      if (batch.messages.length < 1_000 || !cursor || cursor === previous) return;
    }
  }

  async resolveAdapterEvent(event: EvtAdapterMessageCreatedData, cursor: string): Promise<void> {
    const key = workflowReplyMatchKey(event.platform, event.channelId);
    for (const candidate of this.input.store.listActiveWaitsByMatchKey("reply", key)) {
      const result = matchWorkflowReplyWait(candidate, event);
      if (result === null) continue;
      const now = this.now();
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
      if (resolved) await this.publishWakeup(resolved);
    }
  }

  async reconcileTimers(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      const candidates = this.input.store.listDueWaits(now);
      const currentAdapterCutoff = (await this.input.bus.getTopicWatermark("evt.adapter")) ?? "0-0";
      for (const candidate of candidates) {
        if (candidate.match.kind === "reply") {
          const cutoff = this.input.store.captureWaitExpiryCutoff({
            runId: candidate.runId,
            operationId: candidate.operationId,
            cutoffCursor: currentAdapterCutoff,
            now,
          });
          if (!cutoff || !this.input.store.hasAdapterStreamReached("evt.adapter", cutoff)) continue;
        }
        const runOwnerId = this.input.store.getRun(candidate.runId)?.claimedBy;
        if (!runOwnerId) continue;
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
        if (changed) await this.publishWakeup(claimed);
      }
    } catch (error) {
      this.logger.error("Workflow wait timer reconciliation failed", error);
    } finally {
      this.polling = false;
    }
  }

  private async publishWakeup(wait: WorkflowWait): Promise<void> {
    const run = this.input.store.getRun(wait.runId);
    if (!run) return;
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: run.runId,
      revisionId: run.revisionId,
      reason: "operation_changed",
      ts: this.now(),
    });
  }
}
