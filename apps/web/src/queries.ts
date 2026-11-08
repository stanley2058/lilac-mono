import { ORPCError } from "@orpc/client";
import { Result } from "better-result";
import { useCallback, useSyncExternalStore } from "react";
import {
  onlineManager,
  infiniteQueryOptions,
  queryOptions,
  skipToken,
  type QueryClient,
} from "@tanstack/react-query";
import type { NativeClient } from "@stanley2058/lilac-client";

import type { CacheScope } from "@stanley2058/lilac-client";
import type { AppProps } from "./types";
import type { Draft } from "./components/Chat";

export function composerDraftOptions(
  scope: CacheScope,
  threadId: string,
  cache: AppProps["draftCache"],
) {
  return queryOptions({
    queryKey: ["composer-draft", threadId],
    queryFn: async (): Promise<Draft> => {
      const saved = await cache?.readDraft(scope, threadId);
      return { text: "", skillIds: [], ...saved, attachments: [] };
    },
    staleTime: "static",
    // Live attachment keys must survive sidebar unmounts and thread switches.
    gcTime: Infinity,
  });
}

export function updateComposerDraft(queries: QueryClient, threadId: string, draft: Draft) {
  const queryKey = ["composer-draft", threadId];
  // A late IndexedDB read must not replace text written after hydration started.
  void queries.cancelQueries({ queryKey, exact: true });
  queries.setQueryData(queryKey, draft);
}

/**
 * Waits for a draft's saved copy to load, then returns the cached draft. Edits made while it loaded
 * cancel the read, so the cache holds them instead.
 */
export async function loadComposerDraft(
  queries: QueryClient,
  options: ReturnType<typeof composerDraftOptions>,
): Promise<Result<Draft, string>> {
  const read = await Result.tryPromise({
    try: () => queries.query(options),
    catch: (cause) => (cause instanceof Error ? cause.message : "The saved draft did not load"),
  });
  const cached = queries.getQueryData(options.queryKey);
  return cached ? Result.ok(cached) : read;
}

const subscribeBrowserOnline = onlineManager.subscribe.bind(onlineManager);
const browserOnlineSnapshot = () => onlineManager.isOnline();

export function useDeviceOnline() {
  return useSyncExternalStore(subscribeBrowserOnline, browserOnlineSnapshot, browserOnlineSnapshot);
}

export function useNativeOnline(client: NativeClient) {
  const subscribe = useCallback(
    (listener: () => void) =>
      client.subscribe((event) => {
        if (event.kind === "connection") listener();
      }),
    [client],
  );
  const snapshot = useCallback(() => client.connectionState === "online", [client]);
  const online = useSyncExternalStore(subscribe, snapshot, snapshot);
  const deviceOnline = useDeviceOnline();
  return online && deviceOnline;
}

export async function queryNativeRPC<T>(
  client: NativeClient,
  query: (rpc: NonNullable<NativeClient["rpc"]>) => Promise<T>,
): Promise<T> {
  const rpc = client.rpc;
  if (!rpc)
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Connection unavailable. Please retry when connected.",
    });
  return query(rpc);
}

export function participantOptions(client: NativeClient, threadId: string) {
  return queryOptions({
    queryKey: ["participants", threadId],
    queryFn: threadId
      ? ({ signal }) =>
          queryNativeRPC(client, (rpc) => rpc.participants.list({ threadId }, { signal }))
      : skipToken,
  });
}

export function pendingQuestionsOptions(client: NativeClient, threadId: string) {
  return queryOptions({
    queryKey: ["questions", "pending", threadId],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.questions.pending({ threadId }, { signal })),
    // Replays and reconnects invalidate this list; "static" would ignore those invalidations.
    staleTime: Infinity,
  });
}

export function threadOptions(client: NativeClient, threadId: string) {
  return queryOptions({
    queryKey: ["thread", threadId],
    queryFn: threadId
      ? ({ signal }) => queryNativeRPC(client, (rpc) => rpc.threads.get({ threadId }, { signal }))
      : skipToken,
  });
}

