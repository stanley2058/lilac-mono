import {
  OUTLINE_PREVIEW_BATCH,
  type ContextWindowOutline,
  type ThreadOutline,
  type TurnPreview,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";

/** Loads outline pages and previews; Chat reads them over RPC and demos compute them locally. */
export type OutlineSource = {
  /** Fetching waits for a connection; a loaded outline stays usable while offline. */
  online: boolean;
  page: (beforePosition: number | undefined, signal: AbortSignal) => Promise<ThreadOutline>;
  previews: (
    input: { historyGeneration: number; positions: number[] },
    signal?: AbortSignal,
  ) => Promise<{ historyGeneration: number; previews: TurnPreview[] }>;
};

export type RailTurn = { kind: "turn"; key: string; position: number };
export type RailWindow = {
  kind: "window";
  key: string;
  /** The first turn a reader can land on in this window. */
  position: number;
  positions: readonly number[];
  window: ContextWindowOutline;
};
export type RailItem = RailTurn | RailWindow;

export const RAIL_ITEM_SPACING = 8;
export const RAIL_MIN_ITEMS = 2;
const RAIL_MAX_ITEMS = 9;
/** Height kept free above and below the ticks for the step buttons. */
const RAIL_VERTICAL_RESERVE = 96;
const RAIL_STRIP_LEFT = 12;
/** Resting ticks are a third of their 24px hover width. */
const RAIL_STRIP_REST_WIDTH = 8;
const RAIL_HIT_STRIP_MAX_WIDTH = 40;
/** A hovered turn this close to a preview batch edge also prefetches the next batch. */
export const RAIL_PREVIEW_RADIUS = 5;
export const RAIL_WINDOW_TURNS = 5;

/** Pages arrive newest first; windows split by a page edge join back together. */
export function mergeOutlinePages(pages: readonly ThreadOutline[]): {
  positions: number[];
  windows?: ContextWindowOutline[];
} {
  const ordered = pages.toReversed();
  const positions = ordered.flatMap((page) => page.positions);
  if (!ordered.some((page) => page.windows)) return { positions };
  const windows: ContextWindowOutline[] = [];
  for (const page of ordered) {
    for (const window of page.windows ?? []) {
      const previous = windows.at(-1);
      if (!window.continues || previous?.endPosition !== window.firstPosition) {
        windows.push(window);
        continue;
      }
      windows[windows.length - 1] = {
        ...previous,
        endPosition: window.endPosition,
        endAt: Math.max(previous.endAt, window.endAt),
      };
    }
  }
  return { positions, windows };
}

/**
 * Replaces the newest loaded page with a fresh read of it. New turns move the fresh page's start
 * forward, so the turns it no longer covers stay from the old page and older pages stay as loaded.
 */
export function spliceNewestOutlinePage(
  pages: readonly ThreadOutline[],
  fresh: ThreadOutline,
): ThreadOutline[] {
  const [old, ...older] = pages;
  const boundary = fresh.earlierBefore;
  if (!old || boundary === undefined) return [fresh];
  if (boundary <= (old.earlierBefore ?? 0)) return [fresh, ...older];
  const kept: ThreadOutline = {
    ...old,
    positions: old.positions.filter((position) => position < boundary),
    ...(old.windows
      ? {
          windows: old.windows
            .filter((window) => window.firstPosition < boundary)
            .map((window) =>
              window.endPosition > boundary ? { ...window, endPosition: boundary } : window,
            ),
        }
      : {}),
  };
  const merged = mergeOutlinePages([fresh, kept]);
  const newest: ThreadOutline = {
    historyGeneration: fresh.historyGeneration,
    positions: merged.positions,
    ...(merged.windows ? { windows: merged.windows } : {}),
    ...(old.earlierBefore === undefined ? {} : { earlierBefore: old.earlierBefore }),
  };
  return [newest, ...older];
}

export function railItems(outline: {
  positions: readonly number[];
  windows?: readonly ContextWindowOutline[];
}): RailItem[] {
  if (!outline.windows)
    return outline.positions.map((position) => ({ kind: "turn", key: `t${position}`, position }));
  // Both lists ascend, so one pass assigns each position to its window.
  const items: RailWindow[] = [];
  let at = 0;
  for (const window of outline.windows) {
    while (at < outline.positions.length && outline.positions[at]! < window.firstPosition) at++;
    const positions: number[] = [];
    while (at < outline.positions.length && outline.positions[at]! < window.endPosition)
      positions.push(outline.positions[at++]!);
    // Windows holding only folded workflow cards have nothing to land on.
    if (positions.length > 0) items.push(railWindow(window, positions));
  }
  return items;
}

function railWindow(window: ContextWindowOutline, positions: readonly number[]): RailWindow {
  return {
    kind: "window",
    key: `w${window.firstPosition}`,
    position: positions[0] ?? window.firstPosition,
    positions,
    window,
  };
}

/** Ticks shown at a fixed spacing, up to a cap; longer outlines scroll through this many. */
export function railVisibleCount(railHeight: number): number {
  const fit = Math.floor((railHeight - RAIL_VERTICAL_RESERVE) / RAIL_ITEM_SPACING) + 1;
  return Math.max(RAIL_MIN_ITEMS, Math.min(RAIL_MAX_ITEMS, fit));
}

/** The window start after paging one window minus two overlapping ticks toward older or newer items. */
export function railPageStart(start: number, direction: -1 | 1, count: number, visible: number) {
  const step = Math.max(1, visible - 2);
  const target = Math.round(start) + direction * step;
  return Math.max(0, Math.min(target, count - Math.min(count, visible)));
}

/**
 * The reading position in item units: the index of the item at the viewport's middle plus how far
 * the middle has read through it. Gaps between outline items count toward the next item.
 */
export function railFocusIndex(items: readonly RailItem[], focus: number): number {
  const index = railCurrentIndex(items, Math.floor(focus));
  if (index === null) return 0;
  const item = items[index]!;
  const start = item.kind === "turn" ? item.position : item.window.firstPosition;
  const span = Math.max(1, railItemEnd(item) - start);
  return index + Math.max(0, Math.min(1, (focus - start) / span));
}

/**
 * The first shown tick as a fractional index, so the ticks slide with the conversation. The item at the
 * reading position stays in the middle of the window until the window reaches either end.
 */
export function railTrackStart(focusIndex: number, count: number, visible: number): number {
  const start = focusIndex - 0.5 - (Math.min(count, visible) - 1) / 2;
  return Math.max(0, Math.min(start, count - Math.min(count, visible)));
}

/** The item under a pointer `offset` pixels below the window top, for a fractional window `start`. */
export function railIndexAt(offset: number, start: number, shown: number): number {
  const first = Math.ceil(start - 0.5);
  const index = Math.round(offset / RAIL_ITEM_SPACING + start);
  return Math.max(first, Math.min(first + shown - 1, index));
}

export function railItemEnd(item: RailItem): number {
  return item.kind === "turn" ? item.position + 1 : item.window.endPosition;
}

/** The item at the top of the reader's view, or the latest one above it. */
export function railCurrentIndex(items: readonly RailItem[], firstVisible: number): number | null {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = items[middle]!;
    const start = item.kind === "turn" ? item.position : item.window.firstPosition;
    if (start <= firstVisible) low = middle + 1;
    else high = middle;
  }
  if (low > 0) return low - 1;
  return items.length > 0 ? 0 : null;
}

