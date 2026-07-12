import type { ModelMessage } from "ai";
import { createLogger } from "@stanley2058/lilac-utils";

import type { TranscriptSnapshot, TranscriptStore } from "../../../transcript/transcript-store";

const logger = createLogger({ module: "request-composition:checkpoint" });

export type CheckpointSelection<T> = {
  checkpoint: TranscriptSnapshot | null;
  checkpointMessages: ModelMessage[];
  descendants: T[];
  discardedSurfaceCount: number;
  resolvedSnapshotsBySurfaceMessageId: ReadonlyMap<string, TranscriptSnapshot | null>;
};

export function selectNewestReachableCheckpoint<T>(input: {
  chainOldestToNewest: readonly T[];
  botUserId: string;
  platform: "discord";
  channelId: string;
  transcriptStore?: TranscriptStore;
  currentRequestId?: string;
  getAuthorId: (item: T) => string;
  getMessageId: (item: T) => string;
}): CheckpointSelection<T> {
  const original = [...input.chainOldestToNewest];
  const resolvedSnapshotsBySurfaceMessageId = new Map<string, TranscriptSnapshot | null>();
  if (!input.transcriptStore) {
    return emptySelection(original, resolvedSnapshotsBySurfaceMessageId);
  }

  const resolveAt = (index: number): TranscriptSnapshot | null => {
    const item = original[index];
    if (!item || input.getAuthorId(item) !== input.botUserId) return null;
    const messageId = input.getMessageId(item);
    if (resolvedSnapshotsBySurfaceMessageId.has(messageId)) {
      return resolvedSnapshotsBySurfaceMessageId.get(messageId) ?? null;
    }
    const snapshot = input.transcriptStore!.getTranscriptBySurfaceMessage({
      platform: input.platform,
      channelId: input.channelId,
      messageId,
    });
    resolvedSnapshotsBySurfaceMessageId.set(messageId, snapshot);
    return snapshot;
  };

  const seenRequestIds = new Set<string>();
  let checkpoint: TranscriptSnapshot | null = null;
  for (let index = original.length - 1; index >= 0; index--) {
    const snapshot = resolveAt(index);
    if (!snapshot || seenRequestIds.has(snapshot.requestId)) continue;
    seenRequestIds.add(snapshot.requestId);
    if (snapshot.contextMeta?.type !== "compaction") continue;
    checkpoint = snapshot;
    break;
  }

  if (!checkpoint) return emptySelection(original, resolvedSnapshotsBySurfaceMessageId);

  let frontierIndex = -1;
  for (let index = 0; index < original.length; index++) {
    if (resolveAt(index)?.requestId === checkpoint.requestId) frontierIndex = index;
  }
  if (frontierIndex < 0) return emptySelection(original, resolvedSnapshotsBySurfaceMessageId);

  const descendants = original.slice(frontierIndex + 1);
  logger.info("compaction checkpoint applied", {
    currentRequestId: input.currentRequestId,
    checkpointRequestId: checkpoint.requestId,
    checkpointMessageCount: checkpoint.messages.length,
    discardedSurfaceCount: frontierIndex + 1,
    descendantSurfaceCount: descendants.length,
    formatVersion: checkpoint.contextMeta?.formatVersion,
  });

  return {
    checkpoint,
    checkpointMessages: [...checkpoint.messages],
    descendants,
    discardedSurfaceCount: frontierIndex + 1,
    resolvedSnapshotsBySurfaceMessageId,
  };
}

function emptySelection<T>(
  chain: T[],
  resolvedSnapshotsBySurfaceMessageId: ReadonlyMap<string, TranscriptSnapshot | null>,
): CheckpointSelection<T> {
  return {
    checkpoint: null,
    checkpointMessages: [],
    descendants: chain,
    discardedSurfaceCount: 0,
    resolvedSnapshotsBySurfaceMessageId,
  };
}
