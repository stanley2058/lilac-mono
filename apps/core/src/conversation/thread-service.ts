import {
  generateText,
  Output,
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  createLogger,
  ensurePromptWorkspace,
  resolveModelRef,
  resolveModelSlot,
  resolvePromptDir,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import {
  type ConversationThreadMessage,
  type ConversationThreadRow,
  type ConversationThreadSearchFilters,
  type ConversationThreadSearchAllowlist,
  type ConversationThreadSearchHit,
  type ConversationThreadStore,
  type ConversationThreadSummary,
  type ConversationThreadSummaryInput,
  CONVERSATION_THREAD_SUMMARY_VERSION,
} from "./thread-store";
import type {
  ConversationThreadEmbeddingAdapterResolver,
  ConversationThreadEmbeddingUsageEvent,
} from "./thread-embedding";
import type { EntityMapper } from "../entity/entity-mapper";

const SUMMARY_QUIET_MS = 60 * 60 * 1000;
const SUMMARY_HEAD_MESSAGES = 40;
const SUMMARY_TAIL_MESSAGES = 160;
const SUMMARY_MAX_MESSAGES = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;
const DEFAULT_READ_LIMIT = 50;
const SUMMARY_PARSE_MAX_ATTEMPTS = 3;
const HYBRID_LEXICAL_WEIGHT = 0.35;
const PROMPT_CONTEXT_FILES = ["MEMORY.md", "USER.md", "ENTITIES.md"] as const;
const MULTI_QUERY_MAX = 10;
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

const autoInjectQueryPlanSchema = z.object({
  queries: z.array(z.string()).min(1).max(MULTI_QUERY_MAX),
  aboutness: queryAboutnessSchema,
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
}) => Promise<ConversationThreadAutoInjectQueryPlan>;

export type ConversationThreadRunSummarizationInput = {
  jobId?: string;
  dryRun?: boolean;
  wait?: boolean;
  force?: boolean;
  clear?: boolean;
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
  cleared: number;
  summarized: number;
  failed: number;
  failures: Array<{ threadId: string; error: string }>;
  threadIds: string[];
  jobId?: string;
  status?: "queued" | "completed";
};

export type ConversationThreadToolService = Pick<
  ConversationThreadService,
  "search" | "metadata" | "read" | "runSummarization" | "planAutoInjectSearch"
>;

export type ConversationThreadSearchResult = {
  meta: {
    query: string;
    queries?: string[];
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    count: number;
    vectorAvailable: boolean;
    vectorError?: string;
    queryAboutness?: ConversationThreadQueryAboutness;
    queryAboutnessError?: string;
  };
  results: Array<{
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
    content: string;
  }>;
};

export type ConversationThreadMetadataOutput = {
  threads: ConversationThreadReadOutput["thread"][];
  missing: string[];
};

export type ConversationThreadSummarizer = (input: {
  cfg: CoreConfig;
  jobId?: string;
  threadId: string;
  attempt?: number;
  previousSummary: ConversationThreadSummary | null;
  promptContext: ConversationThreadPromptContext | null;
  messages: readonly ConversationThreadMessage[];
  omittedMessages?: number;
}) => Promise<ConversationThreadSummaryInput>;

type ConversationThreadPromptContext = {
  hash: string;
  text: string;
};

type ThreadLanguageModelUsageOperation = "summary" | "query_aboutness" | "auto_inject_query_plan";
type ThreadEmbeddingUsageOperation = "thread_facets" | "search_query";
type ThreadEmbeddingUsageStatus = "completed" | "failed";

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
}) {
  return (event: ThreadLanguageModelCallEndEvent) => {
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

function createThreadEmbeddingUsageAccumulator(operation: ThreadEmbeddingUsageOperation) {
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
      threadLogger.info("conversation.thread.embedding.usage", {
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
      });
    },
  };
}

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

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeSearchQueries(input: string | readonly string[]): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of Array.isArray(input) ? input : [input]) {
    const query = raw.trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MULTI_QUERY_MAX) break;
  }
  if (queries.length === 0) throw new Error("conversation thread search query is required");
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
  const queries = normalizeSearchQueries(plan.queries);
  return {
    queries,
    aboutness: normalizeQueryAboutness(plan.aboutness),
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
  try {
    const raw = await Bun.file(filePath).text();
    const text = stripFrontmatter(raw).trim();
    return text.length > 0 ? text : null;
  } catch (e) {
    if (name === "ENTITIES.md") return null;
    throw e;
  }
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
  const matchReason = !hasSpecificAboutness
    ? "no-specific-aboutness"
    : hasDomainMismatch
      ? "domain-mismatch"
      : highPrecisionCoverage < 0.25
        ? "weak-coverage"
        : highPrecisionCoverage < 0.45
          ? "partial-coverage"
          : highPrecisionCoverage < 0.65
            ? "sufficient-coverage"
            : "strong-coverage";
  const multiplier =
    matchReason === "no-specific-aboutness"
      ? 1
      : matchReason === "domain-mismatch"
        ? DOMAIN_MISMATCH_COVERAGE_MULTIPLIER
        : matchReason === "weak-coverage"
          ? WEAK_COVERAGE_MULTIPLIER
          : matchReason === "partial-coverage"
            ? PARTIAL_COVERAGE_MULTIPLIER
            : matchReason === "sufficient-coverage"
              ? 1
              : 1.05 + Math.min(0.1, ((highPrecisionCoverage - 0.65) / 0.35) * 0.1);

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

function parseQueryAboutnessJson(text: string): ConversationThreadQueryAboutness {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as unknown;
    return normalizeQueryAboutness(queryAboutnessSchema.parse(parsed));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConversationThreadSummaryParseError(`query aboutness JSON parse failed: ${message}`, {
      cause: e,
      rawOutput: truncateErrorDetail(text),
    });
  }
}

