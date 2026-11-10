import "./message-presentation.css";
import { SkeletonConversation } from "./ui/skeleton";
import { latestReadableTurnId } from "../message-grouping";
import {
  ContextMessage,
  NextContextStartAfter,
  TimestampSeparator,
  useRecentContext,
} from "./RecentContext";
import { LoadingSpinner } from "./ui/loading-spinner";
import { OptimisticTurns } from "../optimistic-turns";
import { MessageArrivals } from "../message-arrivals";
import { MessageArrivalsContext } from "./message-arrivals";
import { MessageServicesContext } from "./message-services";
import {
  memo,
  useContext,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { bufferedRange, useReadingAnchor } from "./use-reading-anchor";
import { useTimelineScroll } from "./use-timeline-scroll";
import { ChevronDown } from "lucide-react";
import type { NativeThreadStore } from "@stanley2058/lilac-client";
import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type ReadyTurnSlot,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import { WorkingText } from "./ui/working-text";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { useCitationNavigation } from "./use-citation-navigation";
import { TimelineRail } from "./TimelineRail";
import { slotIndexForPosition, visiblePositions } from "../timeline-outline";
import { useEventCallback } from "../use-event-callback";
import { useStore } from "zustand";
import { clearMessageTarget, messageTargetStore } from "../message-target-store";
import { revealWorkflowCard } from "./reveal-workflow-card";
import { copyAssistantSelection } from "../markdown-copy";
import { Button } from "./ui/button";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import {
  useSlot,
  turnTime,
  useSlotTime,
  useJoinedTurns,
  useTurnPosts,
  renderedRowIndex,
  startsNewDay,
  useSlotIds,
} from "./timeline-slots";
import { type TimelineProps, TimelineContext, useMessageServicesValue } from "./timeline-context";
import { Turn, messageArrivalIds } from "./TimelineTurn";

export function useLatestReadableTurn(store: NativeThreadStore) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(
    () => latestReadableTurnId(store.slotIds, (id) => store.get(id)),
    [store],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const Timeline = memo(function Timeline(props: TimelineProps) {
  // TanStack Virtual returns a mutable virtualizer, which the compiler cannot memoize safely.
  "use no memo";
  const services = useMessageServicesValue(props);
  const store = props.client.thread(props.threadId);
  const storedIds = useSlotIds(store);
  const identities = useMemo(() => new OptimisticTurns(), [store]);
  const pending = props.optimisticTurn;
  const ids = useMemo(
    () => identities.reconcile(storedIds, pending),
    [identities, storedIds, pending],
  );
  const confirmed = useSlot(store, pending?.confirmedSlotId);
  useLayoutEffect(() => {
    if (confirmed?.kind === "ready") props.onOptimisticResolved?.();
  }, [confirmed, props.onOptimisticResolved]);
  const arrivals = useMemo(() => new MessageArrivals(), [store]);

  const subscribeTail = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const tailSnapshot = useCallback(() => store.at(store.size - 1)?.kind !== "deferred", [store]);
  const tailHydrated = useSyncExternalStore(subscribeTail, tailSnapshot, tailSnapshot);
  const parent = useRef<HTMLDivElement>(null);
  const [citationViewport, setCitationViewport] = useState<HTMLDivElement | null>(null);
  const bindViewport = useCallback((element: HTMLDivElement | null) => {
    parent.current = element;
    setCitationViewport(element);
  }, []);
  const citationIndexRef = useRef<number | undefined>(undefined);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const top = headerRef.current?.offsetHeight ?? 0;
      const bottom = footerRef.current?.offsetHeight ?? 0;
      setInsets((current) =>
        current.top === top && current.bottom === bottom ? current : { top, bottom },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (headerRef.current) observer.observe(headerRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, []);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const getItemKey = useCallback(
    (index: number) => {
      if (index === 0) return `${props.threadId}:header`;
      if (index === ids.length + 1) return `${props.threadId}:trailing`;
      if (index === ids.length + 2) return `${props.threadId}:footer`;
      return identities.key(ids[index - 1]!);
    },
    [ids, props.threadId, identities],
  );
  const virtualRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement>>(undefined);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // Sticky chrome participates in measurements so the virtual and native scroll extents agree.
    count: ids.length + 3,
    scrollPaddingStart: insets.top,
    scrollPaddingEnd: insets.bottom,
    getScrollElement: () => parent.current,
    estimateSize: (index) => {
      if (index === 0) return headerRef.current?.offsetHeight ?? 32;
      if (index === ids.length + 1) return 0;
      if (index === ids.length + 2) return footerRef.current?.offsetHeight ?? 0;
      return 240;
    },
    getItemKey,
    // Disclosures are measured during layout, before ResizeObserver delivers their new size.
    measureElement: (element, entry) =>
      Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight),
    overscan: 1,
    rangeExtractor: (range) => {
      const buffered = virtualRef.current
        ? bufferedRange(
            range,
            virtualRef.current.measurementsCache,
            virtualRef.current.scrollOffset ?? 0,
            parent.current?.clientHeight ?? 0,
          )
        : range;
      if (citationIndexRef.current !== undefined && citationIndexRef.current > 0)
        return [...new Set([...defaultRangeExtractor(buffered), citationIndexRef.current])].sort(
          (a, b) => a - b,
        );
      return defaultRangeExtractor(buffered);
    },
  });
  virtualRef.current = virtual;
  const scroll = useTimelineScroll({
    threadId: props.threadId,
    store,
    virtual,
    viewport: citationViewport,
    readingInset: insets.top,
    ready: !!store.checkpoint && tailHydrated,
    ids,
  });
  const switching = scroll.positioning;
  useReadingAnchor({
    virtual,
    viewport: citationViewport,
    headerInset: insets.top,
    isReady: (index) => store.get(ids[index - 1] ?? "")?.kind === "ready",
    mode: scroll.mode,
    currentMode: scroll.currentMode,
    ids,
  });
  const positionCitation = scroll.stopFollowing;
  citationIndexRef.current = useCitationNavigation({
    threadId: props.threadId,
    store,
    client: props.client,
    viewport: parent,
    virtual,
    ready: !switching && !!store.checkpoint,
    onPosition: positionCitation,
  });
  useEffect(() => {
    const viewport = parent.current;
    if (!viewport) return;
    const copy = (event: ClipboardEvent) => copyAssistantSelection(event, viewport);
    viewport.addEventListener("copy", copy);
    return () => viewport.removeEventListener("copy", copy);
  }, []);
  const measureTurn = useCallback(
    (content: HTMLElement) => {
      const row = content.closest<HTMLDivElement>(".virtual-row");
      if (row) virtual.measureElement(row);
    },
    [virtual],
  );
  const timeline = useMemo(
    () => ({
      client: props.client,
      threadId: props.threadId,
      onRewind: props.onRewind,
      timestamps: props.timestamps,
      measureTurn,
    }),
    [props.client, props.threadId, props.onRewind, props.timestamps, measureTurn],
  );
  const measureHeader = useCallback(
    (element: HTMLDivElement | null) => {
      headerRef.current = element;
      virtual.measureElement(element);
    },
    [virtual, props.threadId],
  );
  const measureFooter = useCallback(
    (element: HTMLDivElement | null) => {
      footerRef.current = element;
      virtual.measureElement(element);
    },
    [virtual, getItemKey],
  );
  const totalSize = virtual.getTotalSize();
  const headerSize = virtual.measurementsCache[0]?.size ?? 0;
  const footerSize = virtual.measurementsCache[ids.length + 2]?.size ?? 0;
  useLayoutEffect(() => {
    const viewport = parent.current;
    setAwayFromEnd(
      !!viewport &&
        viewport.scrollHeight - viewport.clientHeight > 8 &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8,
    );
  }, [virtual, totalSize, insets]);
  const rows = virtual.getVirtualItems().filter((row) => row.index > 0 && row.index <= ids.length);
  // The row stays mounted while empty so it measures zero instead of keeping its last height.
  const trailingRow = virtual.getVirtualItems().find((row) => row.index === ids.length + 1);
  const activatedArrivals = useRef<MessageArrivals>(undefined);
  useLayoutEffect(() => {
    if (activatedArrivals.current === arrivals || !tailHydrated || !store.checkpoint) return;
    arrivals.activate(
      store.slotIds.flatMap((id) => {
        const slot = store.get(id);
        return slot?.kind === "ready" ? slot.messages.flatMap(messageArrivalIds) : [];
      }),
    );
    activatedArrivals.current = arrivals;
  }, [arrivals, store, tailHydrated, ids]);
  useLayoutEffect(() => {
    const viewport = parent.current;
    const latest = rows.find((row) => row.index === ids.length);
    const top = (viewport?.scrollTop ?? 0) + insets.top;
    const bottom = (viewport?.scrollTop ?? 0) + (viewport?.clientHeight ?? 0) - insets.bottom;
    // A workflow card folded into the previous turn leaves an empty row at the very end.
    const visible =
      !!viewport &&
      !!latest &&
      (latest.end === latest.start
        ? latest.start >= top && latest.start <= bottom
        : latest.end > top && latest.start < bottom);
    props.onLatestVisibleChange?.(visible);
  }, [rows, ids.length, insets, props.onLatestVisibleChange]);
  const visibleRange = useEventCallback(() => {
    const viewport = parent.current;
    if (!viewport) return undefined;
    const top = viewport.scrollTop + insets.top;
    const bottom = viewport.scrollTop + viewport.clientHeight - insets.bottom;
    return visiblePositions(
      virtual
        .getVirtualItems()
        .filter((row) => row.index > 0 && row.index <= ids.length)
        .map((row) => ({ start: row.start, end: row.end, slot: store.get(ids[row.index - 1]!) })),
      top,
      bottom,
    );
  });
  const [jump, setJump] = useState<{
    threadId: string;
    slotId: string;
    at: number;
    messageId?: string;
  }>();
  const shownThread = useRef(props.threadId);
  useLayoutEffect(() => {
    shownThread.current = props.threadId;
  }, [props.threadId]);
  const jumpRequest = useRef(0);
  const jumpTo = useEventCallback(async (position: number, messageId?: string) => {
    const threadId = props.threadId;
    // A newer selection or a thread switch supersedes a jump still waiting on history.
    const request = ++jumpRequest.current;
    // A deferred range is replaced by the loaded turns around the target, so a few rounds reach it.
    for (let round = 0; round < 4; round++) {
      if (shownThread.current !== threadId || jumpRequest.current !== request) return;
      const slot = store.at(slotIndexForPosition(store.size, (index) => store.at(index), position));
      if (!slot || slot.kind === "failed") return;
      if (slot.kind === "ready") {
        setJump({ threadId, slotId: slot.slotId, at: performance.now(), messageId });
        return;
      }
      await props.client.hydrate(threadId, slot.slotId, { aroundPosition: position });
    }
  });
  const selectTurn = useCallback((position: number) => void jumpTo(position), [jumpTo]);
  const messageTarget = useStore(messageTargetStore, (state) =>
    state.target?.threadId === props.threadId ? state.target : undefined,
  );
  const positionReady = !switching && !!store.checkpoint;
  useEffect(() => {
    if (!messageTarget || !positionReady) return;
    clearMessageTarget();
    positionCitation();
    void jumpTo(messageTarget.position, messageTarget.messageId);
  }, [messageTarget, positionReady, positionCitation, jumpTo]);
  useLayoutEffect(() => {
    if (!jump) return;
    // Timeline stays mounted across threads, so a jump must end with its thread and not restart.
    if (jump.threadId !== props.threadId) {
      setJump(undefined);
      return;
    }
    const seek = () => {
      scroll.stopFollowing();
      const index = renderedRowIndex(store, jump.slotId);
      if (index >= 0) virtual.scrollToIndex(index + 1, { align: "start" });
    };
    seek();
    if (!jump.messageId || !parent.current) return;
    return revealWorkflowCard({
      viewport: parent.current,
      messageId: jump.messageId,
      topInset: insets.top,
      seek,
    });
  }, [jump, props.threadId]);
  const empty = ids.length === 0 && !props.trailing;
  const centered = empty && !!props.centerEmpty;
  return (
    <MessageArrivalsContext value={arrivals}>
      <TimelineContext value={timeline}>
        <MessageServicesContext value={services}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              className={`timeline overflow-auto overscroll-none min-h-0 flex-1 [overflow-anchor:none] chat-scroll relative overflow-y-auto overflow-x-hidden ${centered ? "timeline-centered" : ""}`}
              ref={bindViewport}
              data-timeline-viewport
              data-messaging={props.timestamps || undefined}
              onScroll={(event) => {
                scroll.handlers.onScroll();
                const viewport = event.currentTarget;
                setAwayFromEnd(
                  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8,
                );
              }}
              onWheel={scroll.handlers.onWheel}
              onKeyDown={scroll.handlers.onKeyDown}
              onTouchStart={scroll.handlers.onTouchStart}
              onTouchMove={scroll.handlers.onTouchMove}
              onPointerDown={scroll.handlers.onPointerDown}
              onFocus={scroll.handlers.onFocus}
              onClickCapture={(event) => {
                if (!(event.target instanceof Element)) return;
                const trigger = event.target.closest(
                  '[data-slot="collapsible-trigger"], [data-ui=message-expand]',
                );
                // An expanding disclosure grows down from where the reader is looking.
                if (trigger?.getAttribute("aria-expanded") === "false") scroll.stopFollowing();
              }}
              onFocusCapture={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest('[data-ui=message-card-preview][data-collapsed="true"]')
                )
                  scroll.stopFollowing();
              }}
              role="region"
              aria-label="Conversation"
              tabIndex={0}
            >
              <AssistantSelectionToolbar viewport={citationViewport} threadId={props.threadId} />
              <div
                ref={measureHeader}
                data-index={0}
                className="chat-sticky-header sticky top-0 z-3 [background:color-mix(in_srgb,_var(--ui-background)_var(--ui-glass-opacity),_transparent)] [backdrop-filter:blur(var(--ui-glass-blur))]"
              >
                {props.header}
              </div>
              <div
                data-timeline-canvas
                className="virtual-canvas relative w-full timeline-canvas max-w-[var(--ui-chat-width)] m-auto"
                style={
                  centered
                    ? undefined
                    : {
                        height: Math.max(0, totalSize - headerSize - footerSize),
                        minHeight: `calc(100% - ${insets.top + insets.bottom}px)`,
                      }
                }
              >
                {rows.map((row) => (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtual.measureElement}
                    className="virtual-row absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${row.start - headerSize}px)` }}
                  >
                    <SlotRow
                      slotId={ids[row.index - 1]!}
                      previousSlotId={ids[row.index - 2]}
                      nextSlotId={ids[row.index]}
                      store={store}
                      renderKey={identities.key(ids[row.index - 1]!)}
                      fallback={
                        ids[row.index - 1] === (pending?.confirmedSlotId ?? pending?.slot.slotId)
                          ? pending?.slot
                          : undefined
                      }
                    />
                  </div>
                ))}
                {trailingRow ? (
                  <div
                    key={trailingRow.key}
                    data-index={trailingRow.index}
                    ref={virtual.measureElement}
                    className="virtual-row absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${trailingRow.start - headerSize}px)` }}
                  >
                    {props.trailing}
                  </div>
                ) : null}
                {empty
                  ? (props.emptyContent ?? (
                      <div className="empty-chat">
                        {props.emptyMessage ?? "Start a conversation."}
                      </div>
                    ))
                  : null}
              </div>
              {props.footer ? (
                <div
                  ref={measureFooter}
                  data-index={ids.length + 2}
                  className="chat-sticky-footer sticky bottom-0 z-3"
                >
                  {awayFromEnd && scroll.mode === "read" ? (
                    <div className="scroll-to-end absolute bottom-full left-0 right-0 flex justify-center pb-2 pointer-events-none">
                      <Button variant="secondary" onClick={scroll.followEnd}>
                        <ChevronDown />
                        Scroll to end
                      </Button>
                    </div>
                  ) : null}
                  {props.footer}
                </div>
              ) : null}
            </div>
            {props.outline && !switching ? (
              <TimelineRail
                source={props.outline}
                threadId={props.threadId}
                store={store}
                viewport={citationViewport}
                insets={insets}
                visibleRange={visibleRange}
                onSelect={selectTurn}
                onWheel={scroll.handlers.onWheel}
              />
            ) : null}
          </div>
        </MessageServicesContext>
      </TimelineContext>
    </MessageArrivalsContext>
  );
});

