import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type { ConversationThreadToolService } from "../conversation/thread-service";
import type { DiscoveryResultGroup, DiscoveryService } from "../discovery/discovery-service";
import type { SurfaceAdapter } from "../surface/adapter";
import {
  bestEffortAliasForDiscordChannelId,
  resolveGuildIdForChannel,
  shouldAllowDiscordChannel,
} from "../surface/discord/discord-tool-targets";
import type { NativeSearchService } from "../surface/native/search";
import { boundTimelineText } from "../surface/thread-control";
import { preserveToolPanic } from "./tool-result-adapters";

/**
 * Sources return their best candidates before this module drops hidden threads and repeats, so
 * each source is asked for as many candidates as it allows.
 */
const SUMMARY_CANDIDATES = 50;
const MESSAGE_CANDIDATES = 100;

export class OrchestrateDirectoryFailed extends TaggedError("OrchestrateDirectoryFailed")<{
  readonly message: string;
}> {}

/** The surfaces whose threads orchestrate can list and search. */
export type DirectoryClient = "native" | "discord";

/** What `orchestrate` uses to find threads beyond the caller's own conversation. */
export type OrchestrateDirectoryPorts = {
  readonly native?: Pick<
    NativeSearchService,
    "linkedDiscordIds" | "threads" | "summaries" | "query"
  >;
  readonly conversationThreads?: Pick<ConversationThreadToolService, "search">;
  readonly discovery?: Pick<DiscoveryService, "searchResult">;
  readonly discordAdapter?: () => SurfaceAdapter | undefined;
  /** The current config, so allowlist changes apply to a run already in progress. */
  readonly getConfig?: () => Promise<CoreConfig>;
};

export type ThreadRow = {
  readonly kind: "thread";
  readonly id: string;
  readonly client: DirectoryClient;
  readonly title: string;
  readonly updatedAt?: string;
  readonly active?: boolean;
};

export type SearchRow = {
  readonly id: string;
  readonly client: DirectoryClient;
  readonly title: string;
  readonly snippet: string;
  readonly snippetTruncated?: true;
  readonly matchedIn: "summary" | "message";
  readonly updatedAt?: string;
};

type ThreadPage = { readonly items: ThreadRow[]; readonly before?: string };

function failed(message: string) {
  return new OrchestrateDirectoryFailed({ message });
}

function isoTime(ms: number | undefined): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

/** A keyset cursor `<ms>_<id>` for lists ordered newest first. */
export function parseTimeCursor(
  cursor: string | undefined,
): ResultType<{ time: number; id: string } | undefined, OrchestrateDirectoryFailed> {
  if (cursor === undefined) return Result.ok(undefined);
  const separator = cursor.indexOf("_");
  const time = Number(cursor.slice(0, separator));
  if (separator <= 0 || !Number.isSafeInteger(time) || time < 0)
    return Result.err(failed("Cursor is not from this list"));
  return Result.ok({ time, id: cursor.slice(separator + 1) });
}

function allowedDiscordChannel(config: CoreConfig, channelId: string, guildId?: string | null) {
  return shouldAllowDiscordChannel({ cfg: config, channelId, guildId }).match({
    ok: (allowed) => allowed,
    err: () => false,
  });
}

