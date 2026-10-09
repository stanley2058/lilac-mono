import {
  installNativeConversationSource,
  readNativeConversationThreads,
  readNativeConversationMessages,
  readNativeConversationAttachments,
} from "../surface/native/conversation-source";
import { SUMMARY_QUIET_MS } from "./thread-summary-policy";
import { CONVERSATION_FACET_WEIGHTS as FACET_WEIGHTS } from "./thread-search-weights";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as sqliteVec from "sqlite-vec";
import {
  classifyBunSqliteError,
  createLogger,
  resolveRouterSessionConfig,
  runBunSqliteTransaction,
  type CoreConfig,
  type PersistedDataError,
  type PersistedDataIssueCode,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type {
  ConversationThreadEmbeddingFacet,
  ConversationThreadFacetInput,
} from "./thread-embedding";
import {
  CONVERSATION_THREAD_SUMMARY_FORMAT_VERSION,
  decodeConversationThreadSummaryRow,
  type ConversationThreadAboutness,
  type ConversationThreadImportance,
  type DecodedConversationThreadSummaryRow,
  type PersistedConversationThreadSummaryRow,
} from "./thread-summary-persistence-codec";
import { isDiscordSessionDividerText } from "../surface/discord/discord-session-divider";
import { splitByDiscordWindowOldestToNewest } from "../surface/discord/merge-window";
import { parseLeadingContinueDirective } from "../surface/discord/discord-request-router/common";
import { configureSqliteConnection } from "../shared/sqlite";
import type { DiscordSearchIndexedMessage } from "../surface/store/discord-search-store";
import type { DiscordIndexedAttachmentMeta } from "../surface/discord/discord-attachment";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";

const SEARCH_LIMIT_MAX = 50;
const THREAD_DISCOVERY_GAP_MS = 60 * 60 * 1000;
const threadStoreLogger = createLogger({ module: "conversation-thread-store" });

function resultErrorOrNull<T, E>(result: ResultType<T, E>): E | null {
  const select = result.match<() => E | null>({
    ok: () => () => null,
    err: (error) => () => error,
  });
  return select();
}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

export const CONVERSATION_THREAD_SUMMARY_VERSION = 5;
export const CONVERSATION_THREAD_EMBEDDING_VERSION = 1;

export type ConversationThreadKind = "discord_thread" | "inferred_channel_thread" | "native_thread";

export type ConversationThreadRepairKind = "content" | "topology";

export type ConversationThreadRefreshResult = {
  channels: number;
  threads: number;
  messages: number;
};

export type ConversationThreadContentInvalidationResult = {
  messages: number;
  threads: number;
};

type ConversationThreadGroupingMode = "mention" | "active";

export type ConversationThreadRow = {
  thread_id: string;
  channel_id: string;
  guild_id: string | null;
  parent_channel_id: string | null;
  kind: ConversationThreadKind;
  start_message_id: string;
  end_message_id: string;
  start_ts: number;
  end_ts: number;
  message_count: number;
  updated_at: number;
  last_summarized_at: number | null;
  last_embedded_at: number | null;
  summary_input_hash: string | null;
  summary_prompt_context_hash: string | null;
  embedding_input_hash: string | null;
  summary_version: number;
  embedding_version: number;
  maintenance_attempted_at: number | null;
  maintenance_retry_after: number | null;
};

export type ConversationThreadSummarizationEligibilityReason =
  | "forced"
  | "never-summarized"
  | "content-changed"
  | "summary-version"
  | "embedding-missing"
  | "embedding-outdated"
  | "embedding-version"
  | "embedding-model";

export type ConversationThreadSummarizationEligibility = {
  thread: ConversationThreadRow;
  reasons: ConversationThreadSummarizationEligibilityReason[];
  summaryIsStale: boolean;
  embeddingIsStale: boolean;
};

export type ConversationThreadSummaryRow = PersistedConversationThreadSummaryRow;

export type ConversationThreadMessage = {
  surface?: "discord" | "native";
  channelId: string;
  messageId: string;
  ordinal: number;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  attachments: DiscordIndexedAttachmentMeta[];
};

export type { ConversationThreadAboutness, ConversationThreadImportance };

export type ConversationThreadAboutnessInput = {
  domains?: string[];
  situations?: string[];
  complaintTargets?: string[];
  entities?: string[];
  userWouldAskForThisAs?: string[];
};

export type ConversationThreadSummaryInput = {
  title: string;
  brief: string;
  topics: string[];
  retrievalHints?: string[];
  aboutness?: ConversationThreadAboutnessInput;
  importance?: ConversationThreadImportance;
  importanceReasons?: string[];
};

export type ConversationThreadSummary = {
  title: string;
  brief: string;
  topics: string[];
  retrievalHints: string[];
  aboutness: ConversationThreadAboutness;
  importance: ConversationThreadImportance;
  importanceReasons: string[];
};

export type ConversationThreadSearchHit = {
  threadId: string;
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  kind: ConversationThreadKind;
  sourceRevision?: string;
  title: string;
  brief: string;
  topics: string[];
  retrievalHints: string[];
  aboutness: ConversationThreadAboutness;
  importance: ConversationThreadImportance;
  importanceReasons: string[];
  startTs: number;
  endTs: number;
  messageCount: number;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  startMessageId: string;
  endMessageId: string;
  summarized: boolean;
  stale: boolean;
};

export type ConversationThreadSearchFilters = {
  surface?: "discord" | "native";
  participantSurface?: "discord" | "native";
  sessionId?: string;
  participantId?: string;
  participantIdsAny?: readonly string[];
  beforeTs?: number;
  afterTs?: number;
};

export type ConversationThreadSearchAllowlist = {
  channelIds: readonly string[];
  guildIds: readonly string[];
};

export type ConversationThreadReadResult = {
  thread: ConversationThreadRow;
  summary: ConversationThreadSummary | null;
  messages: ConversationThreadMessage[];
  totalMessages: number;
};

type IndexedMessageRow = {
  channel_id: string;
  guild_id: string | null;
  parent_channel_id: string | null;
  session_type: string | null;
  message_id: string;
  user_id: string;
  user_name: string | null;
  text: string;
  ts: number;
  edited_ts: number | null;
  updated_ts: number;
  attachments_hash: string | null;
  is_chat: number;
  reply_to_channel_id: string | null;
  reply_to_message_id: string | null;
};

type ThreadSearchRow = ConversationThreadRow &
  PersistedConversationThreadSummaryRow & {
    lexical_score: number;
  };

type ThreadSemanticSearchRow = ConversationThreadRow &
  PersistedConversationThreadSummaryRow & {
    semantic_score: number;
  };

type FacetRow = {
  facet: ConversationThreadEmbeddingFacet;
  text: string;
};

const SEMANTIC_SIMILARITY_FLOOR = 0.15;

export type ConversationThreadStoreOptions = {
  surfaceDbPath?: string;
  nativeDbPath?: string;
  mainAgentUserNames?: readonly string[];
  onPersistenceDiagnostic?: (diagnostic: ConversationThreadPersistenceDiagnostic) => void;
};

export type ConversationThreadPersistenceDiagnostic = {
  readonly table: "conversation_thread_summaries";
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
};

export class ConversationThreadSqliteDriverFailure extends TaggedError(
  "ConversationThreadSqliteDriverFailure",
)<{
  readonly operation:
    | "attach-surface-db"
    | "inspect-surface-db"
    | "load-vector-extension"
    | "upsert-summary";
  readonly code: string;
  readonly message: string;
}> {}

function classifyConversationThreadSqliteDriverFailure(
  cause: Error,
  operation: ConversationThreadSqliteDriverFailure["operation"] = "upsert-summary",
): ConversationThreadSqliteDriverFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError === undefined) return undefined;
  return new ConversationThreadSqliteDriverFailure({
    operation,
    code: sqliteError.code,
    message: "Conversation thread summary SQLite write failed",
  });
}

