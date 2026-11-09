import { useEffect, useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { WorkflowCard, WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { attempt } from "./components/ui";
import {
  queryNativeRPC,
  useNativeOnline,
  workflowRunsOptions,
  type WorkflowListState,
} from "./queries";
import { useWorkspace } from "./workspace-context";

type WorkflowStatus = WorkflowCard["status"];

const sections = [
  {
    id: "attention",
    label: "Needs attention",
    statuses: ["needs-attention", "waiting-reply", "blocked"],
    list: "active",
  },
  { id: "running", label: "Running", statuses: ["running", "waiting", "queued"], list: "active" },
  { id: "paused", label: "Paused", statuses: ["paused"], list: "active" },
  { id: "failed", label: "Failed", statuses: ["failed"], list: "failed" },
  { id: "finished", label: "Finished", statuses: ["succeeded", "cancelled"], list: "done" },
] as const satisfies readonly {
  id: string;
  label: string;
  statuses: readonly WorkflowStatus[];
  list: WorkflowListState;
}[];

export type WorkflowSection = {
  id: (typeof sections)[number]["id"];
  label: string;
  list: WorkflowListState;
  runs: WorkflowRunSummary[];
};

/** Every section is always present, so board columns keep their positions when they empty. */
export function workflowSections(runs: readonly WorkflowRunSummary[]): WorkflowSection[] {
  return sections.map(({ id, label, statuses, list }) => ({
    id,
    label,
    list,
    runs: runs.filter((run) =>
      statuses.some((status: WorkflowStatus) => status === run.card.status),
    ),
  }));
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
export function useNewestFinishedRuns(query: string) {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const online = useNativeOnline(client);
  useEffect(() => {
    if (!online) return;
    const refresh = (state: "failed" | "done") => {
      const { queryKey } = workflowRunsOptions(client, state, query);
      return attempt(
        async () => {
          const newest = await queryNativeRPC(client, (rpc) =>
            rpc.workflows.list({ state, limit: 30, ...(query ? { query } : {}) }),
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
    };
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refresh("failed");
      void refresh("done");
    }, NEWEST_FINISHED_POLL_MS);
    return () => clearInterval(timer);
  }, [client, online, queries, query]);
}

function useWorkflowList(state: WorkflowListState, query: string) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  return useInfiniteQuery({
    ...workflowRunsOptions(client, state, query),
    enabled: online,
    // Typing a search keeps the board in place until the new matches arrive.
    placeholderData: online ? keepPreviousData : undefined,
  });
}

type WorkflowList = ReturnType<typeof useWorkflowList>;

function loadable(list: WorkflowList) {
  return list.hasNextPage && !list.isFetchNextPageError;
}

export function useWorkflowRuns(query: string) {
  const active = useWorkflowList("active", query);
  const failed = useWorkflowList("failed", query);
  const done = useWorkflowList("done", query);
  const activeRuns = active.data?.pages;
  const failedRuns = failed.data?.pages;
  const doneRuns = done.data?.pages;
  const grouped = useMemo(() => {
    // An ended list wins for a run that just ended and is still in the last active page.
    const runs = new Map<string, WorkflowRunSummary>();
    for (const page of [...(activeRuns ?? []), ...(failedRuns ?? []), ...(doneRuns ?? [])])
      for (const run of page.items) runs.set(run.id, run);
    return workflowSections([...runs.values()]);
  }, [activeRuns, failedRuns, doneRuns]);
  const lists: Record<WorkflowListState, WorkflowList> = { active, failed, done };
  const perList = <T>(read: (list: WorkflowList) => T): Record<WorkflowListState, T> => ({
    active: read(active),
    failed: read(failed),
    done: read(done),
  });
  const loadMore = (state: WorkflowListState) => {
    if (lists[state].hasNextPage) void lists[state].fetchNextPage({ cancelRefetch: false });
  };
  return {
    sections: grouped,
    loaded: !!active.data && !!failed.data && !!done.data,
    error: active.error?.message ?? failed.error?.message ?? done.error?.message,
    more: perList((list) => list.hasNextPage),
    /** A failed page stops loading here, or reaching the end of a list would request it forever. */
    loadable: perList(loadable),
    fetching: perList((list) => list.isFetchingNextPage),
    hasMore: loadable(active) || loadable(failed) || loadable(done),
    fetchingAny: active.isFetchingNextPage || failed.isFetchingNextPage || done.isFetchingNextPage,
    activeIds: useMemo(
      () => (activeRuns ?? []).flatMap((page) => page.items.map((run) => run.id)),
      [activeRuns],
    ),
    loadMore,
    /** Pages in sidebar order, so earlier sections fill before later ones grow. */
    loadNext() {
      const next = (["active", "failed", "done"] as const).find((state) => loadable(lists[state]));
      if (next) loadMore(next);
    },
  };
}
