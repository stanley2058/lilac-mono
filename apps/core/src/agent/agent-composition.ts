import type { StoredResourceProviderTarget } from "../transcript/stored-message-materialization";
import type { ResolvedModelPlan, ModelCapabilityInfo } from "@stanley2058/lilac-utils";
import type { BuiltLevel1Toolset } from "../plugins";
import {
  buildExperimentalDownloadForAnthropicFallback,
  isAnthropicModelSpec,
  withStableAnthropicUpstreamOrder,
  type AnthropicFallbackBlobStore,
} from "../surface/bridge/bus-agent-runner/anthropic-fallback-media";
import type { InferOk, InferErr } from "better-result";
import type { ModelMessage, ToolSet } from "ai";
import type {
  AiSdkPiAgentOptions,
  AiSdkPiAgent,
  TransformMessagesContext,
} from "@stanley2058/lilac-agent";
import {
  AgentExternalHostFailed,
  attachAutoCompaction,
  classifyHistoryProviderFamily,
  compactWithOpenAIResponsesResult,
  hasMatchingOpenAIServerCompaction,
  hasOpenAIServerCompaction,
  materializeOpenAIServerCompaction,
} from "@stanley2058/lilac-agent";
import { signalExternalToolCallHost } from "@stanley2058/lilac-agent/agent-runtime-support";
import { AiSdkAgentAdapter } from "@stanley2058/lilac-agent/adapters/ai-sdk/adapter";
import { OpenAIResponsesAgentAdapter } from "@stanley2058/lilac-agent/adapters/openai-responses/adapter";
import { createOpenAIResponsesConnect } from "@stanley2058/lilac-agent/adapters/openai-responses/socket";
import { ClaudeCodeAgentAdapter } from "@stanley2058/lilac-claude-code-bridge";
import { env, type ResolvedModelRef, type CoreConfig } from "@stanley2058/lilac-utils";
import { createOpenAIResponsesSseModelProvider } from "@stanley2058/lilac-utils/model-provider";
import { resolveOpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import type { CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";
import type { AgentRunProfile } from "../surface/bridge/bus-agent-runner/raw";
import type { TranscriptStore, TranscriptSnapshot } from "../transcript/transcript-store";
import {
  prepareCoreNamedHistoryView,
  shouldReplayCoreNamedHistory,
} from "../surface/bridge/bus-agent-runner/core-named-continuation";
import {
  prepareCorePrimaryHistoryView,
  shouldReplayCorePrimaryHistory,
} from "../surface/bridge/bus-agent-runner/core-primary-continuation";
import {
  applyCompleteLevel1Tools,
  resolveCoreClaudeCompactionSummaryModel,
  type CoreClaudeComposition,
} from "./claude-composition";
import {
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withOpenAIPromptCacheKey,
  withOpenAIServerCompaction,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
  withProviderOptionsOnLastUserMessage,
  ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
} from "../surface/bridge/bus-agent-runner/provider-options";

type AdapterOptions = Omit<AiSdkPiAgentOptions<ToolSet>, "adapterFactory">;
type CompactionOptions = Parameters<typeof attachAutoCompaction>[1];
export type CoreAgentBinding = {
  readonly resolved: ResolvedModelRef;
  readonly anthropicPromptCachingEnabled: boolean;
};
export function createCoreAgentAdapter(
  options: AdapterOptions,
  input: {
    readonly resolved: ResolvedModelRef;
    readonly claude: CoreClaudeComposition;
    readonly openai?: Parameters<typeof resolveOpenAIResponsesConnectionOptions>[0];
  },
) {
  const { resolved, claude } = input;
  const runtime = claude.namedRuntime ?? claude.primaryRuntime;
  if (resolved.provider === "claude-code") {
    return new ClaudeCodeAgentAdapter(options, {
      currentRun: () => claude.run ?? runtime?.currentRun() ?? null,
      prepareModelCall: runtime?.prepareModelCall,
      recordSuccessfulModelCall: runtime
        ? (messages) => runtime.recordSuccessfulModelCall(messages)
        : undefined,
      retireForRetry: runtime ? () => runtime.retireForRetry() : undefined,
    });
  }
  const settings = input.openai ?? env.providers.openai;
  if (
    resolved.provider !== "openai" ||
    settings.responsesTransport === "sse" ||
    options.model !== resolved.model
  ) {
    return new AiSdkAgentAdapter(options);
  }
  const resolvedConnection = resolveOpenAIResponsesConnectionOptions(settings);
  const connection = resolvedConnection.match<
    | { kind: "ready"; value: InferOk<typeof resolvedConnection> }
    | { kind: "invalid"; error: InferErr<typeof resolvedConnection> }
  >({
    ok: (value) => ({ kind: "ready" as const, value }),
    err: (error) => ({ kind: "invalid" as const, error }),
  });
  if (connection.kind === "invalid") return signalCompositionHost(connection.error);
  return new OpenAIResponsesAgentAdapter({
    model: resolved.modelId,
    transport: settings.responsesTransport,
    connect: createOpenAIResponsesConnect(connection.value),
    fallback: new AiSdkAgentAdapter({
      ...options,
      model: createOpenAIResponsesSseModelProvider().responses(resolved.modelId),
    }),
    executionMode: "single-agent",
  });
}
function signalCompositionHost(error: Error): never {
  return signalExternalToolCallHost(
    new AgentExternalHostFailed({ cause: error, message: error.message }),
  );
}
export function createCoreAgentComposition(input: {
  readonly getBinding: () => CoreAgentBinding;
  readonly claude: CoreClaudeComposition;
  readonly getAgent: () => AiSdkPiAgent<ToolSet>;
  readonly runProfile: AgentRunProfile;
  readonly hasNamedContinuation: boolean;
  readonly getLineage: () => CorePrimaryLineageV2 | undefined;
  readonly transcriptStore: TranscriptStore | undefined;
  readonly sourceMessages: readonly ModelMessage[];
  readonly sourceTranscript: TranscriptSnapshot | null;
  readonly getCurrentTurnMessages: () => readonly ModelMessage[];
  readonly onReplayFallback: (error: Error) => void;
  readonly onUtilityModelFailure: Parameters<
    typeof resolveCoreClaudeCompactionSummaryModel
  >[0]["onFailure"];
}) {
  const runtime = input.claude.namedRuntime ?? input.claude.primaryRuntime;
  const disabledReplayKeys = new Set<string>();
  let activeReplayKey: string | null = null;
  const configuredReplayKey = () => {
    const binding = input.getBinding();
    return binding.resolved.openaiServerCompaction
      ? `${binding.resolved.provider}:${binding.resolved.spec}`
      : undefined;
  };
  const prepareHistory = (
    messages: readonly ModelMessage[],
    context: TransformMessagesContext,
    fullBudget: boolean,
  ): readonly ModelMessage[] => {
    const configuredKey = configuredReplayKey();
    const replayKey =
      configuredKey && !disabledReplayKeys.has(configuredKey) ? configuredKey : undefined;
    activeReplayKey =
      configuredKey && hasMatchingOpenAIServerCompaction(messages, replayKey)
        ? (replayKey ?? null)
        : null;
    const materialized =
      configuredKey || hasOpenAIServerCompaction(messages)
        ? materializeOpenAIServerCompaction(messages, replayKey)
        : messages;
    const projected = projectHistory(materialized, context, fullBudget);
    if (
      configuredKey &&
      disabledReplayKeys.has(configuredKey) &&
      hasMatchingOpenAIServerCompaction(messages, configuredKey)
    ) {
      input.getAgent().replaceMessages(materializeOpenAIServerCompaction(messages, undefined), {
        reason: "compaction",
        preserveRecoveryCheckpoint: true,
      });
      disabledReplayKeys.delete(configuredKey);
    }
    return projected;
  };
  const projectHistory = (
    messages: readonly ModelMessage[],
    context: TransformMessagesContext,
    fullBudget: boolean,
  ): readonly ModelMessage[] => {
    if (input.claude.namedRuntime) return input.claude.namedRuntime.prepareHistoryView(messages);
    if (input.claude.primaryRuntime)
      return fullBudget
        ? input.claude.primaryRuntime.prepareFullBudgetView(messages, context.canonicalStartIndex)
        : input.claude.primaryRuntime.prepareHistoryView(messages);
    const binding = input.getBinding();
    const targetFamily = classifyHistoryProviderFamily({ type: binding.resolved.provider });
    if (input.runProfile === "primary") {
      const lineage = input.getLineage();
      return prepareCorePrimaryHistoryView({
        canonicalMessages: messages,
        lineage,
        replayHistoricalPrefix: shouldReplayCorePrimaryHistory({
          lineage,
          historicalEnd: lineage?.currentCanonicalStart ?? 0,
          store: input.transcriptStore ?? {},
          targetFamily,
        }),
        targetFamily,
        modelSpecifier: binding.resolved.spec,
        canonicalStartIndex: context.canonicalStartIndex,
      });
    }
    if (!input.hasNamedContinuation) return messages;
    return prepareCoreNamedHistoryView({
      canonicalMessages: messages,
      sourceMessages: input.sourceMessages,
      currentTurnMessages: input.getCurrentTurnMessages(),
      replayHistoricalPrefix: shouldReplayCoreNamedHistory({
        sourceTranscript: input.sourceTranscript,
        targetFamily,
      }),
      targetFamily,
      modelSpecifier: binding.resolved.spec,
    });
  };
  const recoverProtocolFailure = (
    error: Error,
    context: Parameters<NonNullable<CompactionOptions["baseTurnErrorHandler"]>>[1],
  ): boolean => {
    if (
      !activeReplayKey ||
      context.phase !== "model-call" ||
      !context.retrySafety.canRetry ||
      context.abortSignal?.aborted
    )
      return false;
    disabledReplayKeys.add(activeReplayKey);
    activeReplayKey = null;
    input.onReplayFallback(error);
    return true;
  };
  const compaction: Pick<
    CompactionOptions,
    | "summaryModel"
    | "thresholdInputSource"
    | "inputEstimateFloor"
    | "decorateRequestPayload"
    | "serverCompaction"
    | "serverCompactionEnabled"
  > = {
    summaryModel:
      input.getBinding().resolved.provider === "claude-code"
        ? () =>
            resolveCoreClaudeCompactionSummaryModel({
              run: input.claude.run ?? runtime?.currentRun() ?? null,
              fallback: () => input.getBinding().resolved.model,
              onFailure: input.onUtilityModelFailure,
            })
        : "current",
    thresholdInputSource:
      input.getBinding().resolved.provider === "claude-code" ? "transcript-estimate" : "usage",
    inputEstimateFloor: runtime ? (estimate) => runtime.inputEstimateFloor(estimate) : undefined,
    decorateRequestPayload: (payload) => {
      const requestPayload =
        payload.length === 0 && runtime
          ? [{ role: "user" as const, content: "Continue after the completed tool call." }]
          : [...payload];
      return input.getBinding().anthropicPromptCachingEnabled
        ? withProviderOptionsOnLastUserMessage(
            requestPayload,
            ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
          )
        : requestPayload;
    },
    serverCompaction: async ({ messages, portableSummary, context, abortSignal }) => {
      const replayKey = configuredReplayKey();
      if (!replayKey)
        return signalCompositionHost(
          new Error("OpenAI server compaction is disabled for the active model"),
        );
      const agent = input.getAgent();
      const compacted = await compactWithOpenAIResponsesResult({
        model: agent.state.model,
        replayKey,
        portableSummary,
        messages,
        system: context?.system ?? agent.state.system,
        tools: context?.tools,
        providerOptions: agent.state.providerOptions,
        reasoning: agent.state.reasoning,
        abortSignal,
      });
      const result = compacted.match<
        | { kind: "ready"; value: InferOk<typeof compacted> }
        | { kind: "failed"; error: InferErr<typeof compacted> }
      >({
        ok: (value) => ({ kind: "ready" as const, value }),
        err: (error) => ({ kind: "failed" as const, error }),
      });
      if (result.kind === "failed") return signalCompositionHost(result.error);
      return result.value;
    },
    serverCompactionEnabled: () => {
      const key = configuredReplayKey();
      return key !== undefined && !disabledReplayKeys.has(key);
    },
  };
  const configureOptions = (
    options: AiSdkPiAgentOptions<ToolSet>,
    host: {
      hasModelFallback: boolean;
      refreshTools: NonNullable<AiSdkPiAgentOptions<ToolSet>["beforeStep"]>;
    },
  ): AiSdkPiAgentOptions<ToolSet> => ({
    ...options,
    model: input.claude.run?.agentModel ?? options.model,
    adapterFactory: (latest) =>
      createCoreAgentAdapter(latest, {
        resolved: input.getBinding().resolved,
        claude: input.claude,
      }),
    ...(host.hasModelFallback || runtime ? { streamTextMaxRetries: 0 } : {}),
    beforeStep:
      input.getBinding().resolved.provider === "claude-code" ? undefined : host.refreshTools,
    sendToolsToModel: input.getBinding().resolved.provider !== "claude-code",
  });
  const initializeTools = (agent: AiSdkPiAgent<ToolSet>, toolset: BuiltLevel1Toolset) => {
    if (input.getBinding().resolved.provider === "claude-code")
      applyCompleteLevel1Tools(agent, toolset);
  };
  const retireForRetry = async () => {
    await runtime?.retireForRetry();
  };
  return {
    configureOptions,
    initializeTools,
    retireForRetry,
    prepareHistory,
    recoverProtocolFailure,
    compaction,
  };
}

export function prepareCoreProviderBinding(input: {
  readonly resolved: ResolvedModelRef;
  readonly reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"];
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly blobStore: AnthropicFallbackBlobStore;
}) {
  const { resolved, reasoningDisplay, systemPrompt, sessionId, blobStore } = input;
  const anthropicModel = isAnthropicModelSpec(resolved.spec);
  const anthropicPromptCachingEnabled = shouldEnableAnthropicPromptCache({
    spec: resolved.spec,
    anthropicPromptCache: resolved.anthropicPromptCache,
  });

  const providerOptionsWithOpenAIReasoningSummary = withReasoningSummaryDefaultForOpenAIModels({
    reasoningDisplay,
    provider: resolved.provider,
    modelId: resolved.modelId,
    providerOptions: resolved.providerOptions,
  });
  const providerOptionsWithReasoningDisplay = withReasoningDisplayDefaultForAnthropicModels({
    reasoningDisplay,
    provider: resolved.provider,
    modelId: resolved.modelId,
    providerOptions: providerOptionsWithOpenAIReasoningSummary,
  });
  const providerOptionsWithPromptCacheKey =
    resolved.provider === "openai" || resolved.provider === "codex"
      ? withOpenAIPromptCacheKey(
          providerOptionsWithReasoningDisplay,
          toOpenAIPromptCacheKey(sessionId),
        )
      : providerOptionsWithReasoningDisplay;
  const providerOptionsWithServerCompaction = resolved.openaiServerCompaction
    ? withOpenAIServerCompaction(providerOptionsWithPromptCacheKey)
    : providerOptionsWithPromptCacheKey;
  const providerOptionsForAgent = anthropicModel
    ? withStableAnthropicUpstreamOrder(resolved.provider, providerOptionsWithServerCompaction)
    : providerOptionsWithServerCompaction;

  const agentSystem = anthropicPromptCachingEnabled
    ? {
        role: "system" as const,
        content: systemPrompt,
        providerOptions: ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
      }
    : systemPrompt;
  const experimentalDownload = buildExperimentalDownloadForAnthropicFallback({
    blobStore,
    spec: resolved.spec,
    provider: resolved.provider,
    providerOptions: providerOptionsForAgent,
  });
  return {
    anthropicPromptCachingEnabled,
    providerOptionsForAgent,
    agentSystem,
    experimentalDownload,
  };
}

export function supportsCoreModelFallback(
  resolved: ResolvedModelRef,
  fallbackCount: number,
): boolean {
  return resolved.provider !== "claude-code" && fallbackCount > 0;
}

export function resolveStoredResourceProviderTarget(input: {
  readonly provider: ResolvedModelRef["provider"];
  readonly capability: ModelCapabilityInfo | null;
}): StoredResourceProviderTarget {
  if (input.provider === "claude-code") {
    return { family: "claude-code", supportsImage: true, supportsPdf: false };
  }
  const supportsAttachments = input.capability?.attachment === true;
  const inputModalities = input.capability?.modalities?.input ?? [];
  return {
    family: "ai-sdk",
    supportsImage: supportsAttachments && inputModalities.includes("image"),
    supportsPdf: supportsAttachments && inputModalities.includes("pdf"),
  };
}

export function selectNextNativeModelFallback(params: {
  plan: ResolvedModelPlan;
  activeIndex: number;
  onSkipClaudeCode?: (candidate: ResolvedModelRef, index: number) => void;
}): { candidate: ResolvedModelRef; index: number } | null {
  const candidates = [params.plan.head, ...params.plan.fallbacks];
  const current = candidates[params.activeIndex];
  if (!current) return null;
  const latchedFamily = classifyHistoryProviderFamily({
    type: params.plan.head.provider,
  });
  if (latchedFamily === "claude-code") return null;

  for (let index = params.activeIndex + 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (classifyHistoryProviderFamily({ type: candidate.provider }) !== latchedFamily) {
      params.onSkipClaudeCode?.(candidate, index);
      continue;
    }
    return { candidate, index };
  }
  return null;
}
