import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  MAX_REPLAY_BATCH_BYTES,
  MAX_REPLAY_SLOTS,
  MAX_REPLAY_TEXT_LENGTH,
  hydrationSchema,
  liveUpdateSchema,
  replayCheckpointSchema,
  replayReplySchema,
  turnSlotSchema,
  type Hydration,
  type ReadyTurnSlot,
  type ReplayCheckpoint,
  type TurnSlot,
} from "../src/replay";

function checkpoint(revision = 1, generation = 0): ReplayCheckpoint {
  return {
    protocolVersion: 1,
    historyGeneration: generation,
    projectionRevision: revision,
    cursor: `c${generation}_${revision}`,
  };
}

function ready(position: number, text = `turn ${position}`): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `slot-${position}`,
    position,
    turnId: `turn-${position}`,
    messages: [{ id: `message-${position}`, role: "assistant", parts: [{ type: "text", text }] }],
  };
}

function deferred(position: number, endPosition = position + 1): TurnSlot {
  return { kind: "deferred", slotId: `slot-${position}`, position, endPosition };
}

function hydrate(slotId: string, slots: TurnSlot[], revision = 1, generation = 0): Hydration {
  return { slotId, slots, projectionRevision: revision, historyGeneration: generation };
}

describe("native replay contracts", () => {
  test("rejects unsupported versions, unsafe revisions and duplicated envelope metadata", () => {
    expect(replayCheckpointSchema.safeParse({ ...checkpoint(), protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(
      replayCheckpointSchema.safeParse({
        ...checkpoint(),
        projectionRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      replayReplySchema.safeParse({ kind: "unchanged", checkpoint: checkpoint(), messages: [] })
        .success,
    ).toBe(false);
    expect(turnSlotSchema.safeParse({ ...ready(0), historyGeneration: 0 }).success).toBe(false);
    expect(replayCheckpointSchema.safeParse({ ...checkpoint(), cursor: "界" }).success).toBe(false);
    expect(turnSlotSchema.safeParse({ ...ready(0), turnId: 'escape"' }).success).toBe(false);
    expect(turnSlotSchema.safeParse({ ...deferred(0), endPosition: 0 }).success).toBe(false);
    expect(hydrationSchema.safeParse(hydrate("slot-0", [])).success).toBe(false);
    expect(
      liveUpdateSchema.safeParse({
        checkpoint: checkpoint(),
        changes: [
          {
            kind: "append-text",
            turnId: "t",
            position: 0,
            messageId: "m",
            partIndex: -1,
            text: "x",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("bounds slot counts, individual text and total encoded payload", () => {
    expect(turnSlotSchema.safeParse(ready(0, "x".repeat(MAX_REPLAY_TEXT_LENGTH + 1))).success).toBe(
      false,
    );
    expect(
      replayReplySchema.safeParse({
        kind: "window",
        checkpoint: checkpoint(),
        slots: Array.from({ length: MAX_REPLAY_SLOTS + 1 }, (_, index) => deferred(index)),
      }).success,
    ).toBe(false);
    const slots = Array.from({ length: 4 }, (_, index) =>
      ready(index, "界".repeat(MAX_REPLAY_TEXT_LENGTH / 2)),
    );
    expect(new TextEncoder().encode(JSON.stringify(slots)).byteLength).toBeGreaterThan(
      MAX_REPLAY_BATCH_BYTES,
    );
    expect(
      replayReplySchema.safeParse({ kind: "window", checkpoint: checkpoint(), slots }).success,
    ).toBe(false);
    expect(hydrationSchema.safeParse(hydrate("slot-0", slots)).success).toBe(false);
  });

  test("display messages remain assignable to AI SDK UIMessage", () => {
    const messages: UIMessage[] = ready(0).messages;
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "turn 0" }]);
  });
});
