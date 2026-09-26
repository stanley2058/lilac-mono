import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import { ArrowUpToLine, ArrowDownToLine } from "lucide-react";
import { CopyReferenceButton, useConversation } from "./ConversationReference";
import { useOptionalWorkspace } from "../workspace-context";
import { Message } from "./Timeline";
import { Skeleton } from "./ui/skeleton";

function noop() {}

function ConversationDivider({
  messages,
  index,
}: {
  messages: readonly DisplayMessage[];
  index: number;
}) {
  const workspace = useOptionalWorkspace();
  const conversation = useConversation();
  function targetFor(message: DisplayMessage) {
    const ref = message.metadata?.reference ?? conversation;
    if (!ref) return;
    return { surface: ref.surface, sessionId: ref.sessionId, messageId: message.id };
  }
  async function rangeFor(message: DisplayMessage) {
    const target = targetFor(message);
    if (!target) return;
    if (workspace?.client.rpc) return workspace.client.rpc.references.range(target);
    const group = messages.filter(
      (item) => item.metadata?.externalRunId === message.metadata?.externalRunId,
    );
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return;
    return {
      surface: target.surface,
      sessionId: target.sessionId,
      range: { startMessageId: first.id, endMessageId: last.id },
    };
  }
  return (
    <div
      className="mx-6 my-4 flex items-center gap-1"
      role="group"
      aria-label="Conversation divider"
    >
      <div className="h-px flex-1 bg-border" />
      <div className="flex">
        <CopyReferenceButton
          label="Copy link to thread above"
          disabled={!targetFor(messages[index - 1]!)}
          resolveTarget={() => rangeFor(messages[index - 1]!)}
        >
          <ArrowUpToLine />
        </CopyReferenceButton>
        <CopyReferenceButton
          label="Copy link to thread below"
          disabled={!targetFor(messages[index]!)}
          resolveTarget={() => rangeFor(messages[index]!)}
        >
          <ArrowDownToLine />
        </CopyReferenceButton>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function ExternalMessages({
  messages,
  resourceUrl,
  loadDirection,
  hasMore,
  loading,
  onLoadMore,
  targetMessageId,
}: {
  messages: readonly DisplayMessage[];
  resourceUrl: (id: string) => string;
  loadDirection: "start" | "end";
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  targetMessageId?: string;
}) {
  const navigated = useRef<string>(undefined);
  const parent = useRef<HTMLDivElement>(null);
  const [positioning, setPositioning] = useState(0);
  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getItemKey,
    getScrollElement: () => parent.current,
    estimateSize: () => 160,
    overscan: 3,
    anchorTo: "end",
    followOnAppend: true,
    // Measure the tail before positioning the normal virtual window at the bottom.
    rangeExtractor: (range) => {
      if (positioning > 0) return defaultRangeExtractor(range);
      const tail: number[] = [];
      for (let index = Math.max(0, range.count - 5); index < range.count; index++) tail.push(index);
      return tail;
    },
  });
  useLayoutEffect(() => {
    if (positioning >= 2) return;
    virtual.scrollToEnd();
    setPositioning((value) => value + 1);
  });
  useLayoutEffect(() => {
    if (!targetMessageId || positioning < 2 || navigated.current === targetMessageId) return;
    const index = messages.findIndex(
      (message) =>
        message.id === targetMessageId ||
        message.metadata?.reference?.messageId === targetMessageId,
    );
    if (index < 0) return;
    virtual.scrollToIndex(index, { align: "center" });
    const element = parent.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    navigated.current = targetMessageId;
  });
  const total = virtual.getTotalSize();
  const offset = virtual.scrollOffset ?? 0;
  const remaining = total - offset - (virtual.scrollRect?.height ?? 0);
  const nearEdge = loadDirection === "start" ? offset < 160 : remaining < 160;
  const loadMore = useEffectEvent(onLoadMore);
  useEffect(() => {
    if (positioning < 2 || !nearEdge || !hasMore || loading) return;
    const viewport = parent.current;
    if (!viewport) return;
    const distance =
      loadDirection === "start"
        ? viewport.scrollTop
        : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distance < 160) loadMore();
  }, [positioning, nearEdge, hasMore, loading, messages.length, loadDirection]);
  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={parent}
        className="external-messages overflow-auto min-h-0 flex-1 relative [overflow-anchor:none]"
        role="log"
        aria-label="External conversation"
        aria-busy={loading || undefined}
      >
        <div className="relative w-full" style={{ height: total }}>
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.key}
              ref={virtual.measureElement}
              data-index={row.index}
              className={`absolute top-0 left-0 w-full ${targetMessageId && (messages[row.index]!.id === targetMessageId || messages[row.index]!.metadata?.reference?.messageId === targetMessageId) ? "bg-accent" : ""}`}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {row.index > 0 &&
              messages[row.index]!.metadata?.externalRunId !==
                messages[row.index - 1]!.metadata?.externalRunId ? (
                <ConversationDivider messages={messages} index={row.index} />
              ) : null}
              <Message
                message={messages[row.index]!}
                canEdit={false}
                resourceUrl={resourceUrl}
                onAction={noop}
                onReaction={noop}
              />
            </div>
          ))}
        </div>
      </div>
      {loading ? (
        <div
          className="absolute top-0 inset-x-0 px-6 py-1 pointer-events-none"
          role="status"
          aria-label="Loading messages"
        >
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}
    </div>
  );
}
