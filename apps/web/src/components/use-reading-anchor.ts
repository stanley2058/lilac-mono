import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { Range, VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { useEventCallback } from "../use-event-callback";
import type { ScrollMode } from "./use-timeline-scroll";

type TimelineVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;
type Key = VirtualItem["key"];

type ReadingAnchor = {
  key: Key;
  /** The row's offset in the list, kept current through compensated size changes. */
  start: number;
  /** The block at the reading line, and its offset inside the row. */
  block: HTMLElement | undefined;
  inset: number;
};

/** Rows this far past the screen stay mounted, so their heights settle before the reader arrives. */
const BUFFER_VIEWPORTS = 1.5;
const ATOMIC_BLOCKS = "pre, table, svg, iframe, img";

export function bufferedRange(
  range: Range,
  items: readonly { start: number; end: number }[],
  offset: number,
  size: number,
): Range {
  const reach = size * BUFFER_VIEWPORTS;
  let { startIndex, endIndex } = range;
  while (startIndex > 0 && (items[startIndex]?.start ?? 0) > offset - reach) startIndex--;
  while (endIndex < range.count - 1 && (items[endIndex]?.end ?? Infinity) < offset + size + reach)
    endIndex++;
  return { ...range, startIndex, endIndex };
}

/**
 * How far a row's size change should move the scroll position so the reader's content stays put.
 * `moved` is how far the reader's content moved inside this row, or undefined when it is in another row.
 */
export function resizeCorrection(input: {
  start: number;
  end: number;
  line: number;
  firstMeasure: boolean;
  /** The reader's content is in a later row; the line alone lags a fast scroll by a frame. */
  aboveAnchor: boolean;
  delta: number;
  moved: number | undefined;
}): number {
  if (input.aboveAnchor || input.end <= input.line) return input.delta;
  if (input.start >= input.line) return 0;
  // A row first measured across the line grew from an estimate, so what follows it is what was on screen.
  if (input.firstMeasure) return input.delta;
  const moved = input.moved ?? 0;
  if (Math.abs(moved) <= 0.5) return 0;
  return Math.abs(moved - input.delta) <= 1 ? input.delta : moved;
}

/** The header row's key, which tells a pending scroll correction which thread it belongs to. */
function headerKey(virtual: TimelineVirtualizer): Key | undefined {
  return virtual.options.count > 0 ? virtual.options.getItemKey(0) : undefined;
}

function readingBlock(row: HTMLElement, line: number): HTMLElement {
  let node = row;
  while (!node.matches(ATOMIC_BLOCKS)) {
    const child = [...node.children].find((element): element is HTMLElement => {
      const box = element.getBoundingClientRect();
      return element instanceof HTMLElement && box.height > 0 && box.bottom > line;
    });
    if (!child) return node;
    node = child;
  }
  return node;
}

function indexOfKey(virtual: TimelineVirtualizer, key: Key): number {
  for (let index = 0; index < virtual.options.count; index++)
    if (virtual.options.getItemKey(index) === key) return index;
  return -1;
}

/** How far the anchored block moved inside its row, updating the anchor to match. */
function movedInsideRow(virtual: TimelineVirtualizer, anchor: ReadingAnchor): number | undefined {
  const row = virtual.elementsCache.get(anchor.key);
  if (!row || !anchor.block?.isConnected) return undefined;
  const inset = anchor.block.getBoundingClientRect().top - row.getBoundingClientRect().top;
  const moved = inset - anchor.inset;
  anchor.inset = inset;
  return moved;
}

/** Part of a correction the scroll range couldn't take yet, because the list hasn't grown. */
export type ClampedShift = { amount: number; scrollTop: number; header: Key | undefined };

/** Shifts the scroll position and returns whatever the scroll range couldn't take. */
export function shiftScroll(
  virtual: Pick<TimelineVirtualizer, "scrollOffset">,
  viewport: Pick<HTMLDivElement, "scrollTop">,
  by: number,
  header: Key | undefined,
): ClampedShift | undefined {
  const before = viewport.scrollTop;
  viewport.scrollTop = before + by;
  // The scroll event arrives after this paint; the next render should already use the new offset.
  virtual.scrollOffset = viewport.scrollTop;
  const amount = by - (viewport.scrollTop - before);
  return Math.abs(amount) > 0.5 ? { amount, scrollTop: viewport.scrollTop, header } : undefined;
}

/** Applies a clamped remainder, unless the reader has since scrolled or changed threads. */
export function retryClampedShift(
  pending: ClampedShift,
  virtual: Pick<TimelineVirtualizer, "scrollOffset">,
  viewport: Pick<HTMLDivElement, "scrollTop">,
  header: Key | undefined,
): ClampedShift | undefined {
  if (pending.scrollTop !== viewport.scrollTop || pending.header !== header) return undefined;
  return shiftScroll(virtual, viewport, pending.amount, header);
}

/**
 * Keeps the content at the reading line in place while rows around it change height or fill in. The
 * virtualizer alone only anchors on the row at the scroll offset, which is the header at the top and
 * can be a placeholder that the update removes, and it skips corrections while scrolling up.
 */
export function useReadingAnchor({
  virtual,
  viewport,
  headerInset,
  isReady,
  mode,
  currentMode,
  ids,
}: {
  virtual: TimelineVirtualizer;
  viewport: HTMLDivElement | null;
  headerInset: number;
  isReady: (index: number) => boolean;
  /** The anchor applies only while reading; the timeline places the content otherwise. */
  mode: ScrollMode;
  currentMode: () => ScrollMode;
  ids: readonly string[];
}) {
  const anchor = useRef<ReadingAnchor>(undefined);
  const inset = useRef(headerInset);
  inset.current = headerInset;
  const ready = useRef(isReady);
  ready.current = isReady;
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const previous = useRef<readonly string[]>(undefined);
  const clamped = useRef<ClampedShift>(undefined);

  const capture = useEventCallback(() => {
    if (currentMode() !== "read") {
      anchor.current = undefined;
      return;
    }
    const offset = viewport?.scrollTop ?? virtual.scrollOffset ?? 0;
    const line = offset + inset.current;
    const item = virtual
      .getVirtualItems()
      .find(
        (row) => row.end > line && row.end > row.start && row.index > 0 && ready.current(row.index),
      );
    if (!item) return;
    const row = virtual.elementsCache.get(item.key);
    // A size change the observer hasn't reported yet still needs comparing with the current anchor.
    if (row && Math.abs(row.getBoundingClientRect().height - item.size) > 1) return;
    const lineY = (viewport?.getBoundingClientRect().top ?? 0) + inset.current;
    const block = row ? readingBlock(row, lineY) : undefined;
    anchor.current = {
      key: item.key,
      start: item.start,
      block,
      inset: row && block ? block.getBoundingClientRect().top - row.getBoundingClientRect().top : 0,
    };
  });

  useLayoutEffect(() => {
    virtual.shouldAdjustScrollPositionOnItemSizeChange = (changed, delta, instance) => {
      const current = currentMode();
      // Following keeps the bottom still; the timeline pins it again after the render.
      if (current === "follow") return true;
      if (current === "position") return false;
      // Rows measured in one batch arrive with offsets from before the batch's earlier corrections.
      instance.getTotalSize();
      const item = instance.measurementsCache[changed.index] ?? changed;
      const reading = anchor.current;
      const sameRow = reading?.key === item.key;
      const aboveAnchor = !!reading && !sameRow && item.start < reading.start;
      const correction = resizeCorrection({
        start: item.start,
        end: item.end,
        line: (viewport?.scrollTop ?? instance.scrollOffset ?? 0) + inset.current,
        firstMeasure: !instance.itemSizeCache.has(item.key),
        aboveAnchor,
        delta,
        moved: sameRow ? movedInsideRow(virtual, reading) : undefined,
      });
      if (aboveAnchor) reading.start += delta;
      if (correction === delta) return true;
      // The virtualizer can only apply the whole delta, and part of this change is below the reader.
      if (correction !== 0 && viewport)
        clamped.current = shiftScroll(
          virtual,
          viewport,
          correction + (clamped.current?.amount ?? 0),
          headerKey(virtual),
        );
      return false;
    };
    return () => {
      virtual.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [virtual, viewport, currentMode]);

  useEffect(() => {
    if (!viewport) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(capture);
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
    };
  }, [viewport, capture]);

  const restoreAfterRowsChange = useEventCallback(() => {
    const current = anchor.current;
    if (!current || currentMode() !== "read" || !viewport) return;
    const start = virtual.measurementsCache[indexOfKey(virtual, current.key)]?.start;
    if (start === undefined || Math.abs(start - current.start) <= 0.5) return;
    shiftScroll(virtual, viewport, start - current.start, headerKey(virtual));
    rerender();
  });

  useLayoutEffect(() => {
    if (!clamped.current || !viewport) return;
    if (currentMode() !== "read") {
      clamped.current = undefined;
      return;
    }
    clamped.current = retryClampedShift(clamped.current, virtual, viewport, headerKey(virtual));
  });

  const totalSize = virtual.getTotalSize();
  useLayoutEffect(() => {
    if (previous.current && previous.current !== ids) restoreAfterRowsChange();
    previous.current = ids;
    capture();
  }, [ids, totalSize, mode, virtual, restoreAfterRowsChange, capture]);
}
