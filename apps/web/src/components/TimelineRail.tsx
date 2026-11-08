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
import { queryOptions, skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "cn";
import type { NativeThreadStore } from "@stanley2058/lilac-client";
import { turnPreviewText, type TurnPreview } from "@stanley2058/lilac-client-protocol";
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
  railPreviewChunks,
  railVisibleCount,
  railWindowStart,
  slotIndexForPosition,
  windowTimeRange,
  type OutlineSource,
  type RailAnchor,
  type RailItem,
  type RailPreviewChunk,
} from "../timeline-outline";
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
  const { refetch, data } = query;
  // The last revision fetched while connected; one seen offline refetches once the connection returns.
  const online = !!source?.online;
  const fetched = useRef(online ? revision : undefined);
  useEffect(() => {
    if (!online || fetched.current === revision) return;
    fetched.current = revision;
    void refetch({ cancelRefetch: false });
  }, [online, revision, refetch]);
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
  /** The first and last turn positions intersecting the reading band. */
  visibleRange: () => { first: number; last: number } | undefined;
  onSelect: (position: number) => void;
};

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
  // While the pointer rests on the rail the tick window holds still, so ticks never slide under it.
  const [held, setHeld] = useState(false);
  const [windowAnchor, setWindowAnchor] = useState<RailAnchor>();
  const strips = useRef(new Map<string, HTMLSpanElement>());
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const recentContext = useRecentContext();
  const contextStart =
    recentContext?.historyGeneration === generation ? recentContext?.firstTurnPosition : null;

  const visible = railVisibleCount(railHeight);
  const shown = Math.min(items.length, visible);
  // The window is remembered by item, so prepending an older outline page leaves it in place.
  const indexOf = useMemo(() => new Map(items.map((item, index) => [item.key, index])), [items]);
  const previousStart = railAnchorIndex(items, indexOf, windowAnchor);
  const start =
    held && previousStart !== undefined
      ? Math.min(previousStart, items.length - shown)
      : railWindowStart(previousStart, current, items.length, visible);
  const startItem = items[start];
  useEffect(() => {
    if (startItem)
      setWindowAnchor((value) => (value?.key === startItem.key ? value : railAnchor(startItem)));
  }, [startItem]);

  const { viewport, visibleRange } = props;
  // Scroll position drives strip highlights through data attributes, so scrolling never rerenders
  // the strips themselves; only a change of the current turn does.
  const follow = useCallback(() => {
    const range = visibleRange();
    if (!range) return;
    for (const item of items.slice(start, start + shown)) {
      const strip = strips.current.get(item.key);
      const next = railItemInView(item, range.first, range.last) ? "true" : "false";
      if (strip && strip.dataset.inView !== next) strip.dataset.inView = next;
    }
    const index = railCurrentIndex(items, range.first);
    setCurrent((value) => (value === index ? value : index));
  }, [items, visibleRange, start, shown]);

  useEffect(() => {
    if (!viewport) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
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
    viewport.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    const canvas = viewport.querySelector("[data-timeline-canvas]");
    if (canvas) resize.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
      resize.disconnect();
    };
  }, [viewport, follow]);

  // Strips that enter the window or the fisheye mount unhighlighted until the next pass.
  useLayoutEffect(() => {
    follow();
  }, [follow, activeAnchor]);

  // Reading back to the start of the outline fetches the next older page.
  useEffect(() => {
    if (start === 0 && current !== null && current < 4 && hasEarlier && !loadingEarlier)
      void loadEarlier();
  }, [start, current, hasEarlier, loadingEarlier, loadEarlier]);

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
        setHeld(false);
        setActiveAnchor(undefined);
        viewport.scrollBy({ top: event.deltaY * wheelUnit(event.deltaMode, viewport) });
      };
      node.addEventListener("wheel", wheel, { passive: false });
      return () => {
        resize.disconnect();
        node.removeEventListener("wheel", wheel);
      };
    },
    [viewport],
  );

  // The hit area reaches 4px past the first and last ticks so edge ticks are easy to hit.
  const pointerIndex = (event: MouseEvent<HTMLElement>) =>
    railIndexAt(event.clientY - event.currentTarget.getBoundingClientRect().top - 4, start, shown);
  const select = (item: RailItem | undefined) => {
    if (!item) return;
    setActiveAnchor(undefined);
    props.onSelect(item.position);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const move = (index: number) => {
      event.preventDefault();
      setHeld(false);
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
  const previous = current === null ? undefined : items[current - 1];
  const next = current === null ? undefined : items[current + 1];
  // Keyboard focus can move past the window edge; the card then pins to the nearest tick.
  const activeOffset =
    activeIndex === null ? 0 : Math.max(0, Math.min(shown - 1, activeIndex - start));
  const fadeTop = start > 0 || !!hasEarlier;
  const fadeBottom = start + shown < items.length;
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
          setHeld(false);
          activate(null);
        }}
      >
        <RailStep direction="previous" item={previous} interactive={strip} onSelect={select} />
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
            setHeld(true);
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
          {items.slice(start, start + shown).map((item, offset) => {
            const index = start + offset;
            return (
              <RailStrip
                key={item.key}
                item={item}
                top={RAIL_ITEM_SPACING * offset + 4}
                // Strips beyond the fisheye share one tier, so a hover move rerenders only its neighbors.
                distance={activeIndex === null ? null : Math.min(3, Math.abs(index - activeIndex))}
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
        <RailStep direction="next" item={next} interactive={strip} onSelect={select} />
      </div>
    </div>
  );
});

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
function cardOffset(index: number | null, count: number): string {
  if (index === 0) return "0%";
  if (index === count - 1) return "-100%";
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
  item,
  interactive,
  onSelect,
}: {
  direction: "previous" | "next";
  item: RailItem | undefined;
  interactive: boolean;
  onSelect: (item: RailItem | undefined) => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
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
        disabled={!item}
        onClick={() => onSelect(item)}
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