/** Orders ids the way the cursor compares them, so a page boundary neither skips nor repeats. */
function newerIdFirst(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

/** Lists the allowlisted Discord channels and threads, most recently active first. */
export async function listDiscordThreads(input: {
  readonly adapter: SurfaceAdapter;
  readonly config: CoreConfig;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<ResultType<ThreadPage, OrchestrateDirectoryFailed>> {
  return Result.gen(async function* () {
    const after = yield* parseTimeCursor(input.cursor);
    const sessions = yield* Result.await(
      input.adapter
        .listSessions({ limit: Number.MAX_SAFE_INTEGER })
        .then((listed) => listed.mapError((error) => failed(error.message))),
    );
    const stored = sessions.flatMap((session) => {
      const ref = session.ref;
      if (ref.platform !== "discord") return [];
      if (!allowedDiscordChannel(input.config, ref.channelId, ref.guildId)) return [];
      const title = session.title ?? ref.channelId;
      return [{ id: ref.channelId, title, time: session.updatedAt ?? 0 }];
    });
    // An allowlisted channel Core has not seen yet has no stored session but can still be read.
    const seen = new Set(stored.map((row) => row.id));
    const unseen = [...new Set(input.config.surface.discord?.allowedChannelIds ?? [])]
      .filter((id) => !seen.has(id))
      .map((id) => {
        const alias = bestEffortAliasForDiscordChannelId({ channelId: id, cfg: input.config });
        return { id, title: alias ? `#${alias}` : id, time: 0 };
      });
    const rows = [...stored, ...unseen]
      .sort((left, right) => right.time - left.time || newerIdFirst(left.id, right.id))
      .filter(
        (row) => !after || row.time < after.time || (row.time === after.time && row.id < after.id),
      );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return Result.ok({
      items: page.map(({ id, title, time }) => ({
        kind: "thread" as const,
        id,
        client: "discord" as const,
        title,
        ...(time ? { updatedAt: isoTime(time) } : {}),
      })),
      ...(last && rows.length > page.length ? { before: `${last.time}_${last.id}` } : {}),
    });
  });
}

type SearchInput = {
  readonly ports: OrchestrateDirectoryPorts;
  readonly config: CoreConfig;
  /** Each surface to search, with the user id the search acts as there. */
  readonly identities: readonly { readonly client: DirectoryClient; readonly userId: string }[];
  readonly query: string;
  readonly limit: number;
  readonly snippetChars: number;
};

type Hits = { readonly summaries: SearchRow[]; readonly messages: SearchRow[] };

function row(
  input: SearchInput,
  hit: Omit<SearchRow, "snippet" | "snippetTruncated"> & { readonly text: string },
): SearchRow {
  const { text, ...rest } = hit;
  const snippet = boundTimelineText(text, input.snippetChars);
  return {
    ...rest,
    snippet: snippet.text,
    ...(snippet.truncated ? { snippetTruncated: true as const } : {}),
  };
}

async function searchNative(
  input: SearchInput,
  userId: string,
): Promise<ResultType<Hits, OrchestrateDirectoryFailed>> {
  return Result.gen(async function* () {
    const native = input.ports.native;
    if (!native) return Result.ok({ summaries: [], messages: [] });
    const summaries = yield* Result.await(
      native
        .summaries(userId, { query: input.query, limit: SUMMARY_CANDIDATES })
        .then((found) => found.mapError((error) => failed(error.message))),
    );
    const messages = yield* native
      .query(userId, { query: input.query, limit: MESSAGE_CANDIDATES })
      .mapError((error) => failed(error.message));
    return Result.ok({
      summaries: summaries.map((hit) =>
        row(input, {
          id: hit.threadId,
          client: "native",
          title: hit.title,
          text: hit.brief,
          matchedIn: "summary",
          ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}),
        }),
      ),
      messages: messages.items.map((hit) =>
        row(input, {
          id: hit.threadId,
          client: "native",
          title: hit.title,
          text: hit.excerpt,
          matchedIn: "message",
        }),
      ),
    });
  });
}

async function discordSummaries(
  input: SearchInput,
): Promise<ResultType<SearchRow[], OrchestrateDirectoryFailed>> {
  const service = input.ports.conversationThreads;
  if (!service) return Result.ok([]);
  const searched = await Result.tryPromise({
    try: () =>
      service.search({
        surface: "discord",
        query: input.query,
        limit: SUMMARY_CANDIDATES,
        verbose: true,
      }),
    // A defect keeps its identity; any other rejection is an ordinary search failure.
    catch: (cause) =>
      Panic.is(cause)
        ? cause
        : failed(cause instanceof Error ? cause.message : "Conversation search failed"),
  });
  return searched
    .mapError((error) => (Panic.is(error) ? preserveToolPanic(error) : error))
    .map((result) =>
      result.results.flatMap((hit) => {
        const session = hit.session;
        if (!session || !allowedDiscordChannel(input.config, session.channelId, session.guildId))
          return [];
        return [
          row(input, {
            id: session.channelId,
            client: "discord",
            title: hit.title,
            text: hit.brief,
            matchedIn: "summary",
            ...(hit.timeRange ? { updatedAt: hit.timeRange.end } : {}),
          }),
        ];
      }),
    );
}

function firstMatchedText(group: DiscoveryResultGroup): string {
  for (const context of group.entries)
    for (const entry of context) if (entry.kind === "message" && entry.matched) return entry.text;
  return "";
}

async function discordMessages(
  input: SearchInput,
): Promise<ResultType<SearchRow[], OrchestrateDirectoryFailed>> {
  return Result.gen(async function* () {
    const discovery = input.ports.discovery;
    if (!discovery) return Result.ok([]);
    const found = yield* Result.await(
      discovery
        .searchResult({
          query: input.query,
          platform: "discord",
          sources: ["conversation"],
          groupBy: "origin",
          surrounding: 0,
          limit: MESSAGE_CANDIDATES,
        })
        .then((searched) => searched.mapError((error) => failed(error.message))),
    );
    const adapter = input.ports.discordAdapter?.();
    const rows: SearchRow[] = [];
    for (const group of found.groups) {
      if (rows.length >= input.limit) break;
      const origin = group.origin;
      if (origin?.kind !== "session") continue;
      // Discovery does not record guilds, and a guild-wide allowlist needs one.
      const listed = allowedDiscordChannel(input.config, origin.sessionId);
      const guildId =
        !listed && adapter
          ? await resolveGuildIdForChannel({ adapter, channelId: origin.sessionId })
          : null;
      if (!listed && !allowedDiscordChannel(input.config, origin.sessionId, guildId)) continue;
      rows.push(
        row(input, {
          id: origin.sessionId,
          client: "discord",
          title: origin.label ?? origin.sessionId,
          text: firstMatchedText(group),
          matchedIn: "message",
          ...(group.ts ? { updatedAt: isoTime(group.ts) } : {}),
        }),
      );
    }
    return Result.ok(rows);
  });
}

async function searchDiscord(
  input: SearchInput,
): Promise<ResultType<Hits, OrchestrateDirectoryFailed>> {
  return Result.gen(async function* () {
    const summaries = yield* Result.await(discordSummaries(input));
    const messages = yield* Result.await(discordMessages(input));
    return Result.ok({ summaries, messages });
  });
}

/**
 * Searches thread summaries and messages on each surface, one row per thread. Summary matches
 * come before message matches, because a summary describes the whole thread.
 */
export async function searchThreads(
  input: SearchInput,
): Promise<ResultType<SearchRow[], OrchestrateDirectoryFailed>> {
  return Result.gen(async function* () {
    const found: Hits[] = [];
    for (const identity of input.identities) {
      const hits =
        identity.client === "native"
          ? yield* Result.await(searchNative(input, identity.userId))
          : yield* Result.await(searchDiscord(input));
      found.push(hits);
    }
    const seen = new Set<string>();
    const rows: SearchRow[] = [];
    for (const hit of [
      ...found.flatMap((hits) => hits.summaries),
      ...found.flatMap((hits) => hits.messages),
    ]) {
      const key = `${hit.client}:${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(hit);
    }
    return Result.ok(rows.slice(0, input.limit));
  });
}