/**
 * Remembers an item across outline pages: by key, and by its last turn for when a merge with an older
 * page renames a DM window.
 */
export type RailAnchor = { key: string; position: number };

export function railAnchor(item: RailItem | undefined): RailAnchor | undefined {
  return item && { key: item.key, position: railItemEnd(item) - 1 };
}

export function railAnchorIndex(
  items: readonly RailItem[],
  indexOf: ReadonlyMap<string, number>,
  anchor: RailAnchor | undefined,
): number | undefined {
  if (!anchor) return undefined;
  return indexOf.get(anchor.key) ?? railCurrentIndex(items, anchor.position) ?? undefined;
}

export function railItemInView(item: RailItem, first: number, last: number): boolean {
  const start = item.kind === "turn" ? item.position : item.window.firstPosition;
  return start <= last && railItemEnd(item) > first;
}

/** Space left of the first content pixel: the side gutter plus the rows' own padding. */
function freeGutter(viewportWidth: number, contentWidth: number, contentInset: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth))
    return 0;
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2) + contentInset;
}

/**
 * Places the ticks beside the content: at the usual offset when the gutter allows, closer to the edge
 * in compact layouts so resting ticks stay visible. The hover strip stops before the content so it
 * never takes pointer events from message text.
 */
export function railLayout(
  viewportWidth: number,
  contentWidth: number,
  contentInset: number,
): { left: number; persistent: boolean; hitStripWidth: number } {
  const free = freeGutter(viewportWidth, contentWidth, contentInset);
  const left = free >= RAIL_STRIP_LEFT + RAIL_STRIP_REST_WIDTH + 4 ? RAIL_STRIP_LEFT : 4;
  return {
    left,
    persistent: free >= left + RAIL_STRIP_REST_WIDTH + 4,
    hitStripWidth: Math.max(0, Math.min(RAIL_HIT_STRIP_MAX_WIDTH, Math.floor(free) - left)),
  };
}

