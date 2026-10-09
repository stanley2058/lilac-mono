import { SUMMARY_QUIET_MS } from "./thread-summary-policy";
import { captureError } from "../shared/error-capture.js";
import {
  AISDKError,
  generateText,
  Output,
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type UserContent,
} from "ai";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  createLogger,
  classifyBunSqliteError,
  errorCode,
  ensurePromptWorkspace,
  extractAiErrorLogDetails,
  formatTaggedErrorForLog,
  ModelResolutionFailed,
  ModelCapability,
  resolveModelRefResult,
  resolveModelSlotResult,
  resolvePromptDir,
  type CoreConfig,
  type ModelCapabilityInfo,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  type ConversationThreadMessage,
  type ConversationThreadRow,
  type ConversationThreadSearchFilters,
  type ConversationThreadSearchAllowlist,
  type ConversationThreadSearchHit,
  type ConversationThreadSqliteDriverFailure,
  type ConversationThreadStore,
  type ConversationThreadSummary,
  type ConversationThreadSummaryInput,
  type ConversationThreadSummaryWriteResult,
  type ConversationThreadSummarizationEligibility,
  type ConversationThreadSummarizationEligibilityReason,
} from "./thread-store";
import type {
  ConversationThreadEmbeddingAdapterResolver,
  ConversationThreadEmbeddingUsageEvent,
} from "./thread-embedding";
import type { EntityMapper } from "../entity/entity-mapper";
import {
  hashIndexedDiscordAttachments,
  toIndexedDiscordAttachments,
  type DiscordAttachmentMeta,
} from "../surface/discord/discord-attachment";
import {
  appendDiscordAttachmentsToUserContent,
  createDiscordAttachmentState,
} from "../surface/bridge/request-composition/attachments";
import { stripLeadingContinueDirective } from "../surface/discord/discord-request-router/common";
import { isSqliteBusyError } from "../shared/sqlite";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";

const SUMMARY_HEAD_MESSAGES = 40;
const SUMMARY_TAIL_MESSAGES = 160;
const SUMMARY_MAX_MESSAGES = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;
const DEFAULT_READ_LIMIT = 50;
const DEFAULT_SEARCH_MIN_SCORE = 0.1;

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
const SUMMARY_PARSE_MAX_ATTEMPTS = 3;
const SUMMARY_FAILURE_RETRY_MS = 60 * 60 * 1000;
const HYBRID_LEXICAL_WEIGHT = 0.35;
const PROMPT_CONTEXT_FILES = ["MEMORY.md", "USER.md", "ENTITIES.md"] as const;
const MULTI_QUERY_MAX = 10;
const AUTO_INJECT_SEARCH_MAX = 3;
const AUTO_INJECT_QUERIES_PER_SEARCH_MAX = 3;
const COVERAGE_RECALL_MULTIPLIER = 5;
const WEAK_COVERAGE_MULTIPLIER = 0.25;
const DOMAIN_MISMATCH_COVERAGE_MULTIPLIER = 0.35;
const PARTIAL_COVERAGE_MULTIPLIER = 0.55;

const threadLogger = createLogger({
  module: "conversation-thread",
});

const COVERAGE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "he",
  "her",
  "his",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "to",
  "was",
  "with",
]);

const threadSummarySchema = z.object({
  title: z.string(),
  brief: z.string(),
  topics: z.array(z.string()),
  retrievalHints: z.array(z.string()),
  aboutness: z.object({
    domains: z.array(z.string()),
    situations: z.array(z.string()),
    complaintTargets: z.array(z.string()),
    entities: z.array(z.string()),
    userWouldAskForThisAs: z.array(z.string()),
  }),
  importance: z.enum(["low", "medium", "high"]),
  importanceReasons: z.array(z.string()),
});

const queryAboutnessSchema = z.object({
  domains: z.array(z.string()),
  situations: z.array(z.string()),
  targets: z.array(z.string()),
  entities: z.array(z.string()),
  userWouldAskForThisAs: z.array(z.string()),
  intentSummary: z.string(),
});

const autoInjectSearchPlanSchema = z.object({
  queries: z.array(z.string()),
  aboutness: queryAboutnessSchema,
});

export const autoInjectQueryPlanSchema = z.object({
  searches: z.array(autoInjectSearchPlanSchema),
});

export type ConversationThreadQueryAboutness = z.infer<typeof queryAboutnessSchema>;
export type ConversationThreadAutoInjectQueryPlan = z.infer<typeof autoInjectQueryPlanSchema>;

export type ConversationThreadQueryAboutnessSummarizer = (input: {
  cfg: CoreConfig;
  queries: readonly string[];
}) => Promise<ConversationThreadQueryAboutness>;

export type ConversationThreadAutoInjectQueryPlanner = (input: {
  cfg: CoreConfig;
  text: string;
  content?: UserContent;
}) => Promise<ConversationThreadAutoInjectQueryPlan>;

export type ConversationThreadRunSummarizationInput = {
  jobId?: string;
  trigger?: "manual" | "periodic";
  dryRun?: boolean;
  wait?: boolean;
  force?: boolean;
  clear?: boolean;
  limit?: number;
  threadId?: string;
  beforeTs?: number;
  afterTs?: number;
  now?: number;
};

export type ConversationThreadEligibilityReasonCounts = {
  forced?: number;
  "never-summarized"?: number;
  "content-changed"?: number;
  "summary-version"?: number;
  "embedding-missing"?: number;
  "embedding-outdated"?: number;
  "embedding-version"?: number;
  "embedding-model"?: number;
};

export type ConversationThreadEligibilityCounts = {
  summary: number;
  embeddingOnly: number;
  reasons: ConversationThreadEligibilityReasonCounts;
};

export type ConversationThreadRunSummarizationResult = {
  dryRun: boolean;
  refreshed: {
    channels: number;
    threads: number;
    messages: number;
  };
  eligible: number;
  eligibleTotal: number;
  eligibility: ConversationThreadEligibilityCounts;
  cleared: number;
  summarized: number;
  failed: number;
  failures: Array<{ threadId: string; error: string }>;
  threadIds: string[];
  jobId?: string;
  status?: "queued" | "completed";
};

export type ConversationThreadToolService = {
  search(
    input: Parameters<ConversationThreadService["search"]>[0],
  ): Promise<ConversationThreadSearchResult>;
  metadata(
    input: Parameters<ConversationThreadService["metadata"]>[0],
  ): Promise<ConversationThreadMetadataOutput>;
  read(
    input: Parameters<ConversationThreadService["read"]>[0],
  ): Promise<ConversationThreadReadOutput>;
  runSummarization(
    input?: ConversationThreadRunSummarizationInput,
  ): Promise<ConversationThreadRunSummarizationResult>;
  planAutoInjectSearch(
    input: Parameters<ConversationThreadService["planAutoInjectSearch"]>[0],
  ): Promise<ConversationThreadAutoInjectQueryPlan>;
  getAutoInjectRankingCorpusDocuments?(): readonly string[] | Promise<readonly string[]>;
  shortlistAutoInjectCandidates?(
    input: Parameters<ConversationThreadService["shortlistAutoInjectCandidates"]>[0],
  ): Promise<ConversationThreadAutoInjectShortlist>;
};

export type ConversationThreadAutoInjectShortlist = {
  source: "lexical" | "semantic" | "hybrid" | "none";
  results: ConversationThreadSearchResult["results"];
};

