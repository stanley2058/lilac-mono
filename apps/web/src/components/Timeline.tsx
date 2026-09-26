import { AgentAvatar } from "./AgentAvatar";
import { LoadingSpinner } from "./ui/loading-spinner";
import { AddReaction, MessageReactions } from "./MessageReactions";
import { OptimisticTurns, type OptimisticTurn } from "../optimistic-turns";
import { CopyReferenceButton, useConversation } from "./ConversationReference";
import { useSubagents, subagentProfileName } from "./subagent-context";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import { copyMessage, messageClipboard } from "../message-clipboard";
import { MessageArrivals } from "../message-arrivals";
import { MessageArrivalsContext, LiveMessageContext, useMessageArrival } from "./message-arrivals";
import {
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
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Copy,
  CopyCheck,
  Bot,
  Brain,
  Wrench,
  Workflow,
} from "lucide-react";
import type { NativeClient, NativeThreadStore } from "@stanley2058/lilac-client";
import type {
  DisplayMessage,
  ReadyTurnSlot,
  DisplayPart,
} from "@stanley2058/lilac-client-protocol";
import { IconButton, attempt } from "./ui";
import { ResourceAttachment } from "./ResourceAttachment";
import { ActorAvatar, type ActorIdentity } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";
import { MessageResourcesContext } from "./message-resources";
import { Bubble, BubbleContent } from "./ui/bubble";
import "./message-presentation.css";
import { Markdown } from "./Markdown";
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
  client: Pick<NativeClient, "thread" | "hydrate" | "loadTurnPage">;
  threadId: string;
  onRewind: (turnId: string) => void;
  onLatestVisibleChange?: (visible: boolean) => void;
  emptyMessage?: string;
  emptyContent?: ReactNode;
  optimisticTurn?: OptimisticTurn;
  onOptimisticResolved?: () => void;
};
type TimelineServices = Pick<TimelineProps, "client" | "threadId" | "onRewind"> & {
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
}: MessageServices) {
  return useMemo(
    () => ({ canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction }),
    [canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction],
  );
}

