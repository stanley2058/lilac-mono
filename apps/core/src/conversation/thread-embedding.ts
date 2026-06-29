import { embed, type EmbeddingModel } from "ai";
import {
  createLogger,
  providers,
  type ResolvedModelRef,
  resolveModelRef,
  type CoreConfig,
  type JSONObject,
} from "@stanley2058/lilac-utils";

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

type EmbeddingProvider = {
  embeddingModel(modelId: string): EmbeddingModel;
};

function hasEmbeddingModel(provider: unknown): provider is EmbeddingProvider {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return false;
  const record = provider as Record<string, unknown>;
  return typeof record.embeddingModel === "function";
}

function getProvider(providerId: string): unknown {
  for (const [id, provider] of Object.entries(providers)) {
    if (id === providerId) return provider;
  }
  return null;
}

function resolveConversationThreadEmbeddingModel(cfg: CoreConfig): ResolvedModelRef | null {
  const embeddingConfig = cfg.conversation.thread.embedding;
  if (!embeddingConfig.enabled) return null;

  return resolveModelRef(
    cfg,
    { model: embeddingConfig.model },
    "conversation.thread.embedding.model",
  );
}

function embeddingAdapterCacheKey(resolved: ResolvedModelRef | null): string {
  if (!resolved) return "disabled";
  return JSON.stringify({
    provider: resolved.provider,
    modelId: resolved.modelId,
    spec: resolved.spec,
    providerOptions: resolved.providerOptions ?? null,
  });
}

function createConversationThreadEmbeddingAdapterFromResolved(
  resolved: ResolvedModelRef | null,
): ConversationThreadEmbeddingAdapter | null {
  if (!resolved) return null;

  const provider = getProvider(resolved.provider);
  if (!hasEmbeddingModel(provider)) {
    throw new Error(`Provider '${resolved.provider}' does not expose embedding models`);
  }

  const model = provider.embeddingModel(resolved.modelId);
  const providerOptions = resolved.providerOptions as Record<string, JSONObject> | undefined;

  return {
    modelId: resolved.spec,
    async embed(input) {
      const result = await embed({
        model,
        value: input.text,
        providerOptions,
      });
      input.onUsage?.({
        modelSpec: resolved.spec,
        provider: resolved.provider,
        modelId: resolved.modelId,
        facet: input.facet,
        inputChars: input.text.length,
        tokens: result.usage.tokens,
        warnings: result.warnings.length,
      });
      return Float32Array.from(result.embedding);
    },
  };
}

export function createConversationThreadEmbeddingAdapter(
  cfg: CoreConfig,
): ConversationThreadEmbeddingAdapter | null {
  return createConversationThreadEmbeddingAdapterFromResolved(
    resolveConversationThreadEmbeddingModel(cfg),
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
    const cfg = await getConfig();
    try {
      const resolved = resolveConversationThreadEmbeddingModel(cfg);
      const key = embeddingAdapterCacheKey(resolved);
      if (cached?.key === key) return cached.adapter;

      const adapter = createConversationThreadEmbeddingAdapterFromResolved(resolved);
      cached = { key, adapter };
      return adapter;
    } catch (e) {
      logger.warn("conversation thread embeddings disabled", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };

  return async () => {
    if (pending) return pending;
    pending = resolve().finally(() => {
      pending = null;
    });
    return pending;
  };
}
