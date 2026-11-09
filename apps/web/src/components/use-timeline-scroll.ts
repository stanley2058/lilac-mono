import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent, TouchEvent, WheelEvent } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import type { NativeThreadStore } from "@stanley2058/lilac-client";
import { useEventCallback } from "../use-event-callback";

type TimelineVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

/**
 * The turn at the reading line when the reader left, and how far into its row the line was. Turns are
 * saved by slot id because a sent turn's render key changes when the thread opens again.
 */
export type SavedPosition = { slotId: string; offset: number };

/**
 * `position` while a thread opens, `follow` while it stays at the bottom, and `read` once the reader
 * leaves the bottom.
 */
export type ScrollMode = "position" | "follow" | "read";

/** Distances up to this are subpixel rounding, not a position above the bottom. */
const END_SLACK = 1;
/** Opening settles in a few renders; the cap only stops a layout that never settles. */
const MAX_POSITION_PASSES = 20;
const LEAVE_END_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

// Memory only, so a reload opens every thread at the bottom. Keying by store forgets evicted threads.
const savedPositions = new WeakMap<NativeThreadStore, SavedPosition>();

export function distanceFromEnd(
  viewport: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">,
): number {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

/** What the timeline does after a scroll event. */
export function scrollOutcome(input: {
  mode: "follow" | "read";
  distance: number;
  scrollTop: number;
  /** Where the timeline last placed the bottom. */
  pinnedTop: number;
  /** The reader holds a pointer on the conversation, dragging its scrollbar or a text selection. */
  dragging: boolean;
}): "follow" | "pin" | "read" {
  if (input.distance <= END_SLACK) return "follow";
  if (input.mode === "read") return "read";
  // Editors and focus changes scroll too; only a pointer drag upward is the reader leaving here.
  return input.dragging && input.scrollTop < input.pinnedTop - END_SLACK ? "read" : "pin";
}

/** The saved position of the turn row at the reading line; the header and footer rows are not turns. */
export function readingPosition(
  ids: readonly string[],
  item: Pick<VirtualItem, "index" | "start"> | undefined,
  line: number,
): SavedPosition | undefined {
  const slotId = item ? ids[item.index - 1] : undefined;
  return item && slotId !== undefined ? { slotId, offset: line - item.start } : undefined;
}

/** The virtual row index of a saved turn, or -1 when the turn is no longer in the thread. */
export function savedRowIndex(ids: readonly string[], saved: SavedPosition): number {
  const index = ids.indexOf(saved.slotId);
  return index < 0 ? -1 : index + 1;
}

/** The scroll offset that puts a saved row back under the reading line. */
export function restoredOffset(saved: SavedPosition, rowStart: number, readingInset: number) {
  return rowStart + saved.offset - readingInset;
}

/**
 * Opens each thread at the bottom, or where the reader left it earlier in this page session, before
 * the first paint, then keeps the bottom in view until the reader scrolls away from it.
 */
export function useTimelineScroll({
  threadId,
  store,
  virtual,
  viewport,
  readingInset,
  ready,
  ids,
}: {
  threadId: string;
  store: NativeThreadStore;
  virtual: TimelineVirtualizer;
  viewport: HTMLDivElement | null;
  /** The reading line's distance below the top of the viewport. */
  readingInset: number;
  /** The thread's checkpoint and newest turn are loaded. */
  ready: boolean;
  /** The turn slot ids, one per virtual row after the header. */
  ids: readonly string[];
}) {
  const [positioned, setPositioned] = useState<string>();
  const positioning = positioned !== threadId;
  const [settledMode, setSettledMode] = useState<"follow" | "read">("follow");
  const modeRef = useRef<"follow" | "read">("follow");
  const pinnedTop = useRef(0);
  const dragging = useRef(false);
  const touchY = useRef<number>(undefined);
  const opening = useRef<{
    threadId: string;
    saved: SavedPosition | undefined;
    passes: number;
    state?: string;
  }>(undefined);
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const currentMode = useEventCallback(
    (): ScrollMode => (positioning ? "position" : modeRef.current),
  );
  const setMode = useEventCallback((next: "follow" | "read") => {
    modeRef.current = next;
    setSettledMode(next);
    if (next === "follow") savedPositions.delete(store);
  });
  const place = useEventCallback((element: HTMLDivElement, offset: number) => {
    element.scrollTop = offset;
    // The scroll event arrives after paint; the next render should already use the new offset.
    virtual.scrollOffset = element.scrollTop;
    pinnedTop.current = element.scrollTop;
  });
  const pin = useEventCallback(() => {
    if (!viewport || currentMode() !== "follow") return;
    if (distanceFromEnd(viewport) > 0) place(viewport, viewport.scrollHeight);
    else pinnedTop.current = viewport.scrollTop;
  });
  const follow = useEventCallback(() => {
    if (modeRef.current !== "follow") setMode("follow");
    pin();
  });
  const positionAgain = useEventCallback((state: string) => {
    if (!opening.current) return;
    opening.current.state = state;
    opening.current.passes++;
    rerender();
  });

  useLayoutEffect(() => {
    if (!positioning || !viewport) return;
    if (opening.current?.threadId !== threadId)
      opening.current = { threadId, saved: savedPositions.get(store), passes: 0 };
    if (!ready) {
      place(viewport, viewport.scrollHeight);
      return;
    }
    const { saved } = opening.current;
    const index = saved ? savedRowIndex(ids, saved) : -1;
    const row = index >= 0 ? virtual.measurementsCache[index] : undefined;
    place(
      viewport,
      saved && row ? restoredOffset(saved, row.start, readingInset) : viewport.scrollHeight,
    );
    // Rendering the rows at the new offset measures them, which can move the target again.
    const state = [
      viewport.scrollTop,
      viewport.scrollHeight,
      readingInset,
      ...virtual.getVirtualItems().map((item) => item.key),
    ].join();
    if (state !== opening.current.state && opening.current.passes < MAX_POSITION_PASSES) {
      positionAgain(state);
      return;
    }
    opening.current = undefined;
    setMode(row ? "read" : "follow");
    setPositioned(threadId);
  });

  useLayoutEffect(() => {
    pin();
  });

  useLayoutEffect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => pin());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport, pin]);

  useEffect(() => {
    const release = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  const leaveEnd = useEventCallback(() => {
    if (currentMode() !== "follow" || !viewport || viewport.scrollTop <= 0) return;
    setMode("read");
  });

  const onScroll = useEventCallback(() => {
    if (!viewport || currentMode() === "position") return;
    const outcome = scrollOutcome({
      mode: modeRef.current,
      distance: distanceFromEnd(viewport),
      scrollTop: viewport.scrollTop,
      pinnedTop: pinnedTop.current,
      dragging: dragging.current,
    });
    if (outcome !== "read") {
      follow();
      return;
    }
    if (modeRef.current !== "read") setMode("read");
    const line = viewport.scrollTop + readingInset;
    const position = readingPosition(ids, virtual.getVirtualItemForOffset(line), line);
    if (position) savedPositions.set(store, position);
  });

  // Wheel and key scrolling animate, so leaving before the first frame keeps a pin from cancelling it.
  const onWheel = useEventCallback((event: Pick<WheelEvent, "deltaY">) => {
    if (event.deltaY < 0) leaveEnd();
  });
  const onKeyDown = useEventCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(EDITABLE)) return;
    if (LEAVE_END_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) leaveEnd();
  });
  const onTouchStart = useEventCallback((event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches[0]?.clientY;
  });
  const onTouchMove = useEventCallback((event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY.current !== undefined && y > touchY.current) leaveEnd();
    touchY.current = y;
  });
  const onPointerDown = useEventCallback((event: PointerEvent<HTMLDivElement>) => {
    // A selection drag past the edge scrolls the conversation; one inside the composer scrolls the composer.
    if (event.target instanceof Element && !event.target.closest(EDITABLE)) dragging.current = true;
  });
  const onFocus = useEventCallback((event: FocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target.closest("[data-timeline-canvas]") && target.matches(":focus-visible")) leaveEnd();
  });

  const stopFollowing = useEventCallback(() => {
    if (currentMode() === "follow") setMode("read");
  });
  const followEnd = useEventCallback(() => {
    if (currentMode() !== "position") follow();
  });

  return {
    positioning,
    mode: positioning ? ("position" as const) : settledMode,
    currentMode,
    handlers: { onScroll, onWheel, onKeyDown, onTouchStart, onTouchMove, onPointerDown, onFocus },
    stopFollowing,
    followEnd,
  };
}