export function useLatestReadableTurn(store: NativeThreadStore) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(() => {
    const id = store.slotIds.at(-1);
    const slot = id ? store.get(id) : undefined;
    if (slot?.kind !== "ready" || slot.state === "pending" || slot.state === "running")
      return undefined;
    return slot.turnId;
  }, [store]);
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
  const [positionedThread, setPositionedThread] = useState<string>();
  const [tailRenderedThread, setTailRenderedThread] = useState<string>();
  const switching = positionedThread !== props.threadId;
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [readingDisclosure, setReadingDisclosure] = useState<string>();
  const getItemKey = useCallback(
    (index: number) => {
      if (index === 0) return `${props.threadId}:header`;
      // The last key must change on append so followOnAppend sees the new turn.
      if (index === ids.length + 1)
        return `${props.threadId}:footer:${identities.key(ids.at(-1) ?? "empty")}`;
      return identities.key(ids[index - 1]!);
    },
    [ids, props.threadId, identities],
  );
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // Sticky chrome participates in measurements so the virtual and native scroll extents agree.
    count: ids.length + 2,
    anchorTo: readingDisclosure === props.threadId ? "start" : "end",
    followOnAppend: readingDisclosure !== props.threadId,
    scrollEndThreshold: 8,
    scrollPaddingStart: insets.top,
    scrollPaddingEnd: insets.bottom,
    getScrollElement: () => parent.current,
    estimateSize: (index) => {
      if (index === 0) return headerRef.current?.offsetHeight ?? 32;
      if (index === ids.length + 1) return footerRef.current?.offsetHeight ?? 0;
      return 240;
    },
    getItemKey,
    // Disclosures are measured during layout, before ResizeObserver delivers their new size.
    measureElement: (element, entry) =>
      Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight),
    overscan: 3,
    rangeExtractor: (range) => {
      if (tailRenderedThread === props.threadId) return defaultRangeExtractor(range);
      const tail: number[] = [];
      for (let index = Math.max(0, range.count - 5); index < range.count; index++) tail.push(index);
      return tail;
    },
  });
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
      measureTurn,
    }),
    [props.client, props.threadId, props.onRewind, measureTurn],
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
  const footerSize = virtual.measurementsCache[ids.length + 1]?.size ?? 0;
  useLayoutEffect(() => {
    if (!switching) return;
    setReadingDisclosure(undefined);
    virtual.scrollToEnd();
    setAwayFromEnd(false);
    if (!store.checkpoint || !tailHydrated || totalSize !== virtual.getTotalSize()) return;
    // Measure the normal overscan before completing the initial thread position.
    if (tailRenderedThread !== props.threadId) {
      setTailRenderedThread(props.threadId);
      return;
    }
    setPositionedThread(props.threadId);
  });
  useLayoutEffect(() => {
    const viewport = parent.current;
    setAwayFromEnd(
      !!viewport &&
        viewport.scrollHeight - viewport.clientHeight > 8 &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8,
    );
  }, [virtual, totalSize, insets]);
  const rows = virtual.getVirtualItems().filter((row) => row.index > 0 && row.index <= ids.length);
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
    const visible =
      !!viewport &&
      !!latest &&
      latest.end > viewport.scrollTop + insets.top &&
      latest.start < viewport.scrollTop + viewport.clientHeight - insets.bottom;
    props.onLatestVisibleChange?.(visible);
  }, [rows, ids.length, insets, props.onLatestVisibleChange]);
  return (
    <MessageArrivalsContext value={arrivals}>
      <TimelineContext value={timeline}>
        <MessageServicesContext value={services}>
          <div
            className="timeline overflow-auto min-h-0 flex-1 [overflow-anchor:none] chat-scroll relative overflow-y-auto overflow-x-hidden"
            ref={parent}
            onScroll={(event) => {
              setReadingDisclosure(undefined);
              const viewport = event.currentTarget;
              setAwayFromEnd(
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8,
              );
            }}
            onClickCapture={(event) => {
              if (!(event.target instanceof Element)) return;
              const trigger = event.target.closest(
                '[data-slot="collapsible-trigger"], [data-ui=message-expand]',
              );
              if (trigger?.getAttribute("aria-expanded") === "false")
                setReadingDisclosure(props.threadId);
            }}
            onFocusCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('[data-ui=message-card-preview][data-collapsed="true"]')
              )
                setReadingDisclosure(props.threadId);
            }}
            role="region"
            aria-label="Conversation"
            tabIndex={0}
          >
            <div
              ref={measureHeader}
              data-index={0}
              className="chat-sticky-header sticky top-0 z-3 [background:color-mix(in_srgb,_var(--ui-background)_75%,_transparent)] [backdrop-filter:blur(16px)]"
            >
              {props.header}
            </div>
            <div
              className="virtual-canvas relative w-full timeline-canvas max-w-[var(--ui-chat-width)] m-auto"
              style={{
                height: Math.max(0, totalSize - headerSize - footerSize),
                minHeight: `calc(100% - ${insets.top + insets.bottom}px)`,
              }}
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
              {ids.length === 0
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
                data-index={ids.length + 1}
                className="chat-sticky-footer sticky bottom-0 z-3"
              >
                {awayFromEnd && !switching ? (
                  <div className="scroll-to-end absolute bottom-full left-0 right-0 flex justify-center pb-2 pointer-events-none">
                    <Button variant="secondary" onClick={() => virtual.scrollToEnd()}>
                      <ChevronDown />
                      Scroll to end
                    </Button>
                  </div>
                ) : null}
                {props.footer}
              </div>
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
        <span className="working-text">Thinking...</span>
      </MarkerContent>
    </Marker>
  );
}

