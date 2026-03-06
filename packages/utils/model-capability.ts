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

export type ModelCapabilityOverride = {
  /** Optional base model capability to inherit from (provider/model). */
  inherit?: ModelSpecifier;
  /** Optional partial cost patch merged onto inherited/base cost. */
  cost?: Partial<ModelCost>;
  /** Optional partial limit patch merged onto inherited/base limits. */
  limit?: {
    context?: number;
    output?: number;
  };
  /** Optional partial modalities patch merged onto inherited/base modalities. */
  modalities?: {
    input?: ModelModality[];
    output?: ModelModality[];
  };
};

export type ModelCapabilityOverrides = Record<ModelSpecifier, ModelCapabilityOverride>;

export type ModelCapabilityOptions = {
  /** Optional overrides that take priority over models.dev. */
  overrides?: ModelCapabilityOverrides;
  /** Optional provider alias mapping merged with defaults. */
  providerAliases?: Record<string, string>;
  /** Providers to always treat as unknown/unresolved capability. */
  forceUnknownProviders?: readonly string[];
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
  private readonly forceUnknownProviders: ReadonlySet<string>;
  private readonly apiUrl: string;
  private readonly fetchFn: typeof fetch;

  private registryPromise: Promise<ModelsDevRegistry> | null = null;

  constructor(options?: ModelCapabilityOptions) {
    this.overrides = options?.overrides ?? {};
    this.providerAliases = {
      ...DEFAULT_PROVIDER_ALIASES,
      ...options?.providerAliases,
    };
    this.forceUnknownProviders = new Set(
      (options?.forceUnknownProviders ?? []).map((provider) => provider.trim().toLowerCase()),
    );
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

  private modelLookupCandidates(model: string): string[] {
    const candidates = [model];

    // Some providers encode version separators differently (e.g. 4.6 vs 4-6).
    const dotToDash = model.replace(/(\d)\.(\d)/g, "$1-$2");
    if (dotToDash !== model) {
      candidates.push(dotToDash);
    }

    const dashToDot = model.replace(/(\d)-(\d)/g, "$1.$2");
    if (dashToDot !== model && dashToDot !== dotToDash) {
      candidates.push(dashToDot);
    }

    return candidates;
  }

  private lookupModelEntry(
    providerEntry: ModelsDevProvider | undefined,
    model: string,
  ): ModelsDevModel | null {
    if (!providerEntry) return null;

    for (const candidate of this.modelLookupCandidates(model)) {
      const modelEntry = providerEntry.models[candidate];
      if (modelEntry) return modelEntry;
    }

    return null;
  }

  private lookupWithFallback(params: {
    registry: ModelsDevRegistry;
    provider: string;
    model: string;
  }): RegistryLookupResult | null {
    const providerEntry = params.registry[params.provider];
    const directModelEntry = this.lookupModelEntry(providerEntry, params.model);
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
    const fallbackModelEntry = this.lookupModelEntry(fallbackProviderEntry, nested.model);
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

  private cloneCost(cost: ModelCost | undefined): ModelCost | undefined {
    if (!cost) return undefined;
    return {
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read,
      cache_write: cost.cache_write,
      input_audio: cost.input_audio,
      output_audio: cost.output_audio,
    };
  }

  private cloneModalities(
    modalities: ModelCapabilityInfo["modalities"],
  ): ModelCapabilityInfo["modalities"] {
    if (!modalities) return undefined;
    return {
      input: [...modalities.input],
      output: modalities.output ? [...modalities.output] : undefined,
    };
  }

  private mergeCostPatch(params: {
    spec: string;
    baseCost: ModelCost | undefined;
    patch: Partial<ModelCost> | undefined;
  }): ModelCost | undefined {
    if (!params.patch) {
      return this.cloneCost(params.baseCost);
    }

    const mergedInput = params.patch.input ?? params.baseCost?.input;
    const mergedOutput = params.patch.output ?? params.baseCost?.output;
    if (mergedInput === undefined || mergedOutput === undefined) {
      throw new Error(
        `Invalid capability override '${params.spec}': cost patch requires cost.input and cost.output (directly or via inherit).`,
      );
    }

    return {
      input: mergedInput,
      output: mergedOutput,
      cache_read: params.patch.cache_read ?? params.baseCost?.cache_read,
      cache_write: params.patch.cache_write ?? params.baseCost?.cache_write,
      input_audio: params.patch.input_audio ?? params.baseCost?.input_audio,
      output_audio: params.patch.output_audio ?? params.baseCost?.output_audio,
    };
  }

  private mergeModalitiesPatch(params: {
    spec: string;
    baseModalities: ModelCapabilityInfo["modalities"];
    patch: ModelCapabilityOverride["modalities"] | undefined;
  }): ModelCapabilityInfo["modalities"] {
    if (!params.patch) {
      return this.cloneModalities(params.baseModalities);
    }

    const mergedInput = params.patch.input ?? params.baseModalities?.input;
    const mergedOutput = params.patch.output ?? params.baseModalities?.output;

    if (!mergedInput) {
      throw new Error(
        `Invalid capability override '${params.spec}': modalities.input is required when overriding modalities without inherit/base modalities.`,
      );
    }

    return {
      input: [...mergedInput],
      output: mergedOutput ? [...mergedOutput] : undefined,
    };
  }

  private async resolveFromRegistry(
    spec: ModelSpecifier,
    options?: {
      signal?: AbortSignal;
      bypassForceUnknown?: boolean;
    },
  ): Promise<ModelCapabilityInfo> {
    const parsed = parseModelSpecifier(spec);
    const provider = this.normalizeProvider(parsed.provider);
    if (
      !options?.bypassForceUnknown &&
      (this.forceUnknownProviders.has(parsed.provider.trim().toLowerCase()) ||
        this.forceUnknownProviders.has(provider.toLowerCase()))
    ) {
      throw new Error(
        `Model capability lookup intentionally disabled for provider '${parsed.provider}' (spec '${spec}').`,
      );
    }

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

  private async resolveWithOverrides(
    spec: ModelSpecifier,
    options: { signal?: AbortSignal; stack: readonly string[] },
  ): Promise<ModelCapabilityInfo> {
    const parsed = parseModelSpecifier(spec);
    const override = this.overrides[spec];
    if (!override) {
      return this.resolveFromRegistry(spec, { signal: options.signal });
    }

    if (options.stack.includes(spec)) {
      const chain = [...options.stack, spec].join(" -> ");
      throw new Error(`Model capability override cycle detected: ${chain}`);
    }

    let base: ModelCapabilityInfo | null = null;
    if (override.inherit) {
      base = await this.resolveWithOverrides(override.inherit, {
        signal: options.signal,
        stack: [...options.stack, spec],
      });
    }

    const mergedContext = override.limit?.context ?? base?.limit.context;
    if (mergedContext === undefined) {
      throw new Error(
        `Invalid capability override '${spec}': limit.context is required (directly or via inherit).`,
      );
    }

    const mergedCost = this.mergeCostPatch({
      spec,
      baseCost: base?.cost,
      patch: override.cost,
    });
    const mergedModalities = this.mergeModalitiesPatch({
      spec,
      baseModalities: base?.modalities,
      patch: override.modalities,
    });

    return {
      provider: parsed.provider,
      model: parsed.model,
      name: base?.name,
      family: base?.family,
      env: base?.env,
      npm: base?.npm,
      doc: base?.doc,
      cost: mergedCost,
      limit: {
        context: mergedContext,
        output: override.limit?.output ?? base?.limit.output ?? 0,
      },
      modalities: mergedModalities,
    };
  }

  async resolve(
    spec: ModelSpecifier,
    options?: { signal?: AbortSignal },
  ): Promise<ModelCapabilityInfo> {
    return await this.resolveWithOverrides(spec, {
      signal: options?.signal,
      stack: [],
    });
  }

  estimateCostUsd(
    info: Pick<ModelCapabilityInfo, "cost">,
    usage: LanguageModelUsage,
  ): number | undefined {
    if (!info.cost) return undefined;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
    const noCacheTokens = usage.inputTokenDetails.noCacheTokens;
    const cacheReadPrice = info.cost.cache_read;
    const cacheWritePrice = info.cost.cache_write;

    const hasCacheReadPrice = cacheReadPrice !== undefined;
    const hasCacheWritePrice = cacheWritePrice !== undefined;

    const hasSaneNoCacheTokens =
      typeof noCacheTokens === "number" &&
      Number.isFinite(noCacheTokens) &&
      noCacheTokens >= 0 &&
      noCacheTokens <= inputTokens;

    let inputTokensAtBaseRate: number;
    if (hasSaneNoCacheTokens) {
      inputTokensAtBaseRate = noCacheTokens;
      if (!hasCacheReadPrice) {
        inputTokensAtBaseRate += cacheReadTokens;
      }
      if (!hasCacheWritePrice) {
        inputTokensAtBaseRate += cacheWriteTokens;
      }
    } else {
      inputTokensAtBaseRate = inputTokens;
      if (hasCacheReadPrice) {
        inputTokensAtBaseRate -= cacheReadTokens;
      }
      if (hasCacheWritePrice) {
        inputTokensAtBaseRate -= cacheWriteTokens;
      }
      inputTokensAtBaseRate = Math.max(0, inputTokensAtBaseRate);
    }

    let total = 0;
    total += (inputTokensAtBaseRate / 1_000_000) * info.cost.input;
    total += (outputTokens / 1_000_000) * info.cost.output;

    if (hasCacheReadPrice) {
      total += (cacheReadTokens / 1_000_000) * cacheReadPrice;
    }
    if (hasCacheWritePrice) {
      total += (cacheWriteTokens / 1_000_000) * cacheWritePrice;
    }

    return total;
  }
}