function parseAutoInjectQueryPlanJson(text: string): ConversationThreadAutoInjectQueryPlan {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as unknown;
    return normalizeAutoInjectQueryPlan(autoInjectQueryPlanSchema.parse(parsed));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConversationThreadSummaryParseError(
      `auto-inject query plan JSON parse failed: ${message}`,
      {
        cause: e,
        rawOutput: truncateErrorDetail(text),
      },
    );
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

function resolveAutoInjectPlannerModel(cfg: CoreConfig) {
  const plannerModel = cfg.conversation.thread.autoInject.plannerModel?.trim();
  if (!plannerModel) return resolveSummarizationModel(cfg);

  const model = plannerModel;
  if (model === "main" || model === "fast") return resolveModelSlot(cfg, model);
  return resolveModelRef(cfg, { model }, "conversation.thread.autoInject.plannerModel");
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
  participantIdsAny?: readonly string[];
  beforeTs?: number;
  afterTs?: number;
}): ConversationThreadSearchFilters {
  return {
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

async function defaultSummarizer(input: {
  cfg: CoreConfig;
  jobId?: string;
  threadId: string;
  attempt?: number;
  previousSummary: ConversationThreadSummary | null;
  promptContext: ConversationThreadPromptContext | null;
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
  const contentParts = ["## Previous summary", previous, ""];
  if (promptContextSection) contentParts.push(promptContextSection, "");
  contentParts.push("## Transcript", transcript);

  const messages = [
    {
      role: "user",
      content: contentParts.join("\n"),
    },
  ] satisfies ModelMessage[];

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
      instructions,
      messages,
      reasoning: resolved.reasoning,
      providerOptions: resolved.providerOptions,
      onLanguageModelCallEnd,
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
    onLanguageModelCallEnd,
  });

  return result.output;
}

async function defaultQueryAboutnessSummarizer(input: {
  cfg: CoreConfig;
  queries: readonly string[];
}): Promise<ConversationThreadQueryAboutness> {
  const resolved = resolveSummarizationModel(input.cfg);
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
    return parseQueryAboutnessJson(await result.text);
  }

  const result = await generateText({
    model: resolved.model,
    output: Output.object({ schema: queryAboutnessSchema }),
    instructions,
    messages,
    maxOutputTokens: 2048,
    reasoning: resolved.reasoning,
    providerOptions: resolved.providerOptions,
    onLanguageModelCallEnd,
  });

  return normalizeQueryAboutness(result.output);
}