export type ConversationThreadSearchResult = {
  meta: {
    query: string;
    queries?: string[];
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    minScore: number;
    count: number;
    vectorAvailable: boolean;
    vectorError?: string;
    queryAboutness?: ConversationThreadQueryAboutness;
    queryAboutnessError?: string;
  };
  results: Array<{
    surface: "discord" | "native";
    threadId: string;
    title: string;
    brief: string;
    topics?: string[];
    retrievalHints?: string[];
    aboutness?: {
      domains: string[];
      situations: string[];
      complaintTargets: string[];
      entities: string[];
      userWouldAskForThisAs: string[];
    };
    timeRange?: {
      start: string;
      end: string;
    };
    messageCount?: number;
    importance?: "low" | "medium" | "high";
    importanceReasons?: string[];
    score?: number;
    lexicalScore?: number;
    semanticScore?: number;
    queryAttribution?: ConversationThreadQueryAttribution[];
    aboutnessCoverage?: ConversationThreadAboutnessCoverage;
    session?: {
      platform: "discord" | "native";
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

type ConversationThreadQueryAttribution = {
  query: string;
  rank: number;
  selfScore: number;
  contribution: number;
  lexicalScore: number;
  semanticScore: number;
};

type ConversationThreadAboutnessCoverage = {
  preCoverageScore: number;
  multiplier: number;
  highPrecisionCoverage: number;
  domainCoverage: number;
  targetCoverage: number;
  situationCoverage: number;
  askPhraseCoverage: number;
  entityCoverage: number;
  matched: boolean;
  matchReason:
    | "no-specific-aboutness"
    | "domain-mismatch"
    | "weak-coverage"
    | "partial-coverage"
    | "sufficient-coverage"
    | "strong-coverage";
};

type ConversationThreadSearchHitWithAttribution = ConversationThreadSearchHit & {
  queryAttribution?: ConversationThreadQueryAttribution[];
  aboutnessCoverage?: ConversationThreadAboutnessCoverage;
};

export type ConversationThreadReadOutput = {
  thread: {
    surface: "discord" | "native";
    threadId: string;
    title?: string;
    brief?: string;
    topics?: string[];
    retrievalHints?: string[];
    aboutness?: {
      domains: string[];
      situations: string[];
      complaintTargets: string[];
      entities: string[];
      userWouldAskForThisAs: string[];
    };
    importance?: "low" | "medium" | "high";
    importanceReasons?: string[];
    session: {
      platform: "discord" | "native";
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
    content: string;
  }>;
};

export type ConversationThreadMetadataOutput = {
  threads: ConversationThreadReadOutput["thread"][];
  missing: string[];
};

export class ConversationThreadNotFound extends TaggedError("ConversationThreadNotFound")<{
  readonly threadId: string;
  readonly message: string;
}> {}

export class ConversationThreadAccessDenied extends TaggedError("ConversationThreadAccessDenied")<{
  readonly threadId: string;
  readonly message: string;
}> {}

export type ConversationThreadSearchError = PersistedDataError | ConversationThreadInvalidInput;

export type ConversationThreadReadError =
  | PersistedDataError
  | ConversationThreadNotFound
  | ConversationThreadAccessDenied
  | ConversationThreadInvalidInput;

export type ConversationThreadMetadataError =
  | PersistedDataError
  | ConversationThreadAccessDenied
  | ConversationThreadInvalidInput;

export class ConversationThreadInvalidInput extends TaggedError("ConversationThreadInvalidInput")<{
  readonly field: "query" | "text" | "threadIds";
  readonly message: string;
}> {}

export class ConversationThreadOperationFailed extends TaggedError(
  "ConversationThreadOperationFailed",
)<{
  readonly operation:
    | "capture-query-aboutness"
    | "persist-summary-failure"
    | "search-embedding"
    | "summarize-thread";
  readonly message: string;
}> {}

export type ConversationThreadGenerationError =
  | ConversationThreadOperationFailed
  | ConversationThreadSummaryParseError
  | ModelResolutionFailed;

function conversationThreadOperationFailed(
  operation: ConversationThreadOperationFailed["operation"],
  message: string,
): ConversationThreadOperationFailed {
  return new ConversationThreadOperationFailed({
    operation,
    message,
  });
}

export type ConversationThreadSummarizer = (input: {
  cfg: CoreConfig;
  jobId?: string;
  threadId: string;
  attempt?: number;
  previousSummary: ConversationThreadSummary | null;
  promptContext: ConversationThreadPromptContext | null;
  messages: readonly ConversationThreadSummaryMessage[];
  omittedMessages?: number;
}) => Promise<ConversationThreadSummaryInput>;

export type ConversationThreadSummaryAttachment = DiscordAttachmentMeta & { data?: Uint8Array };

export type ConversationThreadSummaryMessage = Omit<ConversationThreadMessage, "attachments"> & {
  attachments: ConversationThreadSummaryAttachment[];
};

export type ConversationThreadAttachmentHydrator = (input: {
  refs: readonly { surface?: "discord" | "native"; channelId: string; messageId: string }[];
}) => Promise<
  ResultType<
    Array<{
      ref: { surface?: "discord" | "native"; channelId: string; messageId: string };
      attachments: ConversationThreadSummaryAttachment[];
    }>,
    ConversationThreadOperationFailed
  >
>;

type ConversationThreadPromptContext = {
  hash: string;
  text: string;
};

type ThreadLanguageModelUsageOperation = "summary" | "query_aboutness" | "auto_inject_query_plan";
type ThreadEmbeddingUsageOperation = "thread_facets" | "search_query";
type ThreadEmbeddingUsageStatus = "completed" | "failed";

type AutoInjectTimingStage =
  | "planning"
  | "plannerModel"
  | "search"
  | "embedding"
  | "corpus"
  | "ranking"
  | "shortlist"
  | "decision";
type AutoInjectTiming = { calls: number; totalMs: number; maxMs: number };

export type ConversationThreadAutoInjectUsageAccumulator = {
  recordTiming(stage: AutoInjectTimingStage, elapsedMs: number): void;
  recordPlannerUsage(usage: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  }): void;
  recordEmbeddingUsage(usage: {
    model: string;
    calls: number;
    inputChars: number;
    tokens: number;
    warnings: number;
  }): void;
  recordDecisionUsage(usage: { model: string; inputTokens?: number; outputTokens?: number }): void;
  finish(input: {
    status: "completed" | "abstained" | "partial" | "failed";
    searchCount?: number;
    queryCount?: number;
  }): void;
};

type AutoInjectUsageLogRecord = {
  status: "completed" | "abstained" | "partial" | "failed";
  requestId?: string;
  elapsedMs: number;
  searches: number;
  queries: number;
  timings: Partial<Record<AutoInjectTimingStage, AutoInjectTiming>>;
  planner?: {
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
  };
  embedding?: {
    model: string;
    calls: number;
    inputChars: number;
    tokens: number;
    warnings: number;
  };
  decision?: {
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  };
};

type ThreadLanguageModelCallEndEvent = {
  provider: string;
  modelId: string;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  performance: {
    responseTimeMs: number;
    outputTokensPerSecond: number | undefined;
    timeToFirstOutputMs: number | undefined;
  };
};

function createThreadLanguageModelUsageLogger(input: {
  operation: ThreadLanguageModelUsageOperation;
  modelSpec: string;
  jobId?: string;
  threadId?: string;
  attempt?: number;
  messageCount?: number;
  omittedMessages?: number;
  queryCount?: number;
  inputChars?: number;
  autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
}) {
  return (event: ThreadLanguageModelCallEndEvent) => {
    if (input.autoInjectUsage) {
      input.autoInjectUsage.recordTiming("plannerModel", event.performance.responseTimeMs);
      input.autoInjectUsage.recordPlannerUsage({
        model: input.modelSpec,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens,
        reasoningTokens: event.usage.outputTokenDetails.reasoningTokens,
      });
      return;
    }
    threadLogger.info("conversation.thread.llm.usage", {
      operation: input.operation,
      jobId: input.jobId,
      threadId: input.threadId,
      attempt: input.attempt,
      messageCount: input.messageCount,
      omittedMessages: input.omittedMessages,
      queryCount: input.queryCount,
      inputChars: input.inputChars,
      modelSpec: input.modelSpec,
      provider: event.provider,
      modelId: event.modelId,
      finishReason: event.finishReason,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      totalTokens: event.usage.totalTokens,
      cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens,
      cacheWriteTokens: event.usage.inputTokenDetails.cacheWriteTokens,
      noCacheTokens: event.usage.inputTokenDetails.noCacheTokens,
      reasoningTokens: event.usage.outputTokenDetails.reasoningTokens,
      textTokens: event.usage.outputTokenDetails.textTokens,
      responseTimeMs: event.performance.responseTimeMs,
      timeToFirstOutputMs: event.performance.timeToFirstOutputMs,
      outputTokensPerSecond: event.performance.outputTokensPerSecond,
    });
  };
}

function createThreadEmbeddingUsageAccumulator(
  operation: ThreadEmbeddingUsageOperation,
  autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator,
) {
  let calls = 0;
  let inputChars = 0;
  let tokens = 0;
  let warnings = 0;
  let modelSpec: string | undefined;
  let provider: string | undefined;
  let modelId: string | undefined;
  const facets = new Set<NonNullable<ConversationThreadEmbeddingUsageEvent["facet"]>>();

  return {
    record(event: ConversationThreadEmbeddingUsageEvent) {
      if (event.elapsedMs !== undefined)
        autoInjectUsage?.recordTiming("embedding", event.elapsedMs);
      calls += 1;
      inputChars += event.inputChars;
      tokens += event.tokens;
      warnings += event.warnings;
      modelSpec ??= event.modelSpec;
      provider ??= event.provider;
      modelId ??= event.modelId;
      if (event.facet) facets.add(event.facet);
    },
    log(input: {
      status: ThreadEmbeddingUsageStatus;
      jobId?: string;
      threadId?: string;
      mode?: "hybrid" | "semantic" | "lexical";
      queryCount?: number;
      dimensions?: number;
      persistedEmbeddings?: number;
      error?: string;
    }) {
      if (calls === 0) return;
      const usage = {
        operation,
        status: input.status,
        jobId: input.jobId,
        threadId: input.threadId,
        mode: input.mode,
        queryCount: input.queryCount,
        modelSpec,
        provider,
        modelId,
        calls,
        inputChars,
        tokens,
        warnings,
        facetCount: facets.size,
        facets: [...facets],
        dimensions: input.dimensions,
        persistedEmbeddings: input.persistedEmbeddings,
        error: input.error,
      };
      if (autoInjectUsage) {
        autoInjectUsage.recordEmbeddingUsage({
          model: modelSpec ?? modelId ?? "unknown",
          calls,
          inputChars,
          tokens,
          warnings,
        });
        return;
      }
      threadLogger.info("conversation.thread.embedding.usage", usage);
    },
  };
}

export function createConversationThreadAutoInjectUsageAccumulator(input: {
  requestId?: string;
  now?: () => number;
  log?: (message: string, record: AutoInjectUsageLogRecord) => void;
}): ConversationThreadAutoInjectUsageAccumulator {
  const now = input.now ?? performance.now.bind(performance);
  const startedAt = now();
  const log =
    input.log ??
    ((message: string, record: AutoInjectUsageLogRecord) => threadLogger.info(message, record));
  let finished = false;
  let plannerModel: string | undefined;
  let plannerCalls = 0;
  let plannerInputTokens = 0;
  let plannerOutputTokens = 0;
  let plannerCacheReadTokens = 0;
  let plannerReasoningTokens = 0;
  let embeddingModel: string | undefined;
  let embeddingCalls = 0;
  let embeddingInputChars = 0;
  let embeddingTokens = 0;
  let embeddingWarnings = 0;
  let decisionModel: string | undefined;
  let decisionCalls = 0;
  let decisionInputTokens = 0;
  let decisionOutputTokens = 0;
  const timings: Record<AutoInjectTimingStage, AutoInjectTiming> = {
    planning: { calls: 0, totalMs: 0, maxMs: 0 },
    plannerModel: { calls: 0, totalMs: 0, maxMs: 0 },
    search: { calls: 0, totalMs: 0, maxMs: 0 },
    embedding: { calls: 0, totalMs: 0, maxMs: 0 },
    corpus: { calls: 0, totalMs: 0, maxMs: 0 },
    ranking: { calls: 0, totalMs: 0, maxMs: 0 },
    shortlist: { calls: 0, totalMs: 0, maxMs: 0 },
    decision: { calls: 0, totalMs: 0, maxMs: 0 },
  };

  return {
    recordTiming(stage, elapsedMs) {
      const timing = timings[stage];
      timing.calls += 1;
      timing.totalMs += elapsedMs;
      timing.maxMs = Math.max(timing.maxMs, elapsedMs);
    },
    recordPlannerUsage(usage) {
      plannerModel ??= usage.model;
      plannerCalls += 1;
      plannerInputTokens += usage.inputTokens ?? 0;
      plannerOutputTokens += usage.outputTokens ?? 0;
      plannerCacheReadTokens += usage.cacheReadTokens ?? 0;
      plannerReasoningTokens += usage.reasoningTokens ?? 0;
    },
    recordEmbeddingUsage(usage) {
      embeddingModel ??= usage.model;
      embeddingCalls += usage.calls;
      embeddingInputChars += usage.inputChars;
      embeddingTokens += usage.tokens;
      embeddingWarnings += usage.warnings;
    },
    recordDecisionUsage(usage) {
      decisionModel ??= usage.model;
      decisionCalls += 1;
      decisionInputTokens += usage.inputTokens ?? 0;
      decisionOutputTokens += usage.outputTokens ?? 0;
    },
    finish(finishInput) {
      if (finished) return;
      finished = true;
      const record: AutoInjectUsageLogRecord = {
        status: finishInput.status,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        elapsedMs: Math.round(now() - startedAt),
        searches: finishInput.searchCount ?? 0,
        queries: finishInput.queryCount ?? 0,
        timings: Object.fromEntries(
          Object.entries(timings)
            .filter(([, timing]) => timing.calls > 0)
            .map(([stage, timing]) => [
              stage,
              {
                calls: timing.calls,
                totalMs: Math.round(timing.totalMs),
                maxMs: Math.round(timing.maxMs),
              },
            ]),
        ),
        ...(plannerCalls > 0 && plannerModel
          ? {
              planner: {
                model: plannerModel,
                calls: plannerCalls,
                inputTokens: plannerInputTokens,
                outputTokens: plannerOutputTokens,
                cacheReadTokens: plannerCacheReadTokens,
                reasoningTokens: plannerReasoningTokens,
              },
            }
          : {}),
        ...(embeddingCalls > 0 && embeddingModel
          ? {
              embedding: {
                model: embeddingModel,
                calls: embeddingCalls,
                inputChars: embeddingInputChars,
                tokens: embeddingTokens,
                warnings: embeddingWarnings,
              },
            }
          : {}),
        ...(decisionCalls > 0 && decisionModel
          ? {
              decision: {
                model: decisionModel,
                calls: decisionCalls,
                inputTokens: decisionInputTokens,
                outputTokens: decisionOutputTokens,
              },
            }
          : {}),
      };
      log("conversation.thread.auto_inject.usage", record);
    },
  };
}

export class ConversationThreadSummaryParseError extends TaggedError(
  "ConversationThreadSummaryParseError",
)<{ readonly message: string; readonly rawOutput?: string }> {
  constructor(message: string, rawOutput?: string) {
    super({ message, ...(rawOutput === undefined ? {} : { rawOutput }) });
  }
}

function signalConversationThreadDefect(cause: unknown): never {
  if (cause instanceof Error) return adaptToolResultToHost(Result.err(cause));
  return adaptToolResultToHost(
    Result.err(new Panic({ message: "Conversation thread service defect", cause })),
  );
}

function classifyConversationThreadGenerationFailure(
  cause: unknown,
  operation: ConversationThreadOperationFailed["operation"],
  message: string,
): ConversationThreadGenerationError | undefined {
  if (ConversationThreadOperationFailed.is(cause)) return cause;
  if (ConversationThreadSummaryParseError.is(cause)) return cause;
  if (ModelResolutionFailed.is(cause)) return cause;
  if (AISDKError.isInstance(cause)) return conversationThreadOperationFailed(operation, message);
  if (cause instanceof Error && classifyBunSqliteError(cause)) {
    return conversationThreadOperationFailed(operation, message);
  }
  return undefined;
}

async function captureConversationThreadGeneration<T>(
  run: () => Promise<T>,
  operation: ConversationThreadOperationFailed["operation"],
  message: string,
): Promise<ResultType<T, ConversationThreadGenerationError>> {
  const [settled] = await Promise.allSettled([run()]);
  if (settled.status === "fulfilled") return Result.ok(settled.value);
  const failure = classifyConversationThreadGenerationFailure(settled.reason, operation, message);
  return failure ? Result.err(failure) : signalConversationThreadDefect(settled.reason);
}

function captureConversationThreadSqliteOperation(
  run: () => void,
  operation: ConversationThreadOperationFailed["operation"],
  message: string,
): ResultType<void, ConversationThreadOperationFailed> {
  const captured = Result.try({
    try: run,
    catch: (cause) => captureError(cause, "Conversation thread SQLite operation defect"),
  });
  return captured.match<() => ResultType<void, ConversationThreadOperationFailed>>({
    ok: (value) => () => Result.ok(value),
    err:
      ({ cause: error }) =>
      () => {
        if (error instanceof Error && classifyBunSqliteError(error) !== undefined) {
          return Result.err(conversationThreadOperationFailed(operation, message));
        }
        return signalConversationThreadDefect(error);
      },
  })();
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

export async function buildThreadSummaryModelMessages(input: {
  previous: string;
  promptContextSection: string | null;
  messages: readonly ConversationThreadSummaryMessage[];
  omittedMessages: number;
  capability?: ModelCapabilityInfo | null;
}): Promise<ModelMessage[]> {
  const content: Exclude<UserContent, string> = [
    {
      type: "text",
      text: [
        "## Previous summary",
        input.previous,
        "",
        ...(input.promptContextSection ? [input.promptContextSection, ""] : []),
        "## Transcript",
      ].join("\n"),
    },
  ];
  const attachmentState = createDiscordAttachmentState({ inlineFileData: true });
  for (let index = 0; index < input.messages.length; index += 1) {
    if (input.omittedMessages > 0 && index === SUMMARY_HEAD_MESSAGES) {
      content.push({
        type: "text",
        text: `[transcript truncated: ${input.omittedMessages} middle messages omitted]`,
      });
    }
    const message = input.messages[index]!;
    content.push({ type: "text", text: formatMessageForSummary(message) });
    for (const attachment of message.attachments) {
      if (message.surface === "native" && !attachment.data) {
        content.push({
          type: "text",
          text: attachmentMetadataText({
            filename: attachment.filename,
            mediaType: attachment.mimeType,
            size: attachment.size,
            surface: "native",
            reason: "content unavailable or exceeds attachment limits",
          }),
        });
        continue;
      }
      if (attachment.data)
        attachmentState.cache.set(attachment.url, {
          bytes: attachment.data,
          mimeType: attachment.mimeType,
        });
      const mediaType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
      let modality: "image" | "pdf" | null = null;
      if (mediaType?.startsWith("image/")) modality = "image";
      else if (mediaType === "application/pdf") modality = "pdf";
      if (
        input.capability !== undefined &&
        modality !== null &&
        !supportsUtilityModelAttachment(input.capability, modality)
      ) {
        content.push({
          type: "text",
          text: attachmentMetadataText({
            filename: attachment.filename,
            mediaType: attachment.mimeType,
            size: attachment.size,
          }),
        });
        continue;
      }
      await appendDiscordAttachmentsToUserContent(content, [attachment], attachmentState);
    }
  }
  return [{ role: "user", content }];
}

function attachmentMetadataText(input: {
  surface?: "discord" | "native";
  reason?: string;
  filename?: string;
  mediaType?: string;
  size?: number;
}): string {
  const fields = [
    input.filename ? `filename="${input.filename.replace(/[\n\r"\\]/gu, "_")}"` : null,
    input.mediaType ? `mime="${input.mediaType.replace(/[\n\r"\\]/gu, "_")}"` : null,
    input.size !== undefined ? `size=${input.size}` : null,
  ].filter((field): field is string => field !== null);
  return `[${input.surface ?? "discord"}_attachment ${fields.join(" ")}]\n(attachment omitted: ${input.reason ?? "utility model does not support this media type"})`;
}

function supportsUtilityModelAttachment(
  capability: ModelCapabilityInfo | null,
  modality: "image" | "pdf",
): boolean {
  return (
    capability?.attachment === true && capability.modalities?.input.includes(modality) === true
  );
}

export function filterUtilityModelAttachments(
  messages: readonly ModelMessage[],
  capability: ModelCapabilityInfo | null,
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content: Exclude<UserContent, string> = message.content.map((part) => {
      if (part.type !== "file") return part;
      let modality: "image" | "pdf" | null = null;
      if (part.mediaType.startsWith("image/")) modality = "image";
      else if (part.mediaType === "application/pdf") modality = "pdf";
      if (modality && supportsUtilityModelAttachment(capability, modality)) {
        return part;
      }
      return {
        type: "text",
        text: attachmentMetadataText({
          filename: part.filename,
          mediaType: part.mediaType,
          size: part.data instanceof Uint8Array ? part.data.byteLength : undefined,
        }),
      };
    });
    return { ...message, content };
  });
}

async function resolveUtilityModelCapability(
  cfg: CoreConfig,
  modelSpec: string,
): Promise<ModelCapabilityInfo | null> {
  const config = cfg.models.capability;
  const capability = new ModelCapability({
    forceUnknownProviders: config?.forceUnknownProviders ?? ["openai-compatible"],
    overrides: config?.overrides ?? {},
  });
  const resolved = await capability.resolveResult(modelSpec);
  return resolved.match({ ok: (value) => value, err: () => null });
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeSearchQueries(
  input: string | readonly string[],
  max = MULTI_QUERY_MAX,
): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of Array.isArray(input) ? input : [input]) {
    const query = raw.trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= max) break;
  }
  return queries;
}

