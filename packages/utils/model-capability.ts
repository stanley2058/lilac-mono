import type { LanguageModelUsage } from "ai";

export type ModelSpecifier = string;

export type ModelModality = "text" | "image" | "audio" | "video" | "pdf";

export type ModelCost = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache read tokens (optional). */
  cache_read?: number;
  /** USD per 1M cache write tokens (optional). */
  cache_write?: number;
  /** USD per 1M input audio. */
  input_audio?: number;
  /** USD per 1M output audio. */
  output_audio?: number;
};

export type ModelLimits = {
  context: number;
  output: number;
};

export type ModelCapabilityInfo = {
  provider: string;
  model: string;
  name?: string;
  family?: string;
  env?: string[];
  npm?: string;
  doc?: string;
  cost?: ModelCost;
  limit: ModelLimits;
  modalities?: {
    input: ModelModality[];
    output?: ModelModality[];
  };
};

export type ModelCapabilityOverrides = Record<
  ModelSpecifier,
  {
    cost?: ModelCost;
    limit: {
      context: number;
      output?: number;
    };
    modalities?: {
      input: ModelModality[];
      output?: ModelModality[];
    };
  }
>;

export type ModelCapabilityOptions = {
  /** Optional overrides that take priority over models.dev. */
  overrides?: ModelCapabilityOverrides;
  /** Optional provider alias mapping merged with defaults. */
  providerAliases?: Record<string, string>;
  /** Override models.dev URL for testing. */
  apiUrl?: string;
  /** Inject custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
};

const DEFAULT_PROVIDER_ALIASES = {
  // Our internal provider id for OpenAI Codex OAuth; models.dev uses "openai".
  codex: "openai",
} as const satisfies Record<string, string>;

type ModelsDevRegistry = Record<string, ModelsDevProvider>;

type ModelsDevProvider = {
  id: string;
  env?: string[];
  npm: string;
  name: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
};

type ModelsDevModel = {
  id: string;
  name: string;
  family: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities: {
    input: ModelModality[];
    output: ModelModality[];
  };
  open_weights?: boolean;
  cost?: ModelCost;
  limit: ModelLimits;
};

type RegistryLookupResult = {
  providerEntry: ModelsDevProvider;
  modelEntry: ModelsDevModel;
};

export function parseModelSpecifier(spec: string): {
  provider: string;
  model: string;
} {
  const slashIndex = spec.indexOf("/");
  if (slashIndex <= 0 || slashIndex === spec.length - 1) {
    throw new Error(`Invalid model specifier '${spec}'. Expected format provider/modelstring.`);
  }

  return {
    provider: spec.slice(0, slashIndex),
    model: spec.slice(slashIndex + 1),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function listSomeKeys(input: Record<string, unknown>, max: number): string[] {
  return Object.keys(input).slice(0, max);
}

export class ModelCapability {
  private readonly overrides: ModelCapabilityOverrides;
  private readonly providerAliases: Record<string, string>;
  private readonly apiUrl: string;
  private readonly fetchFn: typeof fetch;

  private registryPromise: Promise<ModelsDevRegistry> | null = null;

  constructor(options?: ModelCapabilityOptions) {
    this.overrides = options?.overrides ?? {};
    this.providerAliases = {
      ...DEFAULT_PROVIDER_ALIASES,
      ...options?.providerAliases,
    };
    this.apiUrl = options?.apiUrl ?? "https://models.dev/api.json";
    this.fetchFn = options?.fetch ?? fetch;
  }

  private normalizeProvider(provider: string): string {
    return this.providerAliases[provider] ?? provider;
  }

  private parseNestedModelSpecifier(model: string): { provider: string; model: string } | null {
    try {
      return parseModelSpecifier(model);
    } catch {
      return null;
    }
  }

  private lookupWithFallback(params: {
    registry: ModelsDevRegistry;
    provider: string;
    model: string;
  }): RegistryLookupResult | null {
    const providerEntry = params.registry[params.provider];
    const directModelEntry = providerEntry?.models[params.model];
    if (providerEntry && directModelEntry) {
      return {
        providerEntry,
        modelEntry: directModelEntry,
      };
    }

    if (params.provider !== "openrouter" && params.provider !== "vercel") {
      return null;
    }

    const nested = this.parseNestedModelSpecifier(params.model);
    if (!nested) return null;

    const fallbackProvider = this.normalizeProvider(nested.provider);
    const fallbackProviderEntry = params.registry[fallbackProvider];
    const fallbackModelEntry = fallbackProviderEntry?.models[nested.model];
    if (!fallbackProviderEntry || !fallbackModelEntry) {
      return null;
    }

    return {
      providerEntry: providerEntry ?? fallbackProviderEntry,
      modelEntry: fallbackModelEntry,
    };
  }

  private async loadRegistry(signal?: AbortSignal): Promise<ModelsDevRegistry> {
    if (!this.registryPromise) {
      this.registryPromise = (async () => {
        const res = await this.fetchFn(this.apiUrl, { signal });
        if (!res.ok) {
          throw new Error(`Failed to fetch models.dev registry (${res.status} ${res.statusText})`);
        }

        const json = (await res.json()) as unknown;
        const record = asRecord(json);
        if (!record) {
          throw new Error("models.dev registry JSON is not an object");
        }

        return record as ModelsDevRegistry;
      })();
    }

    return await this.registryPromise;
  }

  async resolve(
    spec: ModelSpecifier,
    options?: { signal?: AbortSignal },
  ): Promise<ModelCapabilityInfo> {
    const override = this.overrides[spec];
    if (override) {
      const { provider, model } = parseModelSpecifier(spec);
      return {
        provider,
        model,
        cost: override.cost,
        limit: {
          context: override.limit.context,
          output: override.limit.output ?? 0,
        },
        modalities: override.modalities,
      };
    }

    const parsed = parseModelSpecifier(spec);
    const provider = this.normalizeProvider(parsed.provider);

    const registry = await this.loadRegistry(options?.signal);
    const lookedUp = this.lookupWithFallback({
      registry,
      provider,
      model: parsed.model,
    });

    if (!lookedUp) {
      const providerEntry = registry[provider];
      if (!providerEntry) {
        const available = listSomeKeys(registry, 10);
        throw new Error(
          `Unknown provider '${provider}' for spec '${spec}'. Add an override, or ensure models.dev contains it. Available providers (sample): ${available.join(", ")}`,
        );
      }

      const available = listSomeKeys(providerEntry.models, 10);
      throw new Error(
        `Unknown model '${parsed.model}' for provider '${provider}' (spec '${spec}'). Add an override, or ensure models.dev contains it. Available models (sample): ${available.join(", ")}`,
      );
    }

    const { providerEntry, modelEntry } = lookedUp;

    return {
      provider: parsed.provider,
      model: parsed.model,
      name: modelEntry.name ?? providerEntry.name,
      family: modelEntry.family,
      env: providerEntry.env,
      npm: providerEntry.npm,
      doc: providerEntry.doc,
      cost: modelEntry.cost,
      limit: modelEntry.limit,
      modalities: modelEntry.modalities,
    };
  }

  estimateCostUsd(
    info: Pick<ModelCapabilityInfo, "cost">,
    usage: LanguageModelUsage,
  ): number | undefined {
    if (!info.cost) return undefined;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;

    let total = 0;
    total += (inputTokens / 1_000_000) * info.cost.input;
    total += (outputTokens / 1_000_000) * info.cost.output;

    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;

    if (info.cost.cache_read !== undefined) {
      total += (cacheReadTokens / 1_000_000) * info.cost.cache_read;
    }
    if (info.cost.cache_write !== undefined) {
      total += (cacheWriteTokens / 1_000_000) * info.cost.cache_write;
    }

    return total;
  }
}
