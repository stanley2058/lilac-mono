import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { WorkflowCard, WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { attempt } from "./components/ui";
import { queryNativeRPC, useNativeOnline, workflowRunsOptions } from "./queries";
import { useWorkspace } from "./workspace-context";

type WorkflowStatus = WorkflowCard["status"];

const sections = [
  {
    id: "attention",
    label: "Needs attention",
    statuses: ["needs-attention", "waiting-reply", "blocked"],
    finished: false,
  },
  { id: "running", label: "Running", statuses: ["running", "waiting", "queued"], finished: false },
  { id: "paused", label: "Paused", statuses: ["paused"], finished: false },
  { id: "failed", label: "Failed", statuses: ["failed"], finished: true },
  { id: "finished", label: "Finished", statuses: ["succeeded", "cancelled"], finished: true },
] as const satisfies readonly {
  id: string;
  label: string;
  statuses: readonly WorkflowStatus[];
  finished: boolean;
}[];

export type WorkflowSection = {
  id: (typeof sections)[number]["id"];
  label: string;
  finished: boolean;
  runs: WorkflowRunSummary[];
};

/** Empty sections are dropped. Both the minimap and the board follow this order. */
export function workflowSections(runs: readonly WorkflowRunSummary[]): WorkflowSection[] {
  return sections.flatMap(({ id, label, statuses, finished }) => {
    const matching = runs.filter((run) =>
      statuses.some((status: WorkflowStatus) => status === run.card.status),
    );
    return matching.length ? [{ id, label, finished, runs: matching }] : [];
  });
}

const NEWEST_FINISHED_POLL_MS = 30_000;

type WorkflowRunPage = { items: WorkflowRunSummary[]; nextCursor?: string };

/**
 * A full first page with nothing in common with loaded history means more runs finished than one
 * page holds, so merging it would strand the runs between that page and the history.
 */
export function finishedRunsHaveGap(
  history: InfiniteData<WorkflowRunPage, unknown>,
  newest: WorkflowRunPage,
) {
  if (!newest.nextCursor) return false;
  const known = new Set(history.pages.flatMap((page) => page.items.map((run) => run.id)));
  return !newest.items.some((run) => known.has(run.id));
}

/** Adds runs from a fresh first page, leaving loaded history and its page cursors untouched. */
export function mergeNewestFinishedRuns<PageParam>(
  history: InfiniteData<WorkflowRunPage, PageParam>,
  newest: WorkflowRunPage,
): InfiniteData<WorkflowRunPage, PageParam> {
  const known = new Set(history.pages.flatMap((page) => page.items.map((run) => run.id)));
  const added = newest.items.filter((run) => !known.has(run.id));
  const [first, ...rest] = history.pages;
  if (!added.length || !first) return history;
  return { ...history, pages: [{ ...first, items: [...added, ...first.items] }, ...rest] };
}

/**
 * Catches runs that started and ended between two polls of the active list. Refetching the
 * infinite query instead would download every loaded page of finished results each time.
 */
export function useNewestFinishedRuns() {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const online = useNativeOnline(client);
  useEffect(() => {
    if (!online) return;
    const { queryKey } = workflowRunsOptions(client, "finished");
    const timer = setInterval(() => {
      if (document.hidden) return;
      void attempt(
        async () => {
          const newest = await queryNativeRPC(client, (rpc) =>
            rpc.workflows.list({ state: "finished", limit: 30 }),
          );
          const history = queries.getQueryData(queryKey);
          if (!history) return;
          if (!finishedRunsHaveGap(history, newest)) {
            queries.setQueryData(queryKey, mergeNewestFinishedRuns(history, newest));
            return;
          }
          // A refetch outlasting the poll must finish, or each poll would restart it.
          await queries.invalidateQueries({ queryKey }, { cancelRefetch: false });
        },
        () => {},
      );
    }, NEWEST_FINISHED_POLL_MS);
    return () => clearInterval(timer);
  }, [client, online, queries]);
}

export function useWorkflowRuns() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const active = useInfiniteQuery({ ...workflowRunsOptions(client, "active"), enabled: online });
  const finished = useInfiniteQuery({
    ...workflowRunsOptions(client, "finished"),
    enabled: online,
  });
  const activeRuns = active.data?.pages;
  const finishedRuns = finished.data?.pages;
  const grouped = useMemo(() => {
    // Finished wins for a run that just ended and is still in the last active page.
    const runs = new Map<string, WorkflowRunSummary>();
    for (const page of [...(activeRuns ?? []), ...(finishedRuns ?? [])])
      for (const run of page.items) runs.set(run.id, run);
    return workflowSections([...runs.values()]);
  }, [activeRuns, finishedRuns]);
  return {
    sections: grouped,
    loaded: !!active.data && !!finished.data,
    error: active.error?.message ?? finished.error?.message,
    moreActive: active.hasNextPage,
    moreFinished: finished.hasNextPage,
    activeIds: useMemo(
      () => (activeRuns ?? []).flatMap((page) => page.items.map((run) => run.id)),
      [activeRuns],
    ),
    fetching: active.isFetchingNextPage || finished.isFetchingNextPage,
    loadMore() {
      if (active.hasNextPage) void active.fetchNextPage({ cancelRefetch: false });
      else if (finished.hasNextPage) void finished.fetchNextPage({ cancelRefetch: false });
    },
  };
}
