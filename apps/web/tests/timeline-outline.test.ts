import { describe, expect, test } from "bun:test";
import type { ThreadOutline, TurnSlot } from "@stanley2058/lilac-client-protocol";
import {
  mergeOutlinePages,
  railCurrentIndex,
  railLayout,
  railIndexAt,
  railVisibleCount,
  railWindowStart,
  railItemInView,
  railAnchor,
  railAnchorIndex,
  railItems,
  railPreviewChunks,
  slotIndexForPosition,
  visiblePositions,
} from "../src/timeline-outline";

const window = (firstPosition: number, endPosition: number, continues?: true) => ({
  firstPosition,
  endPosition,
  startAt: firstPosition * 1000,
  endAt: endPosition * 1000,
  ...(continues ? { continues } : {}),
});

describe("timeline outline", () => {
  test("joins a context window split across outline pages", () => {
    const newest: ThreadOutline = {
      historyGeneration: 0,
      positions: [10, 11, 12, 14],
      windows: [window(10, 13, true), window(13, 15)],
      earlierBefore: 10,
    };
    const older: ThreadOutline = {
      historyGeneration: 0,
      positions: [7, 8, 9],
      windows: [window(5, 7), window(7, 10)],
    };
    const merged = mergeOutlinePages([newest, older]);
    expect(merged.positions).toEqual([7, 8, 9, 10, 11, 12, 14]);
    expect(merged.windows).toEqual([window(5, 7), window(7, 13), window(13, 15)]);
    const items = railItems(merged);
    // The window at 5 has no outlined turns to land on, and position 13 is a folded workflow card.
    expect(items.map((item) => [item.key, item.position])).toEqual([
      ["w7", 7],
      ["w13", 14],
    ]);
    expect(railPreviewChunks(items, 0)).toEqual([{ key: "w7", positions: [7, 8, 9, 10, 11] }]);
  });

  test("keeps a hovered DM window when an older page renames it", () => {
    const newest: ThreadOutline = {
      historyGeneration: 0,
      positions: [10, 11, 12, 14],
      windows: [window(10, 13, true), window(13, 15)],
      earlierBefore: 10,
    };
    const before = railItems(mergeOutlinePages([newest]));
    const anchor = railAnchor(before[0]);
    const after = railItems(
      mergeOutlinePages([
        newest,
        { historyGeneration: 0, positions: [7, 8, 9], windows: [window(7, 10)] },
      ]),
    );
    const indexOf = new Map(after.map((item, index) => [item.key, index]));
    expect([before[0]?.key, after[0]?.key]).toEqual(["w10", "w7"]);
    expect(railAnchorIndex(after, indexOf, anchor)).toBe(0);
  });

  test("tracks the turn at the top of the view", () => {
    const items = railItems({ positions: [0, 1, 2, 5, 9] });
    expect(railCurrentIndex(items, 0)).toBe(0);
    expect(railCurrentIndex(items, 4)).toBe(2);
    expect(railCurrentIndex(items, 30)).toBe(4);
    expect(railItemInView(items[3]!, 4, 6)).toBe(true);
    expect(railItemInView(items[4]!, 4, 6)).toBe(false);
    expect(railPreviewChunks(items, 4)).toEqual([{ key: "b0", positions: [0, 1, 2, 5, 9] }]);
  });

  test("finds the slot holding a position across deferred ranges", () => {
    const slots: TurnSlot[] = [
      { kind: "deferred", slotId: "a", position: 0, endPosition: 11 },
      {
        kind: "ready",
        slotId: "b",
        turnId: "b",
        position: 11,
        messages: [],
      },
      { kind: "deferred", slotId: "c", position: 12, endPosition: 30 },
    ];
    const at = (index: number) => slots[index];
    expect(slotIndexForPosition(slots.length, at, 4)).toBe(0);
    expect(slotIndexForPosition(slots.length, at, 11)).toBe(1);
    expect(slotIndexForPosition(slots.length, at, 29)).toBe(2);
    expect(slotIndexForPosition(slots.length, at, 30)).toBe(-1);
    expect(
      visiblePositions(
        slots.map((slot, index) => ({ start: index * 100, end: index * 100 + 100, slot })),
        150,
        260,
      ),
    ).toEqual({ first: 11, last: 29 });
  });

  test("keeps the rail and its hover strip beside the content", () => {
    expect(railLayout(1600, 800, 24)).toEqual({ left: 12, persistent: true, hitStripWidth: 40 });
    // Resting ticks fit in a desktop row's padding even when the column fills the pane.
    expect(railLayout(800, 800, 24)).toEqual({ left: 12, persistent: true, hitStripWidth: 12 });
    // Compact rows pull the ticks toward the edge so they stay visible.
    expect(railLayout(800, 800, 16)).toEqual({ left: 4, persistent: true, hitStripWidth: 12 });
    expect(railLayout(800, 800, 8)).toEqual({ left: 4, persistent: false, hitStripWidth: 4 });
  });

  test("batches previews and prefetches across a batch edge", () => {
    const items = railItems({ positions: Array.from({ length: 40 }, (_, index) => index) });
    expect(railPreviewChunks(items, 20).map((chunk) => chunk.key)).toEqual(["b16", "b0"]);
    expect(railPreviewChunks(items, 24).map((chunk) => chunk.key)).toEqual(["b16"]);
    expect(railPreviewChunks(items, 30).map((chunk) => chunk.positions)).toEqual([
      [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
      [32, 33, 34, 35, 36, 37, 38, 39],
    ]);
  });

  test("scrolls a fixed-spacing tick window only near its edges", () => {
    expect(railVisibleCount(600)).toBe(64);
    expect(railVisibleCount(80)).toBe(2);
    // A fresh rail shows the newest ticks.
    expect(railWindowStart(undefined, null, 300, 64)).toBe(236);
    // Reading inside the window keeps it still.
    expect(railWindowStart(236, 260, 300, 64)).toBe(236);
    // Approaching the top edge scrolls it by the overshoot only.
    expect(railWindowStart(236, 238, 300, 64)).toBe(234);
    expect(railWindowStart(236, 10, 300, 64)).toBe(6);
    expect(railWindowStart(undefined, 3, 40, 64)).toBe(0);
    expect(railIndexAt(-20, 100, 64)).toBe(100);
    expect(railIndexAt(19, 100, 64)).toBe(102);
    expect(railIndexAt(9_999, 100, 64)).toBe(163);
  });
});