function buildFallbackQueryAboutness(queries: readonly string[]): ConversationThreadQueryAboutness {
  return {
    domains: [],
    situations: [],
    targets: [],
    entities: [],
    userWouldAskForThisAs: queries.slice(0, 8),
    intentSummary: queries.join("; "),
  };
}

function normalizeQueryAboutness(
  aboutness: ConversationThreadQueryAboutness,
): ConversationThreadQueryAboutness {
  const list = (values: readonly string[], maxItems: number, maxLength: number): string[] =>
    values
      .map((value) => value.trim().replace(/\s+/gu, " "))
      .filter((value) => value.length > 0)
      .map((value) => (value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value))
      .slice(0, maxItems);

  const intentSummary = aboutness.intentSummary.trim().replace(/\s+/gu, " ");
  return {
    domains: list(aboutness.domains, 8, 80),
    situations: list(aboutness.situations, 8, 120),
    targets: list(aboutness.targets, 8, 160),
    entities: list(aboutness.entities, 20, 80),
    userWouldAskForThisAs: list(aboutness.userWouldAskForThisAs, 8, 160),
    intentSummary:
      intentSummary.length > 300 ? intentSummary.slice(0, 300).trimEnd() : intentSummary,
  };
}

function normalizeAutoInjectQueryPlan(
  plan: ConversationThreadAutoInjectQueryPlan,
): ConversationThreadAutoInjectQueryPlan {
  return {
    searches: plan.searches
      .slice(0, AUTO_INJECT_SEARCH_MAX)
      .map((search) => ({
        queries: normalizeSearchQueries(search.queries, AUTO_INJECT_QUERIES_PER_SEARCH_MAX),
        aboutness: normalizeQueryAboutness(search.aboutness),
      }))
      .filter((search) => search.queries.length > 0),
  };
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;

  const idx = raw.indexOf("\n---");
  if (idx === -1) return raw;

  const after = raw.slice(idx + "\n---".length);
  return after.replace(/^\s+/u, "");
}

async function readPromptContextFile(
  promptDir: string,
  name: (typeof PROMPT_CONTEXT_FILES)[number],
): Promise<string | null> {
  const filePath = path.join(promptDir, name);
  const [read] = await Promise.allSettled([Bun.file(filePath).text()]);
  if (read.status === "rejected") {
    const code = errorCode(read.reason);
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR") {
      return null;
    }
    return signalConversationThreadDefect(read.reason);
  }
  const raw = read.value;
  const text = stripFrontmatter(raw).trim();
  return text.length > 0 ? text : null;
}

async function loadPromptContext(): Promise<ConversationThreadPromptContext> {
  await ensurePromptWorkspace();
  const promptDir = resolvePromptDir();
  const sections: string[] = [];

  for (const name of PROMPT_CONTEXT_FILES) {
    const content = await readPromptContextFile(promptDir, name);
    if (!content) continue;
    sections.push([`### ${name}`, content].join("\n"));
  }

  const text = sections.join("\n\n");
  return { hash: stableHash(text), text };
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
    aboutness: {
      domains: [],
      situations: [],
      complaintTargets: [],
      entities: participants,
      userWouldAskForThisAs: firstText ? [firstText] : [],
    },
    importance: "medium",
    importanceReasons: [],
  };
}

function resolveThreadBotMentionNames(cfg: CoreConfig): string[] {
  const botName = cfg.surface.discord.botName.trim();
  return botName.length > 0 ? [botName] : [];
}

function stripThreadContinueDirective(input: {
  text: string;
  botMentionNames: readonly string[];
}): string {
  return stripLeadingContinueDirective({
    text: input.text,
    botNames: input.botMentionNames,
  });
}

function isThreadBotMessage(message: ConversationThreadMessage, cfg: CoreConfig): boolean {
  const botName = cfg.surface.discord.botName.trim().toLowerCase();
  const userName = message.userName?.trim().toLowerCase();
  return botName.length > 0 && userName === botName;
}

function stripUserThreadContinueDirective(input: {
  message: ConversationThreadMessage;
  cfg: CoreConfig;
  botMentionNames: readonly string[];
}): string {
  if (isThreadBotMessage(input.message, input.cfg)) return input.message.text;
  return stripThreadContinueDirective({
    text: input.message.text,
    botMentionNames: input.botMentionNames,
  });
}

function importanceMultiplier(importance: ConversationThreadSearchHit["importance"]): number {
  if (importance === "high") return 1.06;
  if (importance === "low") return 0.96;
  return 1;
}

function applyImportanceNudge(hit: ConversationThreadSearchHit, baseScore: number): number {
  return baseScore * importanceMultiplier(hit.importance);
}

function coverageTokens(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 1 && !COVERAGE_STOP_WORDS.has(token));
  return new Set(tokens ?? []);
}

function phraseSimilarity(queryPhrase: string, candidatePhrase: string): number {
  const query = queryPhrase.trim().toLowerCase();
  const candidate = candidatePhrase.trim().toLowerCase();
  if (!query || !candidate) return 0;
  const queryTokens = coverageTokens(query);
  const candidateTokens = coverageTokens(candidate);
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) intersection += 1;
  }
  const overlap = intersection / Math.min(queryTokens.size, candidateTokens.size);
  if (candidate.includes(query) || query.includes(candidate)) return Math.max(0.85, overlap);
  return overlap;
}

function phraseSetCoverage(
  queryPhrases: readonly string[],
  candidatePhrases: readonly string[],
): number {
  let best = 0;
  for (const queryPhrase of queryPhrases) {
    for (const candidatePhrase of candidatePhrases) {
      best = Math.max(best, phraseSimilarity(queryPhrase, candidatePhrase));
      if (best >= 1) return 1;
    }
  }
  return best;
}

function hasSpecificQueryAboutness(aboutness: ConversationThreadQueryAboutness): boolean {
  return (
    aboutness.domains.length > 0 || aboutness.situations.length > 0 || aboutness.targets.length > 0
  );
}

function computeAboutnessCoverage(
  queryAboutness: ConversationThreadQueryAboutness,
  hit: ConversationThreadSearchHit,
): ConversationThreadAboutnessCoverage {
  const domainCoverage = phraseSetCoverage(queryAboutness.domains, [
    ...hit.aboutness.domains,
    ...hit.topics,
  ]);
  const targetCoverage = phraseSetCoverage(queryAboutness.targets, [
    ...hit.aboutness.complaintTargets,
    ...hit.aboutness.situations,
    ...hit.retrievalHints,
  ]);
  const situationCoverage = phraseSetCoverage(queryAboutness.situations, [
    ...hit.aboutness.situations,
    ...hit.retrievalHints,
    ...hit.topics,
  ]);
  const askPhraseCoverage = phraseSetCoverage(
    [...queryAboutness.userWouldAskForThisAs, queryAboutness.intentSummary],
    [...hit.aboutness.userWouldAskForThisAs, ...hit.retrievalHints, hit.title],
  );
  const entityCoverage = phraseSetCoverage(queryAboutness.entities, hit.aboutness.entities);
  const effectiveAskPhraseCoverage =
    domainCoverage > 0 || targetCoverage >= 0.5 ? askPhraseCoverage : 0;
  const highPrecisionCoverage =
    domainCoverage * 0.3 +
    targetCoverage * 0.3 +
    situationCoverage * 0.2 +
    effectiveAskPhraseCoverage * 0.2;

  const hasSpecificAboutness = hasSpecificQueryAboutness(queryAboutness);
  const hasDomainMismatch =
    queryAboutness.domains.length > 0 && domainCoverage === 0 && targetCoverage < 0.6;
  let matchReason: ConversationThreadAboutnessCoverage["matchReason"];
  if (!hasSpecificAboutness) {
    matchReason = "no-specific-aboutness";
  } else if (hasDomainMismatch) {
    matchReason = "domain-mismatch";
  } else if (highPrecisionCoverage < 0.25) {
    matchReason = "weak-coverage";
  } else if (highPrecisionCoverage < 0.45) {
    matchReason = "partial-coverage";
  } else if (highPrecisionCoverage < 0.65) {
    matchReason = "sufficient-coverage";
  } else {
    matchReason = "strong-coverage";
  }

  let multiplier: number;
  switch (matchReason) {
    case "no-specific-aboutness":
    case "sufficient-coverage":
      multiplier = 1;
      break;
    case "domain-mismatch":
      multiplier = DOMAIN_MISMATCH_COVERAGE_MULTIPLIER;
      break;
    case "weak-coverage":
      multiplier = WEAK_COVERAGE_MULTIPLIER;
      break;
    case "partial-coverage":
      multiplier = PARTIAL_COVERAGE_MULTIPLIER;
      break;
    case "strong-coverage":
      multiplier = 1.05 + Math.min(0.1, ((highPrecisionCoverage - 0.65) / 0.35) * 0.1);
      break;
  }

  return {
    preCoverageScore: hit.score,
    multiplier,
    highPrecisionCoverage,
    domainCoverage,
    targetCoverage,
    situationCoverage,
    askPhraseCoverage,
    entityCoverage,
    matched: !hasSpecificAboutness || (!hasDomainMismatch && highPrecisionCoverage >= 0.45),
    matchReason,
  };
}

function truncateErrorDetail(input: string): string {
  return input.length > 2000 ? `${input.slice(0, 2000)}...` : input;
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

function parseConversationThreadJson(
  text: string,
  message: string,
): ResultType<unknown, ConversationThreadSummaryParseError> {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(extractJsonObject(text)),
    catch: (cause) => cause,
  });
  return parsed.match<() => ResultType<unknown, ConversationThreadSummaryParseError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      if (!(error instanceof SyntaxError)) return signalConversationThreadDefect(error);
      return Result.err(
        new ConversationThreadSummaryParseError(message, truncateErrorDetail(text)),
      );
    },
  })();
}

function parseSummaryJson(
  text: string,
): ResultType<ConversationThreadSummaryInput, ConversationThreadSummaryParseError> {
  const parsed = parseConversationThreadJson(text, "summary JSON parse failed: malformed JSON");
  return parsed.andThen((value) => {
    const decoded = threadSummarySchema.safeParse(value);
    return decoded.success
      ? Result.ok(decoded.data)
      : Result.err(
          new ConversationThreadSummaryParseError(
            `summary JSON parse failed: ${decoded.error.message}`,
            truncateErrorDetail(text),
          ),
        );
  });
}

