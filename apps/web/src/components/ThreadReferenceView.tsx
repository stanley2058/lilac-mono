import {
  olderReferencePage,
  newerReferencePage,
  updateReferencePages,
  type ReferencePages,
  type ReferenceCursor,
} from "../reference-pages";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { referenceHref, type ConversationReference } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { ExternalMessages } from "./ExternalMessages";
import { ConversationContext, ConversationIcon, ReferenceActions } from "./ConversationReference";
import { Button } from "./ui/button";
import { ErrorNotice, attempt } from "./ui";
import { ExternalLink, MessageSquare } from "lucide-react";

export function ThreadReferenceView({
  target,
  active = true,
  panel = false,
}: {
  target: ConversationReference;
  active?: boolean;
  panel?: boolean;
}) {
  const { client, resourceUrl } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const key = referenceHref(target);
  const [watchError, setWatchError] = useState<{ key: string; message: string }>();
  const read = useInfiniteQuery({
    queryKey: ["reference-messages", key],
    initialPageParam: undefined as ReferenceCursor,
    queryFn: ({ pageParam, signal }) =>
      client.rpc!.references.read({ target, ...pageParam }, { signal }),
    getNextPageParam: olderReferencePage,
    getPreviousPageParam: newerReferencePage,
    enabled: active && online && !!client.rpc,
  });
  const error = watchError?.key === key ? watchError.message : read.error?.message;
  const loaded = !!read.data;
  const messages = useMemo(() => {
    const byId = new Map(
      (
        (!error ? read.data : undefined)?.pages.toReversed().flatMap((page) => page.messages) ?? []
      ).map((message) => [message.id, message]),
    );
    return [...byId.values()];
  }, [read.data, error]);
  const page = error ? undefined : read.data?.pages[0];
  const found = !target.messageId || read.data?.pages.some((page) => page.messageFound);
  useEffect(() => {
    if (!loaded || !active || !online || target.surface !== "native" || target.range || !client.rpc)
      return;
    const controller = new AbortController();
    const queryKey = ["reference-messages", key];
    setWatchError(undefined);
    async function reset() {
      const page = await client.rpc!.references.read({ target }, { signal: controller.signal });
      if (!controller.signal.aborted)
        queries.setQueryData<ReferencePages>(queryKey, { pages: [page], pageParams: [undefined] });
    }
    void attempt(
      async () => {
        const cached = queries.getQueryData<ReferencePages>(queryKey);
        const checkpoint = cached?.pages
          .map((page) => page.checkpoint)
          .filter((value) => value !== undefined)
          .sort((a, b) => a.projectionRevision - b.projectionRevision)[0];
        const stream = await client.rpc!.threads.watch(
          { threadId: target.sessionId, checkpoint },
          { signal: controller.signal },
        );
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          if (event.kind === "revoked" || event.kind === "deleted") {
            queries.setQueryData<ReferencePages>(queryKey, { pages: [], pageParams: [] });
            setWatchError({ key, message: "Conversation unavailable" });
            return;
          }
          if (event.kind === "thread") {
            queries.setQueryData<ReferencePages>(
              queryKey,
              (data) =>
                data && {
                  ...data,
                  pages: data.pages.map((page) => ({ ...page, title: event.thread.title })),
                },
            );
            continue;
          }
          if (event.kind === "replay" && event.reply.kind === "window") {
            await reset();
            continue;
          }
          const delta =
            event.kind === "replay" && event.reply.kind === "delta" ? event.reply : undefined;
          const update = event.kind === "update" ? event.update : delta;
          if (!update) continue;
          const data = queries.getQueryData<ReferencePages>(queryKey);
          if (!data) continue;
          const next = updateReferencePages(
            data,
            update,
            delta?.fromRevision ?? update.checkpoint.projectionRevision - 1,
          );
          if (next) queries.setQueryData(queryKey, next);
          else await reset();
        }
      },
      (message) => {
        if (!controller.signal.aborted) setWatchError({ key, message });
      },
    );
    return () => controller.abort();
  }, [client, queries, key, loaded, active, online, target.surface, target.sessionId]);
  const sourceUrl =
    page?.sourceUrl ??
    (target.surface === "discord"
      ? `https://discord.com/channels/@me/${target.sessionId}${target.messageId ? `/${target.messageId}` : ""}`
      : undefined);
  return (
    <ConversationContext value={target}>
      <section className="flex flex-1 min-h-0 flex-col" aria-label="Conversation preview">
        <header
          className={
            panel
              ? "flex items-center gap-2 px-3 py-2 min-w-0"
              : "thread-header flex items-center gap-2 h-8 min-h-8 px-6 min-w-0 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15 group-[.right-panel-hidden]/workspace:pr-15"
          }
        >
          <ConversationIcon surface={target.surface} />
          <span className="truncate flex-1">{page?.title || target.sessionId}</span>
          <span className="text-xs text-muted-foreground">Read-only</span>
          {panel ? (
            <ReferenceActions target={target} sourceUrl={sourceUrl}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open in main view"
                render={<a href={referenceHref(target)} />}
              >
                <ExternalLink />
              </Button>
            </ReferenceActions>
          ) : null}
          {!panel && target.surface === "native" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Continue conversation"
              title="Continue conversation"
              render={<a href={`/threads/${encodeURIComponent(target.sessionId)}`} />}
            >
              <MessageSquare />
            </Button>
          ) : null}
        </header>
        <ErrorNotice message={error} />
        {!found && !read.isFetching && page ? (
          <p className="px-3 text-sm text-muted-foreground">Message unavailable</p>
        ) : null}
        {sourceUrl ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start mx-3"
            render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
            Open in {target.surface === "discord" ? "Discord" : "GitHub"}
          </Button>
        ) : null}
        {read.hasPreviousPage ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={read.isFetching}
            onClick={() => {
              void read.fetchPreviousPage({ cancelRefetch: false });
            }}
          >
            Load newer messages
          </Button>
        ) : null}
        <div className={`flex flex-1 min-h-0 flex-col ${panel ? "px-3" : ""}`}>
          <ExternalMessages
            key={key}
            messages={messages}
            resourceUrl={resourceUrl}
            loadDirection="start"
            targetMessageId={
              read.data?.pages.find((page) => page.anchorMessageId)?.anchorMessageId ??
              target.messageId
            }
            hasMore={!!read.hasNextPage && !read.error && active}
            loading={read.isFetching}
            onLoadMore={() => {
              void read.fetchNextPage({ cancelRefetch: false });
            }}
          />
        </div>
      </section>
    </ConversationContext>
  );
}
