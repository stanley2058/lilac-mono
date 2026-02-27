import type { MsgRef } from "../../types";

import type { SessionMode } from "./common";
import { stripLeadingModelOverrideDirective } from "./common";

export type PendingMentionReplyBatchItem = {
  msgRef: MsgRef;
  requestModelOverride?: string;
  botMentionNames: readonly string[];
};

export type PendingMentionReplyBatch = {
  sourceRequestId: string;
  sessionConfigId: string;
  sessionMode: SessionMode;
  modelOverride?: string;
  items: PendingMentionReplyBatchItem[];
};

export function enqueuePendingMentionReplyBatch(params: {
  pendingMentionReplyBatchBySession: Map<string, PendingMentionReplyBatch>;
  input: {
    sessionId: string;
    sourceRequestId: string;
    sessionConfigId: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    item: PendingMentionReplyBatchItem;
  };
}) {
  const existing = params.pendingMentionReplyBatchBySession.get(params.input.sessionId);

  if (!existing || existing.sourceRequestId !== params.input.sourceRequestId) {
    params.pendingMentionReplyBatchBySession.set(params.input.sessionId, {
      sourceRequestId: params.input.sourceRequestId,
      sessionConfigId: params.input.sessionConfigId,
      sessionMode: params.input.sessionMode,
      modelOverride: params.input.modelOverride,
      items: [
        {
          msgRef: params.input.item.msgRef,
          requestModelOverride: params.input.item.requestModelOverride,
          botMentionNames: [...params.input.item.botMentionNames],
        },
      ],
    });
    return;
  }

  const alreadyTracked = existing.items.some(
    (item) => item.msgRef.messageId === params.input.item.msgRef.messageId,
  );
  if (!alreadyTracked) {
    existing.items.push({
      msgRef: params.input.item.msgRef,
      requestModelOverride: params.input.item.requestModelOverride,
      botMentionNames: [...params.input.item.botMentionNames],
    });
  }

  if (params.input.modelOverride) {
    existing.modelOverride = params.input.modelOverride;
  }
  existing.sessionConfigId = params.input.sessionConfigId;
  existing.sessionMode = params.input.sessionMode;
}

export function takePendingMentionReplyBatch(params: {
  pendingMentionReplyBatchBySession: Map<string, PendingMentionReplyBatch>;
  input: {
    sessionId: string;
    sourceRequestId: string;
  };
}): PendingMentionReplyBatch | null {
  const batch = params.pendingMentionReplyBatchBySession.get(params.input.sessionId);
  if (!batch) return null;
  if (batch.sourceRequestId !== params.input.sourceRequestId) return null;

  params.pendingMentionReplyBatchBySession.delete(params.input.sessionId);
  return batch;
}

export function transformPendingUserText(
  item: PendingMentionReplyBatchItem,
): ((text: string) => string) | undefined {
  if (!item.requestModelOverride) return undefined;
  return (text: string) =>
    stripLeadingModelOverrideDirective({
      text,
      botNames: item.botMentionNames,
    });
}