function parseQueryAboutnessJson(
  text: string,
): ResultType<ConversationThreadQueryAboutness, ConversationThreadSummaryParseError> {
  const parsed = parseConversationThreadJson(
    text,
    "query aboutness JSON parse failed: malformed JSON",
  );
  return parsed.andThen((value) => {
    const decoded = queryAboutnessSchema.safeParse(value);
    return decoded.success
      ? Result.ok(normalizeQueryAboutness(decoded.data))
      : Result.err(
          new ConversationThreadSummaryParseError(
            `query aboutness JSON parse failed: ${decoded.error.message}`,
            truncateErrorDetail(text),
          ),
        );
  });
}

function parseAutoInjectQueryPlanJson(
  text: string,
): ResultType<ConversationThreadAutoInjectQueryPlan, ConversationThreadSummaryParseError> {
  const parsed = parseConversationThreadJson(
    text,
    "auto-inject query plan JSON parse failed: malformed JSON",
  );
  return parsed.andThen((value) => {
    const decoded = autoInjectQueryPlanSchema.safeParse(value);
    return decoded.success
      ? Result.ok(normalizeAutoInjectQueryPlan(decoded.data))
      : Result.err(
          new ConversationThreadSummaryParseError(
            `auto-inject query plan JSON parse failed: ${decoded.error.message}`,
            truncateErrorDetail(text),
          ),
        );
  });
}

function resolveSummarizationModel(cfg: CoreConfig) {
  const model = cfg.conversation.thread.summarization.model.trim();
  if (model === "main" || model === "fast") {
    return resolveModelSlotResult(cfg, model);
  }
  return resolveModelRefResult(cfg, { model }, "conversation.thread.summarization.model");
}

export function selectAutoInjectPlannerModel(
  cfg: CoreConfig,
  content?: UserContent,
): { model: string; source: string } | null {
  const autoInject = cfg.conversation.thread.autoInject;
  const isTextOnly =
    content === undefined ||
    typeof content === "string" ||
    content.every((part) => part.type === "text");
  const textPlannerModel = isTextOnly ? autoInject.textPlannerModel?.trim() : undefined;
  if (textPlannerModel) {
    return {
      model: textPlannerModel,
      source: "conversation.thread.autoInject.textPlannerModel",
    };
  }

  const plannerModel = autoInject.plannerModel?.trim();
  return plannerModel
    ? {
        model: plannerModel,
        source: "conversation.thread.autoInject.plannerModel",
      }
    : null;
}

