import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Result } from "better-result";
import {
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "cn";
import type { NativeThreadStore } from "@stanley2058/lilac-client";
import {
  turnPreviewText,
  type ThreadOutline,
  type TurnPreview,
} from "@stanley2058/lilac-client-protocol";
import {
  RAIL_MIN_ITEMS,
  mergeOutlinePages,
  RAIL_ITEM_SPACING,
  railAnchor,
  railAnchorIndex,
  railCurrentIndex,
  railIndexAt,
  railItemInView,
  railItems,
  railLayout,
  railFocusIndex,
  railPageStart,
  railPreviewChunks,
  railTrackStart,
  railVisibleCount,
  slotIndexForPosition,
  spliceNewestOutlinePage,
  windowTimeRange,
  type OutlineSource,
  type RailAnchor,
  type RailItem,
  type RailPreviewChunk,
} from "../timeline-outline";
import { readMotionDuration } from "../theme/motion";
import { useRecentContext } from "./RecentContext";
import { IconButton } from "./ui";

/** Refetches the outline when a turn is added, finishes, or history is rewound. */
function useOutlineRevision(store: NativeThreadStore) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(() => {
    const checkpoint = store.checkpoint;
    if (!checkpoint) return undefined;
    const last = store.at(store.size - 1);
    const end = last?.kind === "ready" ? last.position + 1 : (last?.endPosition ?? 0);
    const state = last?.kind === "ready" ? last.state : last?.kind;
    return `${checkpoint.historyGeneration}:${end}:${state ?? ""}`;
  }, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRailOutline(
  source: OutlineSource | undefined,
  threadId: string,
  store: NativeThreadStore,
) {
  const revision = useOutlineRevision(store);
  const generation = revision === undefined ? undefined : Number(revision.split(":")[0]);
  const query = useInfiniteQuery({
    queryKey: ["thread-outline", threadId, generation],
    enabled: !!source?.online && generation !== undefined,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => source!.page(pageParam, signal),
    getNextPageParam: (last) => last.earlierBefore,
    staleTime: Infinity,
    // Turns can arrive while the rail is unmounted, and the revision check only sees later changes.
    refetchOnMount: "always",
  });
  const { data } = query;
  const queries = useQueryClient();
  // The last revision fetched while connected; one seen offline refetches once the connection returns.
  const online = !!source?.online;
  const fetched = useRef(online ? revision : undefined);
  useEffect(() => {
    if (!source?.online || generation === undefined || fetched.current === revision) return;
    fetched.current = revision;
    // Turns change only at the newest end, so earlier pages the reader loaded stay as they are.
    const controller = new AbortController();
    void refreshNewestOutlinePage(queries, source, threadId, generation, controller.signal);
    return () => controller.abort();
  }, [source, threadId, generation, revision, queries]);
  const items = useMemo(() => {
    const pages = data?.pages.filter((page) => page.historyGeneration === generation) ?? [];
    return railItems(mergeOutlinePages(pages));
  }, [data, generation]);
  return {
    items,
    generation,
    hasEarlier: query.hasNextPage,
    loadEarlier: query.fetchNextPage,
    loadingEarlier: query.isFetchingNextPage,
  };
}

async function refreshNewestOutlinePage(
  queries: QueryClient,
  source: OutlineSource,
  threadId: string,
  generation: number,
  signal: AbortSignal,
) {
  const queryKey = ["thread-outline", threadId, generation];
  const fresh = await Result.tryPromise(() => source.page(undefined, signal));
  if (fresh.isErr() || signal.aborted) return;
  queries.setQueryData<InfiniteData<ThreadOutline, number | undefined>>(queryKey, (current) =>
    current ? { ...current, pages: spliceNewestOutlinePage(current.pages, fresh.value) } : current,
  );
}

function previewOptions(
  source: OutlineSource | undefined,
  threadId: string,
  generation: number | undefined,
  chunk: RailPreviewChunk | undefined,
) {
  return queryOptions({
    queryKey: ["outline-previews", threadId, generation, chunk?.key, chunk?.positions],
    queryFn:
      source && generation !== undefined && chunk
        ? async ({ signal }) =>
            (
              await source.previews(
                { historyGeneration: generation, positions: chunk.positions },
                signal,
              )
            ).previews
        : skipToken,
    staleTime: Infinity,
  });
}

/** Previews come from loaded turns first; the rest load per batch and stay cached per generation. */
function useRailPreviews(
  source: OutlineSource | undefined,
  threadId: string,
  store: NativeThreadStore,
  generation: number | undefined,
  items: readonly RailItem[],
  activeIndex: number | null,
) {
  const local = useCallback(
    (position: number): TurnPreview | undefined => {
      const slot = store.at(slotIndexForPosition(store.size, (index) => store.at(index), position));
      if (slot?.kind !== "ready") return undefined;
      return { position, ...turnPreviewText(slot.messages) };
    },
    [store],
  );
  const [own, neighbor] = useMemo(
    () => (activeIndex === null ? [] : railPreviewChunks(items, activeIndex)),
    [items, activeIndex],
  );
  const online = !!source?.online;
  const needed = (chunk: RailPreviewChunk | undefined) =>
    online && !!chunk && chunk.positions.some((position) => !local(position));
  const { data } = useQuery({
    ...previewOptions(source, threadId, generation, own),
    enabled: needed(own),
  });
  // Subscribing to the neighboring batch fetches it ahead of the pointer.
  useQuery({
    ...previewOptions(source, threadId, generation, neighbor),
    enabled: needed(neighbor),
  });
  return useCallback(
    (position: number) => local(position) ?? data?.find((item) => item.position === position),
    [local, data],
  );
}

export type TimelineRailProps = {
  source: OutlineSource | undefined;
  threadId: string;
  store: NativeThreadStore;
  viewport: HTMLDivElement | null;
  insets: { top: number; bottom: number };
  /**
   * The first and last turn positions intersecting the reading band, and the fractional position at
   * its middle.
   */
  visibleRange: () => { first: number; last: number; focus: number } | undefined;
  onSelect: (position: number) => void;
  /** Wheel input the rail forwards to the conversation, which reaches the viewport only as a scroll. */
  onWheel: (event: Pick<WheelEvent, "deltaY">) => void;
};

/**
 * A window the reader holds still. Hovering holds it while the pointer stays on the rail; paging holds
 * it until the conversation scrolls. It is kept by item, so prepending an older page leaves it in place.
 */
type RailHold = { anchor: RailAnchor; offset: number; paged: boolean };

export const TimelineRail = memo(function TimelineRail(props: TimelineRailProps) {
  const { items, generation, hasEarlier, loadEarlier, loadingEarlier } = useRailOutline(
    props.source,
    props.threadId,
    props.store,
  );
  const [layout, setLayout] = useState({ left: 12, persistent: false, hitStripWidth: 0 });
  const [current, setCurrent] = useState<number | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  // Hover is kept by item, so prepending an older outline page leaves it on the same turn.
  const [activeAnchor, setActiveAnchor] = useState<RailAnchor>();
  const [hold, setHold] = useState<RailHold>();
  // The followed window, rounded, plus whether ticks continue past each edge. It changes once per item.
  const [rest, setRest] = useState({ start: 0, top: false, bottom: false });
  const strips = useRef(new Map<string, HTMLSpanElement>());
  const track = useRef<HTMLSpanElement>(null);
  const followStart = useRef(0);
  // The outline the track was last placed for; a different one may number the ticks differently.
  const placedItems = useRef<readonly RailItem[]>([]);
  const holdRef = useRef(hold);
  const glideUntil = useRef(0);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const recentContext = useRecentContext();
  const contextStart =
    recentContext?.historyGeneration === generation ? recentContext?.firstTurnPosition : null;

  const visible = railVisibleCount(railHeight);
  const shown = Math.min(items.length, visible);
  const indexOf = useMemo(() => new Map(items.map((item, index) => [item.key, index])), [items]);
  const holdIndex = hold && railAnchorIndex(items, indexOf, hold.anchor);
  const heldStart =
    hold && holdIndex !== undefined
      ? Math.max(0, Math.min(holdIndex + hold.offset, items.length - shown))
      : undefined;
  const center = Math.round(heldStart ?? rest.start);
  // Strips a page beyond each edge stay mounted, so a paged window slides in instead of popping.
  const sliceStart = Math.max(0, center - visible);
  const sliceEnd = Math.min(items.length, center + 2 * visible);
  useLayoutEffect(() => {
    holdRef.current = hold;
  }, [hold]);

  // Changing what the window shows glides it there; reading moves it with the scroll position.
  const changeHold = useCallback((next: RailHold | undefined) => {
    glideUntil.current = performance.now() + RAIL_GLIDE_MS;
    setHold(next);
  }, []);

  const { viewport, visibleRange, onWheel } = props;
  // Scroll position drives the track transform and strip highlights directly, so scrolling rerenders
  // the rail only when the current item or the rounded window start changes.
  const follow = useCallback(() => {
    const range = visibleRange();
    if (!range) return;
    const free = railTrackStart(railFocusIndex(items, range.focus), items.length, visible);
    followStart.current = free;
    const start = heldStart ?? free;
    // A changed outline can renumber the ticks, so the track moves to the new numbering at once.
    const glide =
      performance.now() < glideUntil.current &&
      placedItems.current === items &&
      readMotionDuration() > 0;
    if (track.current) placeTrack(track.current, start, visible, glide);
    placedItems.current = items;
    for (const item of items.slice(sliceStart, sliceEnd)) {
      const strip = strips.current.get(item.key);
      const next = railItemInView(item, range.first, range.last) ? "true" : "false";
      if (strip && strip.dataset.inView !== next) strip.dataset.inView = next;
    }
    const index = railCurrentIndex(items, range.first);
    setCurrent((value) => (value === index ? value : index));
    const next = {
      start: Math.round(free),
      top: free > 0.01,
      bottom: free < items.length - shown - 0.01,
    };
    setRest((value) =>
      value.start === next.start && value.top === next.top && value.bottom === next.bottom
        ? value
        : next,
    );
  }, [items, visibleRange, visible, shown, heldStart, sliceStart, sliceEnd]);

  useEffect(() => {
    if (!viewport) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    };
    const scrolled = () => {
      // Reading on releases a paged window, which glides back to the reading position.
      if (holdRef.current?.paged) changeHold(undefined);
      schedule();
    };
    const measure = () => {
      const viewportWidth = viewport.getBoundingClientRect().width;
      const contentWidth =
        viewport.querySelector<HTMLElement>("[data-timeline-canvas]")?.getBoundingClientRect()
          .width ?? viewportWidth;
      // Turn rows pad their content symmetrically; the left side also holds hanging avatars.
      const turn = viewport.querySelector<HTMLElement>("[data-timeline-canvas] [data-turn-id]");
      const inset = turn ? parseFloat(getComputedStyle(turn).paddingRight) || 16 : 16;
      const next = railLayout(viewportWidth, contentWidth, inset);
      setLayout((value) =>
        value.left === next.left &&
        value.persistent === next.persistent &&
        value.hitStripWidth === next.hitStripWidth
          ? value
          : next,
      );
      schedule();
    };
    measure();
    viewport.addEventListener("scroll", scrolled, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    const canvas = viewport.querySelector("[data-timeline-canvas]");
    if (canvas) resize.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", scrolled);
      resize.disconnect();
    };
  }, [viewport, follow, changeHold]);

  // Strips that enter the slice or the fisheye mount unhighlighted until the next pass.
  useLayoutEffect(() => {
    follow();
  }, [follow, activeAnchor]);

  // Reading back to the start of the outline fetches the next older page.
  useEffect(() => {
    if (rest.start === 0 && current !== null && current < 4 && hasEarlier && !loadingEarlier)
      void loadEarlier();
  }, [rest.start, current, hasEarlier, loadingEarlier, loadEarlier]);

  const activeIndex = railAnchorIndex(items, indexOf, activeAnchor) ?? null;
  const activeItem = activeIndex === null ? undefined : items[activeIndex];
  const activate = (index: number | null) => {
    const next = index === null ? undefined : railAnchor(items[index]);
    // Moving within one tick keeps the same anchor, so it doesn't rerender the rail.
    setActiveAnchor((value) => (value?.key === next?.key ? value : next));
  };
  const preview = useRailPreviews(
    props.source,
    props.threadId,
    props.store,
    generation,
    items,
    activeIndex,
  );
  useEffect(() => {
    if (activeIndex === 0 && hasEarlier && !loadingEarlier) void loadEarlier();
  }, [activeIndex, hasEarlier, loadingEarlier, loadEarlier]);

  const bindRail = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const resize = new ResizeObserver(() => setRailHeight(node.clientHeight));
      resize.observe(node);
      const wheel = (event: WheelEvent) => {
        if (!viewport || event.ctrlKey || event.deltaY === 0) return;
        event.preventDefault();
        // Scrolling from the rail moves the conversation, and the tick window follows it.
        if (holdRef.current) changeHold(undefined);
        setActiveAnchor(undefined);
        onWheel(event);
        viewport.scrollBy({ top: event.deltaY * wheelUnit(event.deltaMode, viewport) });
      };
      node.addEventListener("wheel", wheel, { passive: false });
      return () => {
        resize.disconnect();
        node.removeEventListener("wheel", wheel);
      };
    },
    [viewport, onWheel, changeHold],
  );

  const windowStart = () => heldStart ?? followStart.current;
  // During a glide the pointer targets the tick under it, not the one arriving there.
  const displayedStart = () => (track.current ? trackStart(track.current) : windowStart());
  // The hit area reaches 4px past the first and last ticks so edge ticks are easy to hit.
  const pointerIndex = (event: MouseEvent<HTMLElement>) =>
    railIndexAt(
      event.clientY - event.currentTarget.getBoundingClientRect().top - 4,
      displayedStart(),
      shown,
    );
  const select = (item: RailItem | undefined) => {
    if (!item) return;
    setActiveAnchor(undefined);
    if (hold) changeHold(undefined);
    props.onSelect(item.position);
  };
  const page = (direction: -1 | 1) => {
    const from = windowStart();
    if (direction < 0 && from < 0.5 && hasEarlier && !loadingEarlier) void loadEarlier();
    const anchor = railAnchor(items[railPageStart(from, direction, items.length, visible)]);
    setActiveAnchor(undefined);
    if (anchor) changeHold({ anchor, offset: 0, paged: true });
  };
  const holdForHover = () => {
    if (hold) return;
    const start = followStart.current;
    const anchor = railAnchor(items[Math.floor(start)]);
    if (anchor) setHold({ anchor, offset: start - Math.floor(start), paged: false });
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const move = (index: number) => {
      event.preventDefault();
      if (hold && !hold.paged) changeHold(undefined);
      activate(Math.max(0, Math.min(items.length - 1, index)));
    };
    const base = activeIndex ?? current ?? items.length - 1;
    switch (event.key) {
      case "ArrowDown":
        return move(base + 1);
      case "ArrowUp":
        return move(base - 1);
      case "Home":
        return move(0);
      case "End":
        return move(items.length - 1);
      case "Enter":
      case " ":
        event.preventDefault();
        return select(activeItem);
      case "Escape":
        return activate(null);
    }
  };

  if (items.length < RAIL_MIN_ITEMS) return null;
  const strip = layout.hitStripWidth > 0;
  const start = heldStart ?? rest.start;
  // Keyboard focus can move past the window edge; the card then pins to the nearest tick.
  const activeOffset =
    activeIndex === null ? 0 : Math.max(0, Math.min(shown - 1, activeIndex - start));
  const fadeTop = (heldStart === undefined ? rest.top : heldStart > 0.01) || !!hasEarlier;
  const fadeBottom =
    heldStart === undefined ? rest.bottom : heldStart < items.length - shown - 0.01;
  const windows = items[0]?.kind === "window";
  return (
    <div
      ref={bindRail}
      data-ui="timeline-rail"
      data-persistent={layout.persistent || undefined}
      className={cn(
        "group/rail pointer-events-none absolute left-0 z-4 hidden w-18 [@media(pointer:fine)]:block",
        layout.persistent
          ? "opacity-100"
          : "opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100",
      )}
      style={{ top: props.insets.top, bottom: props.insets.bottom }}
    >
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2",
          strip ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{
          left: layout.left,
          height: (shown - 1) * RAIL_ITEM_SPACING,
          width: activeItem ? "22rem" : layout.hitStripWidth,
        }}
        onMouseLeave={() => {
          pointer.current = undefined;
          if (hold && !hold.paged) changeHold(undefined);
          activate(null);
        }}
      >
        <RailStep
          direction="previous"
          label={windows ? "Show earlier conversations" : "Show earlier turns"}
          disabled={!fadeTop}
          interactive={strip}
          onPage={page}
        />
        <button
          type="button"
          aria-label={railLabel(activeItem)}
          className="absolute -inset-y-1 left-0 cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-focus"
          style={{
            width: layout.hitStripWidth || 24,
            maskImage: railFade(fadeTop, fadeBottom),
          }}
          onMouseMove={(event) => {
            const last = pointer.current;
            pointer.current = { x: event.clientX, y: event.clientY };
            holdForHover();
            // Heading right toward an open card keeps it, so a diagonal path can reach its rows.
            if (activeItem && last && event.clientX - last.x > Math.abs(event.clientY - last.y))
              return;
            activate(pointerIndex(event));
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            // The open card can outlast small pointer moves, and it names the turn the reader expects.
            select(activeItem ?? items[pointerIndex(event)]);
            event.currentTarget.blur();
          }}
          onFocus={() =>
            setActiveAnchor((value) => value ?? railAnchor(items[current ?? items.length - 1]))
          }
          onBlur={(event) => {
            if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) activate(null);
          }}
          onKeyDown={keyDown}
        >
          <span aria-hidden className="pointer-events-none absolute inset-0 overflow-y-clip">
            <span ref={track} className="absolute inset-x-0 top-0">
              {items.slice(sliceStart, sliceEnd).map((item, offset) => {
                const index = sliceStart + offset;
                return (
                  <RailStrip
                    key={item.key}
                    item={item}
                    top={RAIL_ITEM_SPACING * index + 4}
                    // Strips beyond the fisheye share one tier, so a hover move rerenders only its neighbors.
                    distance={
                      activeIndex === null ? null : Math.min(3, Math.abs(index - activeIndex))
                    }
                    context={
                      item.kind === "window" &&
                      contextStart !== null &&
                      contextStart !== undefined &&
                      item.window.firstPosition <= contextStart &&
                      contextStart < item.window.endPosition
                    }
                    strips={strips.current}
                  />
                );
              })}
            </span>
          </span>
        </button>
        {activeItem ? (
          <div
            data-ui="timeline-rail-preview"
            className="absolute left-8 w-80 max-w-[calc(100vw-5rem)]"
            style={{
              top: activeOffset * RAIL_ITEM_SPACING,
              transform: `translateY(${cardOffset(activeOffset, shown)})`,
            }}
          >
            <RailPreview item={activeItem} preview={preview} onSelect={props.onSelect} />
          </div>
        ) : null}
        <RailStep
          direction="next"
          label={windows ? "Show later conversations" : "Show later turns"}
          disabled={!fadeBottom}
          interactive={strip}
          onPage={page}
        />
      </div>
    </div>
  );
});

