import { memo } from "react";
import { useThreadTargets } from "../shortcuts";
import { SidebarEmptyState } from "./SidebarEmptyState";
import { useInfiniteQuery } from "@tanstack/react-query";
import { externalListOptions, useNativeOnline } from "../queries";
import { useWorkspace } from "../workspace-context";
import { ErrorNotice, VirtualList } from "./ui";
import { ThreadCard } from "./ThreadSelect";
import { Skeleton } from "./ui/skeleton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { ConversationIcon } from "./ConversationReference";
import { ExternalMenuItems } from "./ExternalActions";

export function ExternalSkeleton({ conversation = false }: { conversation?: boolean }) {
  return (
    <div
      className="flex flex-col gap-4 p-3"
      role="status"
      aria-label={conversation ? "Loading conversation" : "Loading conversations"}
    >
      {[0, 1, 2, 3, 4, 5].slice(0, conversation ? 3 : 6).map((index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className={conversation ? "h-24 w-full" : "h-5 w-3/4"} />
        </div>
      ))}
    </div>
  );
}

export function ExternalSidebar({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const list = useInfiniteQuery({ ...externalListOptions(client), enabled: online });
  const threads = [
    ...new Map(
      (list.data?.pages.flatMap((page) => page.items) ?? []).map((thread) => [thread.id, thread]),
    ).values(),
  ];
  useThreadTargets(
    threads.map((thread) => thread.id),
    onSelect,
  );
  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <ErrorNotice message={list.error?.message} />
      {!list.data && list.isFetching ? <ExternalSkeleton /> : null}
      <VirtualList
        emptyState={list.data && threads.length === 0 ? <SidebarEmptyState view="others" /> : null}
        items={threads}
        itemKey={(thread) => thread.id}
        label="Other conversations"
        className="thread-list flex-1"
        roving={{ primary: ".thread-card-select", selected: "[aria-current]" }}
        estimate={64}
        scrollFade
        hasMore={!!list.hasNextPage && !list.error}
        loading={list.isFetching}
        onEndReached={() => {
          void list.fetchNextPage({ cancelRefetch: false });
        }}
        render={(thread) => (
          <ExternalThread thread={thread} selected={selectedId === thread.id} onSelect={onSelect} />
        )}
      />
      {list.isFetchingNextPage ? (
        <div
          className="absolute bottom-0 inset-x-0 p-3 bg-sidebar"
          role="status"
          aria-label="Loading conversations"
        >
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}
    </div>
  );
}

const ExternalThread = memo(function ExternalThread({
  thread,
  selected,
  onSelect,
}: {
  thread: {
    id: string;
    title: string;
    surface: "discord" | "github";
    sourceUrl?: string;
    updatedAt?: number;
  };
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="thread-row-card block py-1">
        <ThreadCard
          shortcutId={thread.id}
          title={thread.title}
          starterName={thread.surface === "discord" ? "Discord" : "GitHub"}
          starterIcon={<ConversationIcon surface={thread.surface} />}
          updatedAt={thread.updatedAt}
          state="idle"
          selected={selected}
          onSelect={() => onSelect(thread.id)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ExternalMenuItems threadId={thread.id} thread={thread} Item={ContextMenuItem} />
      </ContextMenuContent>
    </ContextMenu>
  );
});