const SlotRow = memo(function SlotRow(props: {
  store: NativeThreadStore;
  slotId: string;
  renderKey: string;
  fallback?: ReadyTurnSlot;
}) {
  const { client, threadId, onRewind } = useContext(TimelineContext)!;
  const stored = useSlot(props.store, props.slotId);
  const slot = stored?.kind === "ready" ? stored : (props.fallback ?? stored);
  useEffect(() => {
    if (stored?.kind === "deferred") void client.hydrate(threadId, props.slotId);
  }, [stored?.kind, client, threadId, props.slotId]);
  if (!slot) return null;
  if (slot.kind !== "ready")
    return (
      <div className="history-placeholder text-center bg-surface my-3 mx-6 rounded-md flex justify-center gap-3">
        {slot.kind === "failed" ? (
          <>
            <span>{slot.message}</span>
            <Button type="button" onClick={() => void client.hydrate(threadId, slot.slotId)}>
              Retry history
            </Button>
          </>
        ) : (
          <span>Earlier messages</span>
        )}
      </div>
    );
  return (
    <Turn
      slot={slot}
      optimistic={!!props.fallback && stored?.kind !== "ready"}
      userRenderKey={
        props.renderKey !== props.slotId || props.fallback ? props.renderKey : undefined
      }
      animateArrivals={!!props.fallback || props.slotId === props.store.slotIds.at(-1)}
      onRewind={onRewind}
      onLoadMore={() => void client.loadTurnPage(threadId, slot.slotId)}
    />
  );
});

const RequestActiveContext = createContext<boolean | undefined>(undefined);
const LastActivityContext = createContext<ActivityPart | undefined>(undefined);

