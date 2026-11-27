import { useThreadTargets } from "../shortcuts";
import { SidebarEmptyState } from "./SidebarEmptyState";
import { useEventCallback } from "../use-event-callback";
import { memo, useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  NativeRpcOutputs,
  NativeUser,
  SidebarSection,
  DisplayCatalog,
} from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { sidebarOptions, settledCountOptions, refreshSidebar } from "../sidebar-queries";
import { useNativeOnline } from "../queries";
import { moveInQueues, sidebarSections, type ThreadMove, sidebarSnapshot } from "../sidebar-order";
import { SidebarThread } from "./SidebarThread";
import { ThreadQueue } from "./ThreadQueue";
import { toast } from "./ui/toast";
import { isConnectionFailure } from "../connection-lifecycle";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";

type Page = NativeRpcOutputs["sidebar"]["list"];
export const SidebarQueue = memo(function SidebarQueue({
  fallbackThreads,
  draftIds,
  viewer,
  external,
  models,
  onSelect,
  onRename,
  onRegenerateTitle,
  onArchive,
  onDelete,
  onDiscardDraft,
}: {
  /** Listed until the sidebar queries first load, so connecting does not empty the list. */
  fallbackThreads?: NativeThread[];
  draftIds: string[];
  viewer: NativeUser;
  external?: boolean;
  models?: DisplayCatalog["models"];
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRegenerateTitle: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onDiscardDraft: (id: string) => void;
}) {
  const { client, threadMetadata } = useWorkspace();
  const latest = useStore(threadMetadata, (state) => state.threads);
  const queries = useQueryClient();
  const online = useNativeOnline(client);
  const [settledOpen, setSettledOpen] = useState(false);
  const pinned = useInfiniteQuery(sidebarOptions(client, "pinned", online));
  const active = useInfiniteQuery(sidebarOptions(client, "active", online));
  const settled = useInfiniteQuery(sidebarOptions(client, "settled", online && settledOpen));
  const settledCount = useQuery(settledCountOptions(client, online));
  const sections = { pinned, active, settled };
  // The fallback list stays until both default sections settle, so neither response alone empties it.
  const loaded = [pinned, active].every(
    (query) => query.dataUpdatedAt > 0 || query.errorUpdatedAt > 0,
  );
  const queues = sidebarSnapshot(
    loaded
      ? sidebarSections.map((section) => ({
          section,
          items: sections[section].data?.pages.flatMap((page) => page.items) ?? [],
          updatedAt: sections[section].dataUpdatedAt,
        }))
      : [],
    (fallbackThreads ?? []).filter((thread) => thread.kind !== "dm"),
    (id) => latest.get(id),
  );
  useEffect(() => {
    threadMetadata
      .getState()
      .put(
        [pinned.data, active.data, settled.data].flatMap(
          (data) => data?.pages.flatMap((page) => page.items) ?? [],
        ),
      );
  }, [threadMetadata, pinned.data, active.data, settled.data]);
  queues.active.unshift(...draftIds.map((id) => ({ id })));
  const totals = {
    pinned: pinned.data?.pages[0]?.total ?? 0,
    active: active.data?.pages[0]?.total ?? queues.active.length,
    settled: settledCount.data?.total ?? 0,
  };
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "bootstrap" || event.kind === "removed") {
          void refreshSidebar(queries);
          return;
        }
        if (event.kind !== "thread") return;
        // Rows read the new metadata from the shared store; only membership changes need a refetch.
        let known = false,
          needsRefresh = event.thread.archived;
        for (const section of sidebarSections) {
          const listed = queries
            .getQueryData<InfiniteData<Page>>(["sidebar", section])
            ?.pages.flatMap((page) => page.items)
            .find((thread) => thread.id === event.thread.id);
          if (!listed) continue;
          known = true;
          if (section === "settled" && event.thread.updatedAt > listed.updatedAt)
            needsRefresh = true;
        }
        if (!known || needsRefresh) void refreshSidebar(queries);
      }),
    [client, queries],
  );
  const move = useMutation({
    mutationFn: (input: ThreadMove) => client.rpc!.sidebar.move(input),
    onMutate: () => queries.cancelQueries({ queryKey: ["sidebar"] }),
    onSettled: () => refreshSidebar(queries),
  });
  const visible = move.isPending ? moveInQueues(queues, move.variables) : queues;
  const visibleTotals = { ...totals };
  if (move.isPending)
    for (const section of sidebarSections)
      visibleTotals[section] += visible[section].length - queues[section].length;
  const next = sidebarSections.find(
    (section) =>
      (section !== "settled" || settledOpen) &&
      sections[section].hasNextPage &&
      !sections[section].isError,
  );
  // A collapsed Settled query is disabled, so refreshes skip it and its last error would linger.
  const errors = [
    move.error,
    pinned.error,
    active.error,
    settledCount.error,
    settledOpen ? settled.error : null,
  ].filter((error) => !!error);
  const transient = errors.some((error) => isConnectionFailure(error.message));
  const errorMessage = errors.find((error) => !isConnectionFailure(error.message))?.message;
  const retry = useEventCallback(() => {
    move.reset();
    void refreshSidebar(queries);
  });
  // A reconnect refreshes the sidebar itself. A connection that passes the probe never reconnects,
  // so the sidebar refreshes here instead.
  const recover = useEventCallback(async () => {
    if (move.error && isConnectionFailure(move.error.message)) move.reset();
    await client.checkConnection();
    if (client.connectionState === "online") void refreshSidebar(queries);
  });
  useEffect(() => {
    if (transient) void recover();
  }, [transient, recover]);
  useEffect(() => {
    if (!errorMessage) return;
    const id = toast.add({
      id: "sidebar-error",
      title: errorMessage,
      type: "error",
      timeout: 0,
      actionProps: { children: "Retry", onClick: retry },
    });
    return () => toast.close(id);
  }, [errorMessage, retry]);
  const select = useEventCallback((id: string) => onSelect(id));
  useThreadTargets(
    [...visible.pinned, ...visible.active, ...(settledOpen ? visible.settled : [])].map(
      (entry) => entry.id,
    ),
    select,
  );
  const rename = useEventCallback((id: string, title: string) => onRename(id, title));
  const archive = useEventCallback((id: string, archived: boolean) => onArchive(id, archived));
  const settle = useEventCallback((id: string, section: SidebarSection) =>
    move.mutate({
      threadId: id,
      section: section === "settled" ? "active" : "settled",
      atStart: true,
    }),
  );
  const pin = useEventCallback((id: string, section: SidebarSection) =>
    move.mutate({
      threadId: id,
      section: section === "pinned" ? "active" : "pinned",
      atStart: true,
    }),
  );
  return (
    <ThreadQueue
      emptyState={
        errors.length === 0 &&
        !pinned.isFetching &&
        !active.isFetching &&
        visible.pinned.length === 0 &&
        visible.active.length === 0 ? (
          <SidebarEmptyState view="default" />
        ) : null
      }
      queues={visible}
      totals={visibleTotals}
      disabled={!online || move.isPending}
      loading={sidebarSections.some((section) => sections[section].isFetching)}
      // The first pages replace the fallback list in place instead of shuffling its rows.
      animateChanges={loaded}
      hasMore={!!next}
      onEndReached={() => {
        if (next) void sections[next].fetchNextPage({ cancelRefetch: false });
      }}
      settledOpen={settledOpen}
      onSettledOpen={setSettledOpen}
      onMove={(input) => move.mutate(input)}
      renderThread={(entry, section) => (
        <SidebarThread
          id={entry.id}
          thread={entry.source}
          viewer={viewer}
          external={external}
          modelLabel={models?.find((model) => model.id === entry.source?.modelId)?.label}
          section={section}
          onSettle={settle}
          onPin={pin}
          settleDisabled={!online || move.isPending}
          onSelect={select}
          onRename={rename}
          onRegenerateTitle={onRegenerateTitle}
          onArchive={archive}
          onDelete={onDelete}
          onDiscardDraft={onDiscardDraft}
        />
      )}
    />
  );
});
