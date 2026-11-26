import { useMessageTouchMenu } from "./use-message-touch-menu";
import { sameMessageAuthor } from "../message-grouping";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./ui/context-menu";
import { AddReaction, MessageReactions } from "./MessageReactions";
import { CopyReferenceButton, copyReferenceLink, useConversation } from "./ConversationReference";
import {
  Activity,
  ActivitySourceContext,
  ActivityTimesContext,
  ElapsedTime,
  LiveThinkingRow,
  LiveTailContext,
  RequestActiveContext,
} from "./ActivityLog";
import { formatDuration } from "../activity-presentation";
import {
  groupActivityMessages,
  partitionTurnMessages,
  workSegmentKeyForMessage,
  type ResourcePart,
  type TurnSegment,
  type WorkSegment,
} from "../turn-segments";
import { copyMessage, messageClipboard } from "../message-clipboard";
import { LiveMessageContext, useMessageArrival } from "./message-arrivals";
import {
  DisplayStreamContext,
  MessageServicesContext,
  useMessageServices,
} from "./message-services";
import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useId,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleSlash,
  RotateCcw,
  Copy,
  CopyCheck,
  Link2,
} from "lucide-react";
import {
  type DisplayMessage,
  type ReadyTurnSlot,
  type DisplayPart,
} from "@stanley2058/lilac-client-protocol";
import { rewindRestrictionReason, rewindTooltipText } from "../rewind-policy";
import { aroundTurnGap, isIncoming, isPrompt, isTurnLeadIn, unloadedPlace } from "../turn-gap";
import { IconButton, attempt } from "./ui";
import { WorkVerb, useSettledWorkVerb } from "./WorkVerb";
import { ResourceAttachment } from "./ResourceAttachment";
import { ActorAvatar, type ActorIdentity } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";
import { MessageResourcesContext } from "./message-resources";
import { HtmlPreviewMessageContext } from "./HtmlPreview";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Markdown } from "./Markdown";
import { citationStore } from "../citation-store";
import { useStore } from "zustand";
import { WorkflowCard } from "./WorkflowCard";
import { QuestionCard } from "./QuestionCard";
import { readMotionDuration } from "../theme/motion";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Message as ChatMessage, MessageContent, MessageAvatar } from "./ui/message";
import { Marker, MarkerContent } from "./ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  type TimelineProps,
  TimelineContext,
  RewindRestrictionContext,
  useMessageServicesValue,
} from "./timeline-context";