function resolveAutoInjectPlannerModel(cfg: CoreConfig, content?: UserContent) {
  const selected = selectAutoInjectPlannerModel(cfg, content);
  if (!selected) return resolveSummarizationModel(cfg);

  const { model } = selected;
  if (model === "main" || model === "fast") {
    return resolveModelSlotResult(cfg, model);
  }
  return resolveModelRefResult(cfg, { model }, selected.source);
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
  surface?: "discord" | "native";
  participantSurface?: "discord" | "native";
  sessionId?: string;
  participantId?: string;
  participantIdsAny?: readonly string[];
  beforeTs?: number;
  afterTs?: number;
}): ConversationThreadSearchFilters {
  return {
    surface: input.surface ?? (input.sessionId?.startsWith("native:") ? "native" : undefined),
    participantSurface: input.participantSurface,
    sessionId: input.sessionId?.trim() || undefined,
    participantId: input.participantId?.trim() || undefined,
    participantIdsAny: input.participantIdsAny,
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

function incrementEligibilityReason(
  counts: ConversationThreadEligibilityReasonCounts,
  reason: ConversationThreadSummarizationEligibilityReason,
): void {
  switch (reason) {
    case "forced":
      counts.forced = (counts.forced ?? 0) + 1;
      break;
    case "never-summarized":
      counts["never-summarized"] = (counts["never-summarized"] ?? 0) + 1;
      break;
    case "content-changed":
      counts["content-changed"] = (counts["content-changed"] ?? 0) + 1;
      break;
    case "summary-version":
      counts["summary-version"] = (counts["summary-version"] ?? 0) + 1;
      break;
    case "embedding-missing":
      counts["embedding-missing"] = (counts["embedding-missing"] ?? 0) + 1;
      break;
    case "embedding-outdated":
      counts["embedding-outdated"] = (counts["embedding-outdated"] ?? 0) + 1;
      break;
    case "embedding-version":
      counts["embedding-version"] = (counts["embedding-version"] ?? 0) + 1;
      break;
    case "embedding-model":
      counts["embedding-model"] = (counts["embedding-model"] ?? 0) + 1;
      break;
  }
}

function countSummarizationEligibility(
  items: readonly ConversationThreadSummarizationEligibility[],
): ConversationThreadEligibilityCounts {
  const counts: ConversationThreadEligibilityCounts = {
    summary: 0,
    embeddingOnly: 0,
    reasons: {},
  };
  for (const item of items) {
    if (item.summaryIsStale) counts.summary += 1;
    else if (item.embeddingIsStale) counts.embeddingOnly += 1;
    for (const reason of item.reasons) {
      incrementEligibilityReason(counts.reasons, reason);
    }
  }
  return counts;
}

export async function defaultSummarizer(input: {
  cfg: CoreConfig;
  jobId?: string;
  threadId: string;
  attempt?: number;
  previousSummary: ConversationThreadSummary | null;
  promptContext: ConversationThreadPromptContext | null;
  messages: readonly ConversationThreadSummaryMessage[];
  omittedMessages?: number;
  abortSignal?: AbortSignal;
}): Promise<ResultType<ConversationThreadSummaryInput, ConversationThreadGenerationError>> {
  const resolvedResult = resolveSummarizationModel(input.cfg);
  const resolvedError = resultErrorOrNull(resolvedResult);
  if (resolvedError) return Result.err(resolvedError);
  const resolved = selectResultValue(resolvedResult);
  const previous = input.previousSummary
    ? [
        `Previous title: ${input.previousSummary.title}`,
        `Previous brief: ${input.previousSummary.brief}`,
        `Previous topics: ${input.previousSummary.topics.join(", ") || "(none)"}`,
        `Previous retrieval hints: ${input.previousSummary.retrievalHints.join("; ") || "(none)"}`,
        `Previous aboutness domains: ${input.previousSummary.aboutness.domains.join("; ") || "(none)"}`,
        `Previous aboutness situations: ${input.previousSummary.aboutness.situations.join("; ") || "(none)"}`,
        `Previous complaint targets: ${input.previousSummary.aboutness.complaintTargets.join("; ") || "(none)"}`,
        `Previous aboutness entities: ${input.previousSummary.aboutness.entities.join("; ") || "(none)"}`,
        `Previous user-would-ask phrases: ${input.previousSummary.aboutness.userWouldAskForThisAs.join("; ") || "(none)"}`,
        `Previous importance: ${input.previousSummary.importance}`,
        `Previous importance reasons: ${input.previousSummary.importanceReasons.join("; ") || "(none)"}`,
      ].join("\n")
    : "(none)";

  const promptContextSection = input.promptContext
    ? [
        "## Background Context",
        "The following prompt files are background context only.",
        "Use them to resolve aliases, recurring projects, relationships, user vocabulary, and who the main agent/user are.",
        "Do not summarize these files.",
        "Do not add facts unless supported by the transcript.",
        "If background context conflicts with the transcript, trust the transcript.",
        "The main assistant/agent in these conversations may be referred to by names from the background context. Treat those as entities in the transcript, not as your own identity.",
        "",
        input.promptContext.text,
      ].join("\n")
    : null;
  const capability = await resolveUtilityModelCapability(input.cfg, resolved.spec);
  const messages = await buildThreadSummaryModelMessages({
    previous,
    promptContextSection,
    messages: input.messages,
    omittedMessages: input.omittedMessages ?? 0,
    capability,
  });

  const instructions = buildThreadSummaryInstructions();
  const onLanguageModelCallEnd = createThreadLanguageModelUsageLogger({
    operation: "summary",
    modelSpec: resolved.spec,
    jobId: input.jobId,
    threadId: input.threadId,
    attempt: input.attempt,
    messageCount: input.messages.length,
    omittedMessages: input.omittedMessages ?? 0,
  });

  if (resolved.provider === "codex") {
    const result = streamText({
      model: resolved.model,
      abortSignal: input.abortSignal,
      instructions,
      messages,
      reasoning: resolved.reasoning,
      providerOptions: resolved.providerOptions,
      onLanguageModelCallEnd,
    });

    const text = await captureConversationThreadGeneration(
      async () => await result.text,
      "summarize-thread",
      "Summary generation failed",
    );
    return text.andThen(parseSummaryJson);
  }

  const generated = await captureConversationThreadGeneration(
    () =>
      generateText({
        model: resolved.model,
        abortSignal: input.abortSignal,
        output: Output.object({ schema: threadSummarySchema }),
        instructions,
        messages,
        maxOutputTokens: 4096,
        reasoning: resolved.reasoning,
        providerOptions: resolved.providerOptions,
        onLanguageModelCallEnd,
      }),
    "summarize-thread",
    "Summary generation failed",
  );
  return generated.map((value) => value.output);
}

async function defaultQueryAboutnessSummarizer(input: {
  cfg: CoreConfig;
  queries: readonly string[];
}): Promise<ResultType<ConversationThreadQueryAboutness, ConversationThreadGenerationError>> {
  const resolvedResult = resolveSummarizationModel(input.cfg);
  const resolvedError = resultErrorOrNull(resolvedResult);
  if (resolvedError) return Result.err(resolvedError);
  const resolved = selectResultValue(resolvedResult);
  const messages = [
    {
      role: "user",
      content: [
        "Interpret these conversation-thread search query variants as one request.",
        "Do not answer the query. Return only positive aboutness evidence for what the user is trying to find.",
        "",
        "## Query variants",
        ...input.queries.map((query) => `- ${query}`),
      ].join("\n"),
    },
  ] satisfies ModelMessage[];
  const instructions = buildQueryAboutnessInstructions();
  const onLanguageModelCallEnd = createThreadLanguageModelUsageLogger({
    operation: "query_aboutness",
    modelSpec: resolved.spec,
    queryCount: input.queries.length,
  });

  if (resolved.provider === "codex") {
    const result = streamText({
      model: resolved.model,
      instructions,
      messages,
      reasoning: resolved.reasoning,
      providerOptions: resolved.providerOptions,
      onLanguageModelCallEnd,
    });
    const text = await captureConversationThreadGeneration(
      async () => await result.text,
      "capture-query-aboutness",
      "Query aboutness generation failed",
    );
    return text.andThen(parseQueryAboutnessJson);
  }

  const generated = await captureConversationThreadGeneration(
    () =>
      generateText({
        model: resolved.model,
        output: Output.object({ schema: queryAboutnessSchema }),
        instructions,
        messages,
        maxOutputTokens: 2048,
        reasoning: resolved.reasoning,
        providerOptions: resolved.providerOptions,
        onLanguageModelCallEnd,
      }),
    "capture-query-aboutness",
    "Query aboutness generation failed",
  );
  return generated.map((value) => normalizeQueryAboutness(value.output));
}

async function defaultAutoInjectQueryPlanner(input: {
  cfg: CoreConfig;
  text: string;
  content?: UserContent;
  autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
}): Promise<ResultType<ConversationThreadAutoInjectQueryPlan, ConversationThreadGenerationError>> {
  const resolvedResult = resolveAutoInjectPlannerModel(input.cfg, input.content);
  const resolvedError = resultErrorOrNull(resolvedResult);
  if (resolvedError) return Result.err(resolvedError);
  const resolved = selectResultValue(resolvedResult);
  const plannerPrefix = [
    "Create compact conversation-memory search queries for this new user message.",
    "Do not answer the message. Extract what prior conversation threads would be relevant context for responding.",
    "Return grouped search plans and positive aboutness evidence only.",
    "",
    "## User message",
  ].join("\n");
  const plannerContent = input.content ?? input.text;
  const plannerMessages = [
    {
      role: "user",
      content:
        typeof plannerContent === "string"
          ? `${plannerPrefix}\n${plannerContent}`
          : [{ type: "text" as const, text: plannerPrefix }, ...plannerContent],
    },
  ] satisfies ModelMessage[];
  const messages = filterUtilityModelAttachments(
    plannerMessages,
    await resolveUtilityModelCapability(input.cfg, resolved.spec),
  );
  const instructions = buildAutoInjectQueryPlanInstructions();
  const onLanguageModelCallEnd = createThreadLanguageModelUsageLogger({
    operation: "auto_inject_query_plan",
    modelSpec: resolved.spec,
    inputChars: input.text.length,
    autoInjectUsage: input.autoInjectUsage,
  });

  if (resolved.provider === "codex") {
    const result = streamText({
      model: resolved.model,
      instructions,
      messages,
      reasoning: resolved.reasoning,
      providerOptions: resolved.providerOptions,
      onLanguageModelCallEnd,
    });
    const text = await captureConversationThreadGeneration(
      async () => await result.text,
      "summarize-thread",
      "Query planning failed",
    );
    return text.andThen(parseAutoInjectQueryPlanJson);
  }

  const generated = await captureConversationThreadGeneration(
    () =>
      generateText({
        model: resolved.model,
        output: Output.object({ schema: autoInjectQueryPlanSchema }),
        instructions,
        messages,
        maxOutputTokens: 2048,
        reasoning: resolved.reasoning,
        providerOptions: resolved.providerOptions,
        onLanguageModelCallEnd,
      }),
    "summarize-thread",
    "Query planning failed",
  );
  return generated.map((value) => normalizeAutoInjectQueryPlan(value.output));
}

function buildQueryAboutnessInstructions(): string {
  return [
    "You interpret search requests for a conversation memory index.",
    "Return exactly one JSON object and nothing else.",
    "Capture all query variants together as one request; do not produce separate interpretations per variant.",
    "Use only positive aboutness evidence: what the user is trying to find, not what should be excluded.",
    'Shape: {"domains":["..."],"situations":["..."],"targets":["..."],"entities":["..."],"userWouldAskForThisAs":["..."],"intentSummary":"..."}',
    "",
    "- domains: broad real-world or project domains requested by the query, such as workplace, Discord social conflict, React debugging, architecture, deployment, finance, or career planning.",
    "- situations: concrete situations, actions, or events the user wants, such as fixing a websocket stream, reviewing a PR, clarifying a social misunderstanding, or planning a migration.",
    "- targets: objects of the request, complaint, frustration, or investigation, such as company process, coworker handoff, sqlite-vec indexing, a broken API, or Slack standup coordination.",
    "- entities: named people, projects, tools, files, APIs, organizations, commands, errors, or quoted phrases in the request.",
    "- userWouldAskForThisAs: natural query phrasings for this same request, preserving specific subject/domain/target words.",
    "- intentSummary: one sentence describing the user's intended subject of retrieval.",
    "Do not let entity names or emotional tone alone become the whole intent when the query has a concrete subject, domain, or target.",
    "Write primarily in English. Preserve exact names, code identifiers, error messages, and useful source-language phrases.",
  ].join("\n");
}

export function buildAutoInjectQueryPlanInstructions(): string {
  return [
    "You create retrieval queries for an automatic conversation-memory lookup.",
    "Return exactly one JSON object and nothing else.",
    'Shape: {"searches":[{"queries":["..."],"aboutness":{"domains":["..."],"situations":["..."],"targets":["..."],"entities":["..."],"userWouldAskForThisAs":["..."],"intentSummary":"..."}}]}',
    "",
    "The input is a newly received user message, possibly a long article or essay.",
    "Do not summarize the article for the final answer. Generate semantic search queries only when a prior conversation thread would materially help answer the user's current request.",
    'Return {"searches":[]} when retrieval would not help. Abstain for casual reactions, transient coordination, reply-only context, attachment-only messages without a clear durable subject, and incidental mentions of a person, product, or topic.',
    "Use one search for one substantive user intent. Use 2-3 searches only when the user explicitly asks about distinct durable intents and each could retrieve independently useful history.",
    "Do not create separate searches from examples, links, quoted text, article sections, or background clauses unless the user asks about them.",
    "Order multiple searches by expected usefulness.",
    "Each search must contain 1-3 non-empty query variants/facets for the same intent. Prefer 1 query unless aliases, exact entities, or meaningfully different wording improve recall.",
    "Do not split near-duplicate phrasings into separate searches; keep them as query variants inside one search.",
    "Queries should name the durable subject, task, decision, complaint target, project, technology, entities, or situation.",
    "Avoid copying long passages. Preserve exact names, code identifiers, errors, and source-language phrases only when central.",
    "Use only positive aboutness evidence: what relevant prior threads would be about, not what should be excluded.",
    "Each search's aboutness object describes only that search intent and follows the same meaning as conversation-thread search query aboutness.",
    "Write primarily in English.",
  ].join("\n");
}

export function buildThreadSummaryInstructions(): string {
  return [
    "You create compact, stable thread summaries for a conversation memory index.",
    "",
    "# Task",
    "Summarize the conversation thread in user's input for future semantic retrieval.",
    "Keep stable wording when the previous summary is still accurate; avoid unnecessary drift after small updates.",
    "",
    "## Format",
    "Return exactly one JSON object and nothing else.",
    "",
    'Shape: {"title":"...","brief":"...","topics":["..."],"retrievalHints":["..."],"aboutness":{"domains":["..."],"situations":["..."],"complaintTargets":["..."],"entities":["..."],"userWouldAskForThisAs":["..."]},"importance":"low|medium|high","importanceReasons":["..."]}',
    "",
    "- title: concise thread title, under 120 characters.",
    "- brief: compact summary, under 1024 characters.",
    "- topics: short descriptive subject phrases, not canonical tags.",
    "- retrievalHints: short search-query-like phrases a future user might type from memory to find this thread.",
    "- aboutness: positive-only retrieval evidence for what the thread is actually about.",
    "- aboutness.domains: broad real-world or project domains.",
    "- aboutness.situations: concrete situations, actions, or events in the thread.",
    "- aboutness.complaintTargets: what frustration, venting, or criticism is directed at when present. Use an empty array when the thread is not a complaint or vent.",
    "- aboutness.entities: important people, projects, tools, organizations, files, commands, errors, or named concepts.",
    "- aboutness.userWouldAskForThisAs: natural future-search phrases someone might type to find this kind of prior thread.",
    "- importance: low, medium, or high, based on durable future value.",
    "- importanceReasons: brief reasons explaining the rating for debugging.",
    "",
    "Write title, brief, topics, retrieval hints, and importance reasons primarily in English, regardless of the thread language.",
    "Preserve exact names, code identifiers, product names, error messages, quoted phrases, and useful source-language wording when they improve retrieval.",
    "Never use first-person pronouns like I, me, my, mine, we, us, our, or ours in title, topics, retrievalHints, aboutness, or importanceReasons; use the relevant person's name, project name, or stable role instead.",
    "Avoid ambiguous pronouns in retrievalHints and aboutness.userWouldAskForThisAs. Each phrase should stand alone without needing the reader to know who I/me/they/he/she refers to.",
    "Do not create negative aboutness fields or list what the thread is not about. Only encode positive evidence from the transcript and background context.",
    "",
    "## Retrieval hints",
    "- Retrieval hints are alternate semantic access paths, not tags or summaries.",
    "- Use 4-8 hints for substantive threads; use fewer for shallow threads.",
    "- Each hint should usually be 2-12 words.",
    "- Prefer natural user-intent phrases someone might actually type later, not dense mini-summaries or implementation notes.",
    "- Cover multiple abstraction levels: broad remembered wording, moderate subject/object wording, and exact names only when they are likely search handles.",
    "- Keep each hint focused on one access path. Do not pack every important detail into every hint.",
    "- Prefer the wording a person would remember later over the most precise wording present in the transcript.",
    "- Drop incidental qualifiers, counts, durations, severities, versions, and exact identifiers unless they are central to why someone would search for the thread.",
    "- Do not solve broad lookup with fixed domain-specific synonym lists. Infer the right abstraction level from the transcript.",
    "- Avoid generic standalone hints like help, code, app, bug, AI, question, discussion, or notes.",
    "- Avoid near-duplicates; each hint should add a meaningfully different retrieval path.",
    "- Do not invent context, labels, emotions, tools, or technologies not present or strongly implied.",
    "- When updating an existing summary, keep accurate previous hints stable; only change hints that are stale, misleading, redundant, or clearly improved by new transcript content.",
    "",
    "## Aboutness",
    "- Aboutness fields should capture the intended subject, domain, and object of discussion, not just emotional tone.",
    "- For emotionally similar threads, distinguish what the emotion is about without turning the phrase into a full summary.",
    "- userWouldAskForThisAs should contain 3-8 realistic user queries for substantive threads, using the same broad-to-specific abstraction ladder as retrievalHints.",
    "- complaintTargets should be specific and positive-only, but avoid encoding incidental details as targets.",
    "- Do not invent domains, entities, situations, or complaint targets not present or strongly implied by the transcript.",
    "",
    "## Importance",
    "- Use high for durable decisions, architecture, implementation plans, incident/root-cause analysis, reusable project knowledge, or important personal/career context.",
    "- Use medium for useful but limited troubleshooting, explanations, comparisons, planning, or non-critical project context.",
    "- Use low for casual chat, shallow reactions, external-link-only discussion, transient coordination, or low-reuse content.",
  ].join("\n");
}

export class ConversationThreadService {
  private readonly logger = threadLogger;

  constructor(
    private readonly params: {
      store: ConversationThreadStore;
      getConfig: () => Promise<CoreConfig>;
      summarizer?: ConversationThreadSummarizer;
      queryAboutnessSummarizer?: ConversationThreadQueryAboutnessSummarizer;
      autoInjectQueryPlanner?: ConversationThreadAutoInjectQueryPlanner;
      attachmentHydrator?: ConversationThreadAttachmentHydrator;
      getEmbeddingAdapter?: ConversationThreadEmbeddingAdapterResolver;
      entityMapper?: Pick<EntityMapper, "normalizeIncomingText">;
    },
  ) {}

  async search(input: {
    surface?: "discord" | "native";
    participantSurface?: "discord" | "native";
    query: string | readonly string[];
    limit?: number;
    sessionId?: string;
    participantId?: string;
    participantIdsAny?: readonly string[];
    beforeTs?: number;
    afterTs?: number;
    mode?: "hybrid" | "semantic" | "lexical";
    minScore?: number;
    verbose?: boolean;
    queryAboutness?: ConversationThreadQueryAboutness;
    autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
  }): Promise<ResultType<ConversationThreadSearchResult, ConversationThreadSearchError>> {
    const cfg = await this.params.getConfig();
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)));
    const minScore = Math.max(0, input.minScore ?? DEFAULT_SEARCH_MIN_SCORE);
    const mode = input.mode ?? "hybrid";
    const queries = normalizeSearchQueries(input.query);
    if (queries.length === 0) {
      return Result.err(
        new ConversationThreadInvalidInput({
          field: "query",
          message: "conversation thread search query is required",
        }),
      );
    }
    const embeddingAdapter = this.params.getEmbeddingAdapter
      ? await this.params.getEmbeddingAdapter()
      : null;
    const filters = buildSearchFilters(input);
    const recallLimit =
      mode === "lexical" ? limit : Math.min(50, Math.max(limit * COVERAGE_RECALL_MULTIPLIER, 10));
    const usage = createThreadEmbeddingUsageAccumulator("search_query", input.autoInjectUsage);
    const recallHits = await this.searchHitsForQueries({
      queries,
      limit: recallLimit,
      mode,
      cfg,
      embeddingAdapter,
      filters,
      allowlist: buildSearchAllowlist(cfg),
      onEmbeddingUsage: usage.record,
    });
    const recalledResult = recallHits.mapError((error) => {
      usage.log({ status: "failed", mode, queryCount: queries.length });
      return error;
    });
    const recallError = resultErrorOrNull(recalledResult);
    if (recallError) return Result.err(recallError);
    const recalled = selectResultValue(recalledResult);
    const { aboutness: queryAboutness, error: queryAboutnessError } = input.queryAboutness
      ? { aboutness: normalizeQueryAboutness(input.queryAboutness), error: undefined }
      : await this.captureQueryAboutness({
          queries,
          cfg,
          mode,
          candidateCount: recalled.length,
        });
    this.params.store.refreshNativeThreads();
    const currentHits = recalled.filter(
      (hit) =>
        hit.kind !== "native_thread" ||
        this.params.store.getThread(hit.threadId)?.summary_input_hash === hit.sourceRevision,
    );
    const hits = this.applyAboutnessCoverage(currentHits, queryAboutness)
      .filter((hit) => hit.score >= minScore)
      .slice(0, limit);
    const result = {
      meta: {
        query: queries[0]!,
        ...(queries.length > 1 ? { queries } : {}),
        limit,
        mode,
        minScore,
        count: hits.length,
        vectorAvailable: this.params.store.isVectorSearchAvailable() && !!embeddingAdapter,
        vectorError: this.params.store.getVectorLoadError() ?? undefined,
        ...(input.verbose && queryAboutness ? { queryAboutness } : {}),
        ...(input.verbose && queryAboutnessError ? { queryAboutnessError } : {}),
      },
      results: hits.map((hit) => this.formatSearchHit(hit, input.verbose ?? false)),
    } satisfies ConversationThreadSearchResult;
    usage.log({ status: "completed", mode, queryCount: queries.length });
    return Result.ok(result);
  }

  async planAutoInjectSearch(input: {
    text: string;
    content?: UserContent;
    autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
  }): Promise<
    ResultType<
      ConversationThreadAutoInjectQueryPlan,
      ConversationThreadInvalidInput | ConversationThreadGenerationError
    >
  > {
    const text = input.text.trim();
    const hasMultipartContent = Array.isArray(input.content) && input.content.length > 0;
    if (!text && !hasMultipartContent) {
      return Result.err(
        new ConversationThreadInvalidInput({
          field: "text",
          message: "auto-inject query planning text is required",
        }),
      );
    }
    const cfg = await this.params.getConfig();
    const planner = this.params.autoInjectQueryPlanner;
    const planned = planner
      ? await captureConversationThreadGeneration(
          () => planner({ cfg, text, content: input.content }),
          "summarize-thread",
          "Query planning failed",
        )
      : await defaultAutoInjectQueryPlanner({
          cfg,
          text,
          content: input.content,
          autoInjectUsage: input.autoInjectUsage,
        });
    return planned.map(normalizeAutoInjectQueryPlan);
  }

  async shortlistAutoInjectCandidates(input: {
    text: string;
    limit: number;
    semanticFallback: boolean;
    participantSurface?: "discord" | "native";
    participantIdsAny?: readonly string[];
    excludeThreadIds?: readonly string[];
    autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
  }): Promise<ResultType<ConversationThreadAutoInjectShortlist, PersistedDataError>> {
    const text = input.text.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/giu, " ").trim();
    if (!text) return Result.ok({ source: "none", results: [] });
    const cfg = await this.params.getConfig();
    const filters = buildSearchFilters(input);
    const allowlist = buildSearchAllowlist(cfg);
    const semanticLimit = Math.max(1, Math.floor(input.limit / 2));
    const semantic = input.semanticFallback
      ? this.searchAutoInjectSemanticFallback({
          ...input,
          text,
          limit: semanticLimit,
          filters,
          allowlist,
        })
      : Promise.resolve(Result.ok<ConversationThreadSearchHit[]>([]));
    // Over-fetch so stale native summaries dropped by the filter do not take candidate slots.
    const lexical = this.params.store
      .searchAnyTerm({
        text,
        limit: input.limit * 2,
        filters,
        allowlist,
        excludeThreadIds: input.excludeThreadIds,
      })
      .map((hits) => this.filterCurrentAutoInjectHits(cfg, hits).slice(0, input.limit));
    const semanticResult = await semantic;
    const lexicalError = resultErrorOrNull(lexical);
    if (lexicalError) return Result.err(lexicalError);
    const semanticError = resultErrorOrNull(semanticResult);
    if (semanticError) return Result.err(semanticError);
    const lexicalHits = selectResultValue(lexical);
    const semanticHits = this.filterCurrentAutoInjectHits(cfg, selectResultValue(semanticResult));
    if (semanticHits.length === 0) {
      if (lexicalHits.length === 0) return Result.ok({ source: "none", results: [] });
      return Result.ok(this.formatShortlist("lexical", lexicalHits));
    }
    if (lexicalHits.length === 0) return Result.ok(this.formatShortlist("semantic", semanticHits));
    const merged = new Map<string, ConversationThreadSearchHit>();
    for (const hit of [
      ...lexicalHits.slice(0, Math.max(1, input.limit - semanticLimit)),
      ...semanticHits,
    ]) {
      if (!merged.has(hit.threadId)) merged.set(hit.threadId, hit);
    }
    return Result.ok(this.formatShortlist("hybrid", [...merged.values()].slice(0, input.limit)));
  }

  private async searchAutoInjectSemanticFallback(input: {
    text: string;
    limit: number;
    excludeThreadIds?: readonly string[];
    filters: ConversationThreadSearchFilters;
    allowlist: ConversationThreadSearchAllowlist;
    autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
  }): Promise<ResultType<ConversationThreadSearchHit[], PersistedDataError>> {
    const adapter = this.params.getEmbeddingAdapter
      ? await this.params.getEmbeddingAdapter()
      : null;
    if (!adapter || !this.params.store.isVectorSearchAvailable()) return Result.ok([]);

    const usage = createThreadEmbeddingUsageAccumulator("search_query", input.autoInjectUsage);
    const embedded = await captureConversationThreadGeneration(
      () => adapter.embed({ text: input.text, facet: "query", onUsage: usage.record }),
      "search-embedding",
      "Search embedding failed",
    );
    const embeddingError = resultErrorOrNull(embedded);
    if (embeddingError) {
      usage.log({ status: "failed", mode: "semantic", queryCount: 1 });
      this.logger.warn("auto-inject semantic shortlist failed; continuing without candidates", {
        ...formatTaggedErrorForLog(embeddingError),
      });
      return Result.ok([]);
    }
    usage.log({ status: "completed", mode: "semantic", queryCount: 1 });

    const excluded = new Set(input.excludeThreadIds ?? []);
    const queryEmbedding = selectResultValue(embedded);
    return this.params.store
      .searchSemantic({
        embedding: queryEmbedding,
        modelId: adapter.modelId,
        dimensions: queryEmbedding.length,
        limit: input.limit + excluded.size,
        filters: input.filters,
        allowlist: input.allowlist,
      })
      .map((hits) => hits.filter((hit) => !excluded.has(hit.threadId)).slice(0, input.limit));
  }

  private filterCurrentAutoInjectHits(
    cfg: CoreConfig,
    hits: readonly ConversationThreadSearchHit[],
  ): ConversationThreadSearchHit[] {
    return hits.filter((hit) => {
      if (hit.kind === "native_thread") {
        return this.params.store.getThread(hit.threadId)?.summary_input_hash === hit.sourceRevision;
      }
      return shouldAllowDiscordThread(cfg, {
        channelId: hit.channelId,
        parentChannelId: hit.parentChannelId,
        guildId: hit.guildId,
      });
    });
  }

  private formatShortlist(
    source: "lexical" | "semantic" | "hybrid",
    hits: readonly ConversationThreadSearchHit[],
  ): ConversationThreadAutoInjectShortlist {
    return { source, results: hits.map((hit) => this.formatSearchHit(hit, true)) };
  }

  async getAutoInjectRankingCorpusDocuments(): Promise<readonly string[]> {
    const cfg = await this.params.getConfig();
    return this.params.store.listAutoInjectRankingDocuments(buildSearchAllowlist(cfg));
  }

  async read(input: {
    threadId: string;
    offset?: number;
    limit?: number;
  }): Promise<ResultType<ConversationThreadReadOutput, ConversationThreadReadError>> {
    const cfg = await this.params.getConfig();
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? DEFAULT_READ_LIMIT)));
    this.params.store.refreshNativeThreads();
    const result = this.params.store.readThread(input.threadId, offset, limit);
    return result.andThen((value) => {
      if (!value) {
        return Result.err(
          new ConversationThreadNotFound({
            threadId: input.threadId,
            message: `conversation thread not found: ${input.threadId}`,
          }),
        );
      }
      if (
        value.thread.kind !== "native_thread" &&
        !shouldAllowDiscordThread(cfg, {
          channelId: value.thread.channel_id,
          parentChannelId: value.thread.parent_channel_id,
          guildId: value.thread.guild_id,
        })
      ) {
        return Result.err(
          new ConversationThreadAccessDenied({
            threadId: input.threadId,
            message: `Not allowed: conversation thread '${input.threadId}'`,
          }),
        );
      }

      const nextOffset = offset + value.messages.length;
      const hasMore = nextOffset < value.totalMessages;
      const botMentionNames = resolveThreadBotMentionNames(cfg);
      return Result.ok({
        thread: this.formatMetadataThread({
          thread: value.thread,
          summary: value.summary,
          messageCount: value.totalMessages,
        }),
        page: {
          offset,
          limit,
          total: value.totalMessages,
          nextOffset: hasMore ? nextOffset : undefined,
          hasMore,
        },
        messages: value.messages.map((message) => ({
          ordinal: message.ordinal,
          messageId: message.messageId,
          userId: message.userId,
          userName: message.userName,
          time: formatTime(message.ts),
          content:
            value.thread.kind === "native_thread"
              ? message.text
              : stripUserThreadContinueDirective({
                  message,
                  cfg,
                  botMentionNames,
                }),
        })),
      });
    });
  }

  async metadata(input: {
    threadIds: readonly string[];
  }): Promise<ResultType<ConversationThreadMetadataOutput, ConversationThreadMetadataError>> {
    const cfg = await this.params.getConfig();
    this.params.store.refreshNativeThreads();
    const threadIds = normalizeMetadataThreadIds(input);
    if (threadIds.length === 0) {
      return Result.err(
        new ConversationThreadInvalidInput({
          field: "threadIds",
          message: "conversation thread metadata requires threadIds",
        }),
      );
    }
    const threads: ConversationThreadMetadataOutput["threads"] = [];
    const missing: string[] = [];

    for (const threadId of threadIds) {
      const thread = this.params.store.getThread(threadId);
      if (!thread) {
        missing.push(threadId);
        continue;
      }

      if (
        thread.kind !== "native_thread" &&
        !shouldAllowDiscordThread(cfg, {
          channelId: thread.channel_id,
          parentChannelId: thread.parent_channel_id,
          guildId: thread.guild_id,
        })
      ) {
        return Result.err(
          new ConversationThreadAccessDenied({
            threadId,
            message: `Not allowed: conversation thread '${threadId}'`,
          }),
        );
      }

      const summaryResult = this.params.store.getSummary(threadId);
      const summaryError = resultErrorOrNull(summaryResult);
      if (summaryError) return Result.err(summaryError);
      const summary = selectResultValue(summaryResult);
      threads.push(
        this.formatMetadataThread({
          thread,
          summary,
          messageCount: this.params.store.countThreadMessages(threadId),
        }),
      );
    }

    return Result.ok({ threads, missing });
  }

  async runSummarization(
    input: ConversationThreadRunSummarizationInput = {},
  ): Promise<ConversationThreadRunSummarizationResult> {
    this.params.store.refreshNativeThreads();
    const jobId = input.jobId;
    const cfg = await this.params.getConfig();
    const refreshed = { channels: 0, threads: 0, messages: 0 };
    const scope = {
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
    };

    if (input.clear === true && input.dryRun === true) {
      const clearTargets = this.params.store.listThreadsForSummarizationClear(scope);
      this.logger.debug("thread summarization clear dry run completed", {
        jobId,
        clearTargets: clearTargets.length,
        threadId: input.threadId,
        beforeTs: input.beforeTs,
        afterTs: input.afterTs,
      });
      return {
        dryRun: true,
        refreshed,
        eligible: clearTargets.length,
        eligibleTotal: clearTargets.length,
        eligibility: { summary: clearTargets.length, embeddingOnly: 0, reasons: {} },
        cleared: 0,
        summarized: 0,
        failed: 0,
        failures: [],
        threadIds: clearTargets.map((thread) => thread.thread_id),
      };
    }

    const clearedThreadIds =
      input.clear === true ? this.params.store.clearSummarizationState(scope) : [];
    if (input.clear === true) {
      this.logger.debug("thread summarization state cleared", {
        jobId,
        cleared: clearedThreadIds.length,
        threadId: input.threadId,
        beforeTs: input.beforeTs,
        afterTs: input.afterTs,
      });
    }

    const embeddingAdapter = this.params.getEmbeddingAdapter
      ? await this.params.getEmbeddingAdapter()
      : null;
    const promptContext = cfg.conversation.thread.summarization.includePromptContext
      ? await loadPromptContext()
      : null;
    if (promptContext) {
      this.logger.debug("thread summarization prompt context loaded", {
        jobId,
        hash: promptContext.hash,
      });
    }

    const allEligible = this.params.store.listEligibleForSummarization({
      now: input.now,
      quietMs: SUMMARY_QUIET_MS,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
      includeEmbeddingStale: !!embeddingAdapter && this.params.store.isVectorSearchAvailable(),
      embeddingModelId: embeddingAdapter?.modelId,
      force: input.force === true,
    });
    const limit =
      input.limit === undefined
        ? undefined
        : Math.min(10_000, Math.max(1, Math.floor(input.limit)));
    const eligible = limit === undefined ? allEligible : allEligible.slice(0, limit);
    const eligibility = countSummarizationEligibility(allEligible);
    this.logger.debug("thread summarization eligibility completed", {
      jobId,
      eligible: eligible.length,
      eligibleTotal: allEligible.length,
      eligibility,
      limit,
      trigger: input.trigger ?? "manual",
      dryRun: input.dryRun === true,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
      force: input.force === true,
      clear: input.clear === true,
      promptContext: !!promptContext,
    });

    const result: ConversationThreadRunSummarizationResult = {
      dryRun: input.dryRun ?? false,
      refreshed,
      eligible: eligible.length,
      eligibleTotal: allEligible.length,
      eligibility,
      cleared: clearedThreadIds.length,
      summarized: 0,
      failed: 0,
      failures: [],
      threadIds: eligible.map((item) => item.thread.thread_id),
    };

    if (input.dryRun) {
      this.logger.debug("thread summarization dry run completed", {
        jobId,
        eligible: result.eligible,
        eligibleTotal: result.eligibleTotal,
      });
      return result;
    }

    if (eligible.length === 0) {
      this.logger.debug("thread summarization skipped: no eligible threads", {
        jobId,
        force: input.force === true,
        clear: input.clear === true,
      });
      return result;
    }

    const summarize = this.params.summarizer;
    const concurrency = clampSummarizationConcurrency(
      cfg.conversation.thread.summarization.concurrency,
    );
    this.logger.info("thread summarization processing started", {
      jobId,
      eligible: eligible.length,
      eligibleTotal: allEligible.length,
      eligibility,
      concurrency,
      force: input.force === true,
      trigger: input.trigger ?? "manual",
    });

    let nextIndex = 0;
    const processThread = async (item: (typeof eligible)[number]): Promise<void> => {
      const thread = item.thread;
      const threadStartedAt = Date.now();
      const attemptedAt = input.now ?? Date.now();
      const recordFailure = (message: string): void => {
        result.failed += 1;
        result.failures.push({ threadId: thread.thread_id, error: message });
        const failureState = captureConversationThreadSqliteOperation(
          () => {
            const failureAt = input.now ?? Date.now();
            this.params.store.markMaintenanceFailure({
              threadId: thread.thread_id,
              summaryInputHash: thread.summary_input_hash,
              attemptedAt,
              retryAfter: failureAt + SUMMARY_FAILURE_RETRY_MS,
            });
          },
          "persist-summary-failure",
          "Summary failure backoff persistence failed",
        );
        failureState.match({
          ok: () => undefined,
          err: (error) =>
            this.logger.warn("thread summarization failure backoff could not be persisted", {
              jobId,
              threadId: thread.thread_id,
              ...formatTaggedErrorForLog(error),
            }),
        });
      };
      const processed = await captureConversationThreadGeneration(
        async () => {
          const attemptRecorded = this.params.store.markMaintenanceAttempt({
            threadId: thread.thread_id,
            summaryInputHash: thread.summary_input_hash,
            attemptedAt,
          });
          if (!attemptRecorded) {
            this.logger.debug("thread summarization skipped after concurrent update", {
              jobId,
              threadId: thread.thread_id,
            });
            return;
          }
          this.logger.debug("thread summarization thread started", {
            jobId,
            threadId: thread.thread_id,
            kind: thread.kind,
            updatedAt: thread.updated_at,
            lastSummarizedAt: thread.last_summarized_at,
            summaryVersion: thread.summary_version,
            embeddingVersion: thread.embedding_version,
            reasons: item.reasons,
          });
          const summaryRead = readSummaryMessages(this.params.store, thread.thread_id);
          if (summaryRead.totalMessages === 0) {
            this.logger.debug("thread summarization deleting empty thread", {
              jobId,
              threadId: thread.thread_id,
            });
            this.params.store.deleteThread(thread.thread_id);
            return;
          }
          const summaryIsStale = item.summaryIsStale;
          const previousSummary = this.params.store.getSummary(thread.thread_id);
          const previousSummaryError = previousSummary.match({
            ok: () => null,
            err: (error) => error,
          });
          if (previousSummaryError) {
            recordFailure(previousSummaryError.message);
            return;
          }
          const previousSummaryValue = previousSummary.match({
            ok: (value) => value,
            err: () => null,
          });
          if (summaryRead.omittedMessages > 0) {
            this.logger.debug("thread summarization transcript truncated", {
              jobId,
              threadId: thread.thread_id,
              totalMessages: summaryRead.totalMessages,
              includedMessages: summaryRead.messages.length,
              omittedMessages: summaryRead.omittedMessages,
            });
          }
          const summaryWriteResult = summaryIsStale
            ? await (async (): Promise<
                ResultType<
                  ConversationThreadSummaryWriteResult | null,
                  ConversationThreadGenerationError | ConversationThreadSqliteDriverFailure
                >
              > => {
                const hydrated = await this.hydrateMessagesForSummarization(summaryRead.messages);
                const hydrationError = hydrated.match({ ok: () => null, err: (error) => error });
                if (hydrationError) return Result.err(hydrationError);
                const hydratedMessages = hydrated.match({ ok: (value) => value, err: () => [] });
                const summaryMessages =
                  thread.kind === "native_thread"
                    ? hydratedMessages
                    : this.normalizeMessagesForSummarization(hydratedMessages, cfg);
                this.logger.debug("thread summary generation started", {
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
                  promptContext,
                  previousSummary: previousSummaryValue,
                  messages: summaryMessages,
                  omittedMessages: summaryRead.omittedMessages,
                });
                return summary.andThen((value) =>
                  this.params.store.upsertSummary(
                    thread.thread_id,
                    thread.summary_input_hash ?? "",
                    value ?? buildFallbackSummary(summaryMessages),
                    promptContext?.hash ?? null,
                    { ifCurrent: true },
                  ),
                );
              })()
            : Result.ok({
                facets: this.params.store.listFacets(thread.thread_id),
                embeddingInputHash:
                  this.params.store.computeEmbeddingInputHash(thread.thread_id) ?? "",
              });
          const summaryWriteError = summaryWriteResult.match({
            ok: () => null,
            err: (error) => error,
          });
          if (summaryWriteError) {
            recordFailure(summaryWriteError.message);
            return;
          }
          const writtenSummary = summaryWriteResult.match({
            ok: (value) => value,
            err: () => null,
          });
          if (!writtenSummary) {
            this.logger.debug("thread summary generation discarded after concurrent update", {
              jobId,
              threadId: thread.thread_id,
            });
            return;
          }
          if (summaryIsStale) {
            this.logger.debug("thread summary generation completed", {
              jobId,
              threadId: thread.thread_id,
            });
          }

          const embedded = await this.tryEmbedThread({
            jobId,
            threadId: thread.thread_id,
            embeddingAdapter,
            embeddingInputHash: writtenSummary.embeddingInputHash,
            facets: writtenSummary.facets,
          });
          const embeddingFailed = embedded.match({
            ok: () => false,
            err: (error) => {
              recordFailure(error.message);
              return true;
            },
          });
          if (embeddingFailed) return;
          this.params.store.clearMaintenanceFailure({
            threadId: thread.thread_id,
            summaryInputHash: thread.summary_input_hash,
            attemptedAt,
          });
          if (summaryIsStale) result.summarized += 1;
          this.logger.debug("thread summarization thread completed", {
            jobId,
            threadId: thread.thread_id,
            durationMs: Date.now() - threadStartedAt,
            summarized: summaryIsStale,
          });
        },
        "summarize-thread",
        "Thread summarization failed",
      );
      processed.match({
        ok: () => undefined,
        err: (e) => {
          const aiError = extractAiErrorLogDetails(e);
          const message = e instanceof Error ? e.message : String(e);
          const failureMessage = aiError?.providerMessage
            ? `${message}: ${aiError.providerMessage}`
            : message;
          this.logger.error("thread summarization failed", {
            jobId,
            threadId: thread.thread_id,
            ...formatTaggedErrorForLog(
              conversationThreadOperationFailed(
                "summarize-thread",
                e instanceof Error ? e.message : String(e),
              ),
            ),
          });
          recordFailure(failureMessage);
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

          if (isSqliteBusyError(e)) {
            this.logger.warn("thread summarization continuing after sqlite busy failure", {
              jobId,
              threadId: thread.thread_id,
              eligible: result.eligible,
              summarized: result.summarized,
              failed: result.failed,
              ...formatTaggedErrorForLog(
                conversationThreadOperationFailed(
                  "summarize-thread",
                  e instanceof Error ? e.message : String(e),
                ),
              ),
            });
            return;
          }

          this.logger.error("thread summarization continuing after hard failure", {
            jobId,
            threadId: thread.thread_id,
            eligible: result.eligible,
            summarized: result.summarized,
            failed: result.failed,
          });
          return;
        },
      });
    };

    const workerCount = Math.min(concurrency, eligible.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const item = eligible[nextIndex];
        nextIndex += 1;
        if (!item) return;
        await processThread(item);
      }
    });
    await Promise.all(workers);

    this.logger.info("thread summarization run completed", {
      jobId,
      eligible: result.eligible,
      eligibleTotal: result.eligibleTotal,
      summarized: result.summarized,
      failed: result.failed,
      concurrency,
    });
    return result;
  }

  private async summarizeWithParseRetries(input: {
    jobId?: string;
    threadId: string;
    summarize?: ConversationThreadSummarizer;
    cfg: CoreConfig;
    promptContext: ConversationThreadPromptContext | null;
    previousSummary: ConversationThreadSummary | null;
    messages: readonly ConversationThreadSummaryMessage[];
    omittedMessages: number;
  }): Promise<ResultType<ConversationThreadSummaryInput, ConversationThreadGenerationError>> {
    let lastError: ConversationThreadSummaryParseError | null = null;
    for (let attempt = 1; attempt <= SUMMARY_PARSE_MAX_ATTEMPTS; attempt++) {
      const generationInput = {
        cfg: input.cfg,
        jobId: input.jobId,
        threadId: input.threadId,
        attempt,
        promptContext: input.promptContext,
        previousSummary: input.previousSummary,
        messages: input.messages,
        omittedMessages: input.omittedMessages,
      };
      const summarize = input.summarize;
      const summary = summarize
        ? await captureConversationThreadGeneration(
            () => summarize(generationInput),
            "summarize-thread",
            "Summary generation failed",
          )
        : await defaultSummarizer(generationInput);
      const completed = summary.match<
        () => ResultType<ConversationThreadSummaryInput, ConversationThreadGenerationError> | null
      >({
        ok: (value) => () => Result.ok(value),
        err: (error) => () => {
          if (!(error instanceof ConversationThreadSummaryParseError)) {
            if (ConversationThreadOperationFailed.is(error)) return Result.err(error);
            if (ModelResolutionFailed.is(error)) return Result.err(error);
            return Result.err(
              conversationThreadOperationFailed("summarize-thread", "Summary generation failed"),
            );
          }
          lastError = error;
          this.logger.warn("thread summary parse failed", {
            jobId: input.jobId,
            threadId: input.threadId,
            attempt,
            maxAttempts: SUMMARY_PARSE_MAX_ATTEMPTS,
            ...formatTaggedErrorForLog(error),
          });
          return null;
        },
      })();
      if (completed) return completed;
    }

    return Result.err(
      lastError ?? new ConversationThreadSummaryParseError("summary JSON parse failed"),
    );
  }

  private normalizeMessagesForSummarization(
    messages: readonly ConversationThreadSummaryMessage[],
    cfg: CoreConfig,
  ): ConversationThreadSummaryMessage[] {
    const mapper = this.params.entityMapper;
    const botMentionNames = resolveThreadBotMentionNames(cfg);
    const stripped = messages.map((message) => ({
      ...message,
      text: stripUserThreadContinueDirective({
        message,
        cfg,
        botMentionNames,
      }),
    }));
    if (!mapper) return stripped;
    return stripped.map((message) => ({
      ...message,
      userName: mapper.normalizeIncomingText(`<@${message.userId}>`),
      text: mapper.normalizeIncomingText(message.text),
    }));
  }

  private async hydrateMessagesForSummarization(
    messages: readonly ConversationThreadMessage[],
  ): Promise<ResultType<ConversationThreadSummaryMessage[], ConversationThreadOperationFailed>> {
    const refs = messages
      .filter((message) => message.attachments.length > 0)
      .map((message) => ({
        ...(message.surface === "native" ? { surface: "native" as const } : {}),
        channelId: message.channelId,
        messageId: message.messageId,
      }));
    if (refs.length === 0) {
      return Result.ok(messages.map((message) => ({ ...message, attachments: [] })));
    }
    if (!this.params.attachmentHydrator) {
      return Result.err(
        conversationThreadOperationFailed(
          "summarize-thread",
          "Thread attachment hydration is unavailable",
        ),
      );
    }
    const hydrated = await this.params.attachmentHydrator({ refs });
    return hydrated.andThen((items) => {
      const byRef = new Map(
        items.map((item) => [
          `${item.ref.surface ?? "discord"}\u001f${item.ref.channelId}\u001f${item.ref.messageId}`,
          item,
        ]),
      );
      const output: ConversationThreadSummaryMessage[] = [];
      for (const message of messages) {
        if (message.attachments.length === 0) {
          output.push({ ...message, attachments: [] });
          continue;
        }
        const item = byRef.get(
          `${message.surface ?? "discord"}\u001f${message.channelId}\u001f${message.messageId}`,
        );
        if (!item) {
          return Result.err(
            conversationThreadOperationFailed(
              "summarize-thread",
              `Thread attachment hydration omitted message ${message.messageId}`,
            ),
          );
        }
        const expectedHash = hashIndexedDiscordAttachments(message.attachments);
        const actualHash = hashIndexedDiscordAttachments(
          toIndexedDiscordAttachments(item.attachments),
        );
        if (expectedHash !== actualHash) {
          return Result.err(
            conversationThreadOperationFailed(
              "summarize-thread",
              `Thread attachments changed while summarizing message ${message.messageId}`,
            ),
          );
        }
        output.push({ ...message, attachments: item.attachments });
      }
      return Result.ok(output);
    });
  }

  private async tryEmbedThread(input: {
    jobId?: string;
    threadId: string;
    embeddingAdapter: Awaited<ReturnType<ConversationThreadEmbeddingAdapterResolver>>;
    embeddingInputHash: string;
    facets: ReturnType<ConversationThreadStore["listFacets"]>;
  }): Promise<ResultType<void, ConversationThreadGenerationError>> {
    const adapter = input.embeddingAdapter;
    if (!adapter) return Result.ok(undefined);
    if (!this.params.store.isVectorSearchAvailable()) {
      const err = this.params.store.getVectorLoadError();
      this.logger.warn("thread embeddings skipped: sqlite-vec unavailable", {
        jobId: input.jobId,
        threadId: input.threadId,
        error: err ?? undefined,
      });
      return Result.ok(undefined);
    }

    const embeddings: Array<{
      facet: (typeof input.facets)[number]["facet"];
      embedding: Float32Array;
    }> = [];
    let dimensions: number | null = null;
    this.logger.debug("thread embedding generation started", {
      jobId: input.jobId,
      threadId: input.threadId,
      facets: input.facets.length,
      modelId: adapter.modelId,
    });
    const usage = createThreadEmbeddingUsageAccumulator("thread_facets");
    for (const facet of input.facets) {
      const embedded = await captureConversationThreadGeneration(
        () =>
          adapter.embed({
            text: facet.text,
            facet: facet.facet,
            onUsage: usage.record,
          }),
        "search-embedding",
        "Thread embedding failed",
      );
      const embeddingResult = embedded.mapError((error) => {
        usage.log({
          status: "failed",
          jobId: input.jobId,
          threadId: input.threadId,
          dimensions: dimensions ?? undefined,
          persistedEmbeddings: embeddings.length,
          error: error.message,
        });
        return error;
      });
      const embeddingError = resultErrorOrNull(embeddingResult);
      if (embeddingError) return Result.err(embeddingError);
      const embedding = selectResultValue(embeddingResult);
      dimensions ??= embedding.length;
      if (embedding.length !== dimensions) {
        const error = conversationThreadOperationFailed(
          "search-embedding",
          `thread embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`,
        );
        usage.log({
          status: "failed",
          jobId: input.jobId,
          threadId: input.threadId,
          dimensions,
          persistedEmbeddings: embeddings.length,
          error: error.message,
        });
        return Result.err(error);
      }
      embeddings.push({
        facet: facet.facet,
        embedding,
      });
    }

    if (dimensions === null) {
      this.logger.debug("thread embedding generation skipped: no facets", {
        jobId: input.jobId,
        threadId: input.threadId,
      });
      return Result.ok(undefined);
    }

    const persisted = captureConversationThreadSqliteOperation(
      () =>
        this.params.store.upsertEmbeddings({
          threadId: input.threadId,
          embeddingInputHash: input.embeddingInputHash,
          modelId: adapter.modelId,
          dimensions,
          embeddings,
        }),
      "persist-summary-failure",
      "Thread embedding persistence failed",
    );
    const persistedResult = persisted.mapError((error) => {
      usage.log({
        status: "failed",
        jobId: input.jobId,
        threadId: input.threadId,
        dimensions,
        persistedEmbeddings: embeddings.length,
        error: error.message,
      });
      return error;
    });
    const persistenceError = resultErrorOrNull(persistedResult);
    if (persistenceError) return Result.err(persistenceError);
    this.logger.debug("thread embedding generation completed", {
      jobId: input.jobId,
      threadId: input.threadId,
      facets: embeddings.length,
      dimensions,
      modelId: adapter.modelId,
    });
    usage.log({
      status: "completed",
      jobId: input.jobId,
      threadId: input.threadId,
      dimensions,
      persistedEmbeddings: embeddings.length,
    });
    return Result.ok(undefined);
  }

  private async captureQueryAboutness(input: {
    queries: readonly string[];
    cfg: CoreConfig;
    mode: "hybrid" | "semantic" | "lexical";
    candidateCount: number;
  }): Promise<{
    aboutness: ConversationThreadQueryAboutness | null;
    error?: string;
  }> {
    if (input.mode === "lexical" || input.candidateCount < 2) return { aboutness: null };

    const summarizeQueryAboutness = this.params.queryAboutnessSummarizer;
    const captured = summarizeQueryAboutness
      ? await captureConversationThreadGeneration(
          () => summarizeQueryAboutness({ cfg: input.cfg, queries: input.queries }),
          "capture-query-aboutness",
          "Query aboutness generation failed",
        )
      : await defaultQueryAboutnessSummarizer({ cfg: input.cfg, queries: input.queries });
    return captured.match({
      ok: (value) => ({ aboutness: normalizeQueryAboutness(value) }),
      err: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("thread query aboutness capture failed; using fallback coverage", {
          ...formatTaggedErrorForLog(
            conversationThreadOperationFailed("capture-query-aboutness", message),
          ),
        });
        return {
          aboutness: buildFallbackQueryAboutness(input.queries),
          error: message,
        };
      },
    });
  }

  private applyAboutnessCoverage(
    hits: ConversationThreadSearchHitWithAttribution[],
    queryAboutness: ConversationThreadQueryAboutness | null,
  ): ConversationThreadSearchHitWithAttribution[] {
    if (!queryAboutness) return hits;

    return hits
      .map((hit) => {
        const coverage = computeAboutnessCoverage(queryAboutness, hit);
        return {
          ...hit,
          score: hit.score * coverage.multiplier,
          aboutnessCoverage: coverage,
        };
      })
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return right.endTs - left.endTs;
      });
  }

  private async searchHits(input: {
    query: string;
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    cfg: CoreConfig;
    embeddingAdapter: Awaited<ReturnType<ConversationThreadEmbeddingAdapterResolver>>;
    filters: ConversationThreadSearchFilters;
    allowlist: ConversationThreadSearchAllowlist;
    onEmbeddingUsage?: (event: ConversationThreadEmbeddingUsageEvent) => void;
  }): Promise<ResultType<ConversationThreadSearchHit[], PersistedDataError>> {
    const candidates = new Map<string, ConversationThreadSearchHit>();
    const add = (hit: ConversationThreadSearchHit) => {
      if (
        hit.kind !== "native_thread" &&
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
        existing.semanticScore + existing.lexicalScore * HYBRID_LEXICAL_WEIGHT,
      );
    };

    if (input.mode !== "semantic") {
      const lexical = this.params.store.search({
        query: input.query,
        limit: input.limit * 5,
        filters: input.filters,
        allowlist: input.allowlist,
      });
      const lexicalError = resultErrorOrNull(lexical);
      if (lexicalError) return Result.err(lexicalError);
      const lexicalHits = selectResultValue(lexical);
      for (const hit of lexicalHits) {
        hit.score = applyImportanceNudge(
          hit,
          hit.lexicalScore * (input.mode === "lexical" ? 1 : HYBRID_LEXICAL_WEIGHT),
        );
        add(hit);
      }
    }

    const adapter = input.embeddingAdapter;
    if (input.mode !== "lexical" && adapter && this.params.store.isVectorSearchAvailable()) {
      const embedded = await captureConversationThreadGeneration(
        () =>
          adapter.embed({
            text: input.query,
            facet: "query",
            onUsage: input.onEmbeddingUsage,
          }),
        "search-embedding",
        "Search embedding failed",
      );
      const semantic = await embedded.match({
        err: (error) => async () => {
          this.logger.warn("thread semantic search failed; using lexical fallback", {
            ...formatTaggedErrorForLog(
              conversationThreadOperationFailed(
                "search-embedding",
                error instanceof Error ? error.message : String(error),
              ),
            ),
          });
          return Result.ok(undefined);
        },
        ok: (queryEmbedding) => async () =>
          this.params.store
            .searchSemantic({
              embedding: queryEmbedding,
              modelId: adapter.modelId,
              dimensions: queryEmbedding.length,
              limit: input.limit * 5,
              filters: input.filters,
              allowlist: input.allowlist,
            })
            .map((hits) => {
              for (const hit of hits) {
                hit.score = applyImportanceNudge(
                  hit,
                  hit.semanticScore + hit.lexicalScore * HYBRID_LEXICAL_WEIGHT,
                );
                add(hit);
              }
            }),
      })();
      const semanticError = resultErrorOrNull(semantic);
      if (semanticError) return Result.err(semanticError);
    }

    return Result.ok(
      [...candidates.values()]
        .sort((left, right) => {
          if (left.score !== right.score) return right.score - left.score;
          return right.endTs - left.endTs;
        })
        .slice(0, input.limit),
    );
  }

  private async searchHitsForQueries(input: {
    queries: readonly string[];
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    cfg: CoreConfig;
    embeddingAdapter: Awaited<ReturnType<ConversationThreadEmbeddingAdapterResolver>>;
    filters: ConversationThreadSearchFilters;
    allowlist: ConversationThreadSearchAllowlist;
    onEmbeddingUsage?: (event: ConversationThreadEmbeddingUsageEvent) => void;
  }): Promise<ResultType<ConversationThreadSearchHitWithAttribution[], PersistedDataError>> {
    if (input.queries.length === 1) {
      return await this.searchHits({
        query: input.queries[0]!,
        limit: input.limit,
        mode: input.mode,
        cfg: input.cfg,
        embeddingAdapter: input.embeddingAdapter,
        filters: input.filters,
        allowlist: input.allowlist,
        onEmbeddingUsage: input.onEmbeddingUsage,
      });
    }

    const perQueryLimit = Math.min(50, Math.max(input.limit * 5, 10));
    const queryResults = await Promise.all(
      input.queries.map(async (query) => ({
        query,
        hits: await this.searchHits({
          query,
          limit: perQueryLimit,
          mode: input.mode,
          cfg: input.cfg,
          embeddingAdapter: input.embeddingAdapter,
          filters: input.filters,
          allowlist: input.allowlist,
          onEmbeddingUsage: input.onEmbeddingUsage,
        }),
      })),
    );

    const queryCount = input.queries.length;
    const candidates = new Map<
      string,
      ConversationThreadSearchHitWithAttribution & { bestSelfScore: number }
    >();

    for (const { query, hits } of queryResults) {
      const hitError = resultErrorOrNull(hits);
      if (hitError) return Result.err(hitError);
      const values = selectResultValue(hits);
      values.forEach((hit, index) => {
        const selfScore = hit.score;
        const contribution = selfScore / queryCount;
        const attribution: ConversationThreadQueryAttribution = {
          query,
          rank: index + 1,
          selfScore,
          contribution,
          lexicalScore: hit.lexicalScore,
          semanticScore: hit.semanticScore,
        };
        const existing = candidates.get(hit.threadId);
        if (!existing) {
          candidates.set(hit.threadId, {
            ...hit,
            score: contribution,
            queryAttribution: [attribution],
            bestSelfScore: selfScore,
          });
          return;
        }

        existing.score += contribution;
        existing.lexicalScore = Math.max(existing.lexicalScore, hit.lexicalScore);
        existing.semanticScore = Math.max(existing.semanticScore, hit.semanticScore);
        existing.queryAttribution?.push(attribution);
        if (selfScore > existing.bestSelfScore) {
          existing.bestSelfScore = selfScore;
          existing.title = hit.title;
          existing.brief = hit.brief;
          existing.topics = hit.topics;
          existing.retrievalHints = hit.retrievalHints;
          existing.aboutness = hit.aboutness;
          existing.importance = hit.importance;
          existing.importanceReasons = hit.importanceReasons;
          existing.startTs = hit.startTs;
          existing.endTs = hit.endTs;
          existing.messageCount = hit.messageCount;
          existing.summarized = hit.summarized;
          existing.stale = hit.stale;
        }
      });
    }

    return Result.ok(
      [...candidates.values()]
        .sort((left, right) => {
          if (left.score !== right.score) return right.score - left.score;
          return right.endTs - left.endTs;
        })
        .slice(0, input.limit),
    );
  }

  private formatSearchHit(hit: ConversationThreadSearchHitWithAttribution, verbose: boolean) {
    return {
      threadId: hit.threadId,
      surface: hit.kind === "native_thread" ? ("native" as const) : ("discord" as const),
      title: hit.title,
      brief: hit.brief,
      ...(verbose
        ? {
            topics: hit.topics,
            retrievalHints: hit.retrievalHints,
            aboutness: hit.aboutness,
            importance: hit.importance,
            importanceReasons: hit.importanceReasons,
            timeRange: {
              start: formatTime(hit.startTs),
              end: formatTime(hit.endTs),
            },
            messageCount: hit.messageCount,
            score: hit.score,
            lexicalScore: hit.lexicalScore,
            semanticScore: hit.semanticScore,
            ...(hit.queryAttribution ? { queryAttribution: hit.queryAttribution } : {}),
            ...(hit.aboutnessCoverage ? { aboutnessCoverage: hit.aboutnessCoverage } : {}),
            session: {
              platform: hit.kind === "native_thread" ? ("native" as const) : ("discord" as const),
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

  private formatMetadataThread(input: {
    thread: ConversationThreadRow;
    summary: ConversationThreadSummary | null;
    messageCount: number;
  }): ConversationThreadReadOutput["thread"] {
    return {
      threadId: input.thread.thread_id,
      surface: input.thread.kind === "native_thread" ? "native" : "discord",
      ...(input.summary
        ? {
            title: input.summary.title,
            brief: input.summary.brief,
            topics: input.summary.topics,
            retrievalHints: input.summary.retrievalHints,
            aboutness: input.summary.aboutness,
            importance: input.summary.importance,
            importanceReasons: input.summary.importanceReasons,
          }
        : {}),
      session: {
        platform: input.thread.kind === "native_thread" ? "native" : "discord",
        channelId: input.thread.channel_id,
        guildId: input.thread.guild_id ?? undefined,
        parentChannelId: input.thread.parent_channel_id ?? undefined,
      },
      anchors: {
        startMessageId: input.thread.start_message_id,
        endMessageId: input.thread.end_message_id,
      },
      timeRange: {
        start: formatTime(input.thread.start_ts),
        end: formatTime(input.thread.end_ts),
      },
      messageCount: input.messageCount,
    };
  }
}

export function createConversationThreadToolService(
  service: ConversationThreadService,
): ConversationThreadToolService {
  const resolvePersistenceOperation = async <T>(
    operation: Promise<ResultType<T, { readonly message: string }>>,
  ): Promise<T> => {
    const result = await operation;
    return result.match({
      ok: (value) => () => value,
      err: (error) => () => {
        throw new Error(error.message);
      },
    })();
  };
  return {
    search: (input) => resolvePersistenceOperation(service.search(input)),
    metadata: (input) => resolvePersistenceOperation(service.metadata(input)),
    read: (input) => resolvePersistenceOperation(service.read(input)),
    runSummarization: (input) => service.runSummarization(input),
    planAutoInjectSearch: (input) =>
      resolvePersistenceOperation(service.planAutoInjectSearch(input)),
    getAutoInjectRankingCorpusDocuments: () => service.getAutoInjectRankingCorpusDocuments(),
    shortlistAutoInjectCandidates: (input) =>
      resolvePersistenceOperation(service.shortlistAutoInjectCandidates(input)),
  };
}

function normalizeMetadataThreadIds(input: { threadIds: readonly string[] }): string[] {
  const raw = input.threadIds;
  const threadIds = [...new Set(raw.map((id) => id.trim()).filter((id) => id.length > 0))];
  return threadIds;
}
