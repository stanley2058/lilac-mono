import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";

import { DurableWorkflowStore } from "./durable-workflow-store";
import { matchWorkflowReplyWait, workflowReplyMatchKey } from "./workflow-waits";

export function shouldSuppressRouterForWorkflowReply(input: {
  store: DurableWorkflowStore;
  event: EvtAdapterMessageCreatedData;
  now?: number;
}): { suppress: boolean; reason?: string } {
  const consumed = input.store.getAdapterEventSuppression({
    platform: input.event.platform,
    channelId: input.event.channelId,
    messageId: input.event.messageId,
    now: input.now ?? Date.now(),
  });
  if (consumed) {
    return {
      suppress: true,
      reason: `workflow:${consumed.runId}:${consumed.operationId}:consumed`,
    };
  }
  const matchKey = workflowReplyMatchKey(input.event.platform, input.event.channelId);
  const wait = input.store
    .listActiveWaitsByMatchKey("reply", matchKey)
    .find((candidate) => matchWorkflowReplyWait(candidate, input.event) !== null);
  return wait
    ? { suppress: true, reason: `workflow:${wait.runId}:${wait.operationId}:pending` }
    : { suppress: false };
}
