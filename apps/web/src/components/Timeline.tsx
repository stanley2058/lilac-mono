import { useMessageTouchMenu } from "./use-message-touch-menu";
import { SkeletonConversation } from "./ui/skeleton";
import {
  isWorkflowPost,
  joinMessageTurns,
  lastTurnMessageTime,
  sameMessageAuthor,
  workflowPostsDuring,
  latestReadableTurnId,
} from "../message-grouping";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./ui/context-menu";
import {
  ContextMessage,
  NextContextStart,
  TimestampSeparator,
  useRecentContext,
} from "./RecentContext";
import { LoadingSpinner } from "./ui/loading-spinner";
import { AddReaction, MessageReactions } from "./MessageReactions";
import { OptimisticTurns, type OptimisticTurn } from "../optimistic-turns";
import { CopyReferenceButton, copyReferenceLink, useConversation } from "./ConversationReference";
import {
  Activity,
  ActivityTimesContext,
  ElapsedTime,
  LiveThinkingRow,
  LiveTailContext,
  RequestActiveContext,
} from "./ActivityLog";
import { formatDuration } from "../activity-presentation";
import { copyMessage, messageClipboard } from "../message-clipboard";
import { MessageArrivals } from "../message-arrivals";
import { MessageArrivalsContext, LiveMessageContext, useMessageArrival } from "./message-arrivals";
import {
  DisplayStreamContext,
  MessageServicesContext,
  useMessageServices,
  type MessageServices,
} from "./message-services";
import {
  memo,
  createContext,
  useContext,
  useId,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { bufferedRange, useReadingAnchor } from "./use-reading-anchor";
import { useTimelineScroll } from "./use-timeline-scroll";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  RotateCcw,
  Copy,
  CopyCheck,
  Link2,
} from "lucide-react";
import type { NativeClient, NativeThreadStore } from "@stanley2058/lilac-client";
import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type DisplayMessage,
  type ReadyTurnSlot,
  type DisplayPart,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import { IconButton, attempt } from "./ui";
