import { embed, type EmbeddingModel } from "ai";
import {
  createLogger,
  formatTaggedErrorForLog,
  providers,
  openAICompatibleServersOf,
  routeOpenAICompatibleModel,
  type OpenAICompatibleServers,
  type ResolvedModelRef,
  resolveModelRefResult,
  type ModelResolutionFailed,
  type CoreConfig,
  type JSONObject,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

const logger = createLogger({
  module: "conversation-thread",
});

export type ConversationThreadEmbeddingFacet =
  | "combined"
  | "aboutnessDomains"
  | "aboutnessSituations"
  | "aboutnessComplaintTargets"
  | "aboutnessEntities"
  | "userWouldAskForThisAs"
  | "brief"
  | "retrievalHints"
  | "topics"
  | "title";

export type ConversationThreadFacetInput = {
  facet: ConversationThreadEmbeddingFacet;
  text: string;
};

export type ConversationThreadEmbeddingUsageEvent = {
  modelSpec: string;
  provider: string;
  modelId: string;
  facet?: ConversationThreadEmbeddingFacet | "query";
  inputChars: number;
  tokens: number;
  warnings: number;
  elapsedMs?: number;
};

export type ConversationThreadEmbeddingAdapter = {
  modelId: string;
  dimensions?: number;
  embed(input: {
    text: string;
    facet?: ConversationThreadEmbeddingFacet | "query";
    onUsage?: (event: ConversationThreadEmbeddingUsageEvent) => void;
  }): Promise<Float32Array>;
};

export type ConversationThreadEmbeddingAdapterResolver =
  () => Promise<ConversationThreadEmbeddingAdapter | null>;

type EmbeddingProvider = NonNullable<(typeof providers)[string]> & {
  embeddingModel(modelId: string): EmbeddingModel;
};

function getEmbeddingModel(
  ref: ResolvedModelRef,
  openAICompatibleServers: OpenAICompatibleServers,
): EmbeddingModel | null {
  if (ref.provider === "openai-compatible") {
    return routeOpenAICompatibleModel(ref.modelId, openAICompatibleServers).match({
      ok: (route) => route.provider.embeddingModel(route.modelId),
      err: () => null,
    });
  }
  const provider: EmbeddingProvider | null = providers[ref.provider] ?? null;
  return provider?.embeddingModel(ref.modelId) ?? null;
}

type ResolvedEmbeddingModels = { document: ResolvedModelRef; query: ResolvedModelRef };

function resolveConversationThreadEmbeddingModel(
  cfg: CoreConfig,
): ResultType<ResolvedEmbeddingModels | null, ModelResolutionFailed> {
  const embeddingConfig = cfg.conversation.thread.embedding;
  if (!embeddingConfig.enabled) return Result.ok(null);

  return Result.gen(function* () {
    const document = yield* resolveModelRefResult(
      cfg,
      { model: embeddingConfig.model },
      "conversation.thread.embedding.model",
    );
    if (!embeddingConfig.queryModel) return Result.ok({ document, query: document });
    const query = yield* resolveModelRefResult(
      cfg,
      { model: embeddingConfig.queryModel },
      "conversation.thread.embedding.queryModel",
    );
    return Result.ok({ document, query });
  });
}

function embeddingAdapterCacheKey(resolved: ResolvedEmbeddingModels | null): string {
  if (!resolved) return "disabled";
  return JSON.stringify(
    [resolved.document, resolved.query].map((model) => ({
      provider: model.provider,
      modelId: model.modelId,
      spec: model.spec,
      providerOptions: model.providerOptions ?? null,
    })),
  );
}

function createConversationThreadEmbeddingAdapterFromResolved(
  resolved: ResolvedEmbeddingModels | null,
  openAICompatibleServers: OpenAICompatibleServers,
): ConversationThreadEmbeddingAdapter | null {
  if (!resolved) return null;

  const documentModel = getEmbeddingModel(resolved.document, openAICompatibleServers);
  const queryModel = getEmbeddingModel(resolved.query, openAICompatibleServers);
  if (!documentModel || !queryModel) return null;

  return {
    modelId: resolved.document.spec,
    async embed(input) {
      const selected = input.facet === "query" ? resolved.query : resolved.document;
      const model = input.facet === "query" ? queryModel : documentModel;
      const providerOptions = selected.providerOptions as Record<string, JSONObject> | undefined;
      const startedAt = performance.now();
      const result = await embed({
        model,
        value: input.text,
        providerOptions,
      });
      input.onUsage?.({
        modelSpec: selected.spec,
        provider: selected.provider,
        modelId: selected.modelId,
        facet: input.facet,
        inputChars: input.text.length,
        tokens: result.usage.tokens,
        warnings: result.warnings.length,
        elapsedMs: performance.now() - startedAt,
      });
      return Float32Array.from(result.embedding);
    },
  };
}

export function createConversationThreadEmbeddingAdapter(
  cfg: CoreConfig,
): ResultType<ConversationThreadEmbeddingAdapter | null, ModelResolutionFailed> {
  return resolveConversationThreadEmbeddingModel(cfg).map((resolved) =>
    createConversationThreadEmbeddingAdapterFromResolved(resolved, openAICompatibleServersOf(cfg)),
  );
}

export function createConversationThreadEmbeddingAdapterResolver(
  getConfig: () => Promise<CoreConfig>,
): ConversationThreadEmbeddingAdapterResolver {
  let cached: {
    key: string;
    adapter: ConversationThreadEmbeddingAdapter | null;
  } | null = null;
  let pending: Promise<ConversationThreadEmbeddingAdapter | null> | null = null;

  const resolve = async (): Promise<ConversationThreadEmbeddingAdapter | null> => {
    const config = await getConfig();
    return resolveConversationThreadEmbeddingModel(config).match({
      err: (error) => () => {
        logger.warn("conversation thread embeddings disabled", formatTaggedErrorForLog(error));
        return null;
      },
      ok: (resolved) => () => {
        const servers = openAICompatibleServersOf(config);
        const key = JSON.stringify([embeddingAdapterCacheKey(resolved), servers]);
        if (cached?.key === key) return cached.adapter;

        const adapter = createConversationThreadEmbeddingAdapterFromResolved(resolved, servers);
        cached = { key, adapter };
        return adapter;
      },
    })();
  };

  return async () => {
    if (pending) return pending;
    pending = resolve().finally(() => {
      pending = null;
    });
    return pending;
  };
}
