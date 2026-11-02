import type { LanguageModelUsage } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  decodeModelsDevRegistry,
  type ModelsDevRegistry,
  type ModelsDevProvider,
  type ModelsDevModel,
} from "./model-catalog-schema";
import { modelCatalogCache } from "./model-catalog-cache";
import { claudeAliasTarget } from "./model-catalog-family";
export { decodeModelsDevRegistry } from "./model-catalog-schema";

import { capturePromiseResult, captureResultOutcome, isPanic } from "./runtime-utils";

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
  /** Optional over-200k context pricing tier from models.dev. */
  context_over_200k?: {
    /** USD per 1M input tokens. */
    input: number;
    /** USD per 1M output tokens. */
    output: number;
    /** USD per 1M cache read tokens (optional). */
    cache_read?: number;
    /** USD per 1M cache write tokens (optional). */
    cache_write?: number;
  };
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
  attachment?: boolean;
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
  /** Whether the model accepts file/image attachments as input. */
  attachment?: boolean;
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
  // Claude Agent SDK models use Anthropic's model catalog and limits.
  "claude-code": "anthropic",
} as const satisfies Record<string, string>;

type RegistryLookupResult = {
  providerEntry: ModelsDevProvider;
  modelEntry: ModelsDevModel;
};

export type ParsedModelSpecifier = {
  provider: string;
  model: string;
};

export class ModelSpecifierInvalid extends TaggedError("ModelSpecifierInvalid")<{
  readonly spec: string;
  readonly message: string;
}> {}