/** How long a paged or released window takes to slide to its new range. */
const RAIL_GLIDE_MS = 220;

function trackTransform(start: number): string {
  return `translateY(${-start * RAIL_ITEM_SPACING}px)`;
}

/**
 * Moves the track to `start`. A glide from farther than one window first jumps to one window away, since
 * only the ticks a window beyond the destination stay mounted.
 */
function placeTrack(node: HTMLElement, start: number, reach: number, glide: boolean) {
  if (!glide) {
    node.style.transition = "none";
    node.style.transform = trackTransform(start);
    return;
  }
  // An interrupted glide continues from where it is painted, not from its old destination.
  const from = trackStart(node);
  const near = Math.max(start - reach, Math.min(start + reach, from));
  if (near !== from) jumpTrack(node, near);
  node.style.transition = `transform ${RAIL_GLIDE_MS}ms ease-out`;
  node.style.transform = trackTransform(start);
}

function jumpTrack(node: HTMLElement, start: number) {
  node.style.transition = "none";
  node.style.transform = trackTransform(start);
  // Reading layout commits the jump, so the next transition starts from it.
  void node.offsetHeight;
}

/** The first shown tick as currently painted, including partway through a glide. */
function trackStart(node: HTMLElement): number {
  return -new DOMMatrixReadOnly(getComputedStyle(node).transform).m42 / RAIL_ITEM_SPACING;
}

