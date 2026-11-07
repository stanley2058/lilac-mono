import { CopySessionIdContextMenuItem } from "./CopySessionIdMenuItem";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "./ui/context-menu";
import { useContext } from "react";
import { CircleAlert } from "lucide-react";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { cn } from "cn";
import { ActorAvatar } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";
import { ThreadTime, WorkingTime, type ThreadDisplayState } from "./ThreadSelect";
import { LoadingSpinner } from "./ui/loading-spinner";

export function DirectThreadCard({
  thread,
  selected,
  now,
  onSelect,
}: {
  thread: NativeThread;
  selected: boolean;
  now?: number;
  onSelect: (id: string) => void;
}) {
  const { agent } = useContext(MessageIdentityContext);
  const state = thread.displayStatus ?? (thread.activeRunId ? "working" : "idle");
  const unread = state === "completed" && !selected;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<button type="button" />}
        className={cn(
          "relative flex w-full min-w-0 shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover hover:text-hover-foreground focus-visible:outline-2 focus-visible:outline-ring",
          selected && "bg-selection text-selection-foreground hover:bg-selection",
        )}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(thread.id)}
        data-dm-card
        data-state={state}
      >
        <span aria-hidden className="contents">
          <ActorAvatar {...agent} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {agent.displayName}
            </span>
            <span
              className={cn("flex-none text-xs text-muted-foreground", unread && "text-primary")}
            >
              {state === "working" && thread.workingSince !== undefined ? (
                <WorkingTime since={thread.workingSince} now={now} />
              ) : (
                <ThreadTime updatedAt={thread.updatedAt} now={now} counting={false} />
              )}
            </span>
          </span>
          <span
            className={cn(
              "flex items-center gap-2 text-xs text-muted-foreground",
              unread && "text-foreground",
            )}
          >
            <DirectThreadPreview thread={thread} state={state} />
            {unread ? (
              <span
                className="size-2 flex-none rounded-full bg-primary"
                role="img"
                aria-label="Unread"
              />
            ) : null}
            {state === "error" ? (
              <CircleAlert className="size-3.5 flex-none text-danger" aria-label="Run failed" />
            ) : null}
          </span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <CopySessionIdContextMenuItem threadId={thread.id} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DirectThreadPreview({
  thread,
  state,
}: {
  thread: NativeThread;
  state: ThreadDisplayState;
}) {
  if (state === "working")
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 text-primary">
        <LoadingSpinner size={12} />
        <span className="truncate">Working…</span>
      </span>
    );
  if (!thread.preview) return <span className="min-w-0 flex-1 truncate">No messages yet</span>;
  return (
    <span className="min-w-0 flex-1 truncate">
      {thread.preview.role === "user" ? "You: " : null}
      {thread.preview.text}
    </span>
  );
}

export function DirectThreadTitle() {
  const { agent } = useContext(MessageIdentityContext);
  return (
    <>
      <span aria-hidden className="contents">
        <ActorAvatar {...agent} size="sm" />
      </span>
      <h1>{agent.displayName}</h1>
    </>
  );
}
