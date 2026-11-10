import { autoInjectPlannerContext, decisionAutoInjectContext } from "./text-units";
import { buildGeneratedMessage, generatedMessageMetadata } from "@stanley2058/lilac-agent";
import { captureError } from "../../../shared/error-capture";
import { type ModelMessage } from "ai";
import { Result, type Result as ResultType } from "better-result";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { env, isRecord, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { buildSyntheticToolCallId } from "@stanley2058/lilac-agent";
import {
  createConversationThreadAutoInjectUsageAccumulator,
  type ConversationThreadAutoInjectUsageAccumulator,
  type ConversationThreadSearchResult,
  type ConversationThreadToolService,
} from "../../../conversation/thread-service";
import {
  rankAutoInjectedThreadSearchResults,
  type RankedAutoInjectThread,
} from "../../../conversation/thread-auto-inject-ranking";
import { collectDecisionAutoInjectImages } from "../../../conversation/thread-auto-inject-images";
import {
  createDecisionAutoInjectEvaluator,
  decideDecisionAutoInject,
  selectDecisionAutoInjectModel,
  DecisionAutoInjectEvaluationFailed,
  type DecisionAutoInjectAnswers,
  type DecisionAutoInjectEvaluator,
  type DecisionAutoInjectUnavailable,
} from "../../../conversation/thread-auto-inject-decision";
import { getParticipantUserIdsFromRaw, type AgentRunnerRaw } from "./raw";
import { latestUserInput, shouldRunAutoInjectedThreadSearch } from "./text-units";
import { type BusAgentRunnerErrorProjection, projectBusAgentRunnerError } from "./errors";

function buildAutoInjectedThreadSearchToolCallId(requestId: string): string {
  return buildSyntheticToolCallId({
    prefix: "conversation_thread_search",
    seed: `${requestId}:auto-inject`,
  });
}

const AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME = "conversation_thread_search";

export const AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH = 320;

const AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD = Math.floor(
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1,
);

export type AutoInjectedThreadSearchPayload = {
  entries: Array<{
    surface: "discord" | "native";
    threadId: string;
    /** The `conversation.thread.read` offset where the recalled subject starts. */
    offset?: number;
    title: string;
    brief?: string;
    timeRange?: string;
  }>;
};

type AutoInjectedThreadSearchEntry = AutoInjectedThreadSearchPayload["entries"][number] & {
  entryId?: string;
};

type AutoInjectedThreadRankingDiagnostic = {
  threadId: string;
  rawScore: number;
  confidence: number;
  searchIndex: number;
  rank: number;
  breakdown: RankedAutoInjectThread["breakdown"];
};

type AutoInjectedThreadSearchAppendedEvent = {
  toolCallId: string;
  mode: "hybrid" | "semantic" | "lexical";
  limit: number;
  minScore: number;
  searches: readonly (readonly string[])[];
  participantFilterUserCount: number;
  entries: readonly AutoInjectedThreadSearchEntry[];
  ranking: readonly (AutoInjectedThreadRankingDiagnostic & {
    selection: RankedAutoInjectThread["selection"];
  })[];
  highestRejectedByConfidence: AutoInjectedThreadRankingDiagnostic | null;
  expansionMinConfidence: number;
  corpusDocumentCount: number;
};

type DecisionAutoInjectedThreadSearchEvent = {
  mode: "off" | "shadow" | "enforce";
  outcome: "search" | "skip" | "failed" | "length-skip";
  model?: string;
  probabilities?: Pick<DecisionAutoInjectAnswers, "mayHelp" | "clearlyUnneeded">;
  elapsedMs: number;
};

type AutoInjectToolStatusUpdate = {
  toolCallId: string;
  status: "start" | "end";
  display: string;
  ok?: boolean;
  error?: string;
  /** Shown only in native activity details; Discord tool status keeps the label alone. */
  output?: string;
};

export function buildAutoInjectedThreadSearchMessages(params: {
  toolCallId: string;
  entries: readonly AutoInjectedThreadSearchEntry[];
  note?: string;
}): ModelMessage[] {
  const payload: AutoInjectedThreadSearchPayload = {
    entries: params.entries.map((entry) => ({
      threadId: entry.threadId,
      surface: entry.surface,
      ...(entry.offset ? { offset: entry.offset } : {}),
      title: entry.title,
      ...(entry.brief ? { brief: entry.brief } : {}),
      ...(entry.timeRange ? { timeRange: entry.timeRange } : {}),
    })),
  };

  return [
    buildGeneratedMessage({
      kind: "conversation_recall",
      id: params.toolCallId,
      // Entry ids, so another subject of the same thread can still be recalled later.
      threadIds: params.entries.map((entry) => entry.entryId ?? entry.threadId),
      content: JSON.stringify({
        note: params.note ?? "auto-injected after long user input",
        ...payload,
      }),
    }),
  ];
}

function formatAutoInjectedThreadSearchOutput(
  entries: readonly AutoInjectedThreadSearchEntry[],
): string {
  if (entries.length === 0) return "No related threads injected.";
  const lines = entries.map((entry) =>
    entry.timeRange ? `- ${entry.title} (${entry.timeRange})` : `- ${entry.title}`,
  );
  const noun = entries.length === 1 ? "thread" : "threads";
  return [`Injected ${entries.length} related ${noun}:`, ...lines].join("\n");
}

function formatAutoInjectedThreadBrief(brief: string): string | undefined {
  const trimmed = brief.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= AUTO_INJECTED_THREAD_BRIEF_FULL_THRESHOLD) return trimmed;

  return `${trimmed.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH).trimEnd()} ...(${trimmed.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`;
}

