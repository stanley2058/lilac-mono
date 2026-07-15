import { z } from "zod";
import {
  lilacEventTypes,
  type LilacBus,
  type WorkflowRunEventState,
} from "@stanley2058/lilac-event-bus";
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

function previousRunState(
  kind: "approve" | "reject" | "pause" | "resume" | "cancel",
): WorkflowRunEventState | undefined {
  if (kind === "approve" || kind === "reject") return "awaiting_review";
  if (kind === "resume") return "paused";
  return undefined;
}

export async function startWorkflowActionResolver(input: {
  bus: LilacBus;
  store: DurableWorkflowStore;
  subscriptionId: string;
  now?: () => number;
}): Promise<{ stop(): Promise<void> }> {
  const logger = createLogger({ module: "workflow-action-resolver" });
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
        await context.commit();
        return;
      }

      const now = input.now?.() ?? Date.now();
      if (result.approvalId) {
        const approval = input.store.getApproval(result.approvalId);
        if (approval) {
          await input.bus.publish(lilacEventTypes.EvtWorkflowApprovalChanged, {
            approvalId: approval.approvalId,
            revisionId: approval.revisionId,
            runId: result.action.runId,
            state: approval.state,
            previousState: "pending",
            ts: now,
          });
        }
      }
      for (const runId of result.runIds) {
        const run = input.store.getRun(runId);
        if (!run) continue;
        await input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
          runId,
          revisionId: run.revisionId,
          state: run.state,
          previousState: previousRunState(result.action.kind),
          ts: now,
        });
        await input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
          runId,
          revisionId: run.revisionId,
          reason: "state_changed",
          ts: now,
        });
      }
      await context.commit();
    },
  );

  return { stop: () => subscription.stop() };
}