export class ModelCapabilityResolutionFailed extends TaggedError(
  "ModelCapabilityResolutionFailed",
)<{
  readonly spec: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export type ModelCapabilityError = ModelSpecifierInvalid | ModelCapabilityResolutionFailed;

export function parseModelSpecifierResult(
  spec: string,
): ResultType<ParsedModelSpecifier, ModelSpecifierInvalid> {
  const slashIndex = spec.indexOf("/");
  if (slashIndex <= 0 || slashIndex === spec.length - 1) {
    return Result.err(
      new ModelSpecifierInvalid({
        spec,
        message: `Invalid model specifier '${spec}'. Expected format provider/modelstring.`,
      }),
    );
  }

  return Result.ok({
    provider: spec.slice(0, slashIndex),
    model: spec.slice(slashIndex + 1),
  });
}

export function parseModelSpecifier(spec: string): ParsedModelSpecifier {
  const result = parseModelSpecifierResult(spec);
  const resolved = result.match<
    { readonly value: ParsedModelSpecifier } | { readonly error: ModelSpecifierInvalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
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

  private registryPromise: Promise<
    ResultType<ModelsDevRegistry, ModelCapabilityResolutionFailed>
  > | null = null;

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
    return parseModelSpecifierResult(model).match({
      ok: (value) => value,
      err: () => null,
    });
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

  private resolveModelCost(params: {
    registry: ModelsDevRegistry;
    provider: string;
    model: string;
    modelEntry: ModelsDevModel;
  }): ModelCost | undefined {
    const cost = params.modelEntry.cost;
    if (!cost) return undefined;
    if (cost.context_over_200k) return cost;

    const normalizedProvider = this.normalizeProvider(params.provider);
    if (normalizedProvider !== "openrouter" && normalizedProvider !== "vercel") {
      return cost;
    }

    const nested = this.parseNestedModelSpecifier(params.model);
    if (!nested) return cost;

    const nestedProvider = this.normalizeProvider(nested.provider);
    const nestedProviderEntry = params.registry[nestedProvider];
    const nestedModelEntry = this.lookupModelEntry(nestedProviderEntry, nested.model);
    const nestedTier = nestedModelEntry?.cost?.context_over_200k;
    if (!nestedTier) return cost;

    return {
      ...cost,
      context_over_200k: nestedTier,
    };
  }

  private resolveCostForUsage(cost: ModelCost, usage: LanguageModelUsage): ModelCost {
    const tieredCost = cost.context_over_200k;
    if (!tieredCost) return cost;

    const effectiveInputContextTokens = this.resolveInputContextTokensForUsage(usage);
    if (effectiveInputContextTokens <= 200_000) return cost;

    return {
      ...cost,
      input: tieredCost.input,
      output: tieredCost.output,
      cache_read: tieredCost.cache_read ?? cost.cache_read,
      cache_write: tieredCost.cache_write ?? cost.cache_write,
    };
  }

  private resolveInputContextTokensForUsage(usage: LanguageModelUsage): number {
    const inputTokens = usage.inputTokens ?? 0;
    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
    const noCacheTokens = usage.inputTokenDetails.noCacheTokens;

    const hasSaneNoCacheTokens =
      typeof noCacheTokens === "number" &&
      Number.isFinite(noCacheTokens) &&
      noCacheTokens >= 0 &&
      noCacheTokens <= inputTokens;
    if (hasSaneNoCacheTokens) {
      return noCacheTokens + cacheReadTokens + cacheWriteTokens;
    }

    return inputTokens;
  }

  private async loadRegistryResult(
    signal?: AbortSignal,
  ): Promise<ResultType<ModelsDevRegistry, ModelCapabilityResolutionFailed>> {
    if (this.fetchFn === fetch && this.apiUrl === "https://models.dev/api.json") {
      return Result.ok(await modelCatalogCache.read());
    }
    if (!this.registryPromise) {
      this.registryPromise = (async () => {
        const fetched = await capturePromiseResult(() => this.fetchFn(this.apiUrl, { signal }));
        const fetchOutcome = captureResultOutcome(fetched);
        if (!fetchOutcome.ok && isPanic(fetchOutcome.error)) throw fetchOutcome.error;
        if (!fetchOutcome.ok) {
          return Result.err(
            new ModelCapabilityResolutionFailed({
              spec: this.apiUrl,
              cause: fetchOutcome.error,
              message: "Failed to fetch models.dev registry",
            }),
          );
        }
        const response = fetchOutcome.value;
        if (!response.ok) {
          return Result.err(
            new ModelCapabilityResolutionFailed({
              spec: this.apiUrl,
              message: `Failed to fetch models.dev registry (${response.status} ${response.statusText})`,
            }),
          );
        }

        const decoded = await capturePromiseResult(() => response.json() as Promise<unknown>);
        const decodeOutcome = captureResultOutcome(decoded);
        if (!decodeOutcome.ok && isPanic(decodeOutcome.error)) throw decodeOutcome.error;
        if (!decodeOutcome.ok) {
          return Result.err(
            new ModelCapabilityResolutionFailed({
              spec: this.apiUrl,
              cause: decodeOutcome.error,
              message: "models.dev registry response was not valid JSON",
            }),
          );
        }
        const payload = decodeOutcome.value;
        const registry = decodeModelsDevRegistry(payload);
        return registry
          ? Result.ok(registry)
          : Result.err(
              new ModelCapabilityResolutionFailed({
                spec: this.apiUrl,
                message: "models.dev registry JSON has an invalid shape",
              }),
            );
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
      context_over_200k: cost.context_over_200k
        ? {
            input: cost.context_over_200k.input,
            output: cost.context_over_200k.output,
            cache_read: cost.context_over_200k.cache_read,
            cache_write: cost.context_over_200k.cache_write,
          }
        : undefined,
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

  private mergeCostPatchResult(params: {
    spec: string;
    baseCost: ModelCost | undefined;
    patch: Partial<ModelCost> | undefined;
  }): ResultType<ModelCost | undefined, ModelCapabilityResolutionFailed> {
    if (!params.patch) {
      return Result.ok(this.cloneCost(params.baseCost));
    }

    const mergedInput = params.patch.input ?? params.baseCost?.input;
    const mergedOutput = params.patch.output ?? params.baseCost?.output;
    if (mergedInput === undefined || mergedOutput === undefined) {
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec: params.spec,
          message: `Invalid capability override '${params.spec}': cost patch requires cost.input and cost.output (directly or via inherit).`,
        }),
      );
    }

    let contextOver200k: ModelCost["context_over_200k"];
    if (params.patch.context_over_200k !== undefined) {
      contextOver200k = {
        input: params.patch.context_over_200k.input,
        output: params.patch.context_over_200k.output,
        cache_read: params.patch.context_over_200k.cache_read,
        cache_write: params.patch.context_over_200k.cache_write,
      };
    } else if (params.baseCost?.context_over_200k) {
      contextOver200k = {
        input: params.baseCost.context_over_200k.input,
        output: params.baseCost.context_over_200k.output,
        cache_read: params.baseCost.context_over_200k.cache_read,
        cache_write: params.baseCost.context_over_200k.cache_write,
      };
    }

    return Result.ok({
      input: mergedInput,
      output: mergedOutput,
      cache_read: params.patch.cache_read ?? params.baseCost?.cache_read,
      cache_write: params.patch.cache_write ?? params.baseCost?.cache_write,
      input_audio: params.patch.input_audio ?? params.baseCost?.input_audio,
      output_audio: params.patch.output_audio ?? params.baseCost?.output_audio,
      context_over_200k: contextOver200k,
    });
  }

  private mergeModalitiesPatchResult(params: {
    spec: string;
    baseModalities: ModelCapabilityInfo["modalities"];
    patch: ModelCapabilityOverride["modalities"] | undefined;
  }): ResultType<ModelCapabilityInfo["modalities"], ModelCapabilityResolutionFailed> {
    if (!params.patch) {
      return Result.ok(this.cloneModalities(params.baseModalities));
    }

    const mergedInput = params.patch.input ?? params.baseModalities?.input;
    const mergedOutput = params.patch.output ?? params.baseModalities?.output;

    if (!mergedInput) {
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec: params.spec,
          message: `Invalid capability override '${params.spec}': modalities.input is required when overriding modalities without inherit/base modalities.`,
        }),
      );
    }

    return Result.ok({
      input: [...mergedInput],
      output: mergedOutput ? [...mergedOutput] : undefined,
    });
  }

  private async resolveFromRegistryResult(
    spec: ModelSpecifier,
    options?: {
      signal?: AbortSignal;
      bypassForceUnknown?: boolean;
    },
  ): Promise<ResultType<ModelCapabilityInfo, ModelCapabilityError>> {
    const parsed = parseModelSpecifierResult(spec);
    const parsedSpec = parsed.match<ParsedModelSpecifier | ModelSpecifierInvalid>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelSpecifierInvalid.is(parsedSpec)) return Result.err(parsedSpec);
    const provider = this.normalizeProvider(parsedSpec.provider);
    if (
      !options?.bypassForceUnknown &&
      (this.forceUnknownProviders.has(parsedSpec.provider.trim().toLowerCase()) ||
        this.forceUnknownProviders.has(provider.toLowerCase()))
    ) {
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec,
          message: `Model capability lookup intentionally disabled for provider '${parsedSpec.provider}' (spec '${spec}').`,
        }),
      );
    }

    const registryResult = await this.loadRegistryResult(options?.signal);
    const registry = registryResult.match<ModelsDevRegistry | ModelCapabilityResolutionFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelCapabilityResolutionFailed.is(registry)) return Result.err(registry);
    const lookedUp = this.lookupWithFallback({
      registry,
      provider,
      model:
        parsedSpec.provider === "claude-code"
          ? (claudeAliasTarget(registry, parsedSpec.model) ?? parsedSpec.model)
          : parsedSpec.model,
    });

    if (!lookedUp) {
      const providerEntry = registry[provider];
      if (!providerEntry) {
        const available = listSomeKeys(registry, 10);
        return Result.err(
          new ModelCapabilityResolutionFailed({
            spec,
            message: `Unknown provider '${provider}' for spec '${spec}'. Add an override, or ensure models.dev contains it. Available providers (sample): ${available.join(", ")}`,
          }),
        );
      }

      const available = listSomeKeys(providerEntry.models, 10);
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec,
          message: `Unknown model '${parsedSpec.model}' for provider '${provider}' (spec '${spec}'). Add an override, or ensure models.dev contains it. Available models (sample): ${available.join(", ")}`,
        }),
      );
    }

    const { providerEntry, modelEntry } = lookedUp;
    const cost = this.resolveModelCost({
      registry,
      provider: parsedSpec.provider,
      model: parsedSpec.model,
      modelEntry,
    });

    return Result.ok({
      provider: parsedSpec.provider,
      model: parsedSpec.model,
      name: modelEntry.name ?? providerEntry.name,
      family: modelEntry.family,
      env: providerEntry.env,
      npm: providerEntry.npm,
      doc: providerEntry.doc,
      attachment: modelEntry.attachment,
      cost,
      limit: modelEntry.limit,
      modalities: modelEntry.modalities,
    });
  }

  private async resolveWithOverridesResult(
    spec: ModelSpecifier,
    options: { signal?: AbortSignal; stack: readonly string[] },
  ): Promise<ResultType<ModelCapabilityInfo, ModelCapabilityError>> {
    const parsed = parseModelSpecifierResult(spec);
    const parsedSpec = parsed.match<ParsedModelSpecifier | ModelSpecifierInvalid>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelSpecifierInvalid.is(parsedSpec)) return Result.err(parsedSpec);
    const override = this.overrides[spec];
    if (!override) {
      return this.resolveFromRegistryResult(spec, { signal: options.signal });
    }

    if (options.stack.includes(spec)) {
      const chain = [...options.stack, spec].join(" -> ");
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec,
          message: `Model capability override cycle detected: ${chain}`,
        }),
      );
    }

    let base: ModelCapabilityInfo | null = null;
    if (override.inherit) {
      const inherited = await this.resolveWithOverridesResult(override.inherit, {
        signal: options.signal,
        stack: [...options.stack, spec],
      });
      const inheritedValue = inherited.match<ModelCapabilityInfo | ModelCapabilityError>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (
        ModelSpecifierInvalid.is(inheritedValue) ||
        ModelCapabilityResolutionFailed.is(inheritedValue)
      ) {
        return Result.err(inheritedValue);
      }
      base = inheritedValue;
    }

    const mergedContext = override.limit?.context ?? base?.limit.context;
    if (mergedContext === undefined) {
      return Result.err(
        new ModelCapabilityResolutionFailed({
          spec,
          message: `Invalid capability override '${spec}': limit.context is required (directly or via inherit).`,
        }),
      );
    }

    const mergedCost = this.mergeCostPatchResult({
      spec,
      baseCost: base?.cost,
      patch: override.cost,
    });
    const cost = mergedCost.match<ModelCost | undefined | ModelCapabilityResolutionFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelCapabilityResolutionFailed.is(cost)) return Result.err(cost);
    const mergedModalities = this.mergeModalitiesPatchResult({
      spec,
      baseModalities: base?.modalities,
      patch: override.modalities,
    });
    const modalities = mergedModalities.match<
      ModelCapabilityInfo["modalities"] | ModelCapabilityResolutionFailed
    >({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelCapabilityResolutionFailed.is(modalities)) return Result.err(modalities);

    return Result.ok({
      provider: parsedSpec.provider,
      model: parsedSpec.model,
      name: base?.name,
      family: base?.family,
      env: base?.env,
      npm: base?.npm,
      doc: base?.doc,
      attachment: override.attachment ?? base?.attachment,
      cost,
      limit: {
        context: mergedContext,
        output: override.limit?.output ?? base?.limit.output ?? 0,
      },
      modalities,
    });
  }

  async resolveResult(
    spec: ModelSpecifier,
    options?: { signal?: AbortSignal },
  ): Promise<ResultType<ModelCapabilityInfo, ModelCapabilityError>> {
    return await this.resolveWithOverridesResult(spec, {
      signal: options?.signal,
      stack: [],
    });
  }

  async resolve(
    spec: ModelSpecifier,
    options?: { signal?: AbortSignal },
  ): Promise<ModelCapabilityInfo> {
    const result = await this.resolveResult(spec, options);
    const resolved = result.match<
      { readonly value: ModelCapabilityInfo } | { readonly error: ModelCapabilityError }
    >({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in resolved) {
      if (
        resolved.error._tag === "ModelCapabilityResolutionFailed" &&
        Object.hasOwn(resolved.error, "cause")
      ) {
        throw resolved.error.cause;
      }
      throw new Error(resolved.error.message);
    }
    return resolved.value;
  }

  estimateCostUsd(
    info: Pick<ModelCapabilityInfo, "cost">,
    usage: LanguageModelUsage,
  ): number | undefined {
    if (!info.cost) return undefined;

    const resolvedCost = this.resolveCostForUsage(info.cost, usage);

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
    const noCacheTokens = usage.inputTokenDetails.noCacheTokens;
    const cacheReadPrice = resolvedCost.cache_read;
    const cacheWritePrice = resolvedCost.cache_write;

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
    total += (inputTokensAtBaseRate / 1_000_000) * resolvedCost.input;
    total += (outputTokens / 1_000_000) * resolvedCost.output;

    if (hasCacheReadPrice) {
      total += (cacheReadTokens / 1_000_000) * cacheReadPrice;
    }
    if (hasCacheWritePrice) {
      total += (cacheWriteTokens / 1_000_000) * cacheWritePrice;
    }

    return total;
  }
}