/** Fades the window's cut edges so more ticks read as continuing past them. */
function railFade(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined;
  const from = top ? "transparent 0, black 20px" : "black 0";
  const to = bottom ? "black calc(100% - 20px), transparent 100%" : "black 100%";
  return `linear-gradient(to bottom, ${from}, ${to})`;
}

function wheelUnit(mode: number, viewport: HTMLElement): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) return 16;
  if (mode === WheelEvent.DOM_DELTA_PAGE) return viewport.clientHeight;
  return 1;
}

/** Edge cards align with their strip instead of centering, so they never leave the rail. */
function cardOffset(index: number, count: number): string {
  if (index < 0.5) return "0%";
  if (index > count - 1.5) return "-100%";
  return "-50%";
}

function railLabel(item: RailItem | undefined): string {
  if (!item) return "Jump to a turn";
  return item.kind === "window" ? "Jump to this conversation" : "Jump to this turn";
}

const RailStrip = memo(function RailStrip({
  item,
  top,
  distance,
  context,
  strips,
}: {
  item: RailItem;
  top: number;
  distance: number | null;
  context: boolean;
  strips: Map<string, HTMLSpanElement>;
}) {
  return (
    // Width tiers are a scale on a fixed box and the in-view highlight is an opacity overlay, so
    // scrolling and hovering animate only transform and opacity.
    <span
      aria-hidden
      data-in-view="false"
      className={cn(
        "group/strip pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform",
        context && "bg-primary/70",
        !context && distance === 0 && "bg-muted-foreground",
        !context && distance !== 0 && "bg-muted-foreground/45",
        distance === 0 && "scale-x-100",
        distance === 1 && "scale-x-[0.667]",
        distance === 2 && "scale-x-[0.417]",
        (distance === null || distance === 3) && "scale-x-[0.333]",
      )}
      style={{ top }}
      ref={(node) => {
        if (node) strips.set(item.key, node);
        else strips.delete(item.key);
      }}
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full opacity-0 transition-opacity group-data-[in-view=true]/strip:opacity-100",
          context ? "bg-primary" : "bg-foreground",
        )}
      />
    </span>
  );
});

