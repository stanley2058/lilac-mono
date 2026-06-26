import { generateText, Output, type ModelMessage } from "ai";
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

const SUMMARY_QUIET_MS = 60 * 60 * 1000;
const SUMMARY_HEAD_MESSAGES = 40;
const SUMMARY_TAIL_MESSAGES = 160;
const SUMMARY_MAX_MESSAGES = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;
const DEFAULT_READ_LIMIT = 50;

const threadSummarySchema = z.object({
  title: z.string().min(1).max(160),
  brief: z.string().max(1400),
  topics: z.array(z.string().min(1).max(120)).max(12).default([]),
  importance: z.enum(["low", "medium", "high"]),
  importanceReasons: z.array(z.string().min(1).max(220)).max(5).default([]),
});

export type ConversationThreadRunSummarizationInput = {
  jobId?: string;
  dryRun?: boolean;
  wait?: boolean;
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
        `Previous importance: ${input.previousSummary.importance}`,
        `Previous importance reasons: ${input.previousSummary.importanceReasons.join("; ") || "(none)"}`,
      ].join("\n")
    : "(none)";

  const messages = [
    {
      role: "user",
      content: [
        `threadId=${input.threadId}`,
        "Summarize this conversation thread for future semantic retrieval.",
        "Keep stable wording when the previous summary is still accurate; avoid unnecessary drift after small updates.",
        "Return title (<120 chars), brief (<1024 chars), short topic phrases, importance, and importance reasons.",
        "Topics are descriptive phrases, not canonical tags.",
        "Importance is low, medium, or high based on durable future value, not just message count.",
        "Use high for decisions, architecture, implementation plans, incident/root-cause analysis, or reusable project knowledge.",
        "Use low for casual chat, shallow reactions, external-link-only discussion, or transient coordination.",
        "Importance reasons should briefly explain the rating for debugging.",
        "",
        "Previous summary:",
        previous,
        "",
        "Transcript:",
        transcript,
      ].join("\n"),
    },
  ] satisfies ModelMessage[];

  const result = await generateText({
    model: resolved.model,
    output: Output.object({ schema: threadSummarySchema }),
    instructions: "You create compact, stable thread summaries for a conversation memory index.",
    messages,
    maxOutputTokens: 1200,
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
    });
    this.logger.info("thread summarization eligibility completed", {
      jobId,
      eligible: eligible.length,
      dryRun: input.dryRun === true,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
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

    for (const thread of eligible) {
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
        continue;
      }

      try {
        const summaryIsStale =
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
              return this.params.store.upsertSummary(
                thread.thread_id,
                thread.summary_input_hash ?? "",
                (await summarize({
                  cfg,
                  threadId: thread.thread_id,
                  previousSummary,
                  messages: summaryRead.messages,
                  omittedMessages: summaryRead.omittedMessages,
                })) ?? buildFallbackSummary(summaryRead.messages),
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
        const error = e instanceof Error ? e.message : String(e);
        this.logger.error("thread summarization failed", { jobId, threadId: thread.thread_id }, e);
        result.failed += 1;
        result.failures.push({ threadId: thread.thread_id, error });
      }
    }

    this.logger.info("thread summarization run completed", {
      jobId,
      eligible: result.eligible,
      summarized: result.summarized,
      failed: result.failed,
    });
    return result;
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
