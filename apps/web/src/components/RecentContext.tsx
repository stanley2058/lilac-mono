import { createContext, useContext, useEffect, type ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ListStart } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcOutputs, NativeThread } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Context = Omit<NativeRpcOutputs["threads"]["context"], "evaluatedAt">;
const RecentContext = createContext<Context | undefined>(undefined);
export const useRecentContext = () => useContext(RecentContext);

function recentContextOptions(client: NativeClient, threadId: string | undefined) {
  return queryOptions({
    queryKey: ["recent-context", threadId],
    queryFn: ({ signal }) => client.rpc!.threads.context({ threadId: threadId! }, { signal }),
  });
}

// Each poll answers with a new evaluation time. Leaving it out keeps the shared value stable, so
// timeline rows rerender only when the context itself changes.
function withoutEvaluation({
  evaluatedAt: _evaluatedAt,
  ...context
}: NativeRpcOutputs["threads"]["context"]): Context {
  return context;
}

export function RecentContextProvider({
  thread,
  children,
}: {
  thread?: NativeThread;
  children: ReactNode;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const query = useQuery({
    ...recentContextOptions(client, thread?.id),
    enabled: online && thread?.kind === "dm",
    refetchInterval: ({ state }) => {
      if (thread?.activeRunId) return 1000;
      return state.data?.expiresAt ? Math.max(1, state.data.expiresAt - Date.now()) : false;
    },
    select: withoutEvaluation,
  });
  const { refetch } = query;
  useEffect(() => {
    if (online && thread?.kind === "dm") void refetch();
  }, [
    online,
    thread?.kind,
    thread?.id,
    thread?.activeRunId,
    thread?.displayStatus,
    thread?.revision,
    refetch,
  ]);
  return <RecentContext value={query.data}>{children}</RecentContext>;
}

/**
 * A context read from before the turn settled cannot know whether the turn opened a window. A fast
 * reply can settle before the next poll, so the old "no window" answer must not mark a new context.
 */
export function contextCoversTurn(
  evaluatedAt: number | undefined,
  turn: { startedAt?: number; settledAt?: number },
): boolean {
  if (evaluatedAt === undefined) return false;
  const changedAt = turn.settledAt ?? turn.startedAt;
  return changedAt === undefined || evaluatedAt >= changedAt;
}

/**
 * Ends a DM timeline in the divider's space, so the divider appears and hides without moving the
 * turns. It shows only once a context read covers the latest turn.
 */
export function NextContextStartAfter({
  threadId,
  turn,
  show,
}: {
  threadId: string;
  turn: { startedAt?: number; settledAt?: number };
  show: boolean;
}) {
  const { client } = useWorkspace();
  const evaluatedAt = useQuery({
    ...recentContextOptions(client, threadId),
    enabled: false,
    select: (context) => context.evaluatedAt,
  }).data;
  return <NextContextStart hidden={!show || !contextCoversTurn(evaluatedAt, turn)} />;
}

export function ContextMessage({
  summarized,
  children,
}: {
  summarized?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      title={summarized ? "Represented in the context summary" : undefined}
      data-summarized={summarized || undefined}
    >
      {children}
    </div>
  );
}

function separatorTime(at: number): string {
  const date = new Date(at);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TimestampSeparator({ at, contextStart }: { at: number; contextStart?: boolean }) {
  return (
    <p
      data-ui="timestamp-separator"
      data-context-start={contextStart || undefined}
      className="flex items-center justify-center gap-1.5 px-6 pt-4 pb-1 text-xs text-muted-foreground"
    >
      <time dateTime={new Date(at).toISOString()}>{separatorTime(at)}</time>
      {contextStart ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex p-0 border-0 bg-transparent text-inherit cursor-default"
                aria-label="Context starts here"
              />
            }
          >
            <ListStart className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>Context starts here</TooltipContent>
        </Tooltip>
      ) : null}
    </p>
  );
}

export function NextContextStart({ hidden }: { hidden?: boolean }) {
  return (
    <p
      data-ui="next-context-start"
      aria-hidden={hidden || undefined}
      className={`flex items-center gap-3 px-6 pt-3 pb-1 text-xs text-muted-foreground ${hidden ? "invisible" : ""}`}
    >
      <span className="flex-1 border-t border-border" aria-hidden />
      <span className="flex items-center gap-1.5">
        <ListStart className="size-3.5" aria-hidden />
        Next message starts a new context
      </span>
      <span className="flex-1 border-t border-border" aria-hidden />
    </p>
  );
}
