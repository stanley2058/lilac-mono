import { generateText, Output, streamText, type ModelMessage } from "ai";
import { z } from "zod";
import {
  createLogger,
  resolveModelRef,
  resolveModelSlot,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import {
  type ConversationThreadMessage,
  type ConversationThreadSearchFilters,
  type ConversationThreadSearchAllowlist,
  type ConversationThreadSearchHit,
  type ConversationThreadStore,
  type ConversationThreadSummary,
  type ConversationThreadSummaryInput,
  CONVERSATION_THREAD_SUMMARY_VERSION,
} from "./thread-store";
import type { ConversationThreadEmbeddingAdapter } from "./thread-embedding";
import type { EntityMapper } from "../entity/entity-mapper";

const SUMMARY_QUIET_MS = 60 * 60 * 1000;
const SUMMARY_HEAD_MESSAGES = 40;
const SUMMARY_TAIL_MESSAGES = 160;
const SUMMARY_MAX_MESSAGES = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;
const DEFAULT_READ_LIMIT = 50;
const SUMMARY_PARSE_MAX_ATTEMPTS = 3;

const threadSummarySchema = z.object({
  title: z.string(),
  brief: z.string(),
  topics: z.array(z.string()),
  retrievalHints: z.array(z.string()),
  importance: z.enum(["low", "medium", "high"]),
  importanceReasons: z.array(z.string()),
});

export type ConversationThreadRunSummarizationInput = {
  jobId?: string;
  dryRun?: boolean;
  wait?: boolean;
  force?: boolean;
  threadId?: string;
  beforeTs?: number;
  afterTs?: number;
  now?: number;
};

export type ConversationThreadRunSummarizationResult = {
  dryRun: boolean;
  refreshed: {
    channels: number;
    threads: number;
    messages: number;
  };
  eligible: number;
  summarized: number;
  failed: number;
  failures: Array<{ threadId: string; error: string }>;
  threadIds: string[];
  jobId?: string;
  status?: "queued" | "completed";
};

export type ConversationThreadToolService = Pick<
  ConversationThreadService,
  "search" | "read" | "runSummarization"
>;

export type ConversationThreadSearchResult = {
  meta: {
    query: string;
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    count: number;
    vectorAvailable: boolean;
    vectorError?: string;
  };
  results: Array<{
    threadId: string;
    title: string;
    brief: string;
    topics: string[];
    retrievalHints: string[];
    timeRange: {
      start: string;
      end: string;
    };
    messageCount: number;
    importance: "low" | "medium" | "high";
    importanceReasons: string[];
    score?: number;
    lexicalScore?: number;
    semanticScore?: number;
    session?: {
      platform: "discord";
      channelId: string;
      guildId?: string;
      parentChannelId?: string;
    };
    anchors?: {
      startMessageId: string;
      endMessageId: string;
    };
    derivedState?: {
      summarized: boolean;
      stale: boolean;
    };
  }>;
};

export type ConversationThreadReadOutput = {
  thread: {
    threadId: string;
    title?: string;
    brief?: string;
    topics?: string[];
    retrievalHints?: string[];
    importance?: "low" | "medium" | "high";
    importanceReasons?: string[];
    session: {
      platform: "discord";
      channelId: string;
      guildId?: string;
      parentChannelId?: string;
    };
    anchors: {
      startMessageId: string;
      endMessageId: string;
    };
    timeRange: {
      start: string;
      end: string;
    };
    messageCount: number;
  };
  page: {
    offset: number;
    limit: number;
    total: number;
    nextOffset?: number;
    hasMore: boolean;
  };
  messages: Array<{
    ordinal: number;
    messageId: string;
    userId: string;
    userName?: string;
    time: string;
    text: string;
  }>;
};

export type ConversationThreadSummarizer = (input: {
  cfg: CoreConfig;
  threadId: string;
  previousSummary: ConversationThreadSummary | null;
  messages: readonly ConversationThreadMessage[];
  omittedMessages?: number;
}) => Promise<ConversationThreadSummaryInput>;

export class ConversationThreadSummaryParseError extends Error {
  readonly rawOutput?: string;

  constructor(message: string, options?: { cause?: unknown; rawOutput?: string }) {
    super(message, { cause: options?.cause });
    this.name = "ConversationThreadSummaryParseError";
    this.rawOutput = options?.rawOutput;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString();
}

function formatMessageForSummary(message: ConversationThreadMessage): string {
  const author = message.userName ? `${message.userName} (${message.userId})` : message.userId;
  return [
    `[${message.ordinal}] ${formatTime(message.ts)} ${author}`,
    message.text.trim() || "(empty)",
  ].join("\n");
}

function formatSummaryTranscript(
  messages: readonly ConversationThreadMessage[],
  omittedMessages: number,
): string {
  if (omittedMessages <= 0) return messages.map(formatMessageForSummary).join("\n\n");

  const head = messages.slice(0, SUMMARY_HEAD_MESSAGES);
  const tail = messages.slice(SUMMARY_HEAD_MESSAGES);
  return [
    ...head.map(formatMessageForSummary),
    `[transcript truncated: ${omittedMessages} middle text messages omitted]`,
    ...tail.map(formatMessageForSummary),
  ].join("\n\n");
}

function readSummaryMessages(
  store: ConversationThreadStore,
  threadId: string,
): {
  messages: ConversationThreadMessage[];
  totalMessages: number;
  omittedMessages: number;
} {
  const totalMessages = store.countThreadMessages(threadId);
  if (totalMessages <= SUMMARY_MAX_MESSAGES) {
    return {
      messages: store.listMessages(threadId, 0, SUMMARY_MAX_MESSAGES),
      totalMessages,
      omittedMessages: 0,
    };
  }

  const head = store.listMessages(threadId, 0, SUMMARY_HEAD_MESSAGES);
  const tailOffset = Math.max(SUMMARY_HEAD_MESSAGES, totalMessages - SUMMARY_TAIL_MESSAGES);
  const tail = store.listMessages(threadId, tailOffset, SUMMARY_TAIL_MESSAGES);
  return {
    messages: [...head, ...tail],
    totalMessages,
    omittedMessages: Math.max(0, totalMessages - head.length - tail.length),
  };
}

function buildFallbackSummary(
  messages: readonly ConversationThreadMessage[],
): ConversationThreadSummaryInput {
  const firstText = messages.find((message) => message.text.trim().length > 0)?.text.trim() ?? "";
  const title = firstText.length > 0 ? firstText.split("\n")[0]! : "Conversation thread";
  const participants = [
    ...new Set(messages.map((message) => message.userName ?? message.userId)),
  ].slice(0, 5);
  const brief = [
    `Conversation with ${participants.join(", ") || "unknown participants"}.`,
    firstText ? `Opening topic: ${firstText}` : "No text content available.",
  ].join(" ");
  return {
    title,
    brief,
    topics: [],
    retrievalHints: firstText ? [firstText] : [],
    importance: "medium",
    importanceReasons: [],
  };
}

function importanceMultiplier(importance: ConversationThreadSearchHit["importance"]): number {
  if (importance === "high") return 1.06;
  if (importance === "low") return 0.96;
  return 1;
}

function applyImportanceNudge(hit: ConversationThreadSearchHit, baseScore: number): number {
  return baseScore * importanceMultiplier(hit.importance);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function truncateErrorDetail(input: string): string {
  return input.length > 2000 ? `${input.slice(0, 2000)}...` : input;
}

function parseProviderResponseMessage(responseBody: string): string | undefined {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (!isRecord(parsed)) return undefined;
    const error = parsed.error;
    if (isRecord(error)) return readStringField(error, "message");
    return readStringField(parsed, "message");
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function parseSummaryJson(text: string): ConversationThreadSummaryInput {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as unknown;
    return threadSummarySchema.parse(parsed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConversationThreadSummaryParseError(`summary JSON parse failed: ${message}`, {
      cause: e,
      rawOutput: truncateErrorDetail(text),
    });
  }
}

function isSummaryStreamDecodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("activeReasoning") ||
    message.includes("summaryParts") ||
    message.includes("Controller is already closed") ||
    message.includes("Invalid state")
  );
}

function summarizeProviderError(error: unknown): {
  message: string;
  statusCode?: number;
  providerMessage?: string;
  responseBody?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRecord(error)) return { message };

  const responseBody = readStringField(error, "responseBody");
  return {
    message,
    statusCode: readNumberField(error, "statusCode"),
    providerMessage: responseBody ? parseProviderResponseMessage(responseBody) : undefined,
    responseBody: responseBody ? truncateErrorDetail(responseBody) : undefined,
  };
}

function resolveSummarizationModel(cfg: CoreConfig) {
  const model = cfg.conversation.thread.summarization.model.trim();
  if (model === "main" || model === "fast") return resolveModelSlot(cfg, model);
  return resolveModelRef(cfg, { model }, "conversation.thread.summarization.model");
}

function shouldAllowDiscordThread(
  cfg: CoreConfig,
  input: { channelId: string; parentChannelId?: string | null; guildId?: string | null },
): boolean {
  const allowedChannelIds = new Set(cfg.surface.discord.allowedChannelIds);
  const allowedGuildIds = new Set(cfg.surface.discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;
  if (allowedChannelIds.has(input.channelId)) return true;
  if (input.parentChannelId && allowedChannelIds.has(input.parentChannelId)) return true;
  return !!input.guildId && allowedGuildIds.has(input.guildId);
}

function buildSearchFilters(input: {
  sessionId?: string;
  participantId?: string;
  beforeTs?: number;
  afterTs?: number;
}): ConversationThreadSearchFilters {
  return {
    sessionId: input.sessionId?.trim() || undefined,
    participantId: input.participantId?.trim() || undefined,
    beforeTs: input.beforeTs,
    afterTs: input.afterTs,
  };
}

function buildSearchAllowlist(cfg: CoreConfig): ConversationThreadSearchAllowlist {
  return {
    channelIds: cfg.surface.discord.allowedChannelIds,
    guildIds: cfg.surface.discord.allowedGuildIds,
  };
}

function clampSummarizationConcurrency(input: number): number {
  return Math.min(128, Math.max(1, Math.floor(input)));
}

async function defaultSummarizer(input: {
  cfg: CoreConfig;
  threadId: string;
  previousSummary: ConversationThreadSummary | null;
  messages: readonly ConversationThreadMessage[];
  omittedMessages?: number;
}): Promise<ConversationThreadSummaryInput> {
  const resolved = resolveSummarizationModel(input.cfg);
  const transcript = formatSummaryTranscript(input.messages, input.omittedMessages ?? 0);
  const previous = input.previousSummary
    ? [
        `Previous title: ${input.previousSummary.title}`,
        `Previous brief: ${input.previousSummary.brief}`,
        `Previous topics: ${input.previousSummary.topics.join(", ") || "(none)"}`,
        `Previous retrieval hints: ${input.previousSummary.retrievalHints.join("; ") || "(none)"}`,
        `Previous importance: ${input.previousSummary.importance}`,
        `Previous importance reasons: ${input.previousSummary.importanceReasons.join("; ") || "(none)"}`,
      ].join("\n")
    : "(none)";

  const messages = [
    {
      role: "user",
      content: ["## Previous summary", previous, "", "## Transcript", transcript].join("\n"),
    },
  ] satisfies ModelMessage[];

  const instructions = [
    "You create compact, stable thread summaries for a conversation memory index.",
    "",
    "# Task",
    "Summarize the conversation thread in user's input for future semantic retrieval.",
    "Keep stable wording when the previous summary is still accurate; avoid unnecessary drift after small updates.",
    "",
    "## Format",
    "Return exactly one JSON object and nothing else.",
    "",
    'Shape: {"title":"...","brief":"...","topics":["..."],"retrievalHints":["..."],"importance":"low|medium|high","importanceReasons":["..."]}',
    "",
    "- title: concise thread title, under 120 characters.",
    "- brief: compact summary, under 1024 characters.",
    "- topics: short descriptive subject phrases, not canonical tags.",
    "- retrievalHints: short search-query-like phrases a future user might type to find this thread.",
    "- importance: low, medium, or high, based on durable future value.",
    "- importanceReasons: brief reasons explaining the rating for debugging.",
    "",
    "Write title, brief, topics, retrieval hints, and importance reasons primarily in English, regardless of the thread language.",
    "Preserve exact names, code identifiers, product names, error messages, quoted phrases, and useful source-language wording when they improve retrieval.",
    "",
    "## Retrieval hints",
    "- Retrieval hints are alternate semantic access paths, not tags or summaries.",
    "- Use 4-8 hints for substantive threads; use fewer for shallow threads.",
    "- Each hint should usually be 2-12 words.",
    "- Include distinct ways the user might search for this thread later:",
    "  - the user's goal, task, or question",
    "  - the concrete problem, symptom, decision, tradeoff, or outcome",
    "  - exact tools, APIs, files, commands, identifiers, errors, quotes, or product names",
    "  - alternate wording, aliases, abbreviations, colloquial phrasing, or source-language phrases",
    "  - emotional or personal framing when clearly present, such as rant, vent, frustration, career, job, compensation, debugging, architecture, incident, or process",
    "- Avoid generic standalone hints like help, code, app, bug, AI, question, discussion, or notes.",
    "- Avoid near-duplicates; each hint should add a meaningfully different retrieval path.",
    "- Do not invent context, labels, emotions, tools, or technologies not present or strongly implied.",
    "- When updating an existing summary, keep accurate previous hints stable; only change hints that are stale, misleading, redundant, or clearly improved by new transcript content.",
    "",
    "## Importance",
    "- Use high for durable decisions, architecture, implementation plans, incident/root-cause analysis, reusable project knowledge, or important personal/career context.",
    "- Use medium for useful but limited troubleshooting, explanations, comparisons, planning, or non-critical project context.",
    "- Use low for casual chat, shallow reactions, external-link-only discussion, transient coordination, or low-reuse content.",
  ].join("\n");

  if (resolved.provider === "codex") {
    const result = streamText({
      model: resolved.model,
      instructions,
      messages,
      reasoning: resolved.reasoning,
      providerOptions: resolved.providerOptions,
    });

    try {
      return parseSummaryJson(await result.text);
    } catch (e) {
      if (e instanceof ConversationThreadSummaryParseError) throw e;
      if (isSummaryStreamDecodeError(e)) {
        const message = e instanceof Error ? e.message : String(e);
        throw new ConversationThreadSummaryParseError(`summary stream decode failed: ${message}`, {
          cause: e,
        });
      }
      throw e;
    }
  }

  const result = await generateText({
    model: resolved.model,
    output: Output.object({ schema: threadSummarySchema }),
    instructions,
    messages,
    maxOutputTokens: 4096,
    reasoning: resolved.reasoning,
    providerOptions: resolved.providerOptions,
  });

  return result.output;
}

export class ConversationThreadService {
  private readonly logger = createLogger({
    module: "conversation-thread",
  });

  constructor(
    private readonly params: {
      store: ConversationThreadStore;
      getConfig: () => Promise<CoreConfig>;
      summarizer?: ConversationThreadSummarizer;
      embeddingAdapter?: ConversationThreadEmbeddingAdapter;
      entityMapper?: Pick<EntityMapper, "normalizeIncomingText">;
    },
  ) {}

  refreshThreads(): { channels: number; threads: number; messages: number } {
    return this.params.store.refreshInferredThreads();
  }

  async search(input: {
    query: string;
    limit?: number;
    sessionId?: string;
    participantId?: string;
    beforeTs?: number;
    afterTs?: number;
    mode?: "hybrid" | "semantic" | "lexical";
    verbose?: boolean;
  }): Promise<ConversationThreadSearchResult> {
    this.refreshThreads();
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)));
    const mode = input.mode ?? "hybrid";
    const cfg = await this.params.getConfig();
    const filters = buildSearchFilters(input);
    const hits = await this.searchHits({
      query: input.query,
      limit,
      mode,
      cfg,
      filters,
      allowlist: buildSearchAllowlist(cfg),
    });
    return {
      meta: {
        query: input.query,
        limit,
        mode,
        count: hits.length,
        vectorAvailable:
          this.params.store.isVectorSearchAvailable() && !!this.params.embeddingAdapter,
        vectorError: this.params.store.getVectorLoadError() ?? undefined,
      },
      results: hits.map((hit) => this.formatSearchHit(hit, input.verbose ?? false)),
    };
  }

  async read(input: {
    threadId: string;
    offset?: number;
    limit?: number;
  }): Promise<ConversationThreadReadOutput> {
    this.refreshThreads();
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? DEFAULT_READ_LIMIT)));
    const result = this.params.store.readThread(input.threadId, offset, limit);
    if (!result) throw new Error(`conversation thread not found: ${input.threadId}`);
    const cfg = await this.params.getConfig();
    if (
      !shouldAllowDiscordThread(cfg, {
        channelId: result.thread.channel_id,
        parentChannelId: result.thread.parent_channel_id,
        guildId: result.thread.guild_id,
      })
    ) {
      throw new Error(`Not allowed: conversation thread '${input.threadId}'`);
    }

    const nextOffset = offset + result.messages.length;
    const hasMore = nextOffset < result.totalMessages;
    return {
      thread: {
        threadId: result.thread.thread_id,
        ...(result.summary
          ? {
              title: result.summary.title,
              brief: result.summary.brief,
              topics: result.summary.topics,
              retrievalHints: result.summary.retrievalHints,
              importance: result.summary.importance,
              importanceReasons: result.summary.importanceReasons,
            }
          : {}),
        session: {
          platform: "discord",
          channelId: result.thread.channel_id,
          guildId: result.thread.guild_id ?? undefined,
          parentChannelId: result.thread.parent_channel_id ?? undefined,
        },
        anchors: {
          startMessageId: result.thread.start_message_id,
          endMessageId: result.thread.end_message_id,
        },
        timeRange: {
          start: formatTime(result.thread.start_ts),
          end: formatTime(result.thread.end_ts),
        },
        messageCount: result.totalMessages,
      },
      page: {
        offset,
        limit,
        total: result.totalMessages,
        nextOffset: hasMore ? nextOffset : undefined,
        hasMore,
      },
      messages: result.messages.map((message) => ({
        ordinal: message.ordinal,
        messageId: message.messageId,
        userId: message.userId,
        userName: message.userName,
        time: formatTime(message.ts),
        text: message.text,
      })),
    };
  }

  async runSummarization(
    input: ConversationThreadRunSummarizationInput = {},
  ): Promise<ConversationThreadRunSummarizationResult> {
    const jobId = input.jobId;
    this.logger.info("thread summarization refresh started", { jobId });
    const refreshed = this.refreshThreads();
    this.logger.info("thread summarization refresh completed", { jobId, refreshed });
    const eligible = this.params.store.listEligibleForSummarization({
      now: input.now,
      quietMs: SUMMARY_QUIET_MS,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
      includeEmbeddingStale:
        !!this.params.embeddingAdapter && this.params.store.isVectorSearchAvailable(),
      force: input.force === true,
    });
    this.logger.info("thread summarization eligibility completed", {
      jobId,
      eligible: eligible.length,
      dryRun: input.dryRun === true,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
      force: input.force === true,
    });

    const result: ConversationThreadRunSummarizationResult = {
      dryRun: input.dryRun ?? false,
      refreshed,
      eligible: eligible.length,
      summarized: 0,
      failed: 0,
      failures: [],
      threadIds: eligible.map((thread) => thread.thread_id),
    };

    if (input.dryRun) {
      this.logger.info("thread summarization dry run completed", {
        jobId,
        eligible: result.eligible,
      });
      return result;
    }

    const cfg = await this.params.getConfig();
    const summarize = this.params.summarizer ?? defaultSummarizer;
    const concurrency = clampSummarizationConcurrency(
      cfg.conversation.thread.summarization.concurrency,
    );
    this.logger.info("thread summarization processing started", {
      jobId,
      eligible: eligible.length,
      concurrency,
      force: input.force === true,
    });

    let nextIndex = 0;
    let abortError: Error | null = null;

    const processThread = async (thread: (typeof eligible)[number]): Promise<void> => {
      const threadStartedAt = Date.now();
      this.logger.info("thread summarization thread started", {
        jobId,
        threadId: thread.thread_id,
        kind: thread.kind,
        updatedAt: thread.updated_at,
        lastSummarizedAt: thread.last_summarized_at,
        summaryVersion: thread.summary_version,
        embeddingVersion: thread.embedding_version,
      });
      const summaryRead = readSummaryMessages(this.params.store, thread.thread_id);
      if (summaryRead.totalMessages === 0) {
        this.logger.info("thread summarization deleting empty thread", {
          jobId,
          threadId: thread.thread_id,
        });
        this.params.store.deleteThread(thread.thread_id);
        return;
      }
      const summaryMessages = this.normalizeMessagesForSummarization(summaryRead.messages);

      try {
        const summaryIsStale =
          input.force === true ||
          thread.last_summarized_at === null ||
          thread.last_summarized_at < thread.updated_at ||
          thread.summary_version !== CONVERSATION_THREAD_SUMMARY_VERSION;
        const previousSummary = this.params.store.getSummary(thread.thread_id);
        if (summaryRead.omittedMessages > 0) {
          this.logger.info("thread summarization transcript truncated", {
            jobId,
            threadId: thread.thread_id,
            totalMessages: summaryRead.totalMessages,
            includedMessages: summaryRead.messages.length,
            omittedMessages: summaryRead.omittedMessages,
          });
        }
        const summaryWrite = summaryIsStale
          ? await (async () => {
              this.logger.info("thread summary generation started", {
                jobId,
                threadId: thread.thread_id,
                totalMessages: summaryRead.totalMessages,
                includedMessages: summaryRead.messages.length,
              });
              const summary = await this.summarizeWithParseRetries({
                jobId,
                threadId: thread.thread_id,
                summarize,
                cfg,
                previousSummary,
                messages: summaryMessages,
                omittedMessages: summaryRead.omittedMessages,
              });
              return this.params.store.upsertSummary(
                thread.thread_id,
                thread.summary_input_hash ?? "",
                summary ?? buildFallbackSummary(summaryMessages),
              );
            })()
          : {
              facets: this.params.store.listFacets(thread.thread_id),
              embeddingInputHash:
                this.params.store.computeEmbeddingInputHash(thread.thread_id) ?? "",
            };
        if (summaryIsStale) {
          this.logger.info("thread summary generation completed", {
            jobId,
            threadId: thread.thread_id,
            facets: summaryWrite.facets.length,
          });
        }

        await this.tryEmbedThread({
          jobId,
          threadId: thread.thread_id,
          embeddingInputHash: summaryWrite.embeddingInputHash,
          facets: summaryWrite.facets,
        });
        if (summaryIsStale) result.summarized += 1;
        this.logger.info("thread summarization thread completed", {
          jobId,
          threadId: thread.thread_id,
          durationMs: Date.now() - threadStartedAt,
          summarized: summaryIsStale,
        });
      } catch (e) {
        const error = summarizeProviderError(e);
        const failureMessage = error.providerMessage
          ? `${error.message}: ${error.providerMessage}`
          : error.message;
        this.logger.error(
          "thread summarization failed",
          {
            jobId,
            threadId: thread.thread_id,
            statusCode: error.statusCode,
            providerMessage: error.providerMessage,
            responseBody: error.responseBody,
          },
          e,
        );
        result.failed += 1;
        result.failures.push({ threadId: thread.thread_id, error: failureMessage });
        if (e instanceof ConversationThreadSummaryParseError) {
          this.logger.warn("thread summarization continuing after parse failure", {
            jobId,
            threadId: thread.thread_id,
            eligible: result.eligible,
            summarized: result.summarized,
            failed: result.failed,
          });
          return;
        }

        this.logger.error("thread summarization run aborted after hard failure", {
          jobId,
          threadId: thread.thread_id,
          eligible: result.eligible,
          summarized: result.summarized,
          failed: result.failed,
        });
        throw new Error(
          `thread summarization aborted after failure in ${thread.thread_id}: ${failureMessage}`,
        );
      }
    };

    const workerCount = Math.min(concurrency, eligible.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!abortError) {
        const thread = eligible[nextIndex];
        nextIndex += 1;
        if (!thread) return;
        try {
          await processThread(thread);
        } catch (e) {
          abortError = e instanceof Error ? e : new Error(String(e));
          return;
        }
      }
    });
    await Promise.all(workers);
    if (abortError) throw abortError;

    this.logger.info("thread summarization run completed", {
      jobId,
      eligible: result.eligible,
      summarized: result.summarized,
      failed: result.failed,
      concurrency,
    });
    return result;
  }

  private async summarizeWithParseRetries(input: {
    jobId?: string;
    threadId: string;
    summarize: ConversationThreadSummarizer;
    cfg: CoreConfig;
    previousSummary: ConversationThreadSummary | null;
    messages: readonly ConversationThreadMessage[];
    omittedMessages: number;
  }): Promise<ConversationThreadSummaryInput> {
    let lastError: ConversationThreadSummaryParseError | null = null;
    for (let attempt = 1; attempt <= SUMMARY_PARSE_MAX_ATTEMPTS; attempt++) {
      try {
        return await input.summarize({
          cfg: input.cfg,
          threadId: input.threadId,
          previousSummary: input.previousSummary,
          messages: input.messages,
          omittedMessages: input.omittedMessages,
        });
      } catch (e) {
        if (!(e instanceof ConversationThreadSummaryParseError)) throw e;
        lastError = e;
        this.logger.warn("thread summary parse failed", {
          jobId: input.jobId,
          threadId: input.threadId,
          attempt,
          maxAttempts: SUMMARY_PARSE_MAX_ATTEMPTS,
          error: e.message,
          rawOutput: e.rawOutput,
        });
      }
    }

    throw lastError ?? new ConversationThreadSummaryParseError("summary JSON parse failed");
  }

  private normalizeMessagesForSummarization(
    messages: readonly ConversationThreadMessage[],
  ): ConversationThreadMessage[] {
    const mapper = this.params.entityMapper;
    if (!mapper) return [...messages];
    return messages.map((message) => ({
      ...message,
      userName: mapper.normalizeIncomingText(`<@${message.userId}>`),
      text: mapper.normalizeIncomingText(message.text),
    }));
  }

  private async tryEmbedThread(input: {
    jobId?: string;
    threadId: string;
    embeddingInputHash: string;
    facets: ReturnType<ConversationThreadStore["listFacets"]>;
  }): Promise<void> {
    const adapter = this.params.embeddingAdapter;
    if (!adapter) return;
    if (!this.params.store.isVectorSearchAvailable()) {
      const err = this.params.store.getVectorLoadError();
      this.logger.warn("thread embeddings skipped: sqlite-vec unavailable", {
        jobId: input.jobId,
        threadId: input.threadId,
        error: err ?? undefined,
      });
      return;
    }

    const embeddings = [];
    let dimensions: number | null = null;
    this.logger.info("thread embedding generation started", {
      jobId: input.jobId,
      threadId: input.threadId,
      facets: input.facets.length,
      modelId: adapter.modelId,
    });
    for (const facet of input.facets) {
      const embedding = await adapter.embed({ text: facet.text, facet: facet.facet });
      dimensions ??= embedding.length;
      if (embedding.length !== dimensions) {
        throw new Error(
          `thread embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`,
        );
      }
      embeddings.push({
        facet: facet.facet,
        embedding,
      });
    }

    if (dimensions === null) {
      this.logger.info("thread embedding generation skipped: no facets", {
        jobId: input.jobId,
        threadId: input.threadId,
      });
      return;
    }

    this.params.store.upsertEmbeddings({
      threadId: input.threadId,
      embeddingInputHash: input.embeddingInputHash,
      modelId: adapter.modelId,
      dimensions,
      embeddings,
    });
    this.logger.info("thread embedding generation completed", {
      jobId: input.jobId,
      threadId: input.threadId,
      facets: embeddings.length,
      dimensions,
      modelId: adapter.modelId,
    });
  }

  private async searchHits(input: {
    query: string;
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    cfg: CoreConfig;
    filters: ConversationThreadSearchFilters;
    allowlist: ConversationThreadSearchAllowlist;
  }): Promise<ConversationThreadSearchHit[]> {
    const candidates = new Map<string, ConversationThreadSearchHit>();
    const add = (hit: ConversationThreadSearchHit) => {
      if (
        !shouldAllowDiscordThread(input.cfg, {
          channelId: hit.channelId,
          parentChannelId: hit.parentChannelId,
          guildId: hit.guildId,
        })
      ) {
        return;
      }
      const existing = candidates.get(hit.threadId);
      if (!existing) {
        candidates.set(hit.threadId, hit);
        return;
      }
      existing.lexicalScore = Math.max(existing.lexicalScore, hit.lexicalScore);
      existing.semanticScore = Math.max(existing.semanticScore, hit.semanticScore);
      existing.score = applyImportanceNudge(
        existing,
        existing.semanticScore + existing.lexicalScore * 0.15,
      );
    };

    if (input.mode !== "semantic") {
      for (const hit of this.params.store.search({
        query: input.query,
        limit: input.limit * 5,
        filters: input.filters,
        allowlist: input.allowlist,
      })) {
        hit.score = applyImportanceNudge(
          hit,
          hit.lexicalScore * (input.mode === "lexical" ? 1 : 0.15),
        );
        add(hit);
      }
    }

    const adapter = this.params.embeddingAdapter;
    if (input.mode !== "lexical" && adapter && this.params.store.isVectorSearchAvailable()) {
      try {
        const queryEmbedding = await adapter.embed({ text: input.query, facet: "query" });
        for (const hit of this.params.store.searchSemantic({
          embedding: queryEmbedding,
          modelId: adapter.modelId,
          dimensions: queryEmbedding.length,
          limit: input.limit * 5,
          filters: input.filters,
          allowlist: input.allowlist,
        })) {
          hit.score = applyImportanceNudge(hit, hit.semanticScore + hit.lexicalScore * 0.15);
          add(hit);
        }
      } catch (e) {
        this.logger.warn("thread semantic search failed; using lexical fallback", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return [...candidates.values()]
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return right.endTs - left.endTs;
      })
      .slice(0, input.limit);
  }

  private formatSearchHit(hit: ConversationThreadSearchHit, verbose: boolean) {
    return {
      threadId: hit.threadId,
      title: hit.title,
      brief: hit.brief,
      topics: hit.topics,
      retrievalHints: hit.retrievalHints,
      importance: hit.importance,
      importanceReasons: hit.importanceReasons,
      timeRange: {
        start: formatTime(hit.startTs),
        end: formatTime(hit.endTs),
      },
      messageCount: hit.messageCount,
      ...(verbose
        ? {
            score: hit.score,
            lexicalScore: hit.lexicalScore,
            semanticScore: hit.semanticScore,
            session: {
              platform: "discord" as const,
              channelId: hit.channelId,
              guildId: hit.guildId,
              parentChannelId: hit.parentChannelId,
            },
            anchors: {
              startMessageId: hit.startMessageId,
              endMessageId: hit.endMessageId,
            },
            derivedState: {
              summarized: hit.summarized,
              stale: hit.stale,
            },
          }
        : {}),
    };
  }
}