import { WorkingText } from "./ui/working-text";
import { WorkVerb, useSettledWorkVerb } from "./WorkVerb";
import { ResourceAttachment } from "./ResourceAttachment";
import { ActorAvatar, type ActorIdentity } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";
import { MessageResourcesContext } from "./message-resources";
import { HtmlPreviewMessageContext } from "./HtmlPreview";
import { Bubble, BubbleContent } from "./ui/bubble";
import "./message-presentation.css";
import { Markdown } from "./Markdown";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { useCitationNavigation } from "./use-citation-navigation";
import { TimelineRail } from "./TimelineRail";
import { slotIndexForPosition, visiblePositions, type OutlineSource } from "../timeline-outline";
import { useEventCallback } from "../use-event-callback";
import { citationStore } from "../citation-store";
import { useStore } from "zustand";
import { clearMessageTarget, messageTargetStore } from "../message-target-store";
import { revealWorkflowCard } from "./reveal-workflow-card";
import { copyAssistantSelection } from "../markdown-copy";
import { WorkflowCard } from "./WorkflowCard";
import { QuestionCard } from "./QuestionCard";
import { readMotionDuration } from "../theme/motion";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Message as ChatMessage, MessageContent, MessageAvatar } from "./ui/message";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function useSlot(store: NativeThreadStore, slotId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (slotId ? store.subscribeSlot(slotId, listener) : () => {}),
    [store, slotId],
  );
  const snapshot = useCallback(() => (slotId ? store.get(slotId) : undefined), [store, slotId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
function turnTime(slot: TurnSlot | undefined): number | undefined {
  if (slot?.kind !== "ready") return undefined;
  return (
    slot.messages.find((message) => message.role === "user")?.metadata?.createdAt ??
    slot.messages[0]?.metadata?.createdAt ??
    slot.startedAt
  );
}
function useSlotTime(store: NativeThreadStore, slotId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (slotId ? store.subscribeSlot(slotId, listener) : () => {}),
    [store, slotId],
  );
  const snapshot = useCallback(
    () => (slotId ? lastTurnMessageTime(store.get(slotId)) : undefined),
    [store, slotId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
function useJoinedTurns(
  store: NativeThreadStore,
  leftId: string | undefined,
  rightId: string | undefined,
  contextStart: number | null | undefined,
  gapMs: number | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const left = leftId ? store.subscribeSlot(leftId, listener) : () => {};
      const right = rightId ? store.subscribeSlot(rightId, listener) : () => {};
      return () => {
        left();
        right();
      };
    },
    [store, leftId, rightId],
  );
  const snapshot = useCallback(
    () =>
      joinMessageTurns(
        leftId ? store.get(leftId) : undefined,
        rightId ? store.get(rightId) : undefined,
        contextStart,
        gapMs,
      ),
    [store, leftId, rightId, contextStart, gapMs],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
type TurnPosts = {
  posts: readonly ReadyTurnSlot[];
  folded: boolean;
  /** The nearest visible neighbors once folded cards are skipped. */
  previous?: string;
  next?: string;
};
const noPosts: TurnPosts = { posts: [], folded: false };
const foldedPost: TurnPosts = { posts: [], folded: true };

/** Workflow cards fold into the turn that posted them, so their own rows render nothing. */
function useTurnPosts(
  store: NativeThreadStore,
  slotId: string,
  previousId: string | undefined,
  nextId: string | undefined,
): TurnPosts {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(() => listener()),
    [store],
  );
  const key = useCallback(
    () => turnPostsKey(store, slotId, previousId, nextId),
    [store, slotId, previousId, nextId],
  );
  const snapshot = useSyncExternalStore(subscribe, key, key);
  return useMemo(() => {
    if (!snapshot) return noPosts;
    if (snapshot === "folded") return foldedPost;
    const { ids, previous, next } = JSON.parse(snapshot) as {
      ids: string[];
      previous: string | null;
      next: string | null;
    };
    const posts = ids.flatMap((id) => {
      const slot = store.get(id);
      return slot?.kind === "ready" ? [slot] : [];
    });
    return { posts, folded: false, previous: previous ?? undefined, next: next ?? undefined };
  }, [snapshot, store]);
}

/** A card folded into its turn renders in that turn's row, so jumps have to aim there. */
function renderedRowIndex(store: NativeThreadStore, slotId: string): number {
  const ids = store.slotIds;
  let index = ids.indexOf(slotId);
  while (index > 0 && turnPostsKey(store, ids[index]!, ids[index - 1], ids[index + 1]) === "folded")
    index -= 1;
  return index;
}

// The key carries revisions so a card's progress updates still rerender the turn that shows it.
export function turnPostsKey(
  store: NativeThreadStore,
  slotId: string,
  previousId: string | undefined,
  nextId: string | undefined,
): string {
  const post = isWorkflowPost(store.get(slotId));
  const afterPost = isWorkflowPost(previousId ? store.get(previousId) : undefined);
  // Most rows have no workflow card beside them; skip the scan of the whole thread.
  if (!post && !afterPost && !isWorkflowPost(nextId ? store.get(nextId) : undefined)) return "";
  const ids = store.slotIds;
  const index = ids.indexOf(slotId);
  if (index < 0) return "";
  const postsAfter = (from: number) => {
    const slots: TurnSlot[] = [];
    for (let at = from; at < ids.length; at++) {
      const slot = store.get(ids[at]!);
      if (!isWorkflowPost(slot)) break;
      slots.push(slot!);
    }
    return slots;
  };
  // The turn before a run of cards, and the cards in that run it shows itself.
  const ownerBefore = (at: number) => {
    let owner = at - 1;
    while (owner >= 0 && isWorkflowPost(store.get(ids[owner]!))) owner--;
    if (owner < 0) return undefined;
    return { owner, folded: workflowPostsDuring(store.get(ids[owner]!), postsAfter(owner + 1)) };
  };
  const before = post || afterPost ? ownerBefore(index) : undefined;
  if (post && before?.folded.includes(slotId)) return "folded";
  // Only when every card between them folded does this row sit directly after the owner.
  const previous =
    before && before.folded.length === index - 1 - before.owner ? ids[before.owner]! : null;
  const posts = post ? [] : workflowPostsDuring(store.get(slotId), postsAfter(index + 1));
  if (!posts.length && !previous) return "";
  return JSON.stringify({
    ids: posts,
    revisions: posts.map((id) => store.getVersioned(id)?.revision),
    previous,
    next: posts.length ? (ids[index + 1 + posts.length] ?? null) : (nextId ?? null),
  });
}

function startsNewDay(previous: number, next: number): boolean {
  return new Date(previous).toDateString() !== new Date(next).toDateString();
}
export function useSlotIds(store: NativeThreadStore) {
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe((change) => {
        if (change.structure) listener();
      }),
    [store],
  );
  const snapshot = useCallback(() => store.slotIds, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type TimelineProps = MessageServices & {
  header?: ReactNode;
  footer?: ReactNode;
  /** Messages after the last turn that are not turns yet, such as queued or unsent input. */
  trailing?: ReactNode;
  client: Pick<NativeClient, "thread" | "hydrate" | "loadTurnPage" | "subscribe">;
  threadId: string;
  onRewind: (turnId: string) => void;
  onLatestVisibleChange?: (visible: boolean) => void;
  emptyMessage?: string;
  emptyContent?: ReactNode;
  /** Centers the empty state and composer together, as on a new conversation. */
  centerEmpty?: boolean;
  optimisticTurn?: OptimisticTurn;
  onOptimisticResolved?: () => void;
  timestamps?: boolean;
  /** Turn outline for the jump rail; the rail stays hidden without one. */
  outline?: OutlineSource;
};
type TimelineServices = Pick<TimelineProps, "client" | "threadId" | "onRewind" | "timestamps"> & {
  measureTurn: (content: HTMLElement) => void;
};
const TimelineContext = createContext<TimelineServices | undefined>(undefined);
function useMessageServicesValue({
  canEdit,
  rewindDisabled,
  resourceUrl,
  upload,
  onAction,
  onReaction,
  questions,
}: MessageServices) {
  return useMemo(
    () => ({ canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction, questions }),
    [canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction, questions],
  );
}

export function useLatestReadableTurn(store: NativeThreadStore) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(
    () => latestReadableTurnId(store.slotIds, (id) => store.get(id)),
    [store],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const Timeline = memo(function Timeline(props: TimelineProps) {
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
  const groupingContext =
    recentContext?.historyGeneration === props.store.checkpoint?.historyGeneration
      ? recentContext
      : undefined;
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
  const currentContext =
    recentContext?.historyGeneration === props.store.checkpoint?.historyGeneration
      ? recentContext
      : undefined;
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
        onLoadMore={() => void client.loadTurnPage(threadId, slot.slotId)}
      />
      {nextContextStart ? <NextContextStart /> : null}
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

type TurnProps = {
  /** Workflow cards posted during this turn, shown ahead of its reply. */
  posts?: readonly ReadyTurnSlot[];
  joinedBefore?: boolean;
  joinedAfter?: boolean;
  slot: ReadyTurnSlot;
  animateArrivals?: boolean;
  optimistic?: boolean;
  userRenderKey?: string;
  onRewind: (turnId: string) => void;
  onLoadMore: () => void;
};

export const Turn = memo(function Turn(props: TurnProps) {
  const workflow = workflowCardMessage(props.slot);
  if (workflow) return <WorkflowTurn turnId={props.slot.turnId} {...workflow} />;
  return <AgentTurn {...props} />;
});

/** Core posts each workflow progress card as its own slot, outside any agent turn. */
function workflowCardMessage(slot: ReadyTurnSlot) {
  const [message] = slot.messages;
  if (slot.messages.length !== 1 || !message) return undefined;
  const card = message.parts.find((part) => part.type === "data-workflow");
  if (!card) return undefined;
  const actions = message.parts.find((part) => part.type === "data-actions");
  return { messageId: message.id, card: card.data, actions };
}

function WorkflowTurn({
  turnId,
  ...card
}: { turnId: string } & ComponentProps<typeof WorkflowCard>) {
  return (
    <article
      className="turn pt-4 px-6 pb-8 max-workspace:pt-3 max-workspace:px-4 max-workspace:pb-6"
      data-turn-id={turnId}
      data-ui="workflow-turn"
    >
      <WorkflowCard {...card} />
    </article>
  );
}

function AgentTurn(props: TurnProps) {
  const { onRewind, onLoadMore } = props;
  const { canEdit, rewindDisabled } = useMessageServices();
  const { slot } = props;
  const [expanded, setExpanded] = useState(false);
  const citedMessage = useStore(citationStore, (state) => {
    const id = state.navigation?.citation.messageId;
    return props.slot.messages.some((message) => message.id === id) ? id : undefined;
  });
  useEffect(() => {
    if (citedMessage) setExpanded(true);
  }, [citedMessage]);
  const firstUser = slot.messages.find(
    (message) => message.role === "user" && message.metadata?.inputMode !== "steer",
  );
  const incomingMessage = slot.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.metadata?.inputId &&
      message.metadata.inputMode !== "steer",
  );
  const settled = slot.state === "complete" || slot.state === "failed" || slot.state === "canceled";
  const remaining = useMemo(
    () =>
      groupActivityMessages(
        slot.messages.filter(
          (message) => message.id !== firstUser?.id && message.id !== incomingMessage?.id,
        ),
      ),
    [slot.messages, firstUser?.id, incomingMessage?.id],
  );
  // Start times never change, so one stable map keeps streaming updates from rerendering every row.
  const [times] = useState(() => new Map<string, number>());
  recordActivityTimes(times, slot.messages);
  // A trailing question card stays visible below the folded work so it can be answered.
  const lastIntermediate = remaining.findLastIndex(
    (message) =>
      message.role !== "assistant" ||
      (message.metadata?.phase !== "final" &&
        !message.parts.some((part) => part.type === "data-question")),
  );
  const intermediate = remaining.slice(0, lastIntermediate + 1);
  const finals = remaining.slice(lastIntermediate + 1);
  const identities = useContext(MessageIdentityContext);
  const startedAt =
    slot.startedAt ?? firstUser?.metadata?.createdAt ?? incomingMessage?.metadata?.createdAt;
  const duration =
    startedAt !== undefined && slot.settledAt !== undefined
      ? Math.max(0, slot.settledAt - startedAt)
      : undefined;
  const settledVerb = useSettledWorkVerb(slot.turnId, duration);
  const active = slot.state === "pending" || slot.state === "running";
  const waiting = active && !remaining.some((message) => message.role === "assistant");
  // A running turn always ends in a live row: the trailing activity run, or Thinking after text.
  const tail = waiting ? undefined : liveTailActivity(remaining);
  const thinkingAfter =
    active && !waiting && !tail && !finals.length && !remaining.at(-1)?.metadata?.incomplete;
  const incomingContinues = sameMessageAuthor(incomingMessage, remaining[0]);
  const incomingSpacing = incomingContinues ? "mb-2" : "mb-4";
  const folded = slot.state === "complete" && intermediate.length > 0;
  return (
    <article
      className={`turn px-6 max-workspace:px-4 ${props.joinedBefore ? "pt-0" : "pt-1"} ${props.joinedAfter ? "pb-0" : "pb-8 max-workspace:pb-7"}`}
      data-joined-before={props.joinedBefore || undefined}
      data-joined-after={props.joinedAfter || undefined}
      data-turn-id={slot.turnId}
    >
      {firstUser ? (
        <div className={`user-turn ml-12 max-workspace:ml-6 ${remaining.length ? "mb-10" : ""}`}>
          <MessageBody
            live={props.animateArrivals ?? true}
            message={firstUser}
            showAvatar={!props.joinedBefore}
            showControls={!(props.joinedAfter && !remaining.length)}
            rewind={
              canEdit && firstUser.metadata?.authorId === identities.viewerId
                ? {
                    disabled: !!props.optimistic || !!rewindDisabled || slot.state === "pending",
                    run: () => onRewind(slot.turnId),
                  }
                : undefined
            }
            renderKey={props.userRenderKey}
            optimistic={props.optimistic}
            controls={
              <>
                {canEdit && firstUser.metadata?.authorId === identities.viewerId ? (
                  <IconButton
                    disabled={props.optimistic || rewindDisabled || slot.state === "pending"}
                    label="Rewind to this turn"
                    onClick={() => onRewind(slot.turnId)}
                  >
                    <RotateCcw />
                  </IconButton>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
      {incomingMessage ? (
        <div className={props.joinedAfter && !remaining.length ? "mb-0" : incomingSpacing}>
          <MessageBody
            message={incomingMessage}
            live={props.animateArrivals ?? true}
            showAvatar={!props.joinedBefore}
            showControls={!incomingContinues && !(props.joinedAfter && !remaining.length)}
          />
        </div>
      ) : null}
      <RequestActiveContext value={!settled}>
        <LiveTailContext value={tail}>
          <ActivityTimesContext value={times}>
            <div className="agent-response flex flex-col gap-2">
              {!incomingContinues &&
              (!props.joinedBefore || !!firstUser || !!incomingMessage) &&
              (waiting ||
                (remaining.length > 0 &&
                  (settled ||
                    remaining.find((message) => message.role !== "system")?.role ===
                      "assistant"))) ? (
                <AuthorAvatar author={identities.agent} role="Agent" />
              ) : null}
              {active ? (
                <div
                  data-ui="work-summary"
                  className="work-summary flex items-center gap-2 border-b border-border/60 pt-1 pb-2 text-sm text-muted-foreground tabular-nums"
                >
                  {startedAt === undefined ? (
                    "Working…"
                  ) : (
                    <span>
                      <WorkVerb seed={slot.turnId} startedAt={startedAt} /> for{" "}
                      <ElapsedTime since={startedAt} />
                    </span>
                  )}
                  <TurnParticipants messages={slot.messages} />
                </div>
              ) : null}
              {folded ? (
                <Collapsible open={expanded} onOpenChange={setExpanded}>
                  <CollapsibleTrigger
                    render={
                      <button
                        type="button"
                        data-ui="work-summary"
                        className="work-summary flex w-full cursor-pointer items-center gap-2 border-b border-border/60 pt-1 pb-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
                      />
                    }
                  >
                    <span className="work-summary-label flex min-w-0 flex-wrap items-center gap-2">
                      <span>
                        {duration === undefined
                          ? settledVerb
                          : `${settledVerb} for ${formatDuration(duration)}`}
                      </span>
                      <TurnParticipants messages={slot.messages} />
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className={`size-3.5 shrink-0 opacity-70 transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent
                    data-ui="expanded-work"
                    className="expanded-work flex flex-col gap-2 pt-2"
                  >
                    <TurnMessages messages={intermediate} live={false} showFirstAvatar={false} />
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <TurnMessages messages={intermediate} live={!settled} showFirstAvatar={false} />
              )}
              {props.posts?.map((post) => {
                const workflow = workflowCardMessage(post);
                return workflow ? <WorkflowCard key={post.slotId} {...workflow} /> : null;
              })}
              {waiting || thinkingAfter ? <LiveThinkingRow /> : null}
              <TurnMessages
                messages={finals}
                live={props.animateArrivals ?? true}
                showFirstAvatar={!settled && intermediate.at(-1)?.role === "user"}
                finalMessageId={settled && !props.joinedAfter ? finals.at(-1)?.id : undefined}
                finalText={finals.map(messageText).filter(Boolean).join("\n\n")}
              />
            </div>
          </ActivityTimesContext>
        </LiveTailContext>
      </RequestActiveContext>
      {slot.state === "failed" || slot.state === "canceled" ? (
        <p
          data-ui="turn-status"
          data-state={slot.state}
          className="inline-flex min-h-[var(--ui-control-compact)] items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground ring-1 ring-border ring-inset data-[state=failed]:bg-danger/10 data-[state=failed]:text-danger data-[state=failed]:ring-danger/30 [&_svg]:size-3.5"
        >
          {slot.state === "failed" ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <CircleSlash aria-hidden="true" />
          )}
          {slot.state === "failed" ? "Run failed" : "Stopped"}
        </p>
      ) : null}
      {slot.partsCursor ? (
        <Button
          variant="ghost"
          className="text-primary py-2 px-3 text-sm"
          type="button"
          onClick={onLoadMore}
        >
          Load more of this turn
        </Button>
      ) : null}
    </article>
  );
}

function recordActivityTimes(times: Map<string, number>, messages: readonly DisplayMessage[]) {
  for (const message of messages) {
    const createdAt = message.metadata?.createdAt;
    if (createdAt === undefined) continue;
    for (const part of message.parts)
      if (part.type === "data-activity" && !times.has(part.id)) times.set(part.id, createdAt);
  }
}

/** The last activity of a turn when nothing but activity follows it. */
function liveTailActivity(messages: readonly DisplayMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const part = last.parts.at(-1);
  return part?.type === "data-activity" ? part.id : undefined;
}

function TurnParticipants({ messages }: { messages: readonly DisplayMessage[] }) {
  const identities = useContext(MessageIdentityContext);
  const authors = useMemo(
    () => [
      ...new Set(
        messages.flatMap((message) =>
          message.role === "user" && message.metadata?.authorId ? [message.metadata.authorId] : [],
        ),
      ),
    ],
    [messages],
  );
  const unknown = authors.find((id) => !identities.users.has(id));
  const onUnknownAuthor = identities.onUnknownAuthor;
  useEffect(() => {
    if (unknown) onUnknownAuthor?.(unknown);
  }, [unknown, onUnknownAuthor]);
  if (authors.length < 2) return null;
  return (
    <span
      data-ui="work-participation"
      className="work-participation inline-flex min-w-0 items-center gap-2"
    >
      <span>with</span>
      <span className="work-participants inline-flex min-w-0 p-[2px] overflow-hidden">
        {authors.map((id) => {
          const author = identities.users.get(id) ?? { displayName: "Participant" };
          return (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <span
                    data-ui="work-participant"
                    className="work-participant inline-flex rounded-full [box-shadow:0_0_0_2px_var(--ui-background)]"
                  />
                }
              >
                <ActorAvatar {...author} size="sm" />
              </TooltipTrigger>
              <TooltipContent>{author.displayName}</TooltipContent>
            </Tooltip>
          );
        })}
      </span>
    </span>
  );
}

function TurnMessages({
  messages,
  live,
  showFirstAvatar = true,
  finalMessageId,
  finalText,
}: {
  messages: readonly DisplayMessage[];
  live: boolean;
  showFirstAvatar?: boolean;
  finalMessageId?: string;
  finalText?: string;
}) {
  let nextAssistantAvatar = showFirstAvatar;
  return messages.map((message, index) => {
    const showAvatar =
      (message.role === "user" && !sameMessageAuthor(messages[index - 1], message)) ||
      (message.role === "assistant" &&
        (nextAssistantAvatar || (index > 0 && !sameMessageAuthor(messages[index - 1], message))));
    if (message.role === "user") nextAssistantAvatar = true;
    if (message.role === "assistant") nextAssistantAvatar = false;
    return (
      <MessageBody
        key={message.id}
        message={message}
        live={live}
        showAvatar={showAvatar}
        showControls={
          (message.role === "user" && !sameMessageAuthor(message, messages[index + 1])) ||
          message.id === finalMessageId
        }
        copyText={message.id === finalMessageId ? finalText : undefined}
        copyParts={
          message.id === finalMessageId ? messages.flatMap((item) => item.parts) : undefined
        }
      />
    );
  });
}

function AuthorAvatar({
  author,
  role,
  self = false,
  message,
}: {
  author: ActorIdentity;
  role: string;
  self?: boolean;
  message?: DisplayMessage;
}) {
  return (
    <MessageAvatar>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="message-avatar-trigger flex p-0 border-0 rounded-full bg-transparent cursor-default"
              aria-label={`About ${author.displayName}`}
            />
          }
        >
          <ActorAvatar {...author} />
        </TooltipTrigger>
        <TooltipContent
          className="message-author-details flex-col items-start gap-1"
          side={self ? "left" : "right"}
          align="center"
        >
          <span className="message-author-name font-semibold">{author.displayName}</span>
          <span>{role}</span>
          {message?.metadata?.inputMode === "steer" ? <span>Steering</span> : null}
          {message?.metadata?.createdAt !== undefined ? (
            <time dateTime={new Date(message.metadata.createdAt).toISOString()}>
              {new Date(message.metadata.createdAt).toLocaleString()}
            </time>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </MessageAvatar>
  );
}

export function groupActivityMessages(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const grouped: DisplayMessage[] = [];
  const activityOnly = (message: DisplayMessage) =>
    message.role === "assistant" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "data-activity");
  for (const original of messages) {
    const parts = original.parts.filter(
      (part) =>
        !(
          part.type === "data-activity" &&
          part.data.kind === "tool" &&
          /^batch(?:\s|$)/.test(part.data.label)
        ),
    );
    const message = parts.length === original.parts.length ? original : { ...original, parts };
    if (!message.parts.length) continue;
    const previous = grouped.at(-1);
    if (previous && activityOnly(previous) && activityOnly(message)) {
      grouped[grouped.length - 1] = { ...previous, parts: [...previous.parts, ...message.parts] };
      continue;
    }
    grouped.push(message);
  }
  return grouped;
}

export function messageText(message: DisplayMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
type MessageProps = Pick<
  TimelineProps,
  "canEdit" | "resourceUrl" | "upload" | "onAction" | "onReaction"
> & {
  message: DisplayMessage;
  controls?: ReactNode;
};
type Group =
  | { kind: "text"; text: string }
  | { kind: "activity"; parts: Extract<DisplayPart, { type: "data-activity" }>[] }
  | { kind: "part"; part: Exclude<DisplayPart, { type: "text" | "data-activity" }> };
/** A workflow card shows its own controls, and its text is a summary for other surfaces. */
function visibleParts(parts: readonly DisplayPart[]): readonly DisplayPart[] {
  if (!parts.some((part) => part.type === "data-workflow")) return parts;
  return parts.filter((part) => part.type !== "text" && part.type !== "data-actions");
}

export function groupParts(parts: readonly DisplayPart[]): Group[] {
  const groups: Group[] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (part.type === "text") {
      if (previous?.kind === "text") previous.text += part.text;
      else groups.push({ kind: "text", text: part.text });
      continue;
    }
    if (part.type === "data-activity") {
      if (previous?.kind === "activity") previous.parts.push(part);
      else groups.push({ kind: "activity", parts: [part] });
      continue;
    }
    groups.push({ kind: "part", part });
  }
  return groups;
}

type MessageCardGroup = {
  kind: "content";
  texts: string[];
  attachments: Extract<DisplayPart, { type: "data-resource" }>[];
};
type CardGroup =
  | MessageCardGroup
  | Extract<Group, { kind: "activity" }>
  | {
      kind: "part";
      part: Exclude<DisplayPart, { type: "text" | "data-activity" | "data-resource" }>;
    };

function groupMessageCards(groups: readonly Group[]): CardGroup[] {
  const cards: CardGroup[] = [];
  let content: MessageCardGroup | undefined;
  for (const group of groups) {
    if (group.kind === "activity") {
      content = undefined;
      cards.push(group);
      continue;
    }
    if (group.kind === "part" && group.part.type !== "data-resource") {
      content = undefined;
      cards.push({ kind: "part", part: group.part });
      continue;
    }
    if (!content) {
      content = { kind: "content", texts: [], attachments: [] };
      cards.push(content);
    }
    if (group.kind === "text") {
      content.texts.push(group.text);
      continue;
    }
    if (group.part.type === "data-resource") content.attachments.push(group.part);
  }
  return cards;
}

export function messageArrivalIds(message: DisplayMessage): string[] {
  return groupMessageCards(groupParts(message.parts)).flatMap((group, index) => {
    if (group.kind === "content")
      return group.texts.some(Boolean) || group.attachments.length > 0
        ? [`${message.id}:content:${index}`]
        : [];
    if (group.kind === "activity")
      return group.parts.flatMap((part) => [`activity:${part.id}`, `activity-item:${part.id}`]);
    return [];
  });
}

function MessageCard({
  content,
  self,
  collapsible,
  streaming,
  arrivalId,
  reactions,
}: {
  reactions?: ReactNode;
  arrivalId: string;
  content: MessageCardGroup;
  self: boolean;
  collapsible: boolean;
  streaming: boolean;
}) {
  const arrivalRef = useMessageArrival(
    arrivalId,
    content.texts.some(Boolean) || content.attachments.length > 0,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const heightAnimation = useRef<Animation | null>(null);
  const previousStream = useRef<{ text: string; height: number; blocks: number } | null>(null);
  const live = useContext(LiveMessageContext);
  const streamText = streaming && content.texts.length === 1 ? content.texts[0] : undefined;
  const previewId = useId();
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!collapsible || !element) return;
    const measure = () =>
      setLong(
        element.getBoundingClientRect().height >
          24 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsible]);
  const timeline = useContext(TimelineContext);
  useLayoutEffect(() => {
    if (contentRef.current) timeline?.measureTurn(contentRef.current);
  }, [expanded, long, timeline]);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const markdown = contentRef.current?.querySelector(".markdown");
    if (!preview || !markdown || streamText === undefined) {
      previousStream.current = null;
      heightAnimation.current?.cancel();
      return;
    }
    const previous = previousStream.current;
    const height = preview.scrollHeight;
    previousStream.current = { text: streamText, height, blocks: markdown.children.length };
    if (
      !live ||
      !previous ||
      streamText.length <= previous.text.length ||
      !streamText.startsWith(previous.text)
    ) {
      heightAnimation.current?.cancel();
      return;
    }
    const duration = readMotionDuration() * 2;
    if (!duration) return;
    const from =
      heightAnimation.current?.playState === "running"
        ? preview.getBoundingClientRect().height
        : previous.height;
    heightAnimation.current?.cancel();
    if (height > from) {
      heightAnimation.current = preview.animate(
        [{ height: `${from}px` }, { height: `${height}px` }],
        { duration, easing: "ease-out" },
      );
    }
    for (const block of Array.from(markdown.children).slice(previous.blocks)) {
      block.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: "ease-out" });
    }
  }, [live, streamText]);
  const collapsed = collapsible && !expanded;
  const images = content.attachments.filter((part) => part.data.mediaType.startsWith("image/"));
  const files = content.attachments.filter((part) => !part.data.mediaType.startsWith("image/"));
  return (
    <Bubble ref={arrivalRef} variant={self ? "tinted" : "muted"} className="message-bubble">
      <BubbleContent>
        <div
          ref={previewRef}
          id={previewId}
          data-ui="message-card-preview"
          className="message-card-preview min-w-0"
          data-collapsed={collapsed}
          data-overflow={long}
          data-streaming={streaming}
          onFocusCapture={() => {
            if (collapsed) setExpanded(true);
          }}
        >
          <div ref={contentRef} className="message-card-body flow-root min-w-0">
            {images.length > 0 ? (
              <div
                data-ui="message-image-attachments"
                className="message-attachments flex flex-wrap items-start gap-2 message-image-attachments"
              >
                {images.map((part) => (
                  <ResourceAttachment key={part.id} part={part} />
                ))}
              </div>
            ) : null}
            {content.texts.map((text, index) => (
              <div key={index} data-citation-text={collapsible ? undefined : ""}>
                <Markdown
                  text={text}
                  preserveLineBreaks={collapsible}
                  sourcePositions={!collapsible}
                />
              </div>
            ))}
            {files.length > 0 ? (
              <div
                data-ui="message-attachments"
                className="message-attachments flex flex-wrap items-start gap-2"
              >
                {files.map((part) => (
                  <ResourceAttachment key={part.id} part={part} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {collapsible && long ? (
          <Button
            variant="ghost"
            data-ui="message-expand"
            className="message-expand flex ml-auto mt-2"
            aria-expanded={expanded}
            aria-controls={previewId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        ) : null}
        {reactions}
      </BubbleContent>
    </Bubble>
  );
}

export const Message = memo(function Message(props: MessageProps) {
  const services = useMessageServicesValue(props);
  return (
    <MessageServicesContext value={services}>
      <MessageBody message={props.message} controls={props.controls} />
    </MessageServicesContext>
  );
});

const MessageBody = memo(function MessageBody(
  props: Pick<MessageProps, "message" | "controls"> & {
    live?: boolean;
    showAvatar?: boolean;
    showControls?: boolean;
    copyText?: string;
    copyParts?: readonly DisplayPart[];
    renderKey?: string;
    optimistic?: boolean;
    rewind?: { disabled: boolean; run: () => void };
  },
) {
  const { resourceUrl, canEdit, onAction } = useMessageServices();
  const { message } = props;
  const conversation = useConversation();
  const timeline = useContext(TimelineContext);
  const displayStream = useContext(DisplayStreamContext);
  const reference =
    message.metadata?.reference ??
    (timeline
      ? { surface: "native" as const, sessionId: timeline.threadId, messageId: message.id }
      : conversation);
  const copyReference =
    conversation?.surface === "native" && !timeline
      ? { surface: conversation.surface, sessionId: conversation.sessionId, messageId: message.id }
      : reference;
  const [copyError, setCopyError] = useState<string>();
  const touchMenu = useMessageTouchMenu();
  const [copiedAt, setCopiedAt] = useState(0);
  useEffect(() => {
    if (!copiedAt) return;
    const timer = setTimeout(() => setCopiedAt(0), 2000);
    return () => clearTimeout(timer);
  }, [copiedAt]);
  const copyText = props.copyText ?? messageText(message);
  const groups = useMemo(() => groupParts(visibleParts(message.parts)), [message.parts]);
  const cards = useMemo(() => groupMessageCards(groups), [groups]);
  const reactions = useMemo(
    () => message.parts.flatMap((part) => (part.type === "data-reactions" ? part.data.items : [])),
    [message.parts],
  );
  const lastContent = cards.findLastIndex((card) => card.kind === "content");
  const identities = useContext(MessageIdentityContext);
  const authorId = message.role === "user" ? message.metadata?.authorId : undefined;
  const authorResolved = authorId !== undefined && identities.users.has(authorId);
  const onUnknownAuthor = identities.onUnknownAuthor;
  useEffect(() => {
    if (authorId === undefined || authorResolved || message.metadata?.authorDisplayName) return;
    onUnknownAuthor?.(authorId);
  }, [authorId, authorResolved, onUnknownAuthor, message.metadata?.authorDisplayName]);
  const externalAuthor = message.metadata?.authorDisplayName
    ? {
        ...(message.role === "assistant" ? identities.agent : identities.users.get(authorId ?? "")),
        displayName: message.metadata.authorDisplayName,
      }
    : undefined;
  const author =
    externalAuthor ??
    (message.role === "assistant"
      ? identities.agent
      : (identities.users.get(message.metadata?.authorId ?? "") ??
        identities.promptingAgent ?? { displayName: "Participant" }));
  const conversational = groups.some(
    (group) =>
      group.kind === "text" || (group.kind === "part" && group.part.type === "data-resource"),
  );
  let authorRole = externalAuthor ? "User" : "Participant";
  if (identities.promptingAgent) authorRole = "Main agent";
  if (message.role === "assistant") authorRole = "Agent";
  else if (authorId !== undefined && authorId === identities.viewerId) authorRole = "You";
  const self =
    message.role === "user" && authorId !== undefined && authorId === identities.viewerId;
  const attachments = useMemo(
    () => message.parts.filter((part) => part.type === "data-resource"),
    [message.parts],
  );
  const resources = useMemo(
    () =>
      new Map(
        attachments.map((part) => [
          `/api/resources/${encodeURIComponent(part.data.resourceId)}`,
          { resource: part.data, href: resourceUrl(part.data.resourceId) },
        ]),
      ),
    [attachments, resourceUrl],
  );
  const previewThreadId = timeline?.threadId ?? displayStream?.threadId;
  const previewMessage = useMemo(
    () =>
      previewThreadId && message.role === "assistant"
        ? { threadId: previewThreadId, messageId: message.id }
        : null,
    [previewThreadId, message.role, message.id],
  );
  const time =
    message.metadata?.createdAt !== undefined ? (
      <time dateTime={new Date(message.metadata.createdAt).toISOString()}>
        {new Date(message.metadata.createdAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
    ) : null;
  const copyCurrentMessage = () =>
    void attempt(
      async () => {
        setCopyError(undefined);
        await copyMessage(messageClipboard(copyText, props.copyParts ?? message.parts));
        setCopiedAt(Date.now());
      },
      () => setCopyError("Copy unavailable"),
    );
  const copyButton =
    copyText || attachments.length ? (
      <IconButton
        label="Copy message"
        tooltip={copiedAt ? "Copied!" : "Copy message"}
        onClick={copyCurrentMessage}
      >
        {copiedAt ? <CopyCheck /> : <Copy />}
      </IconButton>
    ) : null;
  const copy = copyButton ? (
    <>
      {self ? null : copyButton}
      <CopyReferenceButton target={copyReference} disabled={!!props.optimistic} />
      {self ? copyButton : null}
    </>
  ) : null;
  return (
    <LiveMessageContext value={props.live ?? false}>
      <ContextMenu
        onOpenChange={(open, details) => {
          if (open && window.getSelection()?.toString()) details.cancel();
        }}
      >
        <ContextMenuTrigger
          data-slot="message"
          className="select-text"
          style={{ WebkitTouchCallout: "default" }}
          {...touchMenu}
          render={
            <ChatMessage
              align={self ? "end" : "start"}
              className={`message leading-normal ${conversational ? "py-0.5" : "py-0"} px-0 wrap-anywhere message-${message.role} native-message text-base`}
              data-message-id={message.id}
              data-citation-source={
                message.role === "assistant" &&
                reference?.surface === "native" &&
                displayStream?.kind !== "subagent"
                  ? message.id
                  : undefined
              }
              data-citation-thread={
                reference?.surface === "native" ? reference.sessionId : undefined
              }
            />
          }
        >
          {(props.showAvatar ?? conversational) ? (
            <AuthorAvatar author={author} role={authorRole} self={self} message={message} />
          ) : null}
          <MessageResourcesContext value={resources}>
            <HtmlPreviewMessageContext value={previewMessage}>
              <MessageContent>
                {cards.map((group, index) => {
                  if (group.kind === "content")
                    return (
                      <MessageCard
                        key={index}
                        arrivalId={`${props.renderKey ?? message.id}:content:${index}`}
                        content={group}
                        self={self}
                        collapsible={message.role === "user"}
                        streaming={message.role === "assistant" && !!props.live}
                        reactions={
                          index === lastContent ? (
                            <MessageReactions messageId={message.id} items={reactions} />
                          ) : null
                        }
                      />
                    );
                  if (group.kind === "activity")
                    return <Activity key={index} parts={group.parts} />;
                  const part = group.part;
                  switch (part.type) {
                    case "data-compaction":
                      return (
                        <Marker variant="separator" className="compaction" key={part.id}>
                          <MarkerContent>
                            Context compaction {part.data.state}
                            {part.data.beforeCount !== undefined &&
                            part.data.afterCount !== undefined
                              ? ` · ${part.data.beforeCount} → ${part.data.afterCount}`
                              : ""}
                          </MarkerContent>
                        </Marker>
                      );
                    case "data-input-state":
                      return part.data.state === "admitted" ||
                        part.data.state === "queued" ? null : (
                        <Marker className="input-state" key={part.id}>
                          <MarkerContent>{part.data.reason ?? part.data.state}</MarkerContent>
                        </Marker>
                      );
                    case "data-actions":
                      return (
                        <div className="action-list" key={part.id}>
                          {part.data.actions.map((action) => (
                            <Button
                              key={action.actionId}
                              type="button"
                              disabled={!canEdit || action.disabled}
                              variant={action.style === "danger" ? "destructive" : "secondary"}
                              onClick={() => onAction(message.id, part, action.actionId)}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                      );
                    case "data-workflow":
                      return (
                        <WorkflowCard
                          key={part.id}
                          messageId={message.id}
                          card={part.data}
                          actions={message.parts.find((item) => item.type === "data-actions")}
                        />
                      );
                    case "data-question":
                      return <QuestionCard key={part.id} question={part.data} />;
                    case "data-reactions":
                      return lastContent < 0 ? (
                        <Bubble
                          key={part.id}
                          variant={self ? "tinted" : "muted"}
                          className="message-bubble"
                        >
                          <BubbleContent>
                            <MessageReactions messageId={message.id} items={part.data.items} />
                          </BubbleContent>
                        </Bubble>
                      ) : null;
                  }
                })}
              </MessageContent>
            </HtmlPreviewMessageContext>
          </MessageResourcesContext>
          {conversational &&
          (props.showControls ??
            (message.metadata?.phase !== "commentary" && !message.metadata?.incomplete)) ? (
            <div
              data-ui="message-controls"
              className="message-controls flex items-center justify-end gap-1 text-muted-foreground text-xs"
            >
              {self ? time : copy}
              <AddReaction messageId={message.id} items={reactions} disabled={props.optimistic} />
              {self ? props.controls : null}
              {self ? copy : time}
              {copyError ? <span role="status">{copyError}</span> : null}
            </div>
          ) : null}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={!messageText(message) && !attachments.length}
            onClick={copyCurrentMessage}
          >
            <Copy />
            Copy message
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!!props.optimistic || !copyReference}
            onClick={() => {
              if (copyReference) copyReferenceLink(copyReference);
            }}
          >
            <Link2 />
            Copy link
          </ContextMenuItem>
          <AddReaction messageId={message.id} items={reactions} disabled={props.optimistic} menu />
          {props.rewind ? (
            <ContextMenuItem disabled={props.rewind.disabled} onClick={props.rewind.run}>
              <RotateCcw />
              Rewind to this turn
            </ContextMenuItem>
          ) : null}
          {copyError ? <span role="status">{copyError}</span> : null}
        </ContextMenuContent>
      </ContextMenu>
    </LiveMessageContext>
  );
});
