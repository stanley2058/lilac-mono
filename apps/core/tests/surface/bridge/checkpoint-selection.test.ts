import { describe, expect, it } from "bun:test";

import type { TranscriptSnapshot, TranscriptStore } from "../../../src/transcript/transcript-store";
import { selectNewestReachableCheckpoint } from "../../../src/surface/bridge/request-composition/checkpoint-selection";

type ChainItem = { messageId: string; authorId: string };

function checkpoint(requestId: string, text: string): TranscriptSnapshot {
  return {
    requestId,
    sessionId: "chan",
    requestClient: "discord",
    createdTs: 0,
    updatedTs: 0,
    messages: [{ role: "user", content: text }],
    contextMeta: { type: "compaction", formatVersion: 1 },
  };
}

function storeFor(snapshots: Record<string, TranscriptSnapshot | undefined>): TranscriptStore {
  return {
    saveRequestTranscript() {},
    linkSurfaceMessagesToRequest() {},
    getTranscriptBySurfaceMessage(input) {
      return snapshots[input.messageId] ?? null;
    },
    close() {},
  };
}

function select(chain: ChainItem[], snapshots: Record<string, TranscriptSnapshot | undefined>) {
  return selectNewestReachableCheckpoint({
    chainOldestToNewest: chain,
    botUserId: "bot",
    platform: "discord",
    channelId: "chan",
    transcriptStore: storeFor(snapshots),
    currentRequestId: "current",
    getAuthorId: (item) => item.authorId,
    getMessageId: (item) => item.messageId,
  });
}

describe("selectNewestReachableCheckpoint", () => {
  it("uses the newest checkpoint and appends only descendants", () => {
    const older = checkpoint("older", "OLDER_CHECKPOINT");
    const newer = checkpoint("newer", "NEWER_CHECKPOINT");
    const result = select(
      [
        { messageId: "u1", authorId: "user" },
        { messageId: "old", authorId: "bot" },
        { messageId: "u2", authorId: "user" },
        { messageId: "new", authorId: "bot" },
        { messageId: "u3", authorId: "user" },
      ],
      { old: older, new: newer },
    );

    expect(result.checkpoint?.requestId).toBe("newer");
    expect(result.checkpointMessages).toEqual(newer.messages);
    expect(result.descendants).toEqual([{ messageId: "u3", authorId: "user" }]);
    expect(result.discardedSurfaceCount).toBe(4);
  });

  it("treats every split output for one request as one inclusive frontier", () => {
    const split = checkpoint("split", "SPLIT_CHECKPOINT");
    const result = select(
      [
        { messageId: "chunk1", authorId: "bot" },
        { messageId: "chunk2", authorId: "bot" },
        { messageId: "after", authorId: "user" },
      ],
      { chunk1: split, chunk2: split },
    );

    expect(result.descendants).toEqual([{ messageId: "after", authorId: "user" }]);
    expect(result.discardedSurfaceCount).toBe(2);
  });

  it("keeps raw history when no reachable mapped checkpoint exists", () => {
    const chain = [
      { messageId: "assistant", authorId: "bot" },
      { messageId: "user", authorId: "user" },
    ];
    const ordinary: TranscriptSnapshot = {
      ...checkpoint("ordinary", "ordinary"),
      contextMeta: undefined,
    };

    const result = select(chain, { assistant: ordinary });
    expect(result.checkpoint).toBeNull();
    expect(result.descendants).toEqual(chain);
    expect(result.checkpointMessages).toEqual([]);
  });

  it("does not inherit a checkpoint on a fork whose selected chain ends before it", () => {
    const snap = checkpoint("checkpoint", "CHECKPOINT");
    const beforeFork = [
      { messageId: "ancestor", authorId: "user" },
      { messageId: "before-fork", authorId: "user" },
    ];
    const afterFork = [
      ...beforeFork,
      { messageId: "checkpoint", authorId: "bot" },
      { messageId: "after-fork", authorId: "user" },
    ];

    expect(select(beforeFork, { checkpoint: snap }).checkpoint).toBeNull();
    expect(select(afterFork, { checkpoint: snap }).checkpoint?.requestId).toBe("checkpoint");
  });
});