export type RailPreviewChunk = { key: string; positions: number[] };

/** The turns of a window card, or the aligned batch of turns around a hovered turn. */
function previewChunk(items: readonly RailItem[], index: number): RailPreviewChunk | undefined {
  const item = items[index];
  if (!item) return undefined;
  if (item.kind === "window")
    return { key: item.key, positions: item.positions.slice(0, RAIL_WINDOW_TURNS) };
  const start = index - (index % OUTLINE_PREVIEW_BATCH);
  const positions = items
    .slice(start, start + OUTLINE_PREVIEW_BATCH)
    .flatMap((neighbor) => (neighbor.kind === "turn" ? [neighbor.position] : []));
  return { key: `b${positions[0]}`, positions };
}

/**
 * Preview batches for a hovered item: its own batch first, then a neighboring batch when the item is
 * within a few turns of the boundary, so scrubbing across it rarely waits.
 */
export function railPreviewChunks(items: readonly RailItem[], index: number): RailPreviewChunk[] {
  const own = previewChunk(items, index);
  if (!own) return [];
  if (items[index]?.kind === "window") return [own];
  const offset = index % OUTLINE_PREVIEW_BATCH;
  const neighbor = (at: number) => {
    const chunk = previewChunk(items, at);
    return chunk ? [own, chunk] : [own];
  };
  if (offset < RAIL_PREVIEW_RADIUS) return neighbor(index - offset - 1);
  if (offset >= OUTLINE_PREVIEW_BATCH - RAIL_PREVIEW_RADIUS)
    return neighbor(index - offset + OUTLINE_PREVIEW_BATCH);
  return [own];
}

/** The visible turn range of a viewport band, from the slots that intersect it. */
export function visiblePositions(
  rows: readonly { start: number; end: number; slot: TurnSlot | undefined }[],
  top: number,
  bottom: number,
): { first: number; last: number; focus: number } | undefined {
  const middle = (top + bottom) / 2;
  let first: number | undefined;
  let last: number | undefined;
  let focus: number | undefined;
  for (const row of rows) {
    const slot = row.slot;
    if (!slot) continue;
    const span = slot.kind === "ready" ? 1 : slot.endPosition - slot.position;
    const read = (middle - row.start) / Math.max(1, row.end - row.start);
    if (row.start <= middle) focus = slot.position + span * Math.max(0, Math.min(1, read));
    else focus ??= slot.position;
    if (row.end <= top || row.start >= bottom) continue;
    const start = slot.position;
    const end = slot.kind === "ready" ? slot.position : slot.endPosition - 1;
    first = first === undefined ? start : Math.min(first, start);
    last = last === undefined ? end : Math.max(last, end);
  }
  if (first === undefined || last === undefined) return undefined;
  return { first, last, focus: focus ?? first };
}

/** The index of the slot holding a turn position, by binary search over ordered slots. */
export function slotIndexForPosition(
  count: number,
  at: (index: number) => TurnSlot | undefined,
  position: number,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const slot = at(middle);
    if (slot && slot.position <= position) low = middle + 1;
    else high = middle;
  }
  const slot = at(low - 1);
  if (!slot) return -1;
  const end = slot.kind === "ready" ? slot.position + 1 : slot.endPosition;
  return position < end ? low - 1 : -1;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function windowTimeRange(window: ContextWindowOutline, now = Date.now()): string {
  const start = new Date(window.startAt);
  const end = new Date(window.endAt);
  const year =
    start.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  const day = start.toLocaleDateString(undefined, { month: "short", day: "numeric", ...year });
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay(start, end)) return `${day}, ${time(start)}–${time(end)}`;
  const endDay = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time(start)} – ${endDay}, ${time(end)}`;
}