function signalConversationThreadStoreDefect(cause: unknown): never {
  if (cause instanceof Error) return adaptToolResultToHost(Result.err(cause));
  return adaptToolResultToHost(
    Result.err(new Panic({ message: "Conversation thread store defect", cause })),
  );
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sqlString(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function truncate(input: string, maxLength: number): string {
  const normalized = input.trim().replace(/\s+/gu, " ");
  return normalized.length > maxLength ? normalized.slice(0, maxLength).trimEnd() : normalized;
}

function normalizeStringList(
  values: readonly string[] | undefined,
  maxItems: number,
  maxLength: number,
): string[] {
  return (values ?? [])
    .map((value) => truncate(value, maxLength))
    .filter((value) => value.length > 0)
    .slice(0, maxItems);
}

function normalizeAboutness(
  aboutness: ConversationThreadAboutnessInput | undefined,
): ConversationThreadAboutness {
  return {
    domains: normalizeStringList(aboutness?.domains, 8, 80),
    situations: normalizeStringList(aboutness?.situations, 8, 120),
    complaintTargets: normalizeStringList(aboutness?.complaintTargets, 8, 160),
    entities: normalizeStringList(aboutness?.entities, 20, 80),
    userWouldAskForThisAs: normalizeStringList(aboutness?.userWouldAskForThisAs, 8, 160),
  };
}

function normalizeSummary(summary: ConversationThreadSummaryInput): ConversationThreadSummary {
  return {
    title: truncate(summary.title, 120) || "Untitled conversation",
    brief: truncate(summary.brief, 1024),
    topics: normalizeStringList(summary.topics, 12, 80),
    retrievalHints: normalizeStringList(summary.retrievalHints, 8, 160),
    aboutness: normalizeAboutness(summary.aboutness),
    importance: summary.importance ?? "medium",
    importanceReasons: normalizeStringList(summary.importanceReasons, 5, 180),
  };
}

function computeThreadInputHash(messages: readonly IndexedMessageRow[]): string {
  return stableHash(
    messages
      .map((message) => {
        const fields: Array<string | number> = [
          message.channel_id,
          message.message_id,
          message.user_id,
          message.user_name ?? "",
          message.ts,
          message.edited_ts ?? "",
          message.text,
        ];
        if (message.attachments_hash !== null) fields.push(message.attachments_hash);
        return fields.join("\u001f");
      })
      .join("\u001e"),
  );
}

function computeSummaryHash(summary: ConversationThreadSummary): string {
  return stableHash(
    [
      summary.title,
      summary.brief,
      ...summary.topics,
      ...summary.retrievalHints,
      ...summary.aboutness.domains,
      ...summary.aboutness.situations,
      ...summary.aboutness.complaintTargets,
      ...summary.aboutness.entities,
      ...summary.aboutness.userWouldAskForThisAs,
    ].join("\u001f"),
  );
}

function computeFacetHash(facets: readonly ConversationThreadFacetInput[]): string {
  return stableHash(
    [...facets]
      .sort((a, b) => a.facet.localeCompare(b.facet))
      .map((facet) => [facet.facet, facet.text].join("\u001f"))
      .join("\u001e"),
  );
}

function facetWeightSql(alias: string): string {
  const clauses = Object.entries(FACET_WEIGHTS)
    .map(([facet, weight]) => `WHEN ${sqlString(facet)} THEN ${weight}`)
    .join(" ");
  return `CASE ${alias}.facet ${clauses} ELSE 0 END`;
}

function messageKey(channelId: string, messageId: string): string {
  return `${channelId}\u001f${messageId}`;
}

function groupInferredMessages(input: {
  messages: readonly IndexedMessageRow[];
  mode: ConversationThreadGroupingMode;
  botMentionNames: readonly string[];
  mainAgentUserNames: ReadonlySet<string>;
}): IndexedMessageRow[][] {
  const { messages, mode } = input;
  if (messages.length === 0) return [];

  const parent = messages.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const byMessage = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    byMessage.set(messageKey(message.channel_id, message.message_id), i);
  }

  const visualGroups = splitByDiscordWindowOldestToNewest(
    messages.map((message, index) => ({
      index,
      authorId: message.user_id,
      ts: message.ts,
      hardBreakBefore: Boolean(message.reply_to_message_id),
    })),
  );

  for (const group of visualGroups) {
    const first = group[0];
    if (!first) continue;
    for (const item of group.slice(1)) {
      union(first.index, item.index);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const previous = messages[i - 1];
    if (mode === "active" && previous && message.ts - previous.ts <= THREAD_DISCOVERY_GAP_MS) {
      union(i - 1, i);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!message.reply_to_message_id) continue;
    const replyChannelId = message.reply_to_channel_id ?? message.channel_id;
    if (replyChannelId !== message.channel_id) continue;
    const targetIndex = byMessage.get(messageKey(replyChannelId, message.reply_to_message_id));
    if (targetIndex === undefined) continue;
    union(i, targetIndex);
  }

  if (mode === "active") {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.reply_to_message_id) continue;
      if (isConfiguredMainAgentMessageRow(message, input.mainAgentUserNames)) continue;

      const continueCount = parseLeadingContinueDirective({
        text: message.text,
        botNames: input.botMentionNames,
      });
      if (continueCount === undefined) continue;

      const start = Math.max(0, i - continueCount);
      for (let j = start; j < i; j++) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, IndexedMessageRow[]>();
  for (let i = 0; i < messages.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(messages[i]!);
    else groups.set(root, [messages[i]!]);
  }

  return [...groups.values()].sort((left, right) => {
    const leftStart = left[0]!;
    const rightStart = right[0]!;
    if (leftStart.ts !== rightStart.ts) return leftStart.ts - rightStart.ts;
    return leftStart.message_id.localeCompare(rightStart.message_id);
  });
}

function resolveConversationThreadBotMentionNames(input: {
  cfg?: CoreConfig;
  mainAgentUserNames: ReadonlySet<string>;
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined) => {
    const name = value?.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  add(input.cfg?.surface.discord.botName);
  for (const name of input.mainAgentUserNames) add(name);

  return names;
}

export function classifyConversationThreadMessageUpdate(
  before: DiscordSearchIndexedMessage | null | undefined,
  after: DiscordSearchIndexedMessage,
  cfg?: CoreConfig,
): ConversationThreadRepairKind | null {
  if (!before) return "topology";

  const attachmentContentChanged =
    JSON.stringify(before.attachments) !== JSON.stringify(after.attachments);
  const persistedContentChanged =
    before.text !== after.text || before.editedTs !== after.editedTs || attachmentContentChanged;
  const persistedTopologyFieldChanged =
    before.ref.platform !== after.ref.platform ||
    before.ref.channelId !== after.ref.channelId ||
    before.ref.messageId !== after.ref.messageId ||
    before.session.platform !== after.session.platform ||
    before.session.channelId !== after.session.channelId ||
    before.session.guildId !== after.session.guildId ||
    before.session.parentChannelId !== after.session.parentChannelId ||
    before.userId !== after.userId ||
    before.userName !== after.userName ||
    before.ts !== after.ts ||
    before.deleted !== after.deleted;

  if (!persistedContentChanged && !persistedTopologyFieldChanged) return null;
  if (persistedTopologyFieldChanged) return "topology";
  const beforeEligible = before.text.trim().length > 0 || before.attachments.length > 0;
  const afterEligible = after.text.trim().length > 0 || after.attachments.length > 0;
  if (beforeEligible !== afterEligible) return "topology";
  if (isDiscordSessionDividerText(before.text) !== isDiscordSessionDividerText(after.text)) {
    return "topology";
  }

  const botNames = resolveConversationThreadBotMentionNames({
    cfg,
    mainAgentUserNames: new Set<string>(),
  });
  const beforeContinueCount = parseLeadingContinueDirective({ text: before.text, botNames });
  const afterContinueCount = parseLeadingContinueDirective({ text: after.text, botNames });
  if (beforeContinueCount !== afterContinueCount) return "topology";

  return "content";
}

function isMainAgentMessageRow(
  message: IndexedMessageRow,
  mainAgentUserNames: ReadonlySet<string>,
): boolean {
  if (mainAgentUserNames.size === 0) return true;
  const userName = message.user_name?.trim().toLowerCase();
  return !!userName && mainAgentUserNames.has(userName);
}

function isConfiguredMainAgentMessageRow(
  message: IndexedMessageRow,
  mainAgentUserNames: ReadonlySet<string>,
): boolean {
  if (mainAgentUserNames.size === 0) return false;
  const userName = message.user_name?.trim().toLowerCase();
  return !!userName && mainAgentUserNames.has(userName);
}

function isSessionDividerBoundaryMessage(
  message: IndexedMessageRow,
  mainAgentUserNames: ReadonlySet<string>,
): boolean {
  if (!isDiscordSessionDividerText(message.text)) return false;
  return isMainAgentMessageRow(message, mainAgentUserNames);
}

function splitMessagesBySessionDivider(input: {
  messages: readonly IndexedMessageRow[];
  mainAgentUserNames: ReadonlySet<string>;
}): IndexedMessageRow[][] {
  const groups: IndexedMessageRow[][] = [];
  let current: IndexedMessageRow[] = [];

  for (const message of input.messages) {
    if (isSessionDividerBoundaryMessage(message, input.mainAgentUserNames)) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }

    current.push(message);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function resolveThreadGroupingMode(input: {
  message: IndexedMessageRow;
  cfg?: CoreConfig;
}): ConversationThreadGroupingMode {
  const { message, cfg } = input;
  if (message.session_type === "dm") return "active";
  if (message.session_type === null) return "active";
  if (!cfg) return "active";

  return (
    resolveRouterSessionConfig(cfg, {
      sessionId: message.channel_id,
      parentChannelId: message.parent_channel_id,
      guildId: message.guild_id,
    }).mode ?? cfg.surface.router.defaultMode
  );
}

export type ConversationThreadSummaryWriteResult = {
  facets: ConversationThreadFacetInput[];
  embeddingInputHash: string;
};

function summaryFromDecodedRow(
  row: DecodedConversationThreadSummaryRow,
): ConversationThreadSummary {
  return {
    title: row.title,
    brief: row.brief,
    topics: row.topics,
    retrievalHints: row.retrievalHints,
    aboutness: row.aboutness,
    importance: row.importance,
    importanceReasons: row.importanceReasons,
  };
}

export class ConversationThreadStore {
  private readonly db: Database;
  private readonly searchDbPath: string;
  private readonly surfaceDbPath?: string;
  private readonly mainAgentUserNames: ReadonlySet<string>;
  private hasNativeSource = false;
  private nativeDataVersion: number | undefined;
  private readonly onPersistenceDiagnostic: (
    diagnostic: ConversationThreadPersistenceDiagnostic,
  ) => void;
  private hasSurfaceDb: boolean;
  private vectorLoadError: string | null = null;
  private vectorLoaded = false;

  constructor(dbPath: string, options: ConversationThreadStoreOptions = {}) {
    this.db = new Database(dbPath);
    configureSqliteConnection(this.db);
    this.searchDbPath = dbPath;
    this.surfaceDbPath = options.surfaceDbPath;
    this.onPersistenceDiagnostic =
      options.onPersistenceDiagnostic ??
      ((diagnostic) => {
        threadStoreLogger.warn("conversation thread persisted summary decode failed", diagnostic);
      });
    this.mainAgentUserNames = new Set(
      (options.mainAgentUserNames ?? [])
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );
    this.hasSurfaceDb = this.attachSurfaceDb();
    this.loadVectorExtension();
    this.migrate();
    installNativeConversationSource(this.db, options.nativeDbPath);
    this.hasNativeSource = options.nativeDbPath !== undefined;
    this.installMessageSource();
  }

  attachNativeSource(databasePath: string): void {
    installNativeConversationSource(this.db, databasePath);
    this.hasNativeSource = true;
    this.nativeDataVersion = undefined;
  }

  private installMessageSource(): void {
    this.db.run(`CREATE TEMP VIEW conversation_source_messages AS
      SELECT 'discord' AS surface, channel_id,message_id,user_id,user_name,text,ts,deleted
      FROM discord_search_messages
      UNION ALL SELECT 'native',channel_id,message_id,user_id,user_name,text,ts,0
      FROM native_conversation_messages`);
  }

  refreshNativeThreads(): void {
    if (!this.hasNativeSource) return;
    const version = this.db
      .query<{ data_version: number }, []>("PRAGMA native_conversation.data_version")
      .get()?.data_version;
    if (version !== undefined && version === this.nativeDataVersion) return;
    const startedAt = performance.now();
    this.db.transaction(() => this.materializeNativeThreads()).immediate();
    // Remember the version from before the scan so a concurrent commit cannot be skipped.
    this.nativeDataVersion = version;
    threadStoreLogger.debug("conversation.thread.native_refresh", {
      elapsedMs: performance.now() - startedAt,
    });
  }

  private materializeNativeThreads(): void {
    const threads = selectResultValue(readNativeConversationThreads(this.db));
    const activeIds = new Set(threads.map((thread) => `native:${thread.id}`));
    for (const row of this.db
      .query<{ thread_id: string }, []>(
        "SELECT thread_id FROM conversation_threads WHERE kind='native_thread'",
      )
      .all()) {
      if (!activeIds.has(row.thread_id)) this.deleteThread(row.thread_id);
    }
    for (const thread of threads) {
      const threadId = `native:${thread.id}`;
      const existing = this.getThread(threadId);
      const hash = `native:${stableHash(thread.revision)}`;
      if (existing?.summary_input_hash === hash) continue;
      const sourceMessages = selectResultValue(readNativeConversationMessages(this.db, thread.id));
      const messages: IndexedMessageRow[] = sourceMessages.map((message) => ({
        ...message,
        guild_id: null,
        parent_channel_id: null,
        session_type: "thread",
        edited_ts: null,
        updated_ts: thread.updated_at,
        attachments_hash: null,
        is_chat: 1,
        reply_to_channel_id: null,
        reply_to_message_id: null,
      }));
      // Rebuild changed native entries so removed text cannot survive in a previous summary.
      this.deleteThread(threadId);
      this.upsertThread({ threadId, kind: "native_thread", parentChannelId: null, messages });
      this.db.run(
        "UPDATE conversation_threads SET summary_input_hash=?,updated_at=?,end_ts=? WHERE thread_id=?",
        [hash, thread.updated_at, thread.updated_at, threadId],
      );
    }
  }

  close(): void {
    this.db.close();
  }

  isVectorSearchAvailable(): boolean {
    return this.vectorLoaded;
  }

  getVectorLoadError(): string | null {
    return this.vectorLoadError;
  }

  private loadVectorExtension(): void {
    const loaded = Result.try({
      try: () => sqliteVec.load(this.db),
      catch: (cause) => cause,
    });
    loaded.match({
      ok: () => () => {
        this.vectorLoaded = true;
        this.vectorLoadError = null;
      },
      err: (error) => () => {
        if (!(error instanceof Error)) return signalConversationThreadStoreDefect(error);
        const sqliteFailure = classifyConversationThreadSqliteDriverFailure(
          error,
          "load-vector-extension",
        );
        if (!sqliteFailure) return signalConversationThreadStoreDefect(error);
        this.vectorLoaded = false;
        this.vectorLoadError = sqliteFailure.message;
      },
    })();
  }

  private attachSurfaceDb(): boolean {
    const surfaceDbPath = this.surfaceDbPath;
    if (!surfaceDbPath || surfaceDbPath === this.searchDbPath) return false;
    const attached = Result.try({
      try: () => {
        this.db.run(`ATTACH DATABASE ${sqlString(surfaceDbPath)} AS surface`);
        if (!this.hasRequiredSurfaceTables()) {
          this.db.run("DETACH DATABASE surface");
          return false;
        }
        return true;
      },
      catch: (cause) => cause,
    });
    return attached.match({
      ok: (value) => () => value,
      err: (error) => () => {
        if (!(error instanceof Error)) return signalConversationThreadStoreDefect(error);
        if (!classifyConversationThreadSqliteDriverFailure(error, "attach-surface-db")) {
          return signalConversationThreadStoreDefect(error);
        }
        return false;
      },
    })();
  }

  private hasRequiredSurfaceTables(): boolean {
    const checked = Result.try({
      try: () => {
        const rows = this.db
          .query(
            `
          SELECT name
          FROM surface.sqlite_master
          WHERE type = 'table'
            AND name IN ('discord_sessions', 'discord_message_relations')
          `,
          )
          .all() as Array<{ name: string }>;
        return rows.length === 2;
      },
      catch: (cause) => cause,
    });
    return checked.match({
      ok: (value) => () => value,
      err: (error) => () => {
        if (!(error instanceof Error)) return signalConversationThreadStoreDefect(error);
        if (!classifyConversationThreadSqliteDriverFailure(error, "inspect-surface-db")) {
          return signalConversationThreadStoreDefect(error);
        }
        return false;
      },
    })();
  }

  private ensureSurfaceDb(): boolean {
    if (this.hasSurfaceDb) return true;
    this.hasSurfaceDb = this.attachSurfaceDb();
    return this.hasSurfaceDb;
  }

  private tableHasColumn(
    tableName:
      | "conversation_threads"
      | "conversation_thread_summaries"
      | "conversation_thread_facets",
    columnName: string,
  ): boolean {
    const rows = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private reportPersistenceError(error: PersistedDataError): void {
    this.onPersistenceDiagnostic({
      table: "conversation_thread_summaries",
      field: error.field,
      version: error.version,
      issueCode: error.issueCode,
      recordId: error.recordId,
    });
  }

  private migrate(): void {
    const reset = this.db.transaction(() => {
      const current = this.db
        .query("SELECT name FROM sqlite_master WHERE name='conversation_index_v2'")
        .get();
      if (current) return;
      for (const table of [
        "conversation_thread_facets_fts",
        "conversation_thread_embeddings",
        "conversation_thread_facets",
        "conversation_thread_summaries",
        "conversation_thread_messages",
        "conversation_threads",
      ])
        this.db.run(`DROP TABLE IF EXISTS ${table}`);
      this.db.run("CREATE TABLE conversation_index_v2 (version INTEGER NOT NULL)");
      this.db.run("INSERT INTO conversation_index_v2 VALUES (2)");
    });
    reset();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        thread_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        parent_channel_id TEXT,
        kind TEXT NOT NULL,
        start_message_id TEXT NOT NULL,
        end_message_id TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_summarized_at INTEGER,
        last_embedded_at INTEGER,
        summary_input_hash TEXT,
        summary_prompt_context_hash TEXT,
        embedding_input_hash TEXT,
        summary_version INTEGER NOT NULL DEFAULT ${CONVERSATION_THREAD_SUMMARY_VERSION},
        embedding_version INTEGER NOT NULL DEFAULT ${CONVERSATION_THREAD_EMBEDDING_VERSION},
        maintenance_attempted_at INTEGER,
        maintenance_retry_after INTEGER
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_channel_end_ts
      ON conversation_threads(channel_id, end_ts DESC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated_at
      ON conversation_threads(updated_at ASC);
    `);

    if (!this.tableHasColumn("conversation_threads", "summary_prompt_context_hash")) {
      this.db.run(`
        ALTER TABLE conversation_threads
        ADD COLUMN summary_prompt_context_hash TEXT;
      `);
    }

    if (!this.tableHasColumn("conversation_threads", "maintenance_attempted_at")) {
      this.db.run(`
        ALTER TABLE conversation_threads
        ADD COLUMN maintenance_attempted_at INTEGER;
      `);
    }

    if (!this.tableHasColumn("conversation_threads", "maintenance_retry_after")) {
      this.db.run(`
        ALTER TABLE conversation_threads
        ADD COLUMN maintenance_retry_after INTEGER;
      `);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_messages (
        thread_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_messages_thread_ordinal
      ON conversation_thread_messages(thread_id, ordinal ASC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_messages_channel_message
      ON conversation_thread_messages(channel_id, message_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_summaries (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        retrieval_hints_json TEXT NOT NULL DEFAULT '[]',
        aboutness_json TEXT NOT NULL DEFAULT '{}',
        importance TEXT NOT NULL DEFAULT 'medium',
        importance_reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary_format_version INTEGER
      );
    `);

    if (!this.tableHasColumn("conversation_thread_summaries", "summary_format_version")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN summary_format_version INTEGER;
      `);
    }

    if (!this.tableHasColumn("conversation_thread_summaries", "importance")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN importance TEXT NOT NULL DEFAULT 'medium';
      `);
    }

    if (!this.tableHasColumn("conversation_thread_summaries", "retrieval_hints_json")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN retrieval_hints_json TEXT NOT NULL DEFAULT '[]';
      `);
    }

    if (!this.tableHasColumn("conversation_thread_summaries", "importance_reasons_json")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN importance_reasons_json TEXT NOT NULL DEFAULT '[]';
      `);
    }

    if (!this.tableHasColumn("conversation_thread_summaries", "aboutness_json")) {
      this.db.run(`
        ALTER TABLE conversation_thread_summaries
        ADD COLUMN aboutness_json TEXT NOT NULL DEFAULT '{}';
      `);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_facets (
        thread_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, facet)
      );
    `);

    if (this.tableHasColumn("conversation_thread_facets", "weight")) {
      this.db.run(`
        ALTER TABLE conversation_thread_facets
        DROP COLUMN weight;
      `);
    }

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_thread_facets_fts
      USING fts5(
        text,
        content='conversation_thread_facets',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_ai
      AFTER INSERT ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_ad
      AFTER DELETE ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(conversation_thread_facets_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS conversation_thread_facets_au
      AFTER UPDATE ON conversation_thread_facets
      BEGIN
        INSERT INTO conversation_thread_facets_fts(conversation_thread_facets_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO conversation_thread_facets_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_embeddings (
        thread_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, facet, model_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_embeddings_model
      ON conversation_thread_embeddings(model_id, dimensions);
    `);
  }

  listMaterializationChannelIds(): string[] {
    const rows = this.db
      .query(
        `
        SELECT channel_id
        FROM discord_search_messages
        UNION
        SELECT channel_id
        FROM conversation_threads
        ORDER BY channel_id ASC
        `,
      )
      .all() as Array<{ channel_id: string }>;
    return rows.map((row) => row.channel_id);
  }

  refreshInferredThreads(input?: { cfg?: CoreConfig }): ConversationThreadRefreshResult {
    const result: ConversationThreadRefreshResult = { channels: 0, threads: 0, messages: 0 };
    for (const channelId of this.listMaterializationChannelIds()) {
      const channelResult = this.refreshInferredChannel({ channelId, cfg: input?.cfg });
      result.channels += channelResult.channels;
      result.threads += channelResult.threads;
      result.messages += channelResult.messages;
    }
    return result;
  }

  refreshInferredChannel(input: {
    channelId: string;
    cfg?: CoreConfig;
  }): ConversationThreadRefreshResult {
    const hasSurfaceDb = this.ensureSurfaceDb();
    const metadataSelect = hasSurfaceDb
      ? `
          s.parent_channel_id AS parent_channel_id,
          s.type AS session_type,
          COALESCE(r.is_chat, 1) AS is_chat,
          r.reply_to_channel_id AS reply_to_channel_id,
          r.reply_to_message_id AS reply_to_message_id
        `
      : `
          NULL AS parent_channel_id,
          NULL AS session_type,
          1 AS is_chat,
          NULL AS reply_to_channel_id,
          NULL AS reply_to_message_id
        `;
    const metadataJoin = hasSurfaceDb
      ? `
          LEFT JOIN surface.discord_sessions s
            ON s.channel_id = m.channel_id
          LEFT JOIN surface.discord_message_relations r
            ON r.channel_id = m.channel_id
           AND r.message_id = m.message_id
        `
      : "";
    const rows = this.db
      .query(
        `
        SELECT
          m.channel_id,
          m.guild_id,
          ${metadataSelect},
          m.message_id,
          m.user_id,
          m.user_name,
          m.text,
          m.ts,
          m.edited_ts,
          m.updated_ts,
          m.attachments_hash
        FROM discord_search_messages m
        ${metadataJoin}
        WHERE m.channel_id = ?
          AND m.deleted = 0
          AND (
            trim(m.text) <> ''
            OR EXISTS (
              SELECT 1
              FROM discord_search_message_attachments a
              WHERE a.channel_id = m.channel_id
                AND a.message_id = m.message_id
            )
          )
          AND (${hasSurfaceDb ? "r.is_chat IS NULL OR r.is_chat != 0" : "1 = 1"})
        ORDER BY m.ts ASC, m.message_id ASC
        `,
      )
      .all(input.channelId) as IndexedMessageRow[];

    let threadCount = 0;
    const activeThreadIds = new Set<string>();
    const botMentionNames = resolveConversationThreadBotMentionNames({
      cfg: input.cfg,
      mainAgentUserNames: this.mainAgentUserNames,
    });

    const tx = this.db.transaction(() => {
      for (const segment of splitMessagesBySessionDivider({
        messages: rows,
        mainAgentUserNames: this.mainAgentUserNames,
      })) {
        const first = segment[0];
        if (!first) continue;
        const mode = resolveThreadGroupingMode({ message: first, cfg: input.cfg });
        for (const group of groupInferredMessages({
          messages: segment,
          mode,
          botMentionNames,
          mainAgentUserNames: this.mainAgentUserNames,
        })) {
          if (!this.hasMainAgentMessage(group)) continue;
          const threadId = this.upsertInferredThread(group);
          if (!threadId) continue;
          activeThreadIds.add(threadId);
          threadCount += 1;
        }
      }

      const managedKinds = hasSurfaceDb
        ? "('inferred_channel_thread', 'discord_thread')"
        : "('inferred_channel_thread')";
      const existing = this.db
        .query(
          `
          SELECT thread_id
          FROM conversation_threads
          WHERE channel_id = ?
            AND kind IN ${managedKinds}
          `,
        )
        .all(input.channelId) as Array<{ thread_id: string }>;
      for (const row of existing) {
        if (activeThreadIds.has(row.thread_id)) continue;
        this.deleteThread(row.thread_id);
      }
    });

    tx();

    return {
      channels: rows.length > 0 ? 1 : 0,
      threads: threadCount,
      messages: rows.length,
    };
  }

  invalidateMaterializedMessages(input: {
    channelId: string;
    messageIds: readonly string[];
  }): ConversationThreadContentInvalidationResult {
    const messageIds = [...new Set(input.messageIds.map((id) => id.trim()).filter(Boolean))];
    if (messageIds.length === 0) return { messages: 0, threads: 0 };

    const updatedAt = Date.now();
    const contentRevision = `dirty:${crypto.randomUUID()}`;
    const tx = this.db.transaction(() => {
      let changed = 0;
      for (const messageId of messageIds) {
        const result = this.db.run(
          `
          UPDATE conversation_threads
          SET updated_at = MAX(updated_at, ?, COALESCE(last_summarized_at + 1, 0)),
              summary_input_hash = ?,
              maintenance_attempted_at = NULL,
              maintenance_retry_after = NULL
          WHERE thread_id IN (
            SELECT thread_id
            FROM conversation_thread_messages
            WHERE channel_id = ? AND message_id = ?
          )
          `,
          [updatedAt, contentRevision, input.channelId, messageId],
        );
        changed += result.changes;
      }
      return changed;
    });

    return { messages: messageIds.length, threads: tx() };
  }

  private hasMainAgentMessage(messages: readonly IndexedMessageRow[]): boolean {
    return messages.some((message) => isMainAgentMessageRow(message, this.mainAgentUserNames));
  }

  private upsertInferredThread(messages: readonly IndexedMessageRow[]): string | null {
    const first = messages[0];
    if (!first) return null;
    return this.upsertThread({
      threadId: `discord:channel:${first.channel_id}:${first.message_id}`,
      kind: "inferred_channel_thread",
      parentChannelId: first.parent_channel_id,
      messages,
    });
  }

  private upsertThread(input: {
    threadId: string;
    kind: ConversationThreadKind;
    parentChannelId: string | null;
    messages: readonly IndexedMessageRow[];
  }): string | null {
    const first = input.messages[0];
    const last = input.messages.at(-1);
    if (!first || !last) return null;

    const now = Date.now();
    const updatedAt = Math.max(...input.messages.map((message) => message.updated_ts));
    const inputHash = computeThreadInputHash(input.messages);
    const existing = this.getThread(input.threadId);
    const hashChanged = existing?.summary_input_hash !== inputHash;

    this.db.run(
      `
      INSERT INTO conversation_threads (
        thread_id,
        channel_id,
        guild_id,
        parent_channel_id,
        kind,
        start_message_id,
        end_message_id,
        start_ts,
        end_ts,
        message_count,
        updated_at,
        last_summarized_at,
        last_embedded_at,
        summary_input_hash,
        summary_prompt_context_hash,
        embedding_input_hash,
        summary_version,
        embedding_version,
        maintenance_attempted_at,
        maintenance_retry_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        channel_id=excluded.channel_id,
        guild_id=excluded.guild_id,
        parent_channel_id=excluded.parent_channel_id,
        kind=excluded.kind,
        start_message_id=excluded.start_message_id,
        end_message_id=excluded.end_message_id,
        start_ts=excluded.start_ts,
        end_ts=excluded.end_ts,
        message_count=excluded.message_count,
        updated_at=excluded.updated_at,
        last_summarized_at=conversation_threads.last_summarized_at,
        last_embedded_at=conversation_threads.last_embedded_at,
        summary_input_hash=excluded.summary_input_hash,
        summary_prompt_context_hash=conversation_threads.summary_prompt_context_hash,
        embedding_input_hash=conversation_threads.embedding_input_hash,
        summary_version=conversation_threads.summary_version,
        embedding_version=conversation_threads.embedding_version,
        maintenance_attempted_at=CASE
          WHEN excluded.summary_input_hash = conversation_threads.summary_input_hash THEN conversation_threads.maintenance_attempted_at
          ELSE NULL
        END,
        maintenance_retry_after=CASE
          WHEN excluded.summary_input_hash = conversation_threads.summary_input_hash THEN conversation_threads.maintenance_retry_after
          ELSE NULL
        END;
      `,
      [
        input.threadId,
        first.channel_id,
        first.guild_id,
        input.parentChannelId,
        input.kind,
        first.message_id,
        last.message_id,
        first.ts,
        last.ts,
        input.messages.length,
        hashChanged
          ? Math.max(
              updatedAt,
              existing?.updated_at ?? 0,
              now,
              (existing?.last_summarized_at ?? -1) + 1,
            )
          : (existing?.updated_at ?? updatedAt),
        existing?.last_summarized_at ?? null,
        existing?.last_embedded_at ?? null,
        inputHash,
        existing?.summary_prompt_context_hash ?? null,
        existing?.embedding_input_hash ?? null,
        CONVERSATION_THREAD_SUMMARY_VERSION,
        CONVERSATION_THREAD_EMBEDDING_VERSION,
        null,
        null,
      ],
    );

    this.db.run("DELETE FROM conversation_thread_messages WHERE thread_id = ?", [input.threadId]);
    for (let i = 0; i < input.messages.length; i++) {
      const message = input.messages[i]!;
      this.db.run(
        `
        INSERT INTO conversation_thread_messages (thread_id, channel_id, message_id, ordinal, ts)
        VALUES (?, ?, ?, ?, ?)
        `,
        [input.threadId, message.channel_id, message.message_id, i, message.ts],
      );
    }

    return input.threadId;
  }

  deleteThread(threadId: string): void {
    this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_facets WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_summaries WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_thread_messages WHERE thread_id = ?", [threadId]);
    this.db.run("DELETE FROM conversation_threads WHERE thread_id = ?", [threadId]);
  }

  getThread(threadId: string): ConversationThreadRow | null {
    if (threadId.startsWith("native:") && !this.hasNativeSource) return null;
    return this.db
      .query<ConversationThreadRow, [string]>(
        "SELECT * FROM conversation_threads WHERE thread_id = ?",
      )
      .get(threadId);
  }

  getSummary(threadId: string): ResultType<ConversationThreadSummary | null, PersistedDataError> {
    const row = this.db
      .query<ConversationThreadSummaryRow, [string]>(
        "SELECT * FROM conversation_thread_summaries WHERE thread_id = ?",
      )
      .get(threadId);
    if (!row) return Result.ok(null);
    const decoded = decodeConversationThreadSummaryRow(row);
    const finish = decoded.match<
      () => ResultType<ConversationThreadSummary | null, PersistedDataError>
    >({
      ok: (value) => () => Result.ok(summaryFromDecodedRow(value.value)),
      err: (error) => () => {
        this.reportPersistenceError(error);
        return Result.err(error);
      },
    });
    return finish();
  }

  getMessagePosition(
    channelId: string,
    messageId: string,
  ): { threadId: string; ordinal: number; authorId: string } | null {
    return this.db
      .query<{ threadId: string; ordinal: number; authorId: string }, [string, string]>(`
      SELECT tm.thread_id AS threadId, tm.ordinal, m.user_id AS authorId
      FROM conversation_thread_messages tm
      JOIN conversation_source_messages m ON m.channel_id = tm.channel_id AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
      WHERE tm.channel_id = ? AND tm.message_id = ? AND m.deleted = 0 AND m.surface = 'discord'
      ORDER BY tm.thread_id LIMIT 1
    `)
      .get(channelId, messageId);
  }

  listMessagePositionsBefore(
    threadId: string,
    beforeOrdinal: number,
  ): Array<{ messageId: string; ordinal: number; authorId: string }> {
    return this.db
      .query<{ messageId: string; ordinal: number; authorId: string }, [string, number]>(`
      SELECT tm.message_id AS messageId, tm.ordinal, m.user_id AS authorId
      FROM conversation_thread_messages tm
      JOIN conversation_source_messages m ON m.channel_id = tm.channel_id AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
      WHERE tm.thread_id = ? AND tm.ordinal < ? AND m.deleted = 0
      ORDER BY tm.ordinal DESC LIMIT 200
    `)
      .all(threadId, beforeOrdinal);
  }

  listMessages(threadId: string, offset = 0, limit = 50): ConversationThreadMessage[] {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(
        `
        SELECT
          tm.channel_id,
          tm.message_id,
          tm.ordinal,
          m.user_id,
          m.user_name,
          m.text,
          m.ts
        FROM conversation_thread_messages tm
        JOIN conversation_source_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
        WHERE tm.thread_id = ?
          AND m.deleted = 0
        ORDER BY tm.ordinal ASC
        LIMIT ? OFFSET ?
        `,
      )
      .all(threadId, safeLimit, safeOffset) as Array<{
      channel_id: string;
      message_id: string;
      ordinal: number;
      user_id: string;
      user_name: string | null;
      text: string;
      ts: number;
    }>;

    return rows.map((row) => ({
      surface: threadId.startsWith("native:") ? "native" : "discord",
      channelId: row.channel_id,
      messageId: row.message_id,
      ordinal: row.ordinal,
      userId: row.user_id,
      userName: row.user_name ?? undefined,
      text: row.text,
      ts: row.ts,
      attachments: threadId.startsWith("native:")
        ? selectResultValue(
            readNativeConversationAttachments(this.db, row.channel_id, row.message_id),
          )
        : this.listMessageAttachments(row.channel_id, row.message_id),
    }));
  }

  private listMessageAttachments(
    channelId: string,
    messageId: string,
  ): DiscordIndexedAttachmentMeta[] {
    const rows = this.db
      .query<
        {
          attachment_id: string | null;
          filename: string | null;
          mime_type: string | null;
          size: number | null;
        },
        [string, string]
      >(
        `
        SELECT attachment_id, filename, mime_type, size
        FROM discord_search_message_attachments
        WHERE channel_id = ? AND message_id = ?
        ORDER BY ordinal ASC
        `,
      )
      .all(channelId, messageId);
    return rows.map((row) => ({
      ...(row.attachment_id ? { id: row.attachment_id } : {}),
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.size !== null ? { size: row.size } : {}),
    }));
  }

  countThreadMessages(threadId: string): number {
    const row = this.db
      .query<{ c: number }, [string]>(
        `
        SELECT COUNT(1) AS c
        FROM conversation_thread_messages tm
        JOIN conversation_source_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
        WHERE tm.thread_id = ?
          AND m.deleted = 0
        `,
      )
      .get(threadId);
    return typeof row?.c === "number" ? row.c : 0;
  }

  readThread(
    threadId: string,
    offset?: number,
    limit?: number,
  ): ResultType<ConversationThreadReadResult | null, PersistedDataError> {
    const thread = this.getThread(threadId);
    if (!thread) return Result.ok(null);
    const summary = this.getSummary(threadId);
    return summary.map((value) => ({
      thread,
      summary: value,
      messages: this.listMessages(threadId, offset, limit),
      totalMessages: this.countThreadMessages(threadId),
    }));
  }

  listThreadsForSummarizationClear(input?: {
    threadId?: string;
    beforeTs?: number;
    afterTs?: number;
  }): ConversationThreadRow[] {
    const filter = buildThreadScopeClause(input);
    return this.db
      .query(
        `
        SELECT t.*
        FROM conversation_threads t
        WHERE ${filter.sql}
        ORDER BY t.updated_at ASC, t.thread_id ASC
        `,
      )
      .all(...filter.values) as ConversationThreadRow[];
  }

  clearSummarizationState(input?: {
    threadId?: string;
    beforeTs?: number;
    afterTs?: number;
  }): string[] {
    const threads = this.listThreadsForSummarizationClear(input);
    if (threads.length === 0) return [];

    const filter = buildThreadScopeClause(input);
    const tx = this.db.transaction(() => {
      this.db.run(
        `
        DELETE FROM conversation_thread_embeddings
        WHERE thread_id IN (
          SELECT t.thread_id FROM conversation_threads t WHERE ${filter.sql}
        )
        `,
        filter.values,
      );
      this.db.run(
        `
        DELETE FROM conversation_thread_facets
        WHERE thread_id IN (
          SELECT t.thread_id FROM conversation_threads t WHERE ${filter.sql}
        )
        `,
        filter.values,
      );
      this.db.run(
        `
        DELETE FROM conversation_thread_summaries
        WHERE thread_id IN (
          SELECT t.thread_id FROM conversation_threads t WHERE ${filter.sql}
        )
        `,
        filter.values,
      );
      this.db.run(
        `
        UPDATE conversation_threads AS t
        SET last_summarized_at = NULL,
            last_embedded_at = NULL,
            summary_prompt_context_hash = NULL,
            embedding_input_hash = NULL,
            summary_version = ?,
            embedding_version = ?,
            maintenance_attempted_at = NULL,
            maintenance_retry_after = NULL
        WHERE ${filter.sql}
        `,
        [
          CONVERSATION_THREAD_SUMMARY_VERSION,
          CONVERSATION_THREAD_EMBEDDING_VERSION,
          ...filter.values,
        ],
      );
    });

    tx();
    return threads.map((thread) => thread.thread_id);
  }

  listEligibleForSummarization(input?: {
    now?: number;
    quietMs?: number;
    threadId?: string;
    beforeTs?: number;
    afterTs?: number;
    includeEmbeddingStale?: boolean;
    embeddingModelId?: string;
    force?: boolean;
  }): ConversationThreadSummarizationEligibility[] {
    this.refreshNativeThreads();
    const now = input?.now ?? Date.now();
    const quietMs = input?.quietMs ?? SUMMARY_QUIET_MS;
    const embeddingModelId =
      input?.force !== true && input?.includeEmbeddingStale === true
        ? input.embeddingModelId
        : undefined;
    const embeddingModelSelect = embeddingModelId
      ? `, EXISTS (
          SELECT 1
          FROM conversation_thread_embeddings selected_embedding
          WHERE selected_embedding.thread_id = t.thread_id
            AND selected_embedding.model_id = ?
        ) AS has_embedding_model`
      : ", 0 AS has_embedding_model";
    const values: Array<string | number> = [];
    if (embeddingModelId) values.push(embeddingModelId);
    values.push(now - quietMs);
    const clauses = [
      "(CASE WHEN t.last_summarized_at IS NULL THEN t.end_ts ELSE t.updated_at END) <= ?",
      "t.message_count > 1",
      "(t.kind!='native_thread' OR EXISTS(SELECT 1 FROM native_conversation_threads n WHERE n.id=t.channel_id AND n.active=0))",
    ];
    if (input?.force !== true) {
      clauses.push("(t.maintenance_retry_after IS NULL OR t.maintenance_retry_after <= ?)");
      values.push(now);
      const embeddingModelClause = embeddingModelId
        ? `OR NOT EXISTS (
            SELECT 1
            FROM conversation_thread_embeddings e
            WHERE e.thread_id = t.thread_id AND e.model_id = ?
          )`
        : "";
      clauses.push(
        input?.includeEmbeddingStale === true
          ? `(
              t.last_summarized_at IS NULL
              OR t.last_summarized_at < t.updated_at
              OR t.summary_version != ${CONVERSATION_THREAD_SUMMARY_VERSION}
              OR (
                t.last_summarized_at IS NOT NULL
                AND (
                  t.last_embedded_at IS NULL
                  OR t.last_embedded_at < t.last_summarized_at
                  OR t.embedding_version != ${CONVERSATION_THREAD_EMBEDDING_VERSION}
                  ${embeddingModelClause}
                )
              )
            )`
          : `(
              t.last_summarized_at IS NULL
              OR t.last_summarized_at < t.updated_at
              OR t.summary_version != ${CONVERSATION_THREAD_SUMMARY_VERSION}
            )`,
      );
      if (embeddingModelId) values.push(embeddingModelId);
    }

    if (input?.threadId) {
      clauses.push("t.thread_id = ?");
      values.push(input.threadId);
    }
    if (input?.beforeTs !== undefined) {
      clauses.push("t.end_ts <= ?");
      values.push(input.beforeTs);
    }
    if (input?.afterTs !== undefined) {
      clauses.push("t.end_ts >= ?");
      values.push(input.afterTs);
    }

    const candidates = this.db
      .query(
        `
        SELECT t.* ${embeddingModelSelect}
        FROM conversation_threads t
        WHERE ${clauses.join(" AND ")}
        ORDER BY
          CASE WHEN t.maintenance_retry_after IS NOT NULL THEN 0 ELSE 1 END ASC,
          t.maintenance_retry_after ASC,
          COALESCE(t.maintenance_attempted_at, 0) ASC,
          t.updated_at ASC,
          t.thread_id ASC
        `,
      )
      .all(...values) as Array<ConversationThreadRow & { has_embedding_model: number }>;

    return candidates.flatMap((candidate): ConversationThreadSummarizationEligibility[] => {
      const { has_embedding_model: hasEmbeddingModel, ...thread } = candidate;
      const reasons: ConversationThreadSummarizationEligibilityReason[] = [];
      if (input?.force === true) {
        reasons.push("forced");
      } else {
        if (thread.last_summarized_at === null) reasons.push("never-summarized");
        if (thread.last_summarized_at !== null && thread.last_summarized_at < thread.updated_at) {
          reasons.push("content-changed");
        }
        if (thread.summary_version !== CONVERSATION_THREAD_SUMMARY_VERSION) {
          reasons.push("summary-version");
        }
      }

      const summaryIsStale = reasons.length > 0;
      const embeddingReasons: ConversationThreadSummarizationEligibilityReason[] = [];
      if (
        input?.force !== true &&
        input?.includeEmbeddingStale === true &&
        thread.last_summarized_at !== null
      ) {
        if (thread.last_embedded_at === null) embeddingReasons.push("embedding-missing");
        if (
          thread.last_embedded_at !== null &&
          thread.last_embedded_at < thread.last_summarized_at
        ) {
          embeddingReasons.push("embedding-outdated");
        }
        if (thread.embedding_version !== CONVERSATION_THREAD_EMBEDDING_VERSION) {
          embeddingReasons.push("embedding-version");
        }
        if (input.embeddingModelId && hasEmbeddingModel !== 1) {
          embeddingReasons.push("embedding-model");
        }
      }

      reasons.push(...embeddingReasons);
      if (reasons.length === 0) return [];
      return [
        {
          thread,
          reasons,
          summaryIsStale,
          embeddingIsStale: embeddingReasons.length > 0,
        },
      ];
    });
  }

  markMaintenanceAttempt(input: {
    threadId: string;
    summaryInputHash: string | null;
    attemptedAt?: number;
  }): boolean {
    const result = this.db.run(
      `
      UPDATE conversation_threads
      SET maintenance_attempted_at = ?, maintenance_retry_after = NULL
      WHERE thread_id = ? AND summary_input_hash IS ?
      `,
      [input.attemptedAt ?? Date.now(), input.threadId, input.summaryInputHash],
    );
    return result.changes === 1;
  }

  markMaintenanceFailure(input: {
    threadId: string;
    summaryInputHash: string | null;
    attemptedAt: number;
    retryAfter: number;
  }): boolean {
    const result = this.db.run(
      `
      UPDATE conversation_threads
      SET maintenance_retry_after = ?
      WHERE thread_id = ?
        AND summary_input_hash IS ?
        AND maintenance_attempted_at = ?
      `,
      [input.retryAfter, input.threadId, input.summaryInputHash, input.attemptedAt],
    );
    return result.changes === 1;
  }

  clearMaintenanceFailure(input: {
    threadId: string;
    summaryInputHash: string | null;
    attemptedAt: number;
  }): void {
    this.db.run(
      `
      UPDATE conversation_threads
      SET maintenance_retry_after = NULL
      WHERE thread_id = ?
        AND summary_input_hash IS ?
        AND maintenance_attempted_at = ?
      `,
      [input.threadId, input.summaryInputHash, input.attemptedAt],
    );
  }

  upsertSummary(
    threadId: string,
    summaryInputHash: string,
    summary: ConversationThreadSummaryInput,
    promptContextHash: string | null = null,
    options?: { ifCurrent?: boolean },
  ): ResultType<
    ConversationThreadSummaryWriteResult | null,
    ConversationThreadSqliteDriverFailure
  > {
    this.refreshNativeThreads();
    const normalized = normalizeSummary(summary);
    const now = Date.now();
    const topicsJson = JSON.stringify(normalized.topics);
    const retrievalHintsJson = JSON.stringify(normalized.retrievalHints);
    const aboutnessJson = JSON.stringify(normalized.aboutness);
    const importanceReasonsJson = JSON.stringify(normalized.importanceReasons);
    const embeddingHash = computeSummaryHash(normalized);
    const facets: ConversationThreadFacetInput[] = [
      {
        facet: "combined",
        text: [
          normalized.title,
          normalized.brief,
          normalized.retrievalHints.join("\n"),
          normalized.aboutness.userWouldAskForThisAs.join("\n"),
          normalized.aboutness.complaintTargets.join("\n"),
          normalized.aboutness.domains.join("\n"),
          normalized.aboutness.situations.join("\n"),
          normalized.aboutness.entities.join("\n"),
          normalized.topics.join("\n"),
        ].join("\n\n"),
      },
      {
        facet: "userWouldAskForThisAs",
        text: normalized.aboutness.userWouldAskForThisAs.join("\n"),
      },
      {
        facet: "aboutnessComplaintTargets",
        text: normalized.aboutness.complaintTargets.join("\n"),
      },
      { facet: "aboutnessDomains", text: normalized.aboutness.domains.join("\n") },
      { facet: "aboutnessSituations", text: normalized.aboutness.situations.join("\n") },
      { facet: "aboutnessEntities", text: normalized.aboutness.entities.join("\n") },
      { facet: "retrievalHints", text: normalized.retrievalHints.join("\n") },
      { facet: "title", text: normalized.title },
      { facet: "brief", text: normalized.brief },
      { facet: "topics", text: normalized.topics.join("\n") },
    ];

    const transaction = runBunSqliteTransaction(
      this.db,
      () => {
        if (options?.ifCurrent) {
          const current = this.db
            .query<{ summary_input_hash: string | null }, [string]>(
              "SELECT summary_input_hash FROM conversation_threads WHERE thread_id = ?",
            )
            .get(threadId);
          if (current?.summary_input_hash !== summaryInputHash) return Result.ok(false);
        }

        this.db.run(
          `
        INSERT INTO conversation_thread_summaries (
            thread_id, title, brief, topics_json, retrieval_hints_json, aboutness_json, importance, importance_reasons_json, created_at, updated_at, summary_format_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          title=excluded.title,
          brief=excluded.brief,
          topics_json=excluded.topics_json,
          retrieval_hints_json=excluded.retrieval_hints_json,
          aboutness_json=excluded.aboutness_json,
          importance=excluded.importance,
          importance_reasons_json=excluded.importance_reasons_json,
            summary_format_version=excluded.summary_format_version,
          updated_at=excluded.updated_at
        `,
          [
            threadId,
            normalized.title,
            normalized.brief,
            topicsJson,
            retrievalHintsJson,
            aboutnessJson,
            normalized.importance,
            importanceReasonsJson,
            now,
            now,
            CONVERSATION_THREAD_SUMMARY_FORMAT_VERSION,
          ],
        );

        this.db.run("DELETE FROM conversation_thread_facets WHERE thread_id = ?", [threadId]);
        this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [threadId]);
        for (const facet of facets) {
          if (facet.text.trim().length === 0) continue;
          this.db.run(
            `
          INSERT INTO conversation_thread_facets (thread_id, facet, text, updated_at)
          VALUES (?, ?, ?, ?)
          `,
            [threadId, facet.facet, facet.text, now],
          );
        }

        this.db.run(
          `
        UPDATE conversation_threads
        SET last_summarized_at = ?,
            last_embedded_at = NULL,
            summary_input_hash = ?,
            summary_prompt_context_hash = ?,
            embedding_input_hash = NULL,
            summary_version = ?,
            embedding_version = ?
        WHERE thread_id = ?
        `,
          [
            now,
            summaryInputHash,
            promptContextHash,
            CONVERSATION_THREAD_SUMMARY_VERSION,
            CONVERSATION_THREAD_EMBEDDING_VERSION,
            threadId,
          ],
        );
        return Result.ok(true);
      },
      classifyConversationThreadSqliteDriverFailure,
    );
    return transaction.map((written) => {
      if (!written) return null;
      const filteredFacets = facets.filter((facet) => facet.text.trim().length > 0);
      return {
        facets: filteredFacets,
        embeddingInputHash: computeFacetHash(filteredFacets) || embeddingHash,
      };
    });
  }

  listFacets(threadId: string): ConversationThreadFacetInput[] {
    const rows = this.db
      .query(
        `
        SELECT facet, text
        FROM conversation_thread_facets
        WHERE thread_id = ?
        ORDER BY ${facetWeightSql("conversation_thread_facets")} DESC, facet ASC
        `,
      )
      .all(threadId) as FacetRow[];
    return rows.map((row) => ({
      facet: row.facet,
      text: row.text,
    }));
  }

  listAutoInjectRankingDocuments(allowlist?: ConversationThreadSearchAllowlist): string[] {
    this.refreshNativeThreads();
    const filter = buildSearchFilterClause(undefined, allowlist);
    const rows = this.db
      .query(
        `
        SELECT f.text
        FROM conversation_thread_facets f JOIN conversation_threads t ON t.thread_id=f.thread_id
        WHERE f.facet = 'combined' AND ${filter.sql}
        ORDER BY f.thread_id ASC
        `,
      )
      .all(...filter.values) as Array<{ text: string }>;
    return rows.map((row) => row.text);
  }

  computeEmbeddingInputHash(threadId: string): string | null {
    const facets = this.listFacets(threadId);
    return facets.length > 0 ? computeFacetHash(facets) : null;
  }

  upsertEmbeddings(input: {
    threadId: string;
    embeddingInputHash: string;
    modelId: string;
    dimensions: number;
    embeddings: ReadonlyArray<{
      facet: ConversationThreadEmbeddingFacet;
      embedding: Float32Array;
    }>;
  }): void {
    this.refreshNativeThreads();
    if (
      input.threadId.startsWith("native:") &&
      this.computeEmbeddingInputHash(input.threadId) !== input.embeddingInputHash
    )
      return;
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM conversation_thread_embeddings WHERE thread_id = ?", [
        input.threadId,
      ]);
      for (const item of input.embeddings) {
        this.db.run(
          `
          INSERT INTO conversation_thread_embeddings (
            thread_id, facet, model_id, dimensions, embedding, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [input.threadId, item.facet, input.modelId, input.dimensions, item.embedding, now],
        );
      }

      this.db.run(
        `
        UPDATE conversation_threads
        SET last_embedded_at = ?,
            embedding_input_hash = ?,
            embedding_version = ?
        WHERE thread_id = ?
        `,
        [now, input.embeddingInputHash, CONVERSATION_THREAD_EMBEDDING_VERSION, input.threadId],
      );
    });

    tx();
  }

  search(input: {
    query: string;
    limit?: number;
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): ResultType<ConversationThreadSearchHit[], PersistedDataError> {
    this.refreshNativeThreads();
    const ftsQuery = normalizeFtsQuery(input.query);
    if (!ftsQuery) return Result.ok([]);

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 5)));
    const filter = buildSearchFilterClause(input.filters, input.allowlist);
    const rows = this.db
      .query(
        `
        SELECT
          t.*,
          s.title,
          s.brief,
          s.topics_json,
          s.retrieval_hints_json,
          s.aboutness_json,
          s.importance,
          s.importance_reasons_json,
          s.created_at,
          s.updated_at,
          s.summary_format_version,
          max(fm.facet_score) AS lexical_score
        FROM (
          SELECT
            f.thread_id,
            ${facetWeightSql("f")} AS facet_score
          FROM conversation_thread_facets_fts
          JOIN conversation_thread_facets f ON f.rowid = conversation_thread_facets_fts.rowid
          WHERE conversation_thread_facets_fts MATCH ?
        ) fm
        JOIN conversation_threads t ON t.thread_id = fm.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = t.thread_id
        WHERE ${filter.sql}
        GROUP BY t.thread_id
        ORDER BY lexical_score DESC, t.end_ts DESC
        LIMIT ?
        `,
      )
      .all(ftsQuery, ...filter.values, limit) as ThreadSearchRow[];

    const hits: ConversationThreadSearchHit[] = [];
    for (const row of rows) {
      const decoded = decodeConversationThreadSummaryRow(row);
      const decodeError = resultErrorOrNull(decoded);
      if (decodeError) {
        this.reportPersistenceError(decodeError);
        return Result.err(decodeError);
      }
      const summary = selectResultValue(decoded).value;
      const summarized =
        row.last_summarized_at !== null &&
        row.last_summarized_at >= row.updated_at &&
        row.summary_version === CONVERSATION_THREAD_SUMMARY_VERSION;
      const lexicalScore = row.lexical_score ?? 0;
      hits.push({
        threadId: row.thread_id,
        channelId: row.channel_id,
        guildId: row.guild_id ?? undefined,
        parentChannelId: row.parent_channel_id ?? undefined,
        kind: row.kind,
        sourceRevision: row.summary_input_hash ?? undefined,
        title: summary.title,
        brief: summary.brief,
        topics: summary.topics,
        retrievalHints: summary.retrievalHints,
        aboutness: summary.aboutness,
        importance: summary.importance,
        importanceReasons: summary.importanceReasons,
        startTs: row.start_ts,
        endTs: row.end_ts,
        messageCount: row.message_count,
        score: lexicalScore,
        lexicalScore,
        semanticScore: 0,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        summarized,
        stale: !summarized,
      });
    }
    return Result.ok(hits);
  }

  /**
   * Ranks threads matching any term of raw user text. Unlike `search`, which ANDs a planner query,
   * this is meant for unplanned message text where most words will not appear in any summary.
   */
  searchAnyTerm(input: {
    text: string;
    limit?: number;
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
    excludeThreadIds?: readonly string[];
  }): ResultType<ConversationThreadSearchHit[], PersistedDataError> {
    this.refreshNativeThreads();
    const ftsQuery = buildAnyTermFtsQuery(input.text);
    if (!ftsQuery) return Result.ok([]);

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 5)));
    const filter = buildSearchFilterClause(input.filters, input.allowlist);
    const excluded = [...new Set(input.excludeThreadIds ?? [])];
    const excludeSql =
      excluded.length > 0 ? `AND t.thread_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    // FTS5 rejects bm25 ranking inside joins and aggregates, so rank the matches once in a
    // materialized CTE before joining.
    const rows = this.db
      .query(
        `
        WITH hits AS MATERIALIZED (
          SELECT rowid, rank
          FROM conversation_thread_facets_fts
          WHERE conversation_thread_facets_fts MATCH ?
        )
        SELECT
          t.*,
          s.title,
          s.brief,
          s.topics_json,
          s.retrieval_hints_json,
          s.aboutness_json,
          s.importance,
          s.importance_reasons_json,
          s.created_at,
          s.updated_at,
          s.summary_format_version,
          -min(hits.rank) AS lexical_score
        FROM hits
        JOIN conversation_thread_facets f ON f.rowid = hits.rowid
        JOIN conversation_threads t ON t.thread_id = f.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = t.thread_id
        WHERE ${filter.sql}
          ${excludeSql}
        GROUP BY t.thread_id
        ORDER BY lexical_score DESC, t.end_ts DESC
        LIMIT ?
        `,
      )
      .all(ftsQuery, ...filter.values, ...excluded, limit) as ThreadSearchRow[];

    const hits: ConversationThreadSearchHit[] = [];
    for (const row of rows) {
      const decoded = decodeConversationThreadSummaryRow(row);
      const decodeError = resultErrorOrNull(decoded);
      if (decodeError) {
        this.reportPersistenceError(decodeError);
        return Result.err(decodeError);
      }
      const summary = selectResultValue(decoded).value;
      const summarized =
        row.last_summarized_at !== null &&
        row.last_summarized_at >= row.updated_at &&
        row.summary_version === CONVERSATION_THREAD_SUMMARY_VERSION;
      const lexicalScore = row.lexical_score ?? 0;
      hits.push({
        threadId: row.thread_id,
        channelId: row.channel_id,
        guildId: row.guild_id ?? undefined,
        parentChannelId: row.parent_channel_id ?? undefined,
        kind: row.kind,
        sourceRevision: row.summary_input_hash ?? undefined,
        title: summary.title,
        brief: summary.brief,
        topics: summary.topics,
        retrievalHints: summary.retrievalHints,
        aboutness: summary.aboutness,
        importance: summary.importance,
        importanceReasons: summary.importanceReasons,
        startTs: row.start_ts,
        endTs: row.end_ts,
        messageCount: row.message_count,
        score: lexicalScore,
        lexicalScore,
        semanticScore: 0,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        summarized,
        stale: !summarized,
      });
    }
    return Result.ok(hits);
  }

  prepareSearch(input: {
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): string[] {
    this.refreshNativeThreads();
    const filter = buildSearchFilterClause(input.filters, input.allowlist);
    return this.db
      .query<{ thread_id: string }, (string | number)[]>(
        `SELECT t.thread_id FROM conversation_threads t WHERE ${filter.sql}`,
      )
      .all(...filter.values)
      .map((row) => row.thread_id);
  }

  filterCurrentSearchHits(input: {
    hits: readonly ConversationThreadSearchHit[];
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): ConversationThreadSearchHit[] {
    if (input.hits.length === 0) return [];
    this.refreshNativeThreads();
    const filter = buildSearchFilterClause(
      input.filters,
      input.allowlist,
      input.hits.map((hit) => hit.threadId),
    );
    const eligible = new Set(
      this.db
        .query<{ thread_id: string }, (string | number)[]>(
          `SELECT t.thread_id FROM conversation_threads t WHERE t.thread_id IN (SELECT value FROM json_each(?)) AND ${filter.sql}`,
        )
        .all(JSON.stringify(input.hits.map((hit) => hit.threadId)), ...filter.values)
        .map((row) => row.thread_id),
    );
    return input.hits.filter(
      (hit) =>
        eligible.has(hit.threadId) &&
        (hit.kind !== "native_thread" ||
          this.getThread(hit.threadId)?.summary_input_hash === hit.sourceRevision),
    );
  }

  searchSemantic(input: {
    embedding: Float32Array;
    modelId: string;
    dimensions: number;
    limit?: number;
    eligibleThreadIds?: readonly string[];
    filters?: ConversationThreadSearchFilters;
    allowlist?: ConversationThreadSearchAllowlist;
  }): ResultType<ConversationThreadSearchHit[], PersistedDataError> {
    if (!input.eligibleThreadIds) this.refreshNativeThreads();
    if (!this.vectorLoaded) return Result.ok([]);

    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? 5)));
    const filter = input.eligibleThreadIds
      ? {
          sql: "t.thread_id IN (SELECT value FROM json_each(?))",
          values: [JSON.stringify(input.eligibleThreadIds)],
        }
      : buildSearchFilterClause(input.filters, input.allowlist);
    const rows = this.db
      .query(
        `
        WITH scores AS (
        SELECT t.thread_id, t.end_ts,
          sum(
            max(
              0.0,
              ((1.0 - vec_distance_cosine(e.embedding, ?)) - ${SEMANTIC_SIMILARITY_FLOOR})
                / ${1 - SEMANTIC_SIMILARITY_FLOOR}
            ) * ${facetWeightSql("f")}
          ) / nullif(sum(${facetWeightSql("f")}), 0) AS semantic_score
        FROM conversation_thread_embeddings e
        JOIN conversation_thread_facets f
          ON f.thread_id = e.thread_id
         AND f.facet = e.facet
        JOIN conversation_threads t ON t.thread_id = e.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = t.thread_id
        WHERE e.model_id = ?
          AND e.dimensions = ?
          AND ${filter.sql}
        GROUP BY t.thread_id
        ORDER BY semantic_score DESC, t.end_ts DESC
        LIMIT ?
        )
        SELECT
          t.*,
          s.title,
          s.brief,
          s.topics_json,
          s.retrieval_hints_json,
          s.aboutness_json,
          s.importance,
          s.importance_reasons_json,
          s.created_at,
          s.updated_at,
          s.summary_format_version,
          scores.semantic_score
        FROM scores
        JOIN conversation_threads t ON t.thread_id = scores.thread_id
        JOIN conversation_thread_summaries s ON s.thread_id = scores.thread_id
        ORDER BY scores.semantic_score DESC, t.end_ts DESC
        `,
      )
      .all(
        input.embedding,
        input.modelId,
        input.dimensions,
        ...filter.values,
        limit,
      ) as ThreadSemanticSearchRow[];

    const hits: ConversationThreadSearchHit[] = [];
    for (const row of rows) {
      const decoded = decodeConversationThreadSummaryRow(row);
      const decodeError = resultErrorOrNull(decoded);
      if (decodeError) {
        this.reportPersistenceError(decodeError);
        return Result.err(decodeError);
      }
      const summary = selectResultValue(decoded).value;
      const summarized =
        row.last_summarized_at !== null &&
        row.last_summarized_at >= row.updated_at &&
        row.summary_version === CONVERSATION_THREAD_SUMMARY_VERSION;
      const semanticScore = row.semantic_score ?? 0;
      hits.push({
        threadId: row.thread_id,
        channelId: row.channel_id,
        guildId: row.guild_id ?? undefined,
        parentChannelId: row.parent_channel_id ?? undefined,
        kind: row.kind,
        sourceRevision: row.summary_input_hash ?? undefined,
        title: summary.title,
        brief: summary.brief,
        topics: summary.topics,
        retrievalHints: summary.retrievalHints,
        aboutness: summary.aboutness,
        importance: summary.importance,
        importanceReasons: summary.importanceReasons,
        startTs: row.start_ts,
        endTs: row.end_ts,
        messageCount: row.message_count,
        score: semanticScore,
        lexicalScore: 0,
        semanticScore,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        summarized,
        stale: !summarized,
      });
    }
    return Result.ok(hits);
  }
}