export function ThinkingIndicator({ spinner }: { spinner?: ReactNode } = {}) {
  return (
    <Marker className="px-2 py-1" role="status" data-ui="thinking">
      <MarkerIcon>{spinner ?? <LoadingSpinner />}</MarkerIcon>
      <MarkerContent>
        <WorkingText>Thinking...</WorkingText>
      </MarkerContent>
    </Marker>
  );
}

const SlotRow = memo(function SlotRow(props: {
  store: NativeThreadStore;
  slotId: string;
  previousSlotId?: string;
  nextSlotId?: string;
  renderKey: string;
  fallback?: ReadyTurnSlot;
}) {
  const { client, threadId, onRewind, timestamps } = useContext(TimelineContext)!;
  const posts = useTurnPosts(props.store, props.slotId, props.previousSlotId, props.nextSlotId);
  const nextSlotId = posts.posts.length ? posts.next : props.nextSlotId;
  const previousSlotId = posts.previous ?? props.previousSlotId;
  const recentContext = useRecentContext();
  const generation = props.store.checkpoint?.historyGeneration;
  const groupingContext =
    recentContext && recentContext.historyGeneration === generation ? recentContext : undefined;
  const joinedBefore = useJoinedTurns(
    props.store,
    previousSlotId,
    props.slotId,
    groupingContext?.firstTurnPosition,
    groupingContext?.timestampGapMs,
  );
  const joinedAfter = useJoinedTurns(
    props.store,
    props.slotId,
    nextSlotId,
    groupingContext?.firstTurnPosition,
    groupingContext?.timestampGapMs,
  );
  const stored = useSlot(props.store, props.slotId);
  const previousTime = useSlotTime(props.store, timestamps ? previousSlotId : undefined);
  const loadSlotId =
    stored?.kind === "ready" ? props.slotId : (props.fallback?.slotId ?? props.slotId);
  const loadMore = useCallback(
    () => void client.loadTurnPage(threadId, loadSlotId),
    [client, threadId, loadSlotId],
  );
  const slot = stored?.kind === "ready" ? stored : (props.fallback ?? stored);
  if (!slot || posts.folded) return null;
  // A background job's wake runs with no message and appears only if the agent writes a reply.
  if (slot.kind === "ready" && slot.messages.length === 0) return null;
  if (slot.kind !== "ready")
    return slot.kind === "failed" ? (
      <div className="history-placeholder text-center bg-surface my-3 mx-6 rounded-md flex justify-center gap-3">
        <span>{slot.message}</span>
        <Button type="button" onClick={() => void client.hydrate(threadId, slot.slotId)}>
          Retry history
        </Button>
      </div>
    ) : (
      <DeferredSlot store={props.store} slot={slot} previousSlotId={props.previousSlotId} />
    );
  const currentContext = groupingContext;
  const contextStart = currentContext?.firstTurnPosition === slot.position && slot.position > 0;
  const firstTurnPosition = currentContext?.firstTurnPosition ?? null;
  const summarized =
    firstTurnPosition !== null &&
    slot.position >= firstTurnPosition &&
    slot.position < (currentContext?.summarizedBeforePosition ?? 0);
  const time = turnTime(slot);
  const gapMs = recentContext?.timestampGapMs ?? DEFAULT_DM_TIMESTAMP_GAP_MS;
  const separated =
    timestamps &&
    time !== undefined &&
    (contextStart ||
      previousSlotId === undefined ||
      (previousTime !== undefined &&
        (time - previousTime >= gapMs || startsNewDay(previousTime, time))));
  // An idle DM without a current window means the server will open a new context on the next send.
  const nextContextStart =
    timestamps &&
    nextSlotId === undefined &&
    !props.fallback &&
    slot.state !== "pending" &&
    slot.state !== "running" &&
    currentContext !== undefined &&
    !currentContext.active &&
    currentContext.firstTurnPosition === null;
  return (
    <ContextMessage summarized={summarized}>
      {previousSlotId === undefined && !separated ? (
        // Turns leave their spacing below, so the first one would touch the sticky header.
        <div className="h-6 max-workspace:h-4" aria-hidden="true" />
      ) : null}
      {separated ? <TimestampSeparator at={time} contextStart={contextStart} /> : null}
      <Turn
        slot={slot}
        joinedBefore={joinedBefore && !separated}
        joinedAfter={joinedAfter}
        optimistic={!!props.fallback && stored?.kind !== "ready"}
        userRenderKey={
          props.renderKey !== props.slotId || props.fallback ? props.renderKey : undefined
        }
        animateArrivals={
          !!props.fallback ||
          props.slotId === props.store.slotIds.at(-1) ||
          nextSlotId === undefined
        }
        posts={posts.posts}
        onRewind={onRewind}
        onLoadMore={loadMore}
      />
      {nextContextStart ? <NextContextStartAfter threadId={threadId} turn={slot} /> : null}
      {nextSlotId === undefined && !nextContextStart ? (
        // Hover controls float in the turn's bottom padding, which leaves them touching the composer.
        <div className="hidden h-4 [@media(hover:hover)]:block" aria-hidden="true" />
      ) : null}
    </ContextMessage>
  );
});

