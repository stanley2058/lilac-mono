import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { ArrowUpRight } from "lucide-react";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { resourceUrl } from "../http";
import type { WorkflowCardLocation } from "../message-target-store";
import {
  closeWorkflowCard,
  openWorkflowCard,
  resetWorkflowBoard,
  workflowBoardStore,
  workflowCardFocused,
} from "../workflow-board-store";
import { useNewestFinishedRuns, useWorkflowRuns, type WorkflowSection } from "../workflow-runs";
import { useWorkspace } from "../workspace-context";
import { MessageServicesContext, type MessageServices } from "./message-services";
import { Button } from "./ui/button";
import { attempt, ErrorNotice, Modal, VirtualList } from "./ui";
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

type OpenThread = (threadId: string, source?: WorkflowCardLocation) => void;

export function WorkflowRunCard({
  run,
  onOpenThread,
  ...card
}: {
  run: WorkflowRunSummary;
  onOpenThread: OpenThread;
} & Pick<ComponentProps<typeof WorkflowCard>, "body" | "onOpen" | "selected">) {
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
    <MessageServicesContext value={services}>
      <WorkflowCard
        messageId={run.thread?.source?.messageId ?? run.id}
        card={run.card}
        actions={run.thread?.source?.actions}
        source={<WorkflowCardSource run={run} onOpen={onOpenThread} />}
        runId={run.id}
        {...card}
      />
    </MessageServicesContext>
  );
}

const BoardCard = memo(function BoardCard({
  run,
  onOpenThread,
}: {
  run: WorkflowRunSummary;
  onOpenThread: OpenThread;
}) {
  const selected = useStore(workflowBoardStore, (state) => state.focus?.runId === run.id);
  const takeFocus = useStore(
    workflowBoardStore,
    (state) => state.focus?.runId === run.id && state.focus.pending,
  );
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!takeFocus) return;
    root.current?.focus({ preventScroll: true });
    workflowCardFocused();
  }, [takeFocus]);
  return (
    <div ref={root} data-run-id={run.id} tabIndex={-1} className={workflowTrackRowClass}>
      <WorkflowRunCard
        run={run}
        onOpenThread={onOpenThread}
        body="preview"
        onOpen={() => openWorkflowCard(run.id)}
        selected={selected}
      />
    </div>
  );
});

/**
 * A run can briefly be in no list while it moves from active to ended, and the card updates live, so
 * the dialog reads the current run and keeps the last one it saw.
 */
function BoardDialog({
  sections,
  onOpenThread,
}: {
  sections: readonly WorkflowSection[];
  onOpenThread: OpenThread;
}) {
  const runId = useStore(workflowBoardStore, (state) => state.openRunId);
  const current = useMemo(
    () =>
      runId
        ? sections.flatMap((section) => section.runs).find((run) => run.id === runId)
        : undefined,
    [sections, runId],
  );
  const [held, setHeld] = useState<WorkflowRunSummary>();
  if (current && current !== held) setHeld(current);
  const run = current ?? held;
  if (!run) return null;
  return (
    <Modal open={!!runId} wide title="Workflow" onClose={closeWorkflowCard}>
      <WorkflowRunCard run={run} onOpenThread={onOpenThread} body="full" />
    </Modal>
  );
}

/** Holds the index from the moment of selection, so later list changes do not scroll the track. */
function useRevealTarget(runs: readonly WorkflowRunSummary[]) {
  const focus = useStore(workflowBoardStore, (state) => state.focus);
  const [target, setTarget] = useState<{ key: number; index: number }>();
  if (focus && focus.key !== target?.key)
    setTarget({ key: focus.key, index: runs.findIndex((run) => run.id === focus.runId) });
  return target && target.index >= 0 ? target : undefined;
}

export const workflowTrackListClass = "flex-1 [scrollbar-gutter:stable]";
export const workflowTrackRowClass = "pr-2 pb-3 outline-none";

/** The horizontally scrolling row of tracks. Phones snap to one track at a time. */
export function WorkflowBoardTracks({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-0 flex-1 scroll-px-6 gap-2 overflow-x-auto px-6 pt-2 pb-3 max-workspace:snap-x max-workspace:snap-mandatory max-workspace:scroll-px-3 max-workspace:px-3"
      data-ui="workflow-board"
    >
      {children}
    </div>
  );
}