async function defaultAutoInjectQueryPlanner(input: {
  cfg: CoreConfig;
  text: string;
}): Promise<ConversationThreadAutoInjectQueryPlan> {
  const resolved = resolveAutoInjectPlannerModel(input.cfg);
  const messages = [
    {
      role: "user",
      content: [
        "Create compact conversation-memory search queries for this new user message.",
        "Do not answer the message. Extract what prior conversation threads would be relevant context for responding.",
        "Return search queries and positive aboutness evidence only.",
        "",
        "## User message",
        input.text,
      ].join("\n"),
    },
  ] satisfies ModelMessage[];
  const instructions = buildAutoInjectQueryPlanInstructions();
  const onLanguageModelCallEnd = createThreadLanguageModelUsageLogger({
    operation: "auto_inject_query_plan",
    modelSpec: resolved.spec,
    inputChars: input.text.length,
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
    return parseAutoInjectQueryPlanJson(await result.text);
  }

  const result = await generateText({
    model: resolved.model,
    output: Output.object({ schema: autoInjectQueryPlanSchema }),
    instructions,
    messages,
    maxOutputTokens: 2048,
    reasoning: resolved.reasoning,
    providerOptions: resolved.providerOptions,
    onLanguageModelCallEnd,
  });

  return normalizeAutoInjectQueryPlan(result.output);
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

function buildAutoInjectQueryPlanInstructions(): string {
  return [
    "You create retrieval queries for an automatic conversation-memory lookup.",
    "Return exactly one JSON object and nothing else.",
    'Shape: {"queries":["..."],"aboutness":{"domains":["..."],"situations":["..."],"targets":["..."],"entities":["..."],"userWouldAskForThisAs":["..."],"intentSummary":"..."}}',
    "",
    "The input is a newly received user message, possibly a long article or essay.",
    "Do not summarize the article for the final answer. Instead, generate semantic search queries that would find prior conversation threads useful for responding to it.",
    "Use 2-6 query variants for substantive long input. Prefer compact natural phrases over dense paragraphs.",
    "Queries should name the durable subject, task, decision, complaint target, project, technology, entities, or situation.",
    "Avoid copying long passages. Preserve exact names, code identifiers, errors, and source-language phrases only when central.",
    "Use only positive aboutness evidence: what relevant prior threads would be about, not what should be excluded.",
    "The aboutness object follows the same meaning as conversation-thread search query aboutness.",
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
    "- retrievalHints: short search-query-like phrases a future user might type to find this thread.",
    "- aboutness: positive-only retrieval evidence for what the thread is actually about.",
    "- aboutness.domains: broad real-world or project domains, such as day job, workplace, Discord social conflict, architecture, debugging, or career planning.",
    "- aboutness.situations: concrete situations in the thread, such as false accusation, design handoff issue, review frustration, migration planning, or API failure.",
    "- aboutness.complaintTargets: what frustration, venting, or criticism is directed at when present, such as company process, coworker handoff, DF's accusation, or a flaky API. Use an empty array when the thread is not a complaint or vent.",
    "- aboutness.entities: important people, projects, tools, organizations, files, commands, errors, or named concepts.",
    "- aboutness.userWouldAskForThisAs: natural future-search phrases someone might type to find this exact thread.",
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
    "- Prefer natural user-intent phrases someone might actually type later, not dense implementation notes.",
    "- Include distinct ways the user might search for this thread later:",
    "  - the user's goal, task, or question",
    "  - the concrete problem, symptom, decision, tradeoff, or outcome",
    "  - exact tools, APIs, files, commands, identifiers, errors, quotes, or product names only when central to the thread",
    "  - alternate wording, aliases, abbreviations, colloquial phrasing, or source-language phrases",
    "  - emotional or personal framing when clearly present, such as rant, vent, frustration, career, job, compensation, debugging, architecture, incident, or process",
    "- For any substantive thread, include broad domain phrases and concrete target/object phrases when accurate. Cover the actual domain instead of defaulting to workplace framing: technical debugging, architecture, product/process decisions, interpersonal conflict, project coordination, career planning, personal logistics, finance, incidents, travel, health, or other recurring subjects.",
    "- When emotional framing is clearly present, pair it with what the emotion is about, such as API debugging frustration, Discord social anxiety, migration planning stress, career uncertainty, deployment incident pressure, billing concern, travel logistics worry, or workplace complaint.",
    "- Avoid package versions, CSS syntax, exact dependency versions, long code identifiers, and other technical minutiae in retrieval hints unless the thread is primarily about finding that exact detail.",
    "- Avoid generic standalone hints like help, code, app, bug, AI, question, discussion, or notes.",
    "- Avoid near-duplicates; each hint should add a meaningfully different retrieval path.",
    "- Do not invent context, labels, emotions, tools, or technologies not present or strongly implied.",
    "- When updating an existing summary, keep accurate previous hints stable; only change hints that are stale, misleading, redundant, or clearly improved by new transcript content.",
    "",
    "## Aboutness",
    "- Aboutness fields should capture the intended subject, domain, and object of discussion, not just emotional tone.",
    "- For emotionally similar threads, distinguish what the emotion is about: technical debugging, project boundaries, interpersonal conflict, career uncertainty, family logistics, financial planning, deployment incidents, workplace process, architecture planning, and so on.",
    "- userWouldAskForThisAs should contain 3-8 realistic user queries for substantive threads, especially phrases that name the target domain or complaint target.",
    "- complaintTargets should be specific and positive-only. Prefer concrete objects such as a broken API, unclear requirement, migration blocker, DF's accusation, billing issue, travel constraint, family-home pressure, company process, designer handoff, PR review, or deployment failure over generic frustration.",
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
      getEmbeddingAdapter?: ConversationThreadEmbeddingAdapterResolver;
      entityMapper?: Pick<EntityMapper, "normalizeIncomingText">;
    },
  ) {}

  refreshThreads(cfg?: CoreConfig): { channels: number; threads: number; messages: number } {
    return this.params.store.refreshInferredThreads({ cfg });
  }

  async search(input: {
    query: string | readonly string[];
    limit?: number;
    sessionId?: string;
    participantId?: string;
    participantIdsAny?: readonly string[];
    beforeTs?: number;
    afterTs?: number;
    mode?: "hybrid" | "semantic" | "lexical";
    verbose?: boolean;
    queryAboutness?: ConversationThreadQueryAboutness;
  }): Promise<ConversationThreadSearchResult> {
    const cfg = await this.params.getConfig();
    this.refreshThreads(cfg);
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)));
    const mode = input.mode ?? "hybrid";
    const queries = normalizeSearchQueries(input.query);
    const embeddingAdapter = this.params.getEmbeddingAdapter
      ? await this.params.getEmbeddingAdapter()
      : null;
    const filters = buildSearchFilters(input);
    const recallLimit =
      mode === "lexical" ? limit : Math.min(50, Math.max(limit * COVERAGE_RECALL_MULTIPLIER, 10));
    const usage = createThreadEmbeddingUsageAccumulator("search_query");
    try {
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
      const { aboutness: queryAboutness, error: queryAboutnessError } = input.queryAboutness
        ? { aboutness: normalizeQueryAboutness(input.queryAboutness), error: undefined }
        : await this.captureQueryAboutness({
            queries,
            cfg,
            mode,
            candidateCount: recallHits.length,
          });
      const hits = this.applyAboutnessCoverage(recallHits, queryAboutness).slice(0, limit);
      const result = {
        meta: {
          query: queries[0]!,
          ...(queries.length > 1 ? { queries } : {}),
          limit,
          mode,
          count: hits.length,
          vectorAvailable: this.params.store.isVectorSearchAvailable() && !!embeddingAdapter,
          vectorError: this.params.store.getVectorLoadError() ?? undefined,
          ...(input.verbose && queryAboutness ? { queryAboutness } : {}),
          ...(input.verbose && queryAboutnessError ? { queryAboutnessError } : {}),
        },
        results: hits.map((hit) => this.formatSearchHit(hit, input.verbose ?? false)),
      } satisfies ConversationThreadSearchResult;
      usage.log({ status: "completed", mode, queryCount: queries.length });
      return result;
    } catch (e) {
      usage.log({
        status: "failed",
        mode,
        queryCount: queries.length,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async planAutoInjectSearch(input: {
    text: string;
  }): Promise<ConversationThreadAutoInjectQueryPlan> {
    const text = input.text.trim();
    if (!text) throw new Error("auto-inject query planning text is required");
    const cfg = await this.params.getConfig();
    const planner = this.params.autoInjectQueryPlanner ?? defaultAutoInjectQueryPlanner;
    return normalizeAutoInjectQueryPlan(await planner({ cfg, text }));
  }

  async read(input: {
    threadId: string;
    offset?: number;
    limit?: number;
  }): Promise<ConversationThreadReadOutput> {
    const cfg = await this.params.getConfig();
    this.refreshThreads(cfg);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? DEFAULT_READ_LIMIT)));
    const result = this.params.store.readThread(input.threadId, offset, limit);
    if (!result) throw new Error(`conversation thread not found: ${input.threadId}`);
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
      thread: this.formatMetadataThread({
        thread: result.thread,
        summary: result.summary,
        messageCount: result.totalMessages,
      }),
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
        content: message.text,
      })),
    };
  }

  async metadata(input: {
    threadIds: readonly string[];
  }): Promise<ConversationThreadMetadataOutput> {
    const cfg = await this.params.getConfig();
    this.refreshThreads(cfg);
    const threadIds = normalizeMetadataThreadIds(input);
    const threads: ConversationThreadMetadataOutput["threads"] = [];
    const missing: string[] = [];

    for (const threadId of threadIds) {
      const thread = this.params.store.getThread(threadId);
      if (!thread) {
        missing.push(threadId);
        continue;
      }

      if (
        !shouldAllowDiscordThread(cfg, {
          channelId: thread.channel_id,
          parentChannelId: thread.parent_channel_id,
          guildId: thread.guild_id,
        })
      ) {
        throw new Error(`Not allowed: conversation thread '${threadId}'`);
      }

      threads.push(
        this.formatMetadataThread({
          thread,
          summary: this.params.store.getSummary(threadId),
          messageCount: this.params.store.countThreadMessages(threadId),
        }),
      );
    }

    return { threads, missing };
  }

  async runSummarization(
    input: ConversationThreadRunSummarizationInput = {},
  ): Promise<ConversationThreadRunSummarizationResult> {
    const jobId = input.jobId;
    const cfg = await this.params.getConfig();
    this.logger.debug("thread summarization refresh started", { jobId });
    const refreshed = this.refreshThreads(cfg);
    this.logger.debug("thread summarization refresh completed", { jobId, refreshed });

    if (input.clear === true && input.dryRun === true) {
      const clearTargets = this.params.store.listThreadsForSummarizationClear();
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
        cleared: 0,
        summarized: 0,
        failed: 0,
        failures: [],
        threadIds: clearTargets.map((thread) => thread.thread_id),
      };
    }

    const clearedThreadIds =
      input.clear === true ? this.params.store.clearSummarizationState() : [];
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

    const eligible = this.params.store.listEligibleForSummarization({
      now: input.now,
      quietMs: SUMMARY_QUIET_MS,
      threadId: input.threadId,
      beforeTs: input.beforeTs,
      afterTs: input.afterTs,
      includeEmbeddingStale: !!embeddingAdapter && this.params.store.isVectorSearchAvailable(),
      embeddingModelId: embeddingAdapter?.modelId,
      summaryPromptContextHash: promptContext?.hash,
      force: input.force === true,
    });
    this.logger.debug("thread summarization eligibility completed", {
      jobId,
      eligible: eligible.length,
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
      cleared: clearedThreadIds.length,
      summarized: 0,
      failed: 0,
      failures: [],
      threadIds: eligible.map((thread) => thread.thread_id),
    };

    if (input.dryRun) {
      this.logger.debug("thread summarization dry run completed", {
        jobId,
        eligible: result.eligible,
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
      this.logger.debug("thread summarization thread started", {
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
        this.logger.debug("thread summarization deleting empty thread", {
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
          thread.summary_version !== CONVERSATION_THREAD_SUMMARY_VERSION ||
          (promptContext !== null && thread.summary_prompt_context_hash !== promptContext.hash);
        const previousSummary = this.params.store.getSummary(thread.thread_id);
        if (summaryRead.omittedMessages > 0) {
          this.logger.debug("thread summarization transcript truncated", {
            jobId,
            threadId: thread.thread_id,
            totalMessages: summaryRead.totalMessages,
            includedMessages: summaryRead.messages.length,
            omittedMessages: summaryRead.omittedMessages,
          });
        }
        const summaryWrite = summaryIsStale
          ? await (async () => {
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
                previousSummary,
                messages: summaryMessages,
                omittedMessages: summaryRead.omittedMessages,
              });
              return this.params.store.upsertSummary(
                thread.thread_id,
                thread.summary_input_hash ?? "",
                summary ?? buildFallbackSummary(summaryMessages),
                promptContext?.hash ?? null,
              );
            })()
          : {
              facets: this.params.store.listFacets(thread.thread_id),
              embeddingInputHash:
                this.params.store.computeEmbeddingInputHash(thread.thread_id) ?? "",
            };
        if (summaryIsStale) {
          this.logger.debug("thread summary generation completed", {
            jobId,
            threadId: thread.thread_id,
            facets: summaryWrite.facets.length,
          });
        }

        await this.tryEmbedThread({
          jobId,
          threadId: thread.thread_id,
          embeddingAdapter,
          embeddingInputHash: summaryWrite.embeddingInputHash,
          facets: summaryWrite.facets,
        });
        if (summaryIsStale) result.summarized += 1;
        this.logger.debug("thread summarization thread completed", {
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
    promptContext: ConversationThreadPromptContext | null;
    previousSummary: ConversationThreadSummary | null;
    messages: readonly ConversationThreadMessage[];
    omittedMessages: number;
  }): Promise<ConversationThreadSummaryInput> {
    let lastError: ConversationThreadSummaryParseError | null = null;
    for (let attempt = 1; attempt <= SUMMARY_PARSE_MAX_ATTEMPTS; attempt++) {
      try {
        return await input.summarize({
          cfg: input.cfg,
          jobId: input.jobId,
          threadId: input.threadId,
          attempt,
          promptContext: input.promptContext,
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
    embeddingAdapter: Awaited<ReturnType<ConversationThreadEmbeddingAdapterResolver>>;
    embeddingInputHash: string;
    facets: ReturnType<ConversationThreadStore["listFacets"]>;
  }): Promise<void> {
    const adapter = input.embeddingAdapter;
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
    this.logger.debug("thread embedding generation started", {
      jobId: input.jobId,
      threadId: input.threadId,
      facets: input.facets.length,
      modelId: adapter.modelId,
    });
    const usage = createThreadEmbeddingUsageAccumulator("thread_facets");
    try {
      for (const facet of input.facets) {
        const embedding = await adapter.embed({
          text: facet.text,
          facet: facet.facet,
          onUsage: usage.record,
        });
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
        this.logger.debug("thread embedding generation skipped: no facets", {
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
    } catch (e) {
      usage.log({
        status: "failed",
        jobId: input.jobId,
        threadId: input.threadId,
        dimensions: dimensions ?? undefined,
        persistedEmbeddings: embeddings.length,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
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

    const summarizeQueryAboutness =
      this.params.queryAboutnessSummarizer ?? defaultQueryAboutnessSummarizer;
    try {
      const aboutness = normalizeQueryAboutness(
        await summarizeQueryAboutness({ cfg: input.cfg, queries: input.queries }),
      );
      return { aboutness };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn("thread query aboutness capture failed; using fallback coverage", {
        error: message,
      });
      return {
        aboutness: buildFallbackQueryAboutness(input.queries),
        error: message,
      };
    }
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
        existing.semanticScore + existing.lexicalScore * HYBRID_LEXICAL_WEIGHT,
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
          hit.lexicalScore * (input.mode === "lexical" ? 1 : HYBRID_LEXICAL_WEIGHT),
        );
        add(hit);
      }
    }

    const adapter = input.embeddingAdapter;
    if (input.mode !== "lexical" && adapter && this.params.store.isVectorSearchAvailable()) {
      try {
        const queryEmbedding = await adapter.embed({
          text: input.query,
          facet: "query",
          onUsage: input.onEmbeddingUsage,
        });
        for (const hit of this.params.store.searchSemantic({
          embedding: queryEmbedding,
          modelId: adapter.modelId,
          dimensions: queryEmbedding.length,
          limit: input.limit * 5,
          filters: input.filters,
          allowlist: input.allowlist,
        })) {
          hit.score = applyImportanceNudge(
            hit,
            hit.semanticScore + hit.lexicalScore * HYBRID_LEXICAL_WEIGHT,
          );
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

  private async searchHitsForQueries(input: {
    queries: readonly string[];
    limit: number;
    mode: "hybrid" | "semantic" | "lexical";
    cfg: CoreConfig;
    embeddingAdapter: Awaited<ReturnType<ConversationThreadEmbeddingAdapterResolver>>;
    filters: ConversationThreadSearchFilters;
    allowlist: ConversationThreadSearchAllowlist;
    onEmbeddingUsage?: (event: ConversationThreadEmbeddingUsageEvent) => void;
  }): Promise<ConversationThreadSearchHitWithAttribution[]> {
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
      hits.forEach((hit, index) => {
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

    return [...candidates.values()]
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        return right.endTs - left.endTs;
      })
      .slice(0, input.limit);
  }

  private formatSearchHit(hit: ConversationThreadSearchHitWithAttribution, verbose: boolean) {
    return {
      threadId: hit.threadId,
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

  private formatMetadataThread(input: {
    thread: ConversationThreadRow;
    summary: ConversationThreadSummary | null;
    messageCount: number;
  }): ConversationThreadReadOutput["thread"] {
    return {
      threadId: input.thread.thread_id,
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
        platform: "discord",
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

function normalizeMetadataThreadIds(input: { threadIds: readonly string[] }): string[] {
  const raw = input.threadIds;
  const threadIds = [...new Set(raw.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (threadIds.length === 0) throw new Error("conversation thread metadata requires threadIds");
  return threadIds;
}
