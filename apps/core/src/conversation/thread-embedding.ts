import { embed, type EmbeddingModel } from "ai";
import {
  createLogger,
  providers,
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

export type ConversationThreadEmbeddingAdapter = {
  modelId: string;
  dimensions?: number;
  embed(input: {
    text: string;
    facet?: ConversationThreadEmbeddingFacet | "query";
  }): Promise<Float32Array>;
};

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

export function createConversationThreadEmbeddingAdapter(
  cfg: CoreConfig,
): ConversationThreadEmbeddingAdapter | null {
  const embeddingConfig = cfg.conversation.thread.embedding;
  if (!embeddingConfig.enabled) return null;

  const resolved = resolveModelRef(
    cfg,
    { model: embeddingConfig.model },
    "conversation.thread.embedding.model",
  );
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
      logger.info("conversation.thread.embedding.usage", {
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