/** Loads its range on mount, and again once connected if it mounted from the cache while offline. */
function DeferredSlot(props: {
  store: NativeThreadStore;
  slot: Extract<TurnSlot, { kind: "deferred" }>;
  previousSlotId?: string;
}) {
  const { client, threadId } = useContext(TimelineContext)!;
  const placeholder = useRef<HTMLDivElement>(null);
  const load = useEventCallback(() => {
    void client.hydrate(
      threadId,
      props.slot.slotId,
      readsDownInto(placeholder.current, props.store, props.previousSlotId)
        ? { aroundPosition: props.slot.position }
        : undefined,
    );
  });
  useEffect(() => {
    load();
    return client.subscribe((event) => {
      if (event.kind === "bootstrap") load();
    });
  }, [client, load, props.slot]);
  return (
    <div ref={placeholder}>
      <SkeletonConversation
        label="Loading earlier messages"
        exchanges={1}
        className="px-6 py-4 max-workspace:px-4"
      />
    </div>
  );
}

/**
 * A gap left below a jump target fills from its top while the reader scrolls down into it; the
 * oldest range above the first loaded turn keeps filling from its newest end.
 */
function readsDownInto(
  element: HTMLElement | null,
  store: NativeThreadStore,
  previousSlotId: string | undefined,
): boolean {
  if (!element || !previousSlotId || store.get(previousSlotId)?.kind !== "ready") return false;
  const viewport = element.closest("[data-timeline-viewport]");
  if (!viewport) return false;
  return element.getBoundingClientRect().top >= viewport.getBoundingClientRect().top;
}

export type { TimelineProps } from "./timeline-context";
export { useSlot, useSlotIds, turnPostsKey } from "./timeline-slots";
export {
  Turn,
  Message,
  groupActivityMessages,
  groupParts,
  messageArrivalIds,
  messageText,
} from "./TimelineTurn";