export const Turn = memo(function Turn(props: {
  slot: ReadyTurnSlot;
  animateArrivals?: boolean;
  optimistic?: boolean;
  userRenderKey?: string;
  onRewind: (turnId: string) => void;
  onLoadMore: () => void;
}) {
  const { onRewind, onLoadMore } = props;
  const { canEdit, rewindDisabled } = useMessageServices();
  const { slot } = props;
  const [expanded, setExpanded] = useState(false);
  const firstUser = slot.messages.find(
    (message) => message.role === "user" && message.metadata?.inputMode !== "steer",
  );
  const settled = slot.state === "complete" || slot.state === "failed" || slot.state === "canceled";
  const remaining = useMemo(
    () => groupActivityMessages(slot.messages.filter((message) => message.id !== firstUser?.id)),
    [slot.messages, firstUser?.id],
  );
  const lastActivity = useMemo(
    () =>
      remaining
        .flatMap((message) => message.parts)
        .findLast((part) => part.type === "data-activity"),
    [remaining],
  );
  const lastIntermediate = remaining.findLastIndex(
    (message) => message.role !== "assistant" || message.metadata?.phase !== "final",
  );
  const intermediate = remaining.slice(0, lastIntermediate + 1);
  const finals = remaining.slice(lastIntermediate + 1);
  const identities = useContext(MessageIdentityContext);
  const startedAt = slot.startedAt ?? firstUser?.metadata?.createdAt;
  const duration =
    startedAt !== undefined && slot.settledAt !== undefined
      ? Math.max(0, slot.settledAt - startedAt)
      : undefined;
  const waiting =
    (slot.state === "pending" || slot.state === "running") &&
    !remaining.some((message) => message.role === "assistant");
  return (
    <article
      className="turn pt-4 px-6 pb-8 max-workspace:pt-3 max-workspace:px-4 max-workspace:pb-6"
      data-turn-id={slot.turnId}
    >
      {firstUser ? (
        <div className="user-turn ml-12 mb-6 max-workspace:ml-6">
          <MessageBody
            live={props.animateArrivals ?? true}
            message={firstUser}
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
      <RequestActiveContext value={!settled}>
        <LastActivityContext value={lastActivity}>
          <div className="agent-response flex flex-col gap-2">
            {waiting ||
            (remaining.length > 0 &&
              (settled ||
                remaining.find((message) => message.role !== "system")?.role === "assistant")) ? (
              <AuthorAvatar author={identities.agent} role="Agent" />
            ) : null}
            {waiting ? (
              <MessageBody
                live={true}
                showAvatar={false}
                message={{
                  id: `${slot.turnId}:thinking`,
                  role: "assistant",
                  parts: [
                    {
                      type: "data-activity",
                      id: `${slot.turnId}:thinking`,
                      data: { kind: "thinking", state: "running", label: "Thinking…" },
                    },
                  ],
                }}
              />
            ) : null}
            {settled && intermediate.length > 0 ? (
              <Collapsible open={expanded} onOpenChange={setExpanded}>
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="work-summary w-full flex items-center gap-2 text-muted-foreground text-sm p-2 rounded-lg text-left h-auto justify-start"
                    />
                  }
                >
                  <Marker render={<span />}>
                    <MarkerContent className="work-summary-label flex flex-1 flex-wrap items-center gap-2">
                      <span>
                        {duration === undefined
                          ? "Worked"
                          : `Worked for ${formatDuration(duration)}`}
                      </span>
                      <TurnParticipants messages={slot.messages} />
                    </MarkerContent>
                    {slot.state !== "complete" ? (
                      <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
                        {slot.state}
                      </span>
                    ) : null}
                    <ChevronRight className={expanded ? "rotated [transform:rotate(90deg)]" : ""} />
                  </Marker>
                </CollapsibleTrigger>
                <CollapsibleContent data-ui="expanded-work" className="expanded-work mb-4">
                  <TurnMessages messages={intermediate} live={false} showFirstAvatar={false} />
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <TurnMessages messages={intermediate} live={!settled} showFirstAvatar={false} />
            )}
            <TurnMessages
              messages={finals}
              live={props.animateArrivals ?? true}
              showFirstAvatar={!settled && intermediate.at(-1)?.role === "user"}
              finalMessageId={settled ? finals.at(-1)?.id : undefined}
              finalText={finals.map(messageText).filter(Boolean).join("\n\n")}
            />
          </div>
        </LastActivityContext>
      </RequestActiveContext>
      {settled && !intermediate.length && slot.state !== "complete" ? (
        <Marker className="turn-status">
          <MarkerContent>{slot.state}</MarkerContent>
        </Marker>
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
});

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
  return messages.map((message) => {
    const showAvatar =
      message.role === "user" || (message.role === "assistant" && nextAssistantAvatar);
    if (message.role === "user") nextAssistantAvatar = true;
    if (message.role === "assistant") nextAssistantAvatar = false;
    return (
      <MessageBody
        key={message.id}
        message={message}
        live={live}
        showAvatar={showAvatar}
        showControls={message.role === "user" || message.id === finalMessageId}
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
function formatDuration(duration: number): string {
  const seconds = Math.floor(duration / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`
    : `${seconds}s`;
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
              <Markdown key={index} text={text} preserveLineBreaks={collapsible} />
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
  },
) {
  const { resourceUrl, canEdit, onAction } = useMessageServices();
  const { message } = props;
  const conversation = useConversation();
  const timeline = useContext(TimelineContext);
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
  const [copiedAt, setCopiedAt] = useState(0);
  useEffect(() => {
    if (!copiedAt) return;
    const timer = setTimeout(() => setCopiedAt(0), 2000);
    return () => clearTimeout(timer);
  }, [copiedAt]);
  const copyText = props.copyText ?? messageText(message);
  const groups = useMemo(() => groupParts(message.parts), [message.parts]);
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
  const time =
    message.metadata?.createdAt !== undefined ? (
      <time dateTime={new Date(message.metadata.createdAt).toISOString()}>
        {new Date(message.metadata.createdAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
    ) : null;
  const copyButton =
    copyText || attachments.length ? (
      <IconButton
        label="Copy message"
        tooltip={copiedAt ? "Copied!" : "Copy message"}
        onClick={() =>
          void attempt(
            async () => {
              setCopyError(undefined);
              await copyMessage(messageClipboard(copyText, props.copyParts ?? message.parts));
              setCopiedAt(Date.now());
            },
            () => setCopyError("Copy unavailable"),
          )
        }
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
      <ChatMessage
        align={self ? "end" : "start"}
        className={`message leading-normal py-2 px-0 wrap-anywhere message-${message.role} native-message text-base`}
        data-message-id={message.id}
      >
        {(props.showAvatar ?? conversational) ? (
          <AuthorAvatar author={author} role={authorRole} self={self} message={message} />
        ) : null}
        <MessageResourcesContext value={resources}>
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
                return (
                  <Activity
                    key={index}
                    parts={group.parts}
                    createdAt={message.metadata?.createdAt}
                  />
                );
              const part = group.part;
              switch (part.type) {
                case "data-compaction":
                  return (
                    <Marker variant="separator" className="compaction" key={part.id}>
                      <MarkerContent>
                        Context compaction {part.data.state}
                        {part.data.beforeCount !== undefined && part.data.afterCount !== undefined
                          ? ` · ${part.data.beforeCount} → ${part.data.afterCount}`
                          : ""}
                      </MarkerContent>
                    </Marker>
                  );
                case "data-input-state":
                  return part.data.state === "admitted" || part.data.state === "queued" ? null : (
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
        </MessageResourcesContext>
        {conversational &&
        (props.showControls ??
          (message.metadata?.phase !== "commentary" && !message.metadata?.incomplete)) ? (
          <div
            data-ui="message-controls"
            className="message-controls flex items-center justify-end gap-1 text-muted-foreground text-xs mt-1"
          >
            {self ? time : copy}
            <AddReaction messageId={message.id} items={reactions} disabled={props.optimistic} />
            {self ? props.controls : null}
            {self ? copy : time}
            {copyError ? <span role="status">{copyError}</span> : null}
          </div>
        ) : null}
      </ChatMessage>
    </LiveMessageContext>
  );
});

type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;

export function activitySummary(
  parts: readonly ActivityPart[],
  agents: ReadonlyMap<string, SubagentSummary> = new Map(),
  active = true,
): string {
  const spawned = parts.filter((part) => subagentActivity(part, agents)).length;
  if (spawned) {
    const tools = parts.filter(
      (part) => part.data.kind === "tool" && !subagentActivity(part, agents),
    ).length;
    const labels = [];
    if (tools) labels.push(`Used ${tools} ${tools === 1 ? "tool" : "tools"}`);
    labels.push(
      `${tools ? "spawned" : "Spawned"} ${spawned} ${spawned === 1 ? "agent" : "agents"}`,
    );
    return labels.join(" and ");
  }
  const running = parts.find((part) => part.data.state === "running");
  if (running && parts.length === 1) return activityLabel(running, active);
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.data.state === "complete" && only.data.durationMs !== undefined)
    return `${only.data.kind === "thinking" ? "Thought" : "Worked"} for ${formatDuration(only.data.durationMs)}`;
  if (parts.length === 1) return activityLabel(parts[0]!, false);
  const tools = parts.filter((part) => part.data.kind === "tool").length;
  const workflows = parts.filter((part) => part.data.kind === "workflow").length;
  const thinking = parts.some((part) => part.data.kind === "thinking");
  const labels = [];
  if (thinking) labels.push("Thought");
  if (tools)
    labels.push(`${thinking ? "used" : "Used"} ${tools} ${tools === 1 ? "tool" : "tools"}`);
  if (workflows)
    labels.push(
      `${labels.length ? "ran" : "Ran"} ${workflows} ${workflows === 1 ? "workflow" : "workflows"}`,
    );
  return labels.join(" and ");
}

function activityLabel(part: ActivityPart, running: boolean): string {
  if (part.data.kind === "thinking" && !running && /^thinking[.…]*$/i.test(part.data.label))
    return "Thought";
  return part.data.label;
}

function ActivityIcon({ part, running }: { part: ActivityPart; running: boolean }) {
  if (running) return <LoadingSpinner />;
  if (part.data.kind === "thinking") return <Brain />;
  if (part.data.kind === "workflow") return <Workflow />;
  return <Wrench />;
}

export function Activity({ parts, createdAt }: { parts: ActivityPart[]; createdAt?: number }) {
  const { agents } = useSubagents();
  const requestActive = useContext(RequestActiveContext);
  const lastActivity = useContext(LastActivityContext);
  const runningAgent = parts.some((part) => subagentActivity(part, agents)?.state === "running");
  const active = requestActive ?? parts.some((part) => part.data.state === "running");
  const working =
    active && (runningAgent || lastActivity === undefined || parts.at(-1) === lastActivity);
  const spawned = parts.some((part) => subagentActivity(part, agents));
  const arrivalRef = useMessageArrival(`activity:${parts[0]?.id}`);
  const [open, setOpen] = useState(false);
  const representative =
    parts.find((part) => part.data.state === "running") ??
    parts.find((part) => part.data.kind === "tool") ??
    parts[0];
  if (!representative) return null;
  return (
    <Collapsible
      ref={arrivalRef}
      className="activity-block w-full min-w-0 my-2"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger
        render={
          <Button variant="ghost" className="activity-summary h-auto justify-start px-2 py-1" />
        }
      >
        <Marker render={<span />}>
          <MarkerIcon>
            {spawned ? (
              <Bot />
            ) : (
              <ActivityIcon
                part={representative}
                running={working && representative.data.state === "running"}
              />
            )}
          </MarkerIcon>
          <MarkerContent className="activity-label flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            <span className={working ? "working-text" : undefined}>
              {activitySummary(parts, agents, working)}
            </span>
          </MarkerContent>
          {createdAt !== undefined ? (
            <time
              className="activity-time opacity-0 [transition:opacity_var(--ui-motion-duration)_ease]"
              dateTime={new Date(createdAt).toISOString()}
            >
              {new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
          ) : null}
          <ChevronRight className={open ? "rotated [transform:rotate(90deg)]" : ""} />
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-details pl-3">
        {parts.map((part) => (
          <ActivityItem key={part.id} part={part} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function subagentActivity(
  part: ActivityPart,
  agents: ReadonlyMap<string, SubagentSummary>,
): (Pick<SubagentSummary, "profile" | "title" | "state"> & { id?: string }) | undefined {
  const agent = agents.get(part.id);
  if (agent) return agent;
  const profile = /^subagent(?:_delegate)? \((explore|general|self)(?:;|\))/.exec(
    part.data.label,
  )?.[1];
  if (profile !== "explore" && profile !== "general" && profile !== "self") return;
  const current = part.data.label
    .split("\n")
    .findLast((line) => line.includes("> "))
    ?.split("> ")[1];
  return {
    profile,
    title: current ?? (part.data.state === "running" ? "Thinking…" : "Completed"),
    state: part.data.state,
    id: undefined,
  };
}

export function ActivityItem({ part }: { part: ActivityPart }) {
  const { agents, open: openAgent } = useSubagents();
  const agent = subagentActivity(part, agents);
  const requestActive = useContext(RequestActiveContext);
  const running = requestActive !== false && part.data.state === "running";
  const arrivalRef = useMessageArrival(`activity-item:${part.id}`);
  const [open, setOpen] = useState(false);
  if (agent)
    return (
      <div ref={arrivalRef}>
        <Button
          variant="ghost"
          className="subagent-activity w-full h-auto text-left justify-start text-muted-foreground py-1 px-2"
          onClick={() => openAgent(agent.id ?? part.id)}
        >
          <AgentAvatar
            decorative
            profile={agent.profile}
            displayName={subagentProfileName(agent.profile)}
            size="sm"
          />
          <span>
            {subagentProfileName(agent.profile)} -{" "}
            <span
              className={
                requestActive !== false && agent.state === "running" ? "working-text" : undefined
              }
            >
              {agent.title}
            </span>
          </span>
          <ChevronRight />
        </Button>
      </div>
    );
  const row = (
    <Marker render={<span />}>
      <MarkerIcon>
        <ActivityIcon part={part} running={running} />
      </MarkerIcon>
      <MarkerContent className="activity-label flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        <span className={running ? "working-text" : undefined}>{activityLabel(part, running)}</span>
      </MarkerContent>
      {part.data.state === "failed" ? (
        <span className="activity-state text-danger">Failed</span>
      ) : null}
      {part.data.durationMs !== undefined ? (
        <span className="activity-time opacity-0 [transition:opacity_var(--ui-motion-duration)_ease]">
          {formatDuration(part.data.durationMs)}
        </span>
      ) : null}
      {part.data.detail ? (
        <ChevronRight className={open ? "rotated [transform:rotate(90deg)]" : ""} />
      ) : null}
    </Marker>
  );
  if (!part.data.detail)
    return (
      <div ref={arrivalRef} className="activity-item text-sm activity-item-trigger">
        {row}
      </div>
    );
  return (
    <Collapsible
      ref={arrivalRef}
      className="activity-item text-sm"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="activity-item-trigger h-auto justify-start px-2 py-1"
          />
        }
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="activity-detail m-[calc(var(--ui-space-unit)*2)_calc(var(--ui-space-unit)*2)_calc(var(--ui-space-unit)*3)_calc(var(--ui-space-unit)*8)] p-3 rounded-sm bg-surface max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
          {part.data.detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
