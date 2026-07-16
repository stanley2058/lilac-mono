import { z } from "zod";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore } from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";

const surfaceActionEventSchema = z.strictObject({
  actionId: z.string().min(16).max(200),
  platform: z.enum(["discord", "github"]),
  userId: z.string().min(1).max(200),
  messageRef: z.strictObject({
    platform: z.enum(["discord", "github"]),
    channelId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
  }),
  sourceMessageId: z.string().min(1).max(200).optional(),
  ts: z.number().int().nonnegative(),
});

const approvalChangedSchema = z.strictObject({
  approvalId: z.string(),
  revisionId: z.string(),
  runId: z.string().optional(),
  state: z.enum(["pending", "approved", "rejected", "revoked", "expired"]),
  previousState: z.enum(["pending", "approved", "rejected", "revoked", "expired"]).optional(),
  ts: z.number(),
});
const runChangedSchema = z.strictObject({
  runId: z.string(),
  revisionId: z.string(),
  state: z.enum([
    "awaiting_review",
    "queued",
    "running",
    "blocked",
    "paused",
    "succeeded",
    "failed",
    "rejected",
    "cancelled",
  ]),
  previousState: z
    .enum([
      "awaiting_review",
      "queued",
      "running",
      "blocked",
      "paused",
      "succeeded",
      "failed",
      "rejected",
      "cancelled",
    ])
    .optional(),
  ts: z.number(),
});
const progressRequestedSchema = z.strictObject({
  runId: z.string(),
  revisionId: z.string(),
  reason: z.enum(["created", "state_changed", "operation_changed", "usage_changed", "reconcile"]),
  ts: z.number(),
});

export async function startWorkflowActionResolver(input: {
  bus: LilacBus;
  store: DurableWorkflowStore;
  subscriptionId: string;
  now?: () => number;
  claimStaleMs?: number;
  claimHeartbeatMs?: number;
}): Promise<{ stop(): Promise<void> }> {
  const logger = createLogger({ module: "workflow-action-resolver" });
  const ownerId = `workflow-action-outbox:${process.pid}:${crypto.randomUUID()}`;
  let draining = false;
  const drainOutbox = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      const now = input.now?.() ?? Date.now();
      const claimToken = crypto.randomUUID();
      const entries = input.store.claimPendingActionOutboxEvents({
        ownerId,
        claimToken,
        now,
        staleBefore: now - (input.claimStaleMs ?? 30_000),
      });
      const heartbeat = setInterval(() => {
        input.store.refreshActionOutboxPublishClaims({
          ownerId,
          claimToken,
          now: input.now?.() ?? Date.now(),
        });
      }, input.claimHeartbeatMs ?? 10_000);
      heartbeat.unref?.();
      try {
        for (const entry of entries) {
          try {
            if (entry.eventType === lilacEventTypes.EvtWorkflowApprovalChanged) {
              await input.bus.publish(
                lilacEventTypes.EvtWorkflowApprovalChanged,
                approvalChangedSchema.parse(entry.payload),
                { headers: { workflow_outbox_id: entry.outboxId } },
              );
            } else if (entry.eventType === lilacEventTypes.EvtWorkflowRunChanged) {
              await input.bus.publish(
                lilacEventTypes.EvtWorkflowRunChanged,
                runChangedSchema.parse(entry.payload),
                { headers: { workflow_outbox_id: entry.outboxId } },
              );
            } else if (entry.eventType === lilacEventTypes.EvtWorkflowProgressRequested) {
              await input.bus.publish(
                lilacEventTypes.EvtWorkflowProgressRequested,
                progressRequestedSchema.parse(entry.payload),
                { headers: { workflow_outbox_id: entry.outboxId } },
              );
            } else {
              throw new Error(`Unsupported workflow action outbox event: ${entry.eventType}`);
            }
            if (
              !input.store.markActionOutboxPublished({
                outboxId: entry.outboxId,
                ownerId,
                claimToken,
                now: input.now?.() ?? Date.now(),
              })
            ) {
              throw new Error("Workflow action outbox publication lost its fenced claim");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.store.recordActionOutboxFailure({
              outboxId: entry.outboxId,
              ownerId,
              claimToken,
              error: message,
              now: input.now?.() ?? Date.now(),
            });
            logger.warn("Workflow action outbox publication failed", {
              outboxId: entry.outboxId,
              error: message,
            });
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      draining = false;
    }
  };
  const subscription = await input.bus.subscribeTopic(
    "evt.adapter",
    {
      mode: "fanout",
      subscriptionId: input.subscriptionId,
      consumerId: `${input.subscriptionId}:${process.pid}`,
      offset: { type: "now" },
      batch: { maxWaitMs: 1_000 },
    },
    async (message, context) => {
      if (message.type !== lilacEventTypes.EvtAdapterActionInvoked) {
        await drainOutbox();
        await context.commit();
        return;
      }
      const event = surfaceActionEventSchema.safeParse(message.data);
      if (!event.success || event.data.platform !== event.data.messageRef.platform) {
        logger.warn("Rejected malformed authenticated surface action event", {
          eventId: message.id,
        });
        await context.commit();
        return;
      }

      const result = input.store.applySurfaceAction({
        tokenSha256: sha256(event.data.actionId),
        platform: event.data.platform,
        userId: event.data.userId,
        messageRef: event.data.messageRef,
        sourceMessageId: event.data.sourceMessageId,
        now: input.now?.() ?? Date.now(),
      });
      if (result.status !== "applied") {
        logger.info("Workflow surface action rejected", {
          status: result.status,
          platform: event.data.platform,
          messageId: event.data.messageRef.messageId,
        });
      }
      await drainOutbox();
      await context.commit();
    },
  );

  await drainOutbox();
  const timer = setInterval(() => void drainOutbox(), 1_000);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
      await subscription.stop();
    },
  };
}
