import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListStart } from "lucide-react";
import type { NativeRpcOutputs, NativeThread } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Context = NativeRpcOutputs["threads"]["context"];
const RecentContext = createContext<Context | undefined>(undefined);
export const useRecentContext = () => useContext(RecentContext);

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
    queryKey: ["recent-context", thread?.id],
    enabled: online && thread?.kind === "dm",
    queryFn: ({ signal }) => client.rpc!.threads.context({ threadId: thread!.id }, { signal }),
    refetchInterval: ({ state }) => {
      if (thread?.activeRunId) return 1000;
      return state.data?.expiresAt ? Math.max(1, state.data.expiresAt - Date.now()) : false;
    },
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

export function NextContextStart() {
  return (
    <p
      data-ui="next-context-start"
      className="flex items-center gap-3 px-6 pt-4 pb-1 text-xs text-muted-foreground"
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
