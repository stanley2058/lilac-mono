import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { NativeThreadStore } from "../../../../../packages/client/src/thread-store";
import {
  OUTLINE_PAGE_TURNS,
  hydrationSchema,
  outlinePreviewsSchema,
  threadOutlineSchema,
} from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";

const GAP_MS = 2 * 60 * 60_000;

function setup() {
  let now = 1_000_000_000_000;
  const store = new NativeStore(new Database(":memory:"), () => now);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "local",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const turn = (threadId: string, index: number, text: string, at: number) => {
    now = at;
    const receipt = store
      .acceptInput("owner", {
        threadId,
        commandId: `turn_${threadId}_${index}`,
        historyGeneration: 0,
        text,
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    const input = store.getInput(receipt.inputId).unwrap();
    store.settleInput(input.id, "admitted").unwrap();
    store
      .appendMessage(threadId, 0, input.turnId!, {
        id: `answer_${index}`,
        role: "assistant",
        metadata: { createdAt: at + 2_000, phase: "final" },
        parts: [{ type: "text", text: `Answer ${index}` }],
      })
      .unwrap();
    store
      .projectTurn(threadId, 0, `complete_${index}`, input.turnId!, (slot) =>
        Result.ok({
          slot: { ...slot, state: "complete", startedAt: at, settledAt: at + 3_000 },
          changes: [],
        }),
      )
      .unwrap();
    store.markInputCompleted(input.id).unwrap();
    return input.turnId!;
  };
  return { store, turn, setNow: (at: number) => (now = at) };
}

describe("thread outline", () => {
  test("pages stay bounded and name the cursor for earlier turns", () => {
    const { store, turn } = setup();
    const thread = store.createThread("owner", { commandId: "long" }).unwrap();
    const total = OUTLINE_PAGE_TURNS + 20;
    for (let index = 0; index < total; index++)
      turn(thread.id, index, `Question ${index}`, 1_000_000_000_000 + index * 60_000);
    const latest = store.outline("owner", thread.id, { dmContextGapMs: GAP_MS }).unwrap();
    expect(threadOutlineSchema.safeParse(latest).success).toBe(true);
    expect(latest.positions).toHaveLength(OUTLINE_PAGE_TURNS);
    expect(latest.positions[0]).toBe(20);
    expect(latest.positions.at(-1)).toBe(total - 1);
    expect(latest.windows).toBeUndefined();
    expect(latest.earlierBefore).toBe(20);
    const earlier = store
      .outline("owner", thread.id, { dmContextGapMs: GAP_MS, beforePosition: 20 })
      .unwrap();
    expect(earlier.positions).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(earlier.earlierBefore).toBeUndefined();
  });

  test("a DM outline groups turns into context windows with the agent's gap rule", () => {
    const { store, turn, setNow } = setup();
    const dm = store.ensureDirectThread("owner").unwrap();
    const start = 1_000_000_000_000;
    turn(dm.id, 0, "Morning", start);
    turn(dm.id, 1, "Follow up", start + 10 * 60_000);
    turn(dm.id, 2, "Evening", start + 10 * 60_000 + GAP_MS + 60_000);
    const outline = store.outline("owner", dm.id, { dmContextGapMs: GAP_MS }).unwrap();
    expect(outline.windows?.map((window) => [window.firstPosition, window.endPosition])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    setNow(start + 10 * 60_000 + GAP_MS + 120_000);
    const session = store
      .selectSessionWindow(dm.id, { gapMs: GAP_MS, at: start + 10 * 60_000 + GAP_MS + 120_000 })
      .unwrap();
    expect(session.firstPosition).toBe(outline.windows?.at(-1)?.firstPosition ?? null);
  });

  test("previews return the asking line and final answer for the requested turns", () => {
    const { store, turn } = setup();
    const thread = store.createThread("owner", { commandId: "previews" }).unwrap();
    for (let index = 0; index < 3; index++)
      turn(thread.id, index, `Look at [the doc](https://example.com/${index})\n\nplease`, index);
    const previews = store
      .outlinePreviews("owner", { threadId: thread.id, historyGeneration: 0, positions: [2, 0] })
      .unwrap();
    expect(outlinePreviewsSchema.shape.previews.safeParse(previews).success).toBe(true);
    expect(previews).toEqual([
      { position: 0, user: "Look at the doc please", reply: "Answer 0" },
      { position: 2, user: "Look at the doc please", reply: "Answer 2" },
    ]);
    expect(
      store
        .outlinePreviews("owner", { threadId: thread.id, historyGeneration: 1, positions: [0] })
        .isErr(),
    ).toBe(true);
  });

  test("positioned hydration loads around a target and leaves both sides deferred", () => {
    const { store, turn } = setup();
    const thread = store.createThread("owner", { commandId: "jump" }).unwrap();
    for (let index = 0; index < 40; index++) turn(thread.id, index, `Question ${index}`, index);
    const reply = store.sync("owner", thread.id).unwrap();
    const client = new NativeThreadStore();
    expect(client.replay(reply)).toBe("applied");
    const range = client.at(0);
    if (range?.kind !== "deferred") throw new Error("Expected older history to be deferred");
    const base = {
      threadId: thread.id,
      historyGeneration: reply.checkpoint.historyGeneration,
      projectionRevision: reply.checkpoint.projectionRevision,
    };
    const jump = store
      .hydrate("owner", { ...base, slotId: range.slotId, aroundPosition: 12 })
      .unwrap();
    expect(hydrationSchema.safeParse(jump).success).toBe(true);
    expect(client.hydrate(jump)).toBe("applied");
    const shape = () =>
      client.slotIds.map((id) => {
        const slot = client.get(id)!;
        return slot.kind === "ready" ? slot.position : `${slot.position}-${slot.endPosition}`;
      });
    expect(shape()).toEqual(["0-11", 11, 12, 13, 14, 15, "16-35", 35, 36, 37, 38, 39]);
    const below = client.get(client.slotIds[6]!);
    if (below?.kind !== "deferred") throw new Error("Expected the gap below the target");
    // Reading down into the gap fills it from its top.
    const down = store
      .hydrate("owner", { ...base, slotId: below.slotId, aroundPosition: below.position })
      .unwrap();
    expect(client.hydrate(down)).toBe("applied");
    expect(shape().slice(5, 12)).toEqual([15, 16, 17, 18, 19, 20, "21-35"]);
    // Reading up into the oldest range keeps filling from its newest end.
    const above = client.get(client.slotIds[0]!);
    if (above?.kind !== "deferred") throw new Error("Expected the range above the target");
    expect(client.hydrate(store.hydrate("owner", { ...base, slotId: above.slotId }).unwrap())).toBe(
      "applied",
    );
    expect(shape().slice(0, 7)).toEqual(["0-6", 6, 7, 8, 9, 10, 11]);
    expect(
      store.hydrate("owner", { ...base, slotId: above.slotId, aroundPosition: 40 }).isErr(),
    ).toBe(true);
  });

  test("a jump keeps its target when the lead-in turn fills the byte budget", () => {
    const { store, turn } = setup();
    const thread = store.createThread("owner", { commandId: "large" }).unwrap();
    for (let index = 0; index < 12; index++) {
      const turnId = turn(thread.id, index, `Question ${index}`, index);
      store
        .appendMessage(thread.id, 0, turnId, {
          id: `large_${index}`,
          role: "assistant",
          parts: Array.from({ length: 3 }, () => ({
            type: "text" as const,
            text: "x".repeat(50_000),
          })),
        })
        .unwrap();
    }
    const reply = store.sync("owner", thread.id).unwrap();
    const range = reply.kind === "window" ? reply.slots[0] : undefined;
    if (range?.kind !== "deferred") throw new Error("Expected older history to be deferred");
    const jump = store
      .hydrate("owner", {
        threadId: thread.id,
        historyGeneration: reply.checkpoint.historyGeneration,
        projectionRevision: reply.checkpoint.projectionRevision,
        slotId: range.slotId,
        aroundPosition: 4,
      })
      .unwrap();
    expect(
      jump.slots.map((slot) =>
        slot.kind === "ready" ? slot.position : `${slot.position}-${slot.endPosition}`,
      ),
    ).toEqual(["0-4", 4, `5-${range.endPosition}`]);
  });
});
