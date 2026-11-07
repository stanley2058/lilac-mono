import { useWorkspace } from "../workspace-context";
import { RefreshCw, MessageSquare, ExternalLink } from "lucide-react";
import { ErrorNotice, IconButton } from "./ui";
import { CopyReferenceButton } from "./ConversationReference";
import { ExternalMessages } from "./ExternalMessages";
import { Button } from "./ui/button";
import { ExternalSkeleton } from "./ExternalSidebar";
import { useExternalView } from "./ExternalActions";

export function External({ threadId }: { threadId?: string }) {
  const { resourceUrl } = useWorkspace();
  const { read, view, reference } = useExternalView(threadId);
  if (!threadId)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <MessageSquare className="size-6" />
        <p className="text-sm">Select a conversation</p>
      </div>
    );
  return (
    <section className="external-view flex flex-1 min-h-0 flex-col">
      <header className="thread-header flex items-center gap-2 h-[var(--ui-header-height)] px-6 py-0.5 [&_h1]:truncate [&_.icon-button]:size-[var(--ui-control-compact)] max-workspace:gap-1 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15 group-[.right-panel-hidden]/workspace:pr-[calc(var(--ui-space-unit)*5+var(--ui-control-compact))]">
        <h1>{view?.thread.title ?? ""}</h1>
        <span className="text-xs text-muted-foreground whitespace-nowrap">Read-only</span>
        <span className="flex-1" />
        <div className="hidden workspace:flex items-center gap-2">
          {view?.thread.sourceUrl ? (
            <Button
              variant="ghost"
              size="sm"
              render={<a href={view.thread.sourceUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink /> Open in {view.thread.surface === "discord" ? "Discord" : "GitHub"}
            </Button>
          ) : null}
          <CopyReferenceButton label="Copy conversation link" target={reference} />
          <IconButton
            label="Refresh conversation"
            disabled={read.isFetching}
            onClick={() => {
              void read.refetch();
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </header>
      <ErrorNotice message={read.error?.message} />
      {!view && read.isFetching ? <ExternalSkeleton conversation /> : null}
      {!view && !read.isFetching && !read.error ? (
        <p className="p-6 text-sm text-muted-foreground">Conversation unavailable</p>
      ) : null}
      {view ? (
        <ExternalMessages
          key={threadId}
          messages={view.messages}
          resourceUrl={resourceUrl}
          loadDirection="start"
          hasMore={!!read.hasNextPage && !read.error}
          loading={read.isFetching}
          onLoadMore={() => {
            void read.fetchNextPage({ cancelRefetch: false });
          }}
        />
      ) : null}
    </section>
  );
}