function RailStep({
  direction,
  label,
  disabled,
  interactive,
  onPage,
}: {
  direction: "previous" | "next";
  label: string;
  disabled: boolean;
  interactive: boolean;
  onPage: (direction: -1 | 1) => void;
}) {
  const previous = direction === "previous";
  return (
    <span
      className={cn(
        "absolute left-1 z-1 inline-flex -translate-x-1/2 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover/rail:opacity-60",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        previous ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
      )}
    >
      <IconButton
        label={label}
        tooltipSide={previous ? "top" : "bottom"}
        className="size-6"
        disabled={disabled}
        onClick={() => onPage(previous ? -1 : 1)}
      >
        {previous ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </IconButton>
    </span>
  );
}

function RailPreview({
  item,
  preview,
  onSelect,
}: {
  item: RailItem;
  preview: (position: number) => TurnPreview | undefined;
  onSelect: (position: number) => void;
}) {
  const card =
    "block rounded-xl bg-popover p-3 text-left text-sm text-popover-foreground shadow-overlay ring-1 ring-border";
  if (item.kind === "turn") {
    const turn = preview(item.position);
    // Turns Lilac started on its own have no prompt, so their reply leads.
    const title = turn?.user ?? turn?.reply;
    const body = turn?.user ? turn.reply : undefined;
    return (
      <div className={cn(card, "cursor-text select-text")}>
        <p className={cn("truncate font-medium leading-5", !title && "text-muted-foreground")}>
          {title ?? (turn ? "Empty turn" : "Loading…")}
        </p>
        {body ? <p className="mt-1 line-clamp-3 leading-5 text-muted-foreground">{body}</p> : null}
      </div>
    );
  }
  const [first, ...rest] = item.positions;
  const lead = first === undefined ? undefined : preview(first);
  const total = item.window.continues ? `${item.positions.length}+` : item.positions.length;
  return (
    <div className={card}>
      <p className="text-xs leading-4 text-muted-foreground">
        {windowTimeRange(item.window)} · {total} {item.positions.length === 1 ? "turn" : "turns"}
      </p>
      <p className="mt-1.5 line-clamp-2 font-medium leading-5">
        {lead?.user ?? lead?.reply ?? <span className="text-muted-foreground">Loading…</span>}
      </p>
      {lead?.user && lead.reply ? (
        <p className="mt-1 line-clamp-2 leading-5 text-muted-foreground">{lead.reply}</p>
      ) : null}
      {rest.length ? (
        <ul className="mt-1.5 -mx-1.5 flex flex-col">
          {rest.slice(0, 4).map((position) => {
            const turn = preview(position);
            return (
              <li key={position}>
                <button
                  type="button"
                  className="block w-full truncate rounded-md px-1.5 py-0.5 text-left leading-5 text-muted-foreground hover:bg-surface-hover hover:text-hover-foreground focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() => onSelect(position)}
                >
                  {turn?.user ?? turn?.reply ?? "…"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
