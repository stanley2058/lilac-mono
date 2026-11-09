import { describe, expect, test } from "bun:test";
import {
  distanceFromEnd,
  readingPosition,
  restoredOffset,
  savedRowIndex,
  scrollOutcome,
} from "../src/components/use-timeline-scroll";

describe("scrollOutcome", () => {
  const following = { mode: "follow", pinnedTop: 900, dragging: false } as const;

  test("reaching the bottom follows it again", () => {
    expect(scrollOutcome({ ...following, mode: "read", distance: 0.5, scrollTop: 899.5 })).toBe(
      "follow",
    );
  });

  test("a scroll nobody dragged, such as an editor revealing its caret, returns to the bottom", () => {
    expect(scrollOutcome({ ...following, distance: 48, scrollTop: 852 })).toBe("pin");
  });

  test("a pointer drag upward, on the scrollbar or a text selection, leaves the bottom", () => {
    expect(scrollOutcome({ ...following, dragging: true, distance: 120, scrollTop: 780 })).toBe(
      "read",
    );
  });

  test("content that grew before the next pin is not a drag upward", () => {
    expect(scrollOutcome({ ...following, dragging: true, distance: 120, scrollTop: 900 })).toBe(
      "pin",
    );
  });

  test("reading stays reading above the bottom", () => {
    expect(scrollOutcome({ ...following, mode: "read", distance: 300, scrollTop: 600 })).toBe(
      "read",
    );
  });
});

describe("saved reading positions", () => {
  test("a sent turn restores by slot id after its render key changes", () => {
    // Before the switch, the confirmed turn renders under its optimistic key; after, under its slot id.
    const saved = readingPosition(["first", "server"], { index: 2, start: 1000 }, 1040);
    expect(saved).toEqual({ slotId: "server", offset: 40 });
    expect(savedRowIndex(["first", "server"], saved!)).toBe(2);
  });

  test("the header and footer rows are not saved", () => {
    expect(readingPosition(["turn"], { index: 0, start: 0 }, 10)).toBeUndefined();
    expect(readingPosition(["turn"], { index: 2, start: 500 }, 510)).toBeUndefined();
  });

  test("a turn that left the thread has no row", () => {
    expect(savedRowIndex(["other"], { slotId: "gone", offset: 0 })).toBe(-1);
  });

  test("restoredOffset puts the saved point of the row back under the reading line", () => {
    expect(restoredOffset({ slotId: "turn", offset: 40 }, 1000, 64)).toBe(976);
  });
});

test("distanceFromEnd measures the browser's scroll range", () => {
  expect(distanceFromEnd({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1300 })).toBe(100);
});
