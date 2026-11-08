import { describe, expect, test } from "bun:test";
import {
  bufferedRange,
  resizeCorrection,
  retryClampedShift,
  shiftScroll,
  virtualizerAnchors,
} from "../src/components/use-reading-anchor";

const rows = Array.from({ length: 20 }, (_, index) => ({
  start: index * 500,
  end: (index + 1) * 500,
}));

describe("bufferedRange", () => {
  test("widens the range by pixels on both sides", () => {
    const range = { startIndex: 10, endIndex: 11, overscan: 1, count: 20 };
    // At offset 5000 with an 800px viewport, the buffer reaches 3800 and 7000.
    expect(bufferedRange(range, rows, 5000, 800)).toEqual({
      ...range,
      startIndex: 7,
      endIndex: 13,
    });
  });

  test("stops at the ends of the list", () => {
    const range = { startIndex: 0, endIndex: 1, overscan: 1, count: 3 };
    expect(bufferedRange(range, rows.slice(0, 3), 0, 800)).toEqual({ ...range, endIndex: 2 });
  });
});

describe("resizeCorrection", () => {
  const resize = {
    line: 1000,
    firstMeasure: false,
    aboveAnchor: false,
    delta: 100,
    moved: undefined,
  };

  test("a row above the reading line moves the scroll position by its whole change", () => {
    expect(resizeCorrection({ ...resize, start: 200, end: 1000 })).toBe(100);
  });

  test("a row above the anchored row moves the scroll position even across the line", () => {
    expect(resizeCorrection({ ...resize, start: 800, end: 1400, aboveAnchor: true })).toBe(100);
  });

  test("a row below the reading line leaves the scroll position", () => {
    expect(resizeCorrection({ ...resize, start: 1000, end: 1400 })).toBe(0);
  });

  test("a row first measured across the line keeps what follows it in place", () => {
    expect(resizeCorrection({ ...resize, start: 800, end: 1040, firstMeasure: true })).toBe(100);
  });

  test("growth above the anchored block in the same row is compensated", () => {
    expect(resizeCorrection({ ...resize, start: 800, end: 1400, moved: 100 })).toBe(100);
  });

  test("growth below the anchored block, such as streaming text, leaves the scroll position", () => {
    expect(resizeCorrection({ ...resize, start: 800, end: 1400, moved: 0 })).toBe(0);
  });

  test("mixed growth above and below the anchored block corrects only the part above", () => {
    expect(resizeCorrection({ ...resize, delta: 200, start: 800, end: 1400, moved: 100 })).toBe(
      100,
    );
  });

  test("opposing changes around the anchored block still correct the part above", () => {
    expect(resizeCorrection({ ...resize, delta: -50, start: 800, end: 1400, moved: 100 })).toBe(
      100,
    );
  });

  test("a row across the line without an anchored block is left alone", () => {
    expect(resizeCorrection({ ...resize, start: 800, end: 1400 })).toBe(0);
  });
});

describe("virtualizerAnchors", () => {
  const edges = { count: 3, first: "header", last: "footer:a" };

  test("is true when the row count or an edge key changes", () => {
    expect(virtualizerAnchors(edges, { ...edges, count: 4 })).toBe(true);
    expect(virtualizerAnchors(edges, { ...edges, last: "footer:b" })).toBe(true);
    expect(virtualizerAnchors(edges, { ...edges, first: "other" })).toBe(true);
  });

  test("is false when a middle range is replaced by one row", () => {
    expect(virtualizerAnchors(edges, { ...edges })).toBe(false);
  });
});

describe("shiftScroll", () => {
  function scroller(start: number, max: number) {
    let top = start;
    return {
      get scrollTop() {
        return top;
      },
      set scrollTop(value: number) {
        top = Math.max(0, Math.min(max, value));
      },
    };
  }

  test("keeps nothing when the scroll range takes the whole shift", () => {
    const virtual = { scrollOffset: 1000 };
    expect(shiftScroll(virtual, scroller(1000, 2000), 100, "t")).toBeUndefined();
    expect(virtual.scrollOffset).toBe(1100);
  });

  test("keeps the part a list too short to scroll that far could not take", () => {
    const virtual = { scrollOffset: 1200 };
    expect(shiftScroll(virtual, scroller(1200, 1220), 100, "t")).toEqual({
      amount: 80,
      scrollTop: 1220,
      header: "t",
    });
    expect(virtual.scrollOffset).toBe(1220);
  });

  const pending = { amount: 88, scrollTop: 1012, header: "t" };

  test("a retry against a list that still hasn't grown keeps the remainder", () => {
    const viewport = scroller(1012, 1012);
    expect(retryClampedShift(pending, { scrollOffset: 1012 }, viewport, "t")).toEqual(pending);
  });

  test("a retry after the list grows applies the remainder", () => {
    const viewport = scroller(1012, 2000);
    expect(retryClampedShift(pending, { scrollOffset: 1012 }, viewport, "t")).toBeUndefined();
    expect(viewport.scrollTop).toBe(1100);
  });

  test("a retry after the reader scrolled drops the remainder", () => {
    const viewport = scroller(700, 2000);
    expect(retryClampedShift(pending, { scrollOffset: 700 }, viewport, "t")).toBeUndefined();
    expect(viewport.scrollTop).toBe(700);
  });

  test("a retry in another thread drops the remainder", () => {
    const viewport = scroller(1012, 2000);
    expect(retryClampedShift(pending, { scrollOffset: 1012 }, viewport, "u")).toBeUndefined();
    expect(viewport.scrollTop).toBe(1012);
  });
});