export function userOptions(client: NativeClient) {
  return infiniteQueryOptions({
    queryKey: ["users"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      queryNativeRPC(client, (rpc) =>
        rpc.users.list({ limit: 100, cursor: pageParam }, { signal }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function searchOptions(client: NativeClient, query: string) {
  return infiniteQueryOptions({
    queryKey: ["search", query],
    staleTime: 0,
    initialPageParam: undefined as string | undefined,
    queryFn: query
      ? ({ pageParam, signal }) =>
          queryNativeRPC(client, (rpc) =>
            rpc.search.query({ query, limit: 100, cursor: pageParam }, { signal }),
          )
      : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function configOptions(client: NativeClient, kind: "core" | "mcp") {
  return queryOptions({
    queryKey: ["config", kind],
    queryFn: ({ signal }) => queryNativeRPC(client, (rpc) => rpc.config.read({ kind }, { signal })),
    staleTime: 0,
    gcTime: 0,
  });
}

export function externalListOptions(client: NativeClient) {
  return infiniteQueryOptions({
    queryKey: ["external", "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      queryNativeRPC(client, (rpc) =>
        rpc.external.list({ limit: 100, cursor: pageParam }, { signal }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function externalReadOptions(client: NativeClient, threadId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: ["external", "read", threadId],
    initialPageParam: undefined as string | undefined,
    queryFn: threadId
      ? ({ pageParam, signal }) =>
          queryNativeRPC(client, (rpc) =>
            rpc.external.read({ threadId, cursor: pageParam }, { signal }),
          )
      : skipToken,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function queueOptions(client: NativeClient, threadId: string) {
  return queryOptions({
    queryKey: ["queue", threadId],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.runs.queue({ threadId }, { signal })),
    staleTime: 0,
  });
}

export async function refreshQueue(queries: QueryClient, threadId: string) {
  const filters = { queryKey: ["queue", threadId], exact: true };
  await queries.cancelQueries(filters);
  await queries.invalidateQueries(filters);
}

export function profileOptions(client: NativeClient) {
  return queryOptions({
    queryKey: ["profile"],
    queryFn: ({ signal }) => queryNativeRPC(client, (rpc) => rpc.profile.get({}, { signal })),
    refetchOnWindowFocus: true,
  });
}

export function subagentsOptions(client: NativeClient, threadId: string) {
  return infiniteQueryOptions({
    queryKey: ["subagents", threadId],
    initialPageParam: undefined as string | undefined,
    queryFn:
      threadId && !threadId.startsWith("draft:")
        ? ({ signal, pageParam }) =>
            queryNativeRPC(client, (rpc) =>
              rpc.subagents.list({ threadId, cursor: pageParam }, { signal }),
            )
        : skipToken,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 1000,
  });
}

export type SubagentTranscriptPage = Awaited<
  ReturnType<NonNullable<NativeClient["rpc"]>["subagents"]["read"]>
>;

export function mergeSubagentTranscript(
  previous: SubagentTranscriptPage | undefined,
  page: SubagentTranscriptPage,
): SubagentTranscriptPage {
  if (!previous || page.offset < previous.offset) return page;
  const prefix = previous.messages.slice(0, page.offset - previous.offset);
  return {
    ...page,
    offset: previous.offset,
    nextBefore: previous.nextBefore,
    messages: [...prefix, ...page.messages],
  };
}

export function subagentTranscriptOptions(
  client: NativeClient,
  queries: QueryClient,
  threadId: string,
  agentId: string,
) {
  const queryKey = ["subagent-transcript", threadId, agentId];
  return queryOptions({
    queryKey,
    queryFn: agentId
      ? async ({ signal }) => {
          const previous = queries.getQueryData<SubagentTranscriptPage>(queryKey);
          const from = previous
            ? previous.offset + Math.max(0, previous.messages.length - 20)
            : undefined;
          const page = await queryNativeRPC(client, (rpc) =>
            rpc.subagents.read({ threadId, agentId, from }, { signal }),
          );
          return mergeSubagentTranscript(previous, page);
        }
      : skipToken,
    staleTime: 1000,
  });
}

export function subagentHistoryOptions(
  client: NativeClient,
  threadId: string,
  agentId: string,
  before?: number,
) {
  return infiniteQueryOptions({
    queryKey: ["subagent-history", threadId, agentId],
    initialPageParam: before,
    queryFn: agentId
      ? ({ signal, pageParam }) =>
          queryNativeRPC(client, (rpc) =>
            rpc.subagents.read({ threadId, agentId, before: pageParam }, { signal }),
          )
      : skipToken,
    getNextPageParam: (page) => page.nextBefore,
    staleTime: Infinity,
  });
}