function buildSearchFilterClause(
  filters?: ConversationThreadSearchFilters,
  allowlist?: ConversationThreadSearchAllowlist,
  candidateIds?: readonly string[],
): {
  sql: string;
  values: Array<string | number>;
} {
  const clauses: string[] = [
    "(t.kind!='native_thread' OR EXISTS(SELECT 1 FROM native_conversation_threads n WHERE n.id=t.channel_id))",
  ];
  const values: Array<string | number> = [];

  const channelIds = allowlist?.channelIds.filter((id) => id.trim().length > 0) ?? [];
  const guildIds = allowlist?.guildIds.filter((id) => id.trim().length > 0) ?? [];
  if (allowlist) {
    const allowClauses: string[] = [];
    if (channelIds.length > 0) {
      const placeholders = channelIds.map(() => "?").join(", ");
      allowClauses.push(`t.channel_id IN (${placeholders})`);
      allowClauses.push(`t.parent_channel_id IN (${placeholders})`);
      values.push(...channelIds, ...channelIds);
    }
    if (guildIds.length > 0) {
      const placeholders = guildIds.map(() => "?").join(", ");
      allowClauses.push(`t.guild_id IN (${placeholders})`);
      values.push(...guildIds);
    }

    clauses.push(`(t.kind='native_thread' OR (${allowClauses.join(" OR ") || "0=1"}))`);
  }

  if (filters?.surface) {
    clauses.push(
      filters.surface === "native" ? "t.kind='native_thread'" : "t.kind!='native_thread'",
    );
  }
  if (filters?.sessionId) {
    clauses.push("t.channel_id = ?");
    values.push(filters.sessionId.replace(/^(native|discord):/u, ""));
  }

  if (filters?.participantId) {
    clauses.push(`
      t.thread_id IN (
        SELECT tm.thread_id
        FROM conversation_thread_messages tm
        JOIN conversation_source_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
        WHERE m.deleted = 0
          ${candidateIds ? "AND tm.thread_id IN (SELECT value FROM json_each(?))" : ""}
          AND m.user_id = ?
      )
    `);
    if (candidateIds) values.push(JSON.stringify(candidateIds));
    values.push(filters.participantId);
  }

  const participantIdsAny = [
    ...new Set(
      (filters?.participantIdsAny ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ];
  if (participantIdsAny.length > 0) {
    let crossSurface = "";
    if (filters?.participantSurface === "native") crossSurface = "1=1 OR ";
    if (filters?.participantSurface === "discord") crossSurface = "t.kind='native_thread' OR ";
    const placeholders = participantIdsAny.map(() => "?").join(", ");
    clauses.push(`
      (${crossSurface}t.thread_id IN (
        SELECT tm.thread_id
        FROM conversation_thread_messages tm
        JOIN conversation_source_messages m
          ON m.channel_id = tm.channel_id
         AND m.message_id = tm.message_id AND m.surface = CASE WHEN tm.thread_id LIKE 'native:%' THEN 'native' ELSE 'discord' END
        WHERE m.deleted = 0
          ${candidateIds ? "AND tm.thread_id IN (SELECT value FROM json_each(?))" : ""}
          AND m.user_id IN (${placeholders})
      ))
    `);
    if (candidateIds) values.push(JSON.stringify(candidateIds));
    values.push(...participantIdsAny);
  }

  if (filters?.beforeTs !== undefined) {
    clauses.push("t.end_ts <= ?");
    values.push(filters.beforeTs);
  }

  if (filters?.afterTs !== undefined) {
    clauses.push("t.end_ts >= ?");
    values.push(filters.afterTs);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1",
    values,
  };
}

function buildThreadScopeClause(filters?: {
  threadId?: string;
  beforeTs?: number;
  afterTs?: number;
}): { sql: string; values: Array<string | number> } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (filters?.threadId) {
    clauses.push("t.thread_id = ?");
    values.push(filters.threadId);
  }
  if (filters?.beforeTs !== undefined) {
    clauses.push("t.end_ts <= ?");
    values.push(filters.beforeTs);
  }
  if (filters?.afterTs !== undefined) {
    clauses.push("t.end_ts >= ?");
    values.push(filters.afterTs);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1",
    values,
  };
}

const ANY_TERM_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/giu;
const ANY_TERM_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ANY_TERM_MAX_TERMS = 40;
const ANY_TERM_STOPWORDS = new Set(
  (
    "the and for are but not you your with this that have has had was were will would could " +
    "should can what when where which who how why its don dont doesn didn isn wasn just like about " +
    "from into then than they them there their also some any all more most very really tho idk lol"
  ).split(" "),
);

function buildAnyTermFtsQuery(input: string): string | null {
  const tokens =
    input
      .toLowerCase()
      .replace(ANY_TERM_URL_RE, " ")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= (ANY_TERM_CJK_RE.test(token) ? 2 : 3))
      .filter((token) => !ANY_TERM_STOPWORDS.has(token)) ?? [];
  const unique = [...new Set(tokens)].slice(0, ANY_TERM_MAX_TERMS);
  return unique.length > 0 ? unique.map((token) => `"${token}"`).join(" OR ") : null;
}

function normalizeFtsQuery(input: string): string | null {
  const tokens = input
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  return tokens.length > 0 ? tokens.join(" ") : null;
}