function formatAutoInjectedThreadSearchResult(
  result: ConversationThreadSearchResult["results"][number],
): AutoInjectedThreadSearchEntry {
  const timeRange = result.timeRange ? formatInjectedThreadTimeRange(result.timeRange) : undefined;
  const brief = formatAutoInjectedThreadBrief(result.brief);
  return {
    threadId: result.threadId,
    entryId: result.entryId ?? result.threadId,
    surface: result.surface,
    ...(result.offset ? { offset: result.offset } : {}),
    title: result.title,
    ...(brief ? { brief } : {}),
    ...(timeRange ? { timeRange } : {}),
  };
}

/** A thread's first entry id is its thread id, which is what older transcripts recorded. */
function collectAutoInjectedEntryIds(messages: readonly ModelMessage[]): Set<string> {
  const entryIds = new Set<string>();

  for (const message of messages) {
    const generated = generatedMessageMetadata(message);
    if (generated?.kind === "conversation_recall" && Array.isArray(generated.threadIds)) {
      for (const id of generated.threadIds) {
        if (typeof id === "string") entryIds.add(id);
      }
      continue;
    }
    const content: unknown = message.content;
    if (message.role !== "tool" || !Array.isArray(content)) continue;

    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type !== "tool-result" || part.toolName !== AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME) {
        continue;
      }

      const output = part.output;
      const payload = isRecord(output) && output.type === "json" ? output.value : output;
      const entries = isRecord(payload) ? payload.entries : undefined;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const threadId = entry.threadId;
        if (typeof threadId === "string" && threadId.length > 0) entryIds.add(threadId);
      }
    }
  }

  return entryIds;
}

function padLocalDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalThreadTime(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const year = date.getFullYear();
  const month = padLocalDatePart(date.getMonth() + 1);
  const day = padLocalDatePart(date.getDate());
  const hour = padLocalDatePart(date.getHours());
  const minute = padLocalDatePart(date.getMinutes());
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function formatInjectedThreadTimeRange(input: { start: string; end: string }): string | undefined {
  const start = formatLocalThreadTime(input.start);
  const end = formatLocalThreadTime(input.end);
  if (!start || !end) return undefined;
  return `${start} - ${end}`;
}

async function publishAutoInjectToolStatusBestEffort(
  params: {
    publishToolStatus: (update: AutoInjectToolStatusUpdate) => Promise<void>;
    onError: (message: string, error: BusAgentRunnerErrorProjection) => void;
  },
  update: AutoInjectToolStatusUpdate,
): Promise<void> {
  const attempt = await Result.tryPromise({
    try: async () => {
      await params.publishToolStatus(update);
    },
    catch: captureError,
  });

  if (attempt.isErr()) {
    params.onError(
      "auto-injected thread search status publish failed; continuing",
      projectBusAgentRunnerError(attempt.error.cause),
    );
  }
}

function notifyAutoInjectObserverBestEffort(
  onError: (message: string, error: BusAgentRunnerErrorProjection) => void,
  notify: () => void,
): void {
  const attempt = Result.try({ try: notify, catch: captureError });

  if (attempt.isErr()) {
    onError(
      "auto-injected thread search append log failed; continuing",
      projectBusAgentRunnerError(attempt.error.cause),
    );
  }
}

type AutoInjectedThreadSearchParams = {
  surface?: "discord" | "native";
  cfg: CoreConfig;
  conversationThreads?: ConversationThreadToolService;
  requestId: string;
  /** Session of the request; for native requests this is also the current conversation thread id. */
  sessionId?: string;
  raw?: AgentRunnerRaw;
  previousMessages?: readonly ModelMessage[];
  userMessages: readonly ModelMessage[];
  publishToolStatus: (update: AutoInjectToolStatusUpdate) => Promise<void>;
  onInjected?: (event: AutoInjectedThreadSearchAppendedEvent) => void;
  onDecisionEvaluated?: (event: DecisionAutoInjectedThreadSearchEvent) => void;
  onError: (message: string, error: BusAgentRunnerErrorProjection) => void;
  autoInjectUsage?: ConversationThreadAutoInjectUsageAccumulator;
  loadDecisionUserMessages?: () => Promise<readonly ModelMessage[]>;
  /** Overrides the configured decision evaluator; used by tests. */
  createDecisionEvaluator?: (
    model: string,
  ) => ResultType<DecisionAutoInjectEvaluator, DecisionAutoInjectUnavailable>;
};

type DecisionEvaluatorResolution =
  | { kind: "ready"; model: string; evaluator: DecisionAutoInjectEvaluator }
  | { kind: "unavailable"; message: string };

type DecisionEvaluationOutcome =
  | { kind: "answered"; answers: DecisionAutoInjectAnswers }
  | { kind: "failed"; message: string };

function createEnvDecisionAutoInjectEvaluator(
  model: string,
): ResultType<DecisionAutoInjectEvaluator, DecisionAutoInjectUnavailable> {
  const settings = model.startsWith("openai/") ? env.providers.openai : env.providers.typesafe;
  return createDecisionAutoInjectEvaluator({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model,
  });
}

function resolveDecisionAutoInjectEvaluator(
  params: AutoInjectedThreadSearchParams,
  hasImages: boolean,
): DecisionEvaluatorResolution {
  const model = selectDecisionAutoInjectModel(
    params.cfg.conversation.thread.autoInject.gate?.model ?? [],
    hasImages,
  );
  const create = params.createDecisionEvaluator ?? createEnvDecisionAutoInjectEvaluator;
  return create(model).match<DecisionEvaluatorResolution>({
    ok: (evaluator) => ({ kind: "ready", model, evaluator }),
    err: (error) => ({ kind: "unavailable", message: error.message }),
  });
}

async function prepareDecisionAutoInjectImages(
  params: AutoInjectedThreadSearchParams,
): Promise<ResultType<string[], DecisionAutoInjectEvaluationFailed>> {
  const latest = latestUserInput(params.userMessages);
  const supportsImages = (params.cfg.conversation.thread.autoInject.gate?.model ?? []).some(
    (model) => model.startsWith("openai/"),
  );
  if (!supportsImages || (!latest.hasAttachment && !params.loadDecisionUserMessages))
    return Result.ok([]);
  const prepared = await Result.tryPromise({
    try: async () =>
      latestUserInput(
        await (params.loadDecisionUserMessages?.() ?? Promise.resolve(params.userMessages)),
      ).content,
    catch: (cause) =>
      new DecisionAutoInjectEvaluationFailed({
        message: opaqueErrorMessage(cause, "Decision image materialization failed"),
      }),
  });
  return Result.gen(async function* () {
    const content = yield* prepared;
    const images = yield* Result.await(
      collectDecisionAutoInjectImages({
        content,
        maxBytesPerPart: params.cfg.tools.media.maxInlineBytesPerPart,
        maxBytesTotal: params.cfg.tools.media.maxInlineBytesTotal,
      }),
    );
    return Result.ok(images);
  });
}

async function shouldSkipAutoInjectByDecision(
  params: AutoInjectedThreadSearchParams,
  autoInjectUsage: ConversationThreadAutoInjectUsageAccumulator,
): Promise<boolean> {
  const gate = params.cfg.conversation.thread.autoInject.gate;
  if (!gate || gate.mode === "off") return false;
  const startedAt = performance.now();
  const notify = (event: Omit<DecisionAutoInjectedThreadSearchEvent, "mode" | "elapsedMs">) =>
    notifyAutoInjectObserverBestEffort(params.onError, () =>
      params.onDecisionEvaluated?.({
        ...event,
        mode: gate.mode,
        elapsedMs: performance.now() - startedAt,
      }),
    );
  const prepared = (await prepareDecisionAutoInjectImages(params)).match<
    { kind: "prepared"; images: string[] } | { kind: "failed"; message: string }
  >({
    ok: (images) => ({ kind: "prepared", images }),
    err: (error) => ({ kind: "failed", message: error.message }),
  });
  if (prepared.kind === "failed") {
    notify({ outcome: "failed" });
    params.onError(
      "Decision image preparation failed; continuing to planner",
      projectBusAgentRunnerError(new Error(prepared.message)),
    );
    return false;
  }
  const latest = latestUserInput(params.userMessages);
  if (latest.hasAttachment && !latest.authoredText.trim() && prepared.images.length === 0) {
    notify({ outcome: "search" });
    return false;
  }
  const resolution = resolveDecisionAutoInjectEvaluator(params, prepared.images.length > 0);
  if (resolution.kind === "unavailable") {
    notify({ outcome: "failed" });
    params.onError(
      "Decision gate unavailable; continuing to planner",
      projectBusAgentRunnerError(new Error(resolution.message)),
    );
    return false;
  }
  const evaluator = resolution.evaluator;
  const evaluated = await evaluator.evaluate({
    message: decisionAutoInjectContext(
      latestUserInput(params.userMessages).authoredText,
      params.previousMessages ?? [],
    ),
    images: evaluator.supportsImages ? prepared.images : undefined,
  });
  autoInjectUsage.recordTiming("decision", performance.now() - startedAt);
  const outcome = evaluated.match<DecisionEvaluationOutcome>({
    ok: (answers) => ({ kind: "answered", answers }),
    err: (error) => ({ kind: "failed", message: error.message }),
  });
  if (outcome.kind === "failed") {
    notify({ outcome: "failed", model: evaluator.model });
    params.onError(
      "Decision gate evaluation failed; continuing to planner",
      projectBusAgentRunnerError(new Error(outcome.message)),
    );
    return false;
  }
  const { answers } = outcome;
  autoInjectUsage.recordDecisionUsage({ model: evaluator.model, ...answers.usage });
  const decision = decideDecisionAutoInject(answers, gate.skipMinProbability);
  notify({
    outcome: decision,
    model: evaluator.model,
    probabilities: { mayHelp: answers.mayHelp, clearlyUnneeded: answers.clearlyUnneeded },
  });
  return gate.mode === "enforce" && decision === "skip";
}

export async function maybeBuildAutoInjectedThreadSearchMessages(
  params: AutoInjectedThreadSearchParams,
): Promise<ModelMessage[]> {
  const autoInject = params.cfg.conversation.thread.autoInject;
  if (!autoInject.enabled) return [];
  if (!params.conversationThreads) return [];
  const conversationThreads = params.conversationThreads;
  const autoInjectUsage =
    params.autoInjectUsage ??
    createConversationThreadAutoInjectUsageAccumulator({ requestId: params.requestId });
  const latestInput = latestUserInput(params.userMessages);
  const text = autoInjectPlannerContext(latestInput.text, params.previousMessages ?? []);
  const previouslyInjectedEntryIds = collectAutoInjectedEntryIds(params.previousMessages ?? []);
  const minTextUnits =
    previouslyInjectedEntryIds.size > 0 ? autoInject.followUpMinTextUnits : autoInject.minTextUnits;
  if (
    !latestInput.hasAttachment &&
    !shouldRunAutoInjectedThreadSearch({
      text: latestInput.authoredText,
      minTextUnits,
    })
  ) {
    notifyAutoInjectObserverBestEffort(params.onError, () =>
      params.onDecisionEvaluated?.({
        mode: autoInject.gate?.mode ?? "off",
        outcome: "length-skip",
        elapsedMs: 0,
      }),
    );
    autoInjectUsage.finish({ status: "abstained" });
    return [];
  }
  if (await shouldSkipAutoInjectByDecision(params, autoInjectUsage)) {
    autoInjectUsage.finish({ status: "abstained" });
    return [];
  }

  const participantIds =
    autoInject.filterCurrentParticipants && params.surface !== "native"
      ? getParticipantUserIdsFromRaw(params.raw)
      : [];

  let usageStatus: "completed" | "abstained" | "partial" | "failed" = "failed";
  let usageSearchCount = 0;
  let usageQueryCount = 0;

  const toolCallId = buildAutoInjectedThreadSearchToolCallId(params.requestId);
  const display = `${AUTO_INJECTED_THREAD_SEARCH_TOOL_NAME} auto-injected metadata`;
  const publishToolStatusBestEffort = async (update: AutoInjectToolStatusUpdate) =>
    await publishAutoInjectToolStatusBestEffort(params, update);

  await publishToolStatusBestEffort({ toolCallId, status: "start", display });

  {
    const attempt = await Result.tryPromise({
      try: async () => {
        const planningStartedAt = performance.now();
        const plan = await conversationThreads.planAutoInjectSearch({
          text,
          content:
            typeof latestInput.content === "string"
              ? text
              : [
                  ...(text ? [{ type: "text" as const, text }] : []),
                  ...latestInput.content.filter((part) => part.type !== "text"),
                ],
          autoInjectUsage,
        });
        autoInjectUsage.recordTiming("planning", performance.now() - planningStartedAt);
        usageSearchCount = plan.searches.length;
        usageQueryCount = plan.searches.reduce(
          (sum, searchPlan) => sum + searchPlan.queries.length,
          0,
        );
        if (plan.searches.length === 0) {
          usageStatus = "abstained";
          await publishToolStatusBestEffort({
            toolCallId,
            status: "end",
            display,
            ok: true,
            output: formatAutoInjectedThreadSearchOutput([]),
          });
          return [];
        }
        const searchRecallLimit = Math.min(50, Math.max(autoInject.limit * 5, 10));
        const searchStartedAt = performance.now();
        const settledSearches = await Promise.allSettled(
          plan.searches.map((searchPlan) =>
            conversationThreads.search({
              query: searchPlan.queries,
              queryAboutness: searchPlan.aboutness,
              limit: searchRecallLimit,
              minScore: autoInject.minScore,
              mode: autoInject.mode,
              verbose: true,
              autoInjectUsage,
              ...(participantIds.length > 0
                ? { participantIdsAny: participantIds, participantSurface: params.surface }
                : {}),
            }),
          ),
        );
        autoInjectUsage.recordTiming("search", performance.now() - searchStartedAt);
        let fulfilledSearches = 0;
        const successfulSearches: Array<{
          searchIndex: number;
          result: ConversationThreadSearchResult;
        }> = [];
        settledSearches.forEach((result, searchIndex) => {
          if (result.status === "fulfilled") {
            fulfilledSearches += 1;
            successfulSearches.push({ searchIndex, result: result.value });
            return;
          }

          params.onError(
            "auto-injected thread search failed; continuing with partial metadata",
            projectBusAgentRunnerError(result.reason, `Search ${searchIndex} failed`),
          );
        });
        if (fulfilledSearches === 0) {
          const failure = projectBusAgentRunnerError(
            new Error("all auto-injected thread searches failed"),
          );
          await publishToolStatusBestEffort({
            toolCallId,
            status: "end",
            display,
            ok: false,
            error: failure.message,
          });
          params.onError(
            "auto-injected thread search failed; continuing without metadata",
            failure,
          );
          return [];
        }
        usageStatus = fulfilledSearches === plan.searches.length ? "completed" : "partial";
        const corpusStartedAt = performance.now();
        const corpusDocuments =
          (await conversationThreads.getAutoInjectRankingCorpusDocuments?.()) ?? [];
        autoInjectUsage.recordTiming("corpus", performance.now() - corpusStartedAt);
        const rankingStartedAt = performance.now();
        const rankingResult = rankAutoInjectedThreadSearchResults({
          plan,
          searches: successfulSearches,
          corpusDocuments,
          excludedEntryIds: previouslyInjectedEntryIds,
          limit: autoInject.limit,
          expansionMinConfidence: autoInject.expansionMinConfidence,
        });
        autoInjectUsage.recordTiming("ranking", performance.now() - rankingStartedAt);
        const rankedEntries = rankingResult.selected;
        const entries = rankedEntries.map((candidate) =>
          formatAutoInjectedThreadSearchResult(candidate.result),
        );

        await publishToolStatusBestEffort({
          toolCallId,
          status: "end",
          display,
          ok: true,
          output: formatAutoInjectedThreadSearchOutput(entries),
        });

        if (entries.length === 0) return [];
        {
          const attempt = Result.try({
            try: () => {
              params.onInjected?.({
                toolCallId,
                mode: autoInject.mode,
                limit: autoInject.limit,
                minScore: autoInject.minScore,
                searches: plan.searches.map((searchPlan) => searchPlan.queries),
                participantFilterUserCount: participantIds.length,
                entries,
                ranking: rankedEntries.map((entry) => ({
                  threadId: entry.result.threadId,
                  rawScore: entry.rawScore,
                  confidence: entry.confidence,
                  selection: entry.selection,
                  searchIndex: entry.searchIndex,
                  rank: entry.rank,
                  breakdown: entry.breakdown,
                })),
                highestRejectedByConfidence: rankingResult.highestRejectedByConfidence
                  ? {
                      threadId: rankingResult.highestRejectedByConfidence.result.threadId,
                      rawScore: rankingResult.highestRejectedByConfidence.rawScore,
                      confidence: rankingResult.highestRejectedByConfidence.confidence,
                      searchIndex: rankingResult.highestRejectedByConfidence.searchIndex,
                      rank: rankingResult.highestRejectedByConfidence.rank,
                      breakdown: rankingResult.highestRejectedByConfidence.breakdown,
                    }
                  : null,
                expansionMinConfidence: autoInject.expansionMinConfidence,
                corpusDocumentCount: corpusDocuments.length,
              });
            },
            catch: captureError,
          });

          if (attempt.isErr()) {
            const error = attempt.error.cause;
            params.onError(
              "auto-injected thread search append log failed; continuing",
              projectBusAgentRunnerError(error),
            );
          }
        }
        return buildAutoInjectedThreadSearchMessages({ toolCallId, entries });
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const error = attempt.error.cause;
      const projected = projectBusAgentRunnerError(error);
      await publishToolStatusBestEffort({
        toolCallId,
        status: "end",
        display,
        ok: false,
        error: projected.message,
      });
      params.onError("auto-injected thread search failed; continuing without metadata", projected);
      autoInjectUsage.finish({
        status: "failed",
        searchCount: usageSearchCount,
        queryCount: usageQueryCount,
      });
      return [];
    }
    autoInjectUsage.finish({
      status: usageStatus,
      searchCount: usageSearchCount,
      queryCount: usageQueryCount,
    });
    return attempt.value;
  }
}