export type TurnProps = {
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
export function workflowCardMessage(slot: ReadyTurnSlot) {
  const [message] = slot.messages;
  if (slot.messages.length !== 1 || !message) return undefined;
  const card = message.parts.find((part) => part.type === "data-workflow");
  if (!card) return undefined;
  const actions = message.parts.find((part) => part.type === "data-actions");
  return { messageId: message.id, card: card.data, actions };
}

export function WorkflowTurn({
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

export function AgentTurn(props: TurnProps) {
  const { onRewind, onLoadMore } = props;
  const { canEdit, rewindDisabled } = useMessageServices();
  const restriction = useContext(RewindRestrictionContext);
  const { slot } = props;
  let reason = rewindRestrictionReason(restriction, slot.turnId);
  if (!reason && rewindDisabled) reason = "busy";
  if (!reason && (props.optimistic || slot.state === "pending")) reason = "unsettled";
  const rewindTooltip = reason ? rewindTooltipText(reason) : undefined;
  const [expandedSegments, setExpandedSegments] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSegment = useCallback((key: string, open: boolean) => {
    setExpandedSegments((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const messages = useMemo(
    () => (slot.partsCursor ? aroundTurnGap(slot.messages, isTurnLeadIn) : slot.messages),
    [slot.messages, slot.partsCursor],
  );
  const firstUser = messages.find(isPrompt);
  const incomingMessage = messages.find(isIncoming);
  const settled = slot.state === "complete" || slot.state === "failed" || slot.state === "canceled";
  const completed = slot.state === "complete";
  const rawRemaining = useMemo(
    () =>
      messages.filter(
        (message) => message.id !== firstUser?.id && message.id !== incomingMessage?.id,
      ),
    [messages, firstUser?.id, incomingMessage?.id],
  );
  // Start times never change, so one stable map keeps streaming updates from rerendering every row.
  const [times] = useState(() => new Map<string, number>());
  recordActivityTimes(times, messages);
  const identities = useContext(MessageIdentityContext);
  const startedAt =
    slot.startedAt ?? firstUser?.metadata?.createdAt ?? incomingMessage?.metadata?.createdAt;
  const duration =
    startedAt !== undefined && slot.settledAt !== undefined
      ? Math.max(0, slot.settledAt - startedAt)
      : undefined;
  const settledVerb = useSettledWorkVerb(slot.turnId, duration);
  const completedSegments = useMemo(
    () =>
      completed
        ? partitionTurnMessages(rawRemaining, { startedAt, settledAt: slot.settledAt })
        : undefined,
    [completed, rawRemaining, startedAt, slot.settledAt],
  );
  const remaining = useMemo(
    () => (completed ? [] : groupActivityMessages(rawRemaining)),
    [completed, rawRemaining],
  );
  const citedMessage = useStore(citationStore, (state) => {
    const id = state.navigation?.citation.messageId;
    return props.slot.messages.some((message) => message.id === id) ? id : undefined;
  });
  useEffect(() => {
    if (!citedMessage || !completedSegments) return;
    const key = workSegmentKeyForMessage(completedSegments, citedMessage);
    if (!key) return;
    setExpandedSegments((current) => (current.has(key) ? current : new Set([...current, key])));
  }, [citedMessage, completedSegments]);
  // Live/failed/canceled turns stay unfolded in arrival order; trailing finals still drive thinkingAfter.
  const lastIntermediate = completed
    ? -1
    : remaining.findLastIndex(
        (message) =>
          message.role !== "assistant" ||
          (message.metadata?.phase !== "final" &&
            !message.parts.some((part) => part.type === "data-question")),
      );
  const intermediate = completed ? [] : remaining.slice(0, lastIntermediate + 1);
  const finals = completed ? [] : remaining.slice(lastIntermediate + 1);
  const active = slot.state === "pending" || slot.state === "running";
  const waiting = active && !remaining.some((message) => message.role === "assistant");
  // A running turn always ends in a live row: the trailing activity run, or Thinking after text.
  const tail = completed || waiting ? undefined : liveTailActivity(remaining);
  const thinkingAfter =
    active && !waiting && !tail && !finals.length && !remaining.at(-1)?.metadata?.incomplete;
  const hasRemaining = completed ? (completedSegments?.length ?? 0) > 0 : remaining.length > 0;
  const firstRemaining = completed ? completedSegments?.[0]?.messages[0] : remaining[0];
  const incomingContinues = sameMessageAuthor(incomingMessage, firstRemaining);
  const incomingSpacing = incomingContinues ? "mb-2" : "mb-4";
  const hasLeadIn = !!firstUser || !!incomingMessage;
  const displayStream = useContext(DisplayStreamContext);
  const timelineThreadId = useContext(TimelineContext)?.threadId;
  const activitySource = useMemo(() => {
    const target =
      displayStream ??
      (timelineThreadId ? { kind: "thread" as const, threadId: timelineThreadId } : undefined);
    return target ? { target, turnId: slot.turnId } : undefined;
  }, [displayStream, timelineThreadId, slot.turnId]);
  const loadMore = slot.partsCursor ? (
    <Button
      variant="ghost"
      className="mb-4 text-primary py-2 px-3 text-sm"
      type="button"
      data-ui="turn-load-more"
      onClick={onLoadMore}
    >
      Load more of this turn
    </Button>
  ) : null;
  const gap = slot.partsCursor ? unloadedPlace(slot.messages) : undefined;
  return (
    <article
      className={`turn px-6 max-workspace:px-4 ${props.joinedBefore ? "pt-0" : "pt-1"} ${props.joinedAfter ? "pb-0" : "pb-8 max-workspace:pb-7"}`}
      data-joined-before={props.joinedBefore || undefined}
      data-joined-after={props.joinedAfter || undefined}
      data-turn-id={slot.turnId}
    >
      {gap === "top" ? loadMore : null}
      {firstUser ? (
        <div
          className={`user-turn ml-12 max-workspace:ml-6 ${active || hasRemaining ? "mb-10" : ""}`}
        >
          <MessageBody
            live={props.animateArrivals ?? true}
            message={firstUser}
            showAvatar={!props.joinedBefore}
            showControls={!(props.joinedAfter && !hasRemaining)}
            rewind={
              canEdit && firstUser.metadata?.authorId === identities.viewerId
                ? {
                    disabled: !!rewindTooltip,
                    run: () => onRewind(slot.turnId),
                    reason: rewindTooltip,
                  }
                : undefined
            }
            renderKey={props.userRenderKey}
            optimistic={props.optimistic}
            controls={
              <>
                {canEdit && firstUser.metadata?.authorId === identities.viewerId ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex" tabIndex={rewindTooltip ? 0 : undefined} />
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="icon-button rounded-sm text-muted-foreground"
                        aria-label="Rewind to this turn"
                        disabled={!!rewindTooltip}
                        onClick={() => onRewind(slot.turnId)}
                      >
                        <RotateCcw />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{rewindTooltip ?? "Rewind to this turn"}</TooltipContent>
                  </Tooltip>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
      {incomingMessage ? (
        <div className={props.joinedAfter && !hasRemaining ? "mb-0" : incomingSpacing}>
          <MessageBody
            message={incomingMessage}
            live={props.animateArrivals ?? true}
            showAvatar={!props.joinedBefore}
            showControls={!incomingContinues && !(props.joinedAfter && !hasRemaining)}
          />
        </div>
      ) : null}
      {gap === "after-first" ? loadMore : null}
      <RequestActiveContext value={!settled}>
        <ActivitySourceContext value={activitySource}>
          <LiveTailContext value={tail}>
            <ActivityTimesContext value={times}>
              <div className="agent-response flex flex-col gap-2">
                {completedSegments ? (
                  <CompletedTurnSegments
                    segments={completedSegments}
                    expandedSegments={expandedSegments}
                    onToggleSegment={toggleSegment}
                    settledVerb={settledVerb}
                    agent={identities.agent}
                    animateArrivals={props.animateArrivals ?? true}
                    joinedBefore={props.joinedBefore}
                    joinedAfter={props.joinedAfter}
                    hasLeadIn={hasLeadIn}
                    incomingContinues={incomingContinues}
                    posts={props.posts}
                  />
                ) : (
                  <>
                    {!incomingContinues &&
                    (!props.joinedBefore || hasLeadIn) &&
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
                    <TurnMessages
                      messages={intermediate}
                      live={!settled}
                      showFirstAvatar={false}
                      inResponse
                      hasFollowing={
                        !!props.posts?.length || waiting || thinkingAfter || finals.length > 0
                      }
                    />
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
                      inResponse
                    />
                  </>
                )}
              </div>
            </ActivityTimesContext>
          </LiveTailContext>
        </ActivitySourceContext>
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
      {gap === "end" ? loadMore : null}
    </article>
  );
}

export function recordActivityTimes(
  times: Map<string, number>,
  messages: readonly DisplayMessage[],
) {
  for (const message of messages) {
    const createdAt = message.metadata?.createdAt;
    if (createdAt === undefined) continue;
    for (const part of message.parts)
      if (part.type === "data-activity" && !times.has(part.id)) times.set(part.id, createdAt);
  }
}

/** The last activity of a turn when nothing but activity follows it. */
export function liveTailActivity(messages: readonly DisplayMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const part = last.parts.at(-1);
  return part?.type === "data-activity" ? part.id : undefined;
}

export function TurnParticipants({ messages }: { messages: readonly DisplayMessage[] }) {
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

function workSegmentLabel(segment: WorkSegment, settledVerb: string): string {
  const verb = segment.workIndex === 0 ? settledVerb : "Continued";
  if (segment.durationMs === undefined) return verb;
  return `${verb} for ${formatDuration(segment.durationMs)}`;
}

function workflowPostTargetMessageId(
  finalMessages: readonly DisplayMessage[],
  post: ReadyTurnSlot,
): string | undefined {
  const postedAt = post.messages[0]?.metadata?.createdAt;
  if (postedAt !== undefined) {
    const match = finalMessages.find((message) => {
      const replyAt = message.metadata?.createdAt;
      return replyAt !== undefined && replyAt > postedAt;
    });
    if (match) return match.id;
  }
  return finalMessages.at(-1)?.id;
}

function WorkSegmentCollapsible({
  segment,
  label,
  open,
  onOpenChange,
}: {
  segment: WorkSegment;
  label: string;
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={(next) => onOpenChange(segment.key, next)}>
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
          <span>{label}</span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 opacity-70 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-ui="expanded-work"
        className="expanded-work flex flex-col gap-2 pt-2"
      >
        <TurnMessages messages={segment.messages} live={false} showFirstAvatar={false} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function renderWorkSegmentRow({
  segment,
  index,
  needsAvatar,
  agent,
  label,
  open,
  onToggleSegment,
}: {
  segment: WorkSegment;
  index: number;
  needsAvatar: boolean;
  agent: ActorIdentity;
  label: string;
  open: boolean;
  onToggleSegment: (key: string, open: boolean) => void;
}): ReactNode {
  const collapsible = (
    <WorkSegmentCollapsible
      segment={segment}
      label={label}
      open={open}
      onOpenChange={onToggleSegment}
    />
  );
  if (needsAvatar && index === 0) {
    return (
      <Fragment key={segment.key}>
        <AuthorAvatar author={agent} role="Agent" />
        {collapsible}
      </Fragment>
    );
  }
  if (needsAvatar) {
    return (
      <div key={segment.key} className="agent-work-section relative flex flex-col gap-2">
        <AuthorAvatar author={agent} role="Agent" />
        {collapsible}
      </div>
    );
  }
  return <Fragment key={segment.key}>{collapsible}</Fragment>;
}

function CompletedTurnSegments({
  segments,
  expandedSegments,
  onToggleSegment,
  settledVerb,
  agent,
  animateArrivals,
  joinedBefore,
  joinedAfter,
  hasLeadIn,
  incomingContinues,
  posts,
}: {
  segments: readonly TurnSegment[];
  expandedSegments: ReadonlySet<string>;
  onToggleSegment: (key: string, open: boolean) => void;
  settledVerb: string;
  agent: ActorIdentity;
  animateArrivals: boolean;
  joinedBefore?: boolean;
  joinedAfter?: boolean;
  hasLeadIn: boolean;
  incomingContinues: boolean;
  posts?: readonly ReadyTurnSlot[];
}) {
  const finalMessages = segments.flatMap((segment) =>
    segment.kind === "visible" && segment.role === "assistant"
      ? segment.messages.filter((message) => message.metadata?.phase === "final")
      : [],
  );
  const postsBeforeMessage = new Map<string, ReadyTurnSlot[]>();
  const trailingPosts: ReadyTurnSlot[] = [];
  for (const post of posts ?? []) {
    const targetId = workflowPostTargetMessageId(finalMessages, post);
    if (!targetId) {
      trailingPosts.push(post);
      continue;
    }
    const bucket = postsBeforeMessage.get(targetId);
    if (bucket) bucket.push(post);
    else postsBeforeMessage.set(targetId, [post]);
  }
  const renderPosts = (items: readonly ReadyTurnSlot[]) =>
    items.map((post) => {
      const workflow = workflowCardMessage(post);
      return workflow ? <WorkflowCard key={post.slotId} {...workflow} /> : null;
    });
  let lastRole: "agent" | "user" | undefined =
    incomingContinues || (joinedBefore && !hasLeadIn) ? "agent" : undefined;
  const rows: ReactNode[] = [];
  for (const [index, segment] of segments.entries()) {
    const hasFollowing = index < segments.length - 1 || trailingPosts.length > 0;
    if (segment.kind === "work") {
      const needsAvatar = lastRole !== "agent";
      lastRole = "agent";
      rows.push(
        renderWorkSegmentRow({
          segment,
          index,
          needsAvatar,
          agent,
          label: workSegmentLabel(segment, settledVerb),
          open: expandedSegments.has(segment.key),
          onToggleSegment,
        }),
      );
      continue;
    }
    if (segment.role === "user") {
      lastRole = "user";
      rows.push(
        <TurnMessages
          key={segment.key}
          messages={segment.messages}
          live={animateArrivals}
          showFirstAvatar
          inResponse
          hasFollowing={hasFollowing}
        />,
      );
      continue;
    }
    const needsAvatar = lastRole !== "agent";
    lastRole = "agent";
    const hideControls = index === segments.length - 1 && !!joinedAfter;
    const lastAssistant = segment.messages.findLast(
      (message) =>
        message.role === "assistant" &&
        (message.parts.some((part) => part.type === "text" || part.type === "data-resource") ||
          (segment.trailingAttachments.get(message.id)?.length ?? 0) > 0),
    );
    const extraParts = [...segment.trailingAttachments.values()].flat();
    rows.push(
      <TurnMessages
        key={segment.key}
        messages={segment.messages}
        live={animateArrivals}
        showFirstAvatar={needsAvatar}
        finalMessageId={hideControls ? undefined : lastAssistant?.id}
        finalText={segment.messages.map(messageText).filter(Boolean).join("\n\n")}
        trailingAttachments={segment.trailingAttachments}
        extraCopyParts={extraParts.length ? extraParts : undefined}
        postsBeforeMessage={postsBeforeMessage.size ? postsBeforeMessage : undefined}
        inResponse
        hasFollowing={hasFollowing}
      />,
    );
  }
  if (trailingPosts.length) {
    rows.push(<Fragment key="turn-posts:end">{renderPosts(trailingPosts)}</Fragment>);
  }
  return rows;
}

export function TurnMessages({
  messages,
  live,
  showFirstAvatar = true,
  finalMessageId,
  finalText,
  trailingAttachments,
  extraCopyParts,
  postsBeforeMessage,
  inResponse = false,
  hasFollowing = false,
}: {
  messages: readonly DisplayMessage[];
  live: boolean;
  showFirstAvatar?: boolean;
  finalMessageId?: string;
  finalText?: string;
  trailingAttachments?: ReadonlyMap<string, readonly ResourcePart[]>;
  extraCopyParts?: readonly DisplayPart[];
  postsBeforeMessage?: ReadonlyMap<string, readonly ReadyTurnSlot[]>;
  inResponse?: boolean;
  hasFollowing?: boolean;
}) {
  let nextAssistantAvatar = showFirstAvatar;
  return messages.map((message, index) => {
    const showAvatar =
      (message.role === "user" && !sameMessageAuthor(messages[index - 1], message)) ||
      (message.role === "assistant" &&
        (nextAssistantAvatar || (index > 0 && !sameMessageAuthor(messages[index - 1], message))));
    if (message.role === "user") nextAssistantAvatar = true;
    if (message.role === "assistant") nextAssistantAvatar = false;
    const trailing = trailingAttachments?.get(message.id);
    const showControls =
      (message.role === "user" && !sameMessageAuthor(message, messages[index + 1])) ||
      message.id === finalMessageId;
    const spacingClass = inResponse
      ? [
          message.role === "user" ? "not-first:mt-4" : "",
          showControls && (hasFollowing || index < messages.length - 1)
            ? "[@media(hover:hover)]:mb-7"
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : undefined;
    const beforePosts = postsBeforeMessage?.get(message.id);
    const body = (
      <MessageBody
        key={message.id}
        message={message}
        live={live}
        showAvatar={showAvatar}
        showControls={showControls}
        copyText={message.id === finalMessageId ? finalText : undefined}
        copyParts={
          message.id === finalMessageId
            ? [...messages.flatMap((item) => item.parts), ...(extraCopyParts ?? [])]
            : undefined
        }
        trailingAttachments={trailing}
        className={spacingClass || undefined}
      />
    );
    if (!beforePosts?.length) return body;
    return (
      <Fragment key={message.id}>
        {beforePosts.map((post) => {
          const workflow = workflowCardMessage(post);
          return workflow ? <WorkflowCard key={post.slotId} {...workflow} /> : null;
        })}
        {body}
      </Fragment>
    );
  });
}

export function AuthorAvatar({
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

export { groupActivityMessages, partitionTurnMessages } from "../turn-segments";

export function messageText(message: DisplayMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
export type MessageProps = Pick<
  TimelineProps,
  "canEdit" | "resourceUrl" | "upload" | "onAction" | "onReaction"
> & {
  message: DisplayMessage;
  controls?: ReactNode;
};
export type Group =
  | { kind: "text"; text: string }
  | { kind: "activity"; parts: Extract<DisplayPart, { type: "data-activity" }>[] }
  | { kind: "part"; part: Exclude<DisplayPart, { type: "text" | "data-activity" }> };
/** A workflow card shows its own controls, and its text is a summary for other surfaces. */
export function visibleParts(parts: readonly DisplayPart[]): readonly DisplayPart[] {
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

export type MessageCardGroup = {
  kind: "content";
  texts: string[];
  attachments: Extract<DisplayPart, { type: "data-resource" }>[];
};
export type CardGroup =
  | MessageCardGroup
  | Extract<Group, { kind: "activity" }>
  | {
      kind: "part";
      part: Exclude<DisplayPart, { type: "text" | "data-activity" | "data-resource" }>;
    };

export function groupMessageCards(groups: readonly Group[]): CardGroup[] {
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

export function MessageCard({
  content,
  self,
  collapsible,
  streaming,
  arrivalId,
  reactions,
  trailingAttachments,
}: {
  reactions?: ReactNode;
  arrivalId: string;
  content: MessageCardGroup;
  self: boolean;
  collapsible: boolean;
  streaming: boolean;
  trailingAttachments?: readonly ResourcePart[];
}) {
  const arrivalRef = useMessageArrival(
    arrivalId,
    content.texts.some(Boolean) ||
      content.attachments.length > 0 ||
      (trailingAttachments?.length ?? 0) > 0,
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
  const bottomAttachments = trailingAttachments?.length
    ? [...files, ...trailingAttachments]
    : files;
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
            {bottomAttachments.length > 0 ? (
              <div
                data-ui="message-attachments"
                className={`message-attachments flex flex-wrap items-start gap-2 ${
                  trailingAttachments?.length && (content.texts.length > 0 || images.length > 0)
                    ? "mt-3"
                    : ""
                }`}
              >
                {bottomAttachments.map((part) => (
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

export const MessageBody = memo(function MessageBody(
  props: Pick<MessageProps, "message" | "controls"> & {
    live?: boolean;
    showAvatar?: boolean;
    showControls?: boolean;
    copyText?: string;
    copyParts?: readonly DisplayPart[];
    trailingAttachments?: readonly ResourcePart[];
    className?: string;
    renderKey?: string;
    optimistic?: boolean;
    rewind?: { disabled: boolean; reason?: string; run: () => void };
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
  const conversational =
    (props.trailingAttachments?.length ?? 0) > 0 ||
    groups.some(
      (group) =>
        group.kind === "text" || (group.kind === "part" && group.part.type === "data-resource"),
    );
  let authorRole = externalAuthor ? "User" : "Participant";
  if (identities.promptingAgent)
    authorRole = identities.promptingAgent.agentProfile ? "Parent agent" : "Main agent";
  if (message.role === "assistant") authorRole = "Agent";
  else if (authorId !== undefined && authorId === identities.viewerId) authorRole = "You";
  const self =
    message.role === "user" && authorId !== undefined && authorId === identities.viewerId;
  const attachments = useMemo(
    () => [
      ...message.parts.filter((part) => part.type === "data-resource"),
      ...(props.trailingAttachments ?? []),
    ],
    [message.parts, props.trailingAttachments],
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
        const fallbackParts = props.trailingAttachments?.length
          ? [...message.parts, ...props.trailingAttachments]
          : message.parts;
        await copyMessage(messageClipboard(copyText, props.copyParts ?? fallbackParts));
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
              className={`message leading-normal ${conversational ? "py-0.5" : "py-0"} px-0 wrap-anywhere message-${message.role} native-message text-base${props.className ? ` ${props.className}` : ""}`}
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
                        trailingAttachments={
                          index === lastContent ? props.trailingAttachments : undefined
                        }
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
          {props.rewind ? <RewindContextMenuItem {...props.rewind} /> : null}
          {copyError ? <span role="status">{copyError}</span> : null}
        </ContextMenuContent>
      </ContextMenu>
    </LiveMessageContext>
  );
});

function RewindContextMenuItem({
  disabled,
  reason,
  run,
}: {
  disabled: boolean;
  reason?: string;
  run: () => void;
}) {
  const item = (
    <ContextMenuItem disabled={disabled} onClick={run}>
      <RotateCcw />
      Rewind to this turn
    </ContextMenuItem>
  );
  if (!disabled || !reason) return item;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{item}</TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  );
}
