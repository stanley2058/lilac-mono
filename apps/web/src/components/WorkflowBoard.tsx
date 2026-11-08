import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { ArrowUpRight } from "lucide-react";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { resourceUrl } from "../http";
import type { WorkflowCardLocation } from "../message-target-store";
import { setVisibleWorkflowCards, workflowBoardStore } from "../workflow-board-store";
import { useNewestFinishedRuns, useWorkflowRuns } from "../workflow-runs";
import { useWorkspace } from "../workspace-context";
import { MessageServicesContext, type MessageServices } from "./message-services";
import { Button } from "./ui/button";
import { attempt, ErrorNotice } from "./ui";
import { toast } from "./ui/toast";
import { Skeleton } from "./ui/skeleton";
import { WorkflowCard } from "./WorkflowCard";

const platforms: Record<string, string> = { discord: "Discord", github: "GitHub" };

export function WorkflowCardSource({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary;
  onOpen: (threadId: string, source?: WorkflowCardLocation) => void;
}) {
  const thread = run.thread;
  if (!thread)
    return (
      <p className="m-0 text-xs text-muted-foreground">
        {(run.platform && platforms[run.platform]) ?? "No conversation"}
      </p>
    );
  const title = thread.title || "Untitled";
  return (
    <Button
      variant="ghost"
      size="sm"
      data-ui="workflow-open-thread"
      aria-label={`Open ${title}`}
      className="-ml-2 max-w-full justify-start gap-1 self-start px-2 text-muted-foreground"
      onClick={() => onOpen(thread.id, thread.source)}
    >
      <span className="min-w-0 truncate">{title}</span>
      <ArrowUpRight className="flex-none" aria-hidden="true" />
    </Button>
  );
}

const BoardCard = memo(function BoardCard({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary;
  onOpen: (threadId: string, source?: WorkflowCardLocation) => void;
}) {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const threadId = run.thread?.id;
  const services = useMemo<MessageServices>(
    () => ({
      // The server only sends actions to viewers who can edit the thread.
      canEdit: true,
      resourceUrl,
      onReaction: () => {},
      onAction: (messageId, part, actionId) => {
        if (!client.rpc || !threadId) return;
        void attempt(
          () =>
            client.rpc!.actions.invoke({
              threadId,
              messageId,
              actionId,
              requestId: part.data.requestId,
              revision: part.data.revision,
              commandId: crypto.randomUUID(),
            }),
          (message) => toast.add({ title: message, type: "error" }),
        ).then(() => queries.invalidateQueries({ queryKey: ["workflows"] }));
      },
    }),
    [client, queries, threadId],
  );
  return (
    <div
      data-run-id={run.id}
      tabIndex={-1}
      className="scroll-mt-[calc(var(--ui-header-height)+var(--ui-space-unit)*2)] outline-none"
    >
      <MessageServicesContext value={services}>
        <WorkflowCard
          messageId={run.thread?.source?.messageId ?? run.id}
          card={run.card}
          actions={run.thread?.source?.actions}
          source={<WorkflowCardSource run={run} onOpen={onOpen} />}
        />
      </MessageServicesContext>
    </div>
  );
});

function useVisibleCards(root: React.RefObject<HTMLDivElement | null>, signature: string) {
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target instanceof HTMLElement ? entry.target.dataset.runId : undefined;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setVisibleWorkflowCards(new Set(visible));
      },
      { root: container },
    );
    for (const card of container.querySelectorAll("[data-run-id]")) observer.observe(card);
    return () => {
      observer.disconnect();
      setVisibleWorkflowCards(new Set());
    };
  }, [root, signature]);
}

export function WorkflowBoard({
  onOpen,
}: {
  onOpen: (threadId: string, source?: WorkflowCardLocation) => void;
}) {
  const queries = useQueryClient();
  const runs = useWorkflowRuns();
  useNewestFinishedRuns();
  const ordered = runs.sections.flatMap((section) => section.runs);
  const root = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useVisibleCards(root, ordered.map((run) => run.id).join());

  const focus = useStore(workflowBoardStore, (state) => state.focus);
  useLayoutEffect(() => {
    if (!focus) return;
    const card = root.current?.querySelector<HTMLElement>(
      `[data-run-id="${CSS.escape(focus.runId)}"]`,
    );
    card?.scrollIntoView({ block: "start" });
    card?.focus({ preventScroll: true });
  }, [focus]);

  // Runs that leave the active list show up in the finished one, which is not polled.
  const previousActive = useRef(runs.activeIds);
  useEffect(() => {
    const current = new Set(runs.activeIds);
    const ended = previousActive.current.some((id) => !current.has(id));
    previousActive.current = runs.activeIds;
    if (ended) void queries.invalidateQueries({ queryKey: ["workflows", "finished"] });
  }, [runs.activeIds, queries]);

  const more = runs.moreActive || runs.moreFinished;
  const { loadMore } = runs;
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const sentinel = end.current;
    if (!sentinel || !more) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadMoreRef.current();
      },
      { root: root.current, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [more, ordered.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="thread-header flex items-center gap-2 h-[var(--ui-header-height)] min-h-0 px-6 py-0.5 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15">
        <h1 className="m-0 truncate text-base font-medium">Workflows</h1>
      </header>
      <div ref={root} className="min-h-0 flex-1 overflow-y-auto" data-ui="workflow-board">
        <div className="mx-auto flex w-full max-w-[var(--ui-chat-width)] flex-col gap-3 px-6 pt-2 pb-6 max-workspace:px-3">
          <ErrorNotice message={runs.error} />
          {!runs.loaded && !runs.error
            ? [0, 1, 2].map((index) => <Skeleton key={index} className="h-40 w-full rounded-xl" />)
            : null}
          {runs.loaded && ordered.length === 0 ? (
            <p className="m-0 py-16 text-center text-sm text-muted-foreground">No workflows yet</p>
          ) : null}
          {ordered.map((run) => (
            <BoardCard key={run.id} run={run} onOpen={onOpen} />
          ))}
          <div ref={end} aria-hidden="true" className="h-px" />
        </div>
      </div>
    </div>
  );
}
