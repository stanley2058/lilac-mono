import { Result } from "better-result";
import type { ConversationThreadToolService } from "../../conversation/thread-service";
import {
  resolveTimeWindow,
  compareGroups,
  stripVerboseGroup,
  type DiscoveryService,
  type DiscoverySearchInput,
  type DiscoverySearchResult,
} from "../../discovery/discovery-service";
import type { RequestContext } from "../../tool-server/types";
import { NativeStore, type NativeStoreResult, type NativeStoreError } from "./store";
import { NativeSearchStore, type NativeSearchMessage } from "./store-search";
import { nativeThreadId } from "./native-protocol";
import { nativeFailure } from "./errors";

type SearchHit = {
  threadId: string;
  turnId?: string;
  title: string;
  excerpt: string;
  surface: "native";
};

function discoveryGroupKey(
  groupBy: "none" | "source" | "origin",
  row: NativeSearchMessage,
): string {
  if (groupBy === "none") return `native:${row.threadId}:${row.messageId}`;
  if (groupBy === "source") return "conversation";
  return `native:${row.threadId}`;
}

function excerpt(text: string, query = ""): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase().split(/\s+/u)[0] ?? "");
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 1800)}${text.length > start + 1800 ? "…" : ""}`;
}

function offsetCursor(cursor?: string): NativeStoreResult<number> {
  if (!cursor) return Result.ok(0);
  const offset = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset) || offset < 0)
    return Result.err(nativeFailure("invalid", "Invalid search cursor"));
  return Result.ok(offset);
}

export function nativeSearchFailureToHost(error: NativeStoreError): never {
  throw error;
}

export function resolveNativeSearchToHost<T>(result: NativeStoreResult<T>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeSearchFailureToHost(error),
  });
  return settle();
}

export class NativeSearchService {
  constructor(
    private readonly params: {
      store: NativeStore;
      searchStore: NativeSearchStore;
      conversationThreads?: ConversationThreadToolService;
    },
  ) {}

  forThread(threadId: string): ConversationThreadToolService {
    const service = () => this.forUser(resolveNativeSearchToHost(this.starter(threadId)));
    return {
      search: (input) => service().search(input),
      metadata: (input) => service().metadata(input),
      read: (input) => service().read(input),
      runSummarization: (input) => service().runSummarization(input),
      planAutoInjectSearch: (input) => service().planAutoInjectSearch(input),
      getAutoInjectRankingCorpusDocuments: () =>
        service().getAutoInjectRankingCorpusDocuments?.() ?? [],
      shortlistAutoInjectCandidates: async (input) =>
        (await service().shortlistAutoInjectCandidates?.(input)) ?? {
          source: "none",
          results: [],
        },
    };
  }

  forUser(userId: string): ConversationThreadToolService {
    const user = resolveNativeSearchToHost(this.params.store.getUser(userId));
    if (user.role === "service")
      return resolveNativeSearchToHost(
        Result.err(nativeFailure("forbidden", "Service users cannot browse conversations")),
      );
    return (
      this.params.conversationThreads ??
      resolveNativeSearchToHost(
        Result.err(nativeFailure("invalid", "Conversation memory is unavailable")),
      )
    );
  }

  query(
    userId: string,
    input: { query: string; threadId?: string; cursor?: string; limit?: number },
  ): NativeStoreResult<{ items: SearchHit[]; nextCursor?: string }> {
    return Result.gen(function* () {
      const offset = yield* offsetCursor(input.cursor);
      const limit = Math.min(100, Math.max(1, input.limit ?? 30));
      const rows = yield* this.params.searchStore.searchMessages(userId, {
        ...input,
        limit: limit + 1,
        offset,
      });
      return Result.ok({
        items: rows.slice(0, limit).map((row) => ({
          threadId: row.threadId,
          turnId: row.turnId,
          title: row.title.slice(0, 512),
          excerpt: excerpt(row.text, input.query),
          surface: "native" as const,
        })),
        ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
      });
    }, this);
  }

  starter(threadId: string): NativeStoreResult<string> {
    return Result.gen(function* () {
      const thread = yield* this.params.store.getThreadRecord(threadId);
      yield* this.params.store.authorizeThread(thread.starterId, threadId);
      return Result.ok(thread.starterId);
    }, this);
  }

  principal(context?: RequestContext): NativeStoreResult<string> {
    if (!context?.serverOwnedRequest || context.requestInitiator?.platform !== "native")
      return Result.err(
        nativeFailure("forbidden", "Native search requires an authenticated thread origin"),
      );
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!threadId) return Result.err(nativeFailure("forbidden", "Native thread origin is missing"));
    return this.starter(nativeThreadId(threadId));
  }

  discovery(userId: string, input: DiscoverySearchInput): NativeStoreResult<DiscoverySearchResult> {
    return Result.gen(function* () {
      yield* this.params.store.getUser(userId);
      const limit = Math.min(100, Math.max(1, input.limit ?? 10));
      const surrounding = Math.min(20, Math.max(0, input.surrounding ?? 1));
      const groupBy = input.groupBy ?? "origin";
      const now = Date.now();
      const window = yield* resolveTimeWindow(input, now).mapError((error) =>
        nativeFailure("invalid", error.message),
      );
      const grouped = new Map<string, DiscoverySearchResult["groups"][number]>();
      if (
        (!input.platform || input.platform === "native") &&
        (!input.sources || input.sources.includes("conversation"))
      ) {
        const rows = yield* this.params.searchStore.searchMessages(userId, {
          query: input.query,
          threadId: input.sessionId ? nativeThreadId(input.sessionId) : undefined,
          authorId: input.authorId,
          afterTs: window?.startTs,
          beforeTs: window?.endTs,
          direction: input.direction,
          limit: Math.min(500, limit * 8),
        });
        const matchedIds = new Set(rows.map((row) => row.messageId));
        const included = new Set<string>();
        for (const row of rows) {
          const key = discoveryGroupKey(groupBy, row);
          if (!grouped.has(key) && grouped.size >= limit) continue;
          const origin = {
            kind: "session" as const,
            platform: "native" as const,
            sessionId: row.threadId,
            label: row.title,
          };
          const group = grouped.get(key) ?? {
            key,
            ts: row.createdAt,
            score:
              1 / (21 + grouped.size) +
              0.35 * Math.exp(-Math.max(0, now - row.createdAt) / 604_800_000),
            source: "conversation" as const,
            ...(groupBy === "source" ? {} : { origin }),
            time: new Date(row.createdAt).toISOString(),
            entries: [],
          };
          const context =
            groupBy === "origin" && surrounding > 0
              ? (yield* this.params.searchStore.readThread(userId, row.threadId, {
                  offset: Math.max(0, row.ordinal - surrounding),
                  limit: surrounding * 2 + 1,
                  around: {
                    turnId: row.turnId,
                    messageId: row.messageId,
                    ordinal: row.ordinal,
                    surrounding,
                  },
                  skipBounds: true,
                })).messages
              : [row];
          const entries: DiscoverySearchResult["groups"][number]["entries"][number] = [];
          for (const message of context) {
            const identity = `${message.threadId}:${message.messageId}`;
            if (included.has(identity)) continue;
            included.add(identity);
            entries.push({
              kind: "message",
              matched: matchedIds.has(message.messageId),
              text: excerpt(message.text, input.query),
              time: new Date(message.createdAt).toISOString(),
              messageId: message.messageId,
              author: message.authorId,
              origin,
              ...(input.verbose ? { ts: message.createdAt } : {}),
            });
          }
          if (entries.length > 0) group.entries.push(entries);
          grouped.set(key, group);
        }
      }
      return Result.ok({
        meta: {
          query: input.query,
          sources: ["conversation" as const],
          orderBy: input.orderBy ?? "relevance",
          direction: input.direction ?? "desc",
          groupBy,
          surrounding,
          limit,
          verbose: input.verbose ?? false,
          platform: "native" as const,
          sessionId: input.sessionId,
          authorId: input.authorId,
          ...(window
            ? {
                window: {
                  startTime: new Date(window.startTs).toISOString(),
                  endTime: new Date(window.endTs).toISOString(),
                  ...(input.verbose ? { startTs: window.startTs, endTs: window.endTs } : {}),
                },
              }
            : {}),
        },
        groups: [...grouped.values()]
          .sort((a, b) =>
            compareGroups(a, b, input.orderBy ?? "relevance", input.direction ?? "desc"),
          )
          .map((group) => stripVerboseGroup(group, input.verbose ?? false)),
      });
    }, this);
  }

  async discoveryWithExternal(
    userId: string,
    input: DiscoverySearchInput,
    legacy: Pick<DiscoveryService, "searchResult">,
  ): Promise<NativeStoreResult<DiscoverySearchResult>> {
    return Result.gen(async function* () {
      const user = yield* this.params.store.getUser(userId);
      const native = yield* this.discovery(userId, { ...input, verbose: true });
      if (user.role !== "owner" || input.platform === "native")
        return Result.ok({
          ...native,
          meta: { ...native.meta, verbose: input.verbose ?? false },
          groups: native.groups.map((group) => stripVerboseGroup(group, input.verbose ?? false)),
        });
      const external = yield* Result.await(
        legacy
          .searchResult({ ...input, verbose: true })
          .then((result) =>
            result.mapError((error) =>
              nativeFailure(
                error._tag === "DiscoverySearchInputError" ? "invalid" : "sqlite",
                error.message,
              ),
            ),
          ),
      );
      const merged = new Map<string, DiscoverySearchResult["groups"][number]>();
      for (const group of [...native.groups, ...external.groups]) {
        const previous = merged.get(group.key);
        if (!previous) {
          merged.set(group.key, group);
          continue;
        }
        merged.set(group.key, {
          ...previous,
          entries: [...previous.entries, ...group.entries],
          score: Math.max(previous.score ?? 0, group.score ?? 0),
          ts: Math.max(previous.ts ?? 0, group.ts ?? 0),
        });
      }
      const groups = [...merged.values()]
        .sort((a, b) =>
          compareGroups(a, b, input.orderBy ?? "relevance", input.direction ?? "desc"),
        )
        .slice(0, input.limit ?? 10)
        .map((group) => stripVerboseGroup(group, input.verbose ?? false));
      return Result.ok({ meta: { ...external.meta, verbose: input.verbose ?? false }, groups });
    }, this);
  }
}