export function WorkflowTrackFrame({
  ref,
  id,
  label,
  count,
  more = false,
  collapsed = false,
  children,
}: {
  ref?: Ref<HTMLElement>;
  id: string;
  label: string;
  count: number;
  more?: boolean;
  /** An empty track shrinks to its label so the tracks with runs stay in view. */
  collapsed?: boolean;
  children?: ReactNode;
}) {
  if (collapsed)
    return (
      <section
        ref={ref}
        data-ui="workflow-track"
        data-section={id}
        data-collapsed
        aria-label={label}
        className="flex w-8 shrink-0 snap-start flex-col items-center gap-2 pt-0.5 text-muted-foreground"
      >
        <span className="text-xs tabular-nums">{count}</span>
        <h2 className="m-0 text-sm font-medium [writing-mode:vertical-rl]">{label}</h2>
      </section>
    );
  return (
    <section
      ref={ref}
      data-ui="workflow-track"
      data-section={id}
      aria-label={label}
      className="flex min-h-0 w-84 max-w-[85vw] shrink-0 snap-start flex-col"
    >
      <h2 className="m-0 flex items-center gap-2 px-1 pb-2 text-sm font-medium">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
          {more ? "+" : ""}
        </span>
      </h2>
      {children}
    </section>
  );
}

function BoardTrack({
  section,
  loaded,
  more,
  loadable,
  loading,
  onLoadMore,
  onOpen,
}: {
  section: WorkflowSection;
  loaded: boolean;
  more: boolean;
  loadable: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onOpen: OpenThread;
}) {
  const reveal = useRevealTarget(section.runs);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (reveal) root.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [reveal]);
  return (
    <WorkflowTrackFrame
      ref={root}
      id={section.id}
      label={section.label}
      count={section.runs.length}
      more={more}
      collapsed={loaded && !section.runs.length && !loadable}
    >
      {loaded ? (
        <VirtualList
          items={section.runs}
          itemKey={(run) => run.id}
          label={section.label}
          className={workflowTrackListClass}
          estimate={260}
          hasMore={loadable}
          loading={loading}
          onEndReached={onLoadMore}
          reveal={reveal}
          // Active columns share a cursor, so an empty one would page through every active run.
          loadOnlyAfterScroll={section.list === "active"}
          render={(run) => <BoardCard run={run} onOpenThread={onOpen} />}
        />
      ) : (
        <Skeleton className="h-40 w-full rounded-xl" />
      )}
    </WorkflowTrackFrame>
  );
}

export function WorkflowBoard({ query, onOpen }: { query: string; onOpen: OpenThread }) {
  const queries = useQueryClient();
  const runs = useWorkflowRuns(query);
  useNewestFinishedRuns(query);
  useEffect(() => resetWorkflowBoard, []);

  // Runs that leave the active list show up in the ended lists, which are not polled.
  const previousActive = useRef(runs.activeIds);
  useEffect(() => {
    const current = new Set(runs.activeIds);
    const ended = previousActive.current.some((id) => !current.has(id));
    previousActive.current = runs.activeIds;
    if (!ended) return;
    void queries.invalidateQueries({ queryKey: ["workflows", "failed"] });
    void queries.invalidateQueries({ queryKey: ["workflows", "done"] });
  }, [runs.activeIds, queries]);

  const empty = runs.loaded && runs.sections.every((section) => !section.runs.length);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="thread-header flex items-center gap-2 h-[var(--ui-header-height)] min-h-0 px-6 py-0.5 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15">
        <h1 className="m-0 truncate text-base font-medium">Workflows</h1>
      </header>
      <ErrorNotice message={runs.error} />
      {empty ? (
        <p className="m-0 py-16 text-center text-sm text-muted-foreground">
          {query ? "No matching workflows" : "No workflows yet"}
        </p>
      ) : (
        <WorkflowBoardTracks>
          {runs.sections.map((section) => (
            <BoardTrack
              key={section.id}
              section={section}
              loaded={runs.loaded}
              more={runs.more[section.list]}
              loadable={runs.loadable[section.list]}
              loading={runs.fetching[section.list]}
              onLoadMore={() => runs.loadMore(section.list)}
              onOpen={onOpen}
            />
          ))}
        </WorkflowBoardTracks>
      )}
      <BoardDialog sections={runs.sections} onOpenThread={onOpen} />
    </div>
  );
}
