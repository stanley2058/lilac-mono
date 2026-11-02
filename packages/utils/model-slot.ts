import type { LanguageModel } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { providers, type Providers } from "./model-provider";
import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions";
import type {
  ConfiguredModelChainEntry,
  ConfiguredModelRef,
  CoreConfig,
  JSONObject,
  JSONValue,
  ModelReasoningEffort,
} from "./core-config";
import { createLogger } from "./logging";
import { isRecord } from "./runtime-utils";
import { parseModelSpecifierResult } from "./model-capability";
import {
  formatModelProviderOptionWarning,
  normalizeConfiguredModelProviderOptions,
  validateModelProviderOptions,
} from "./model-provider-option-validation";

import { modelRuleDefaults, mergeModelOptions } from "./model-rules";

const logger = createLogger({ module: "utils:model-slot" });
const warnedProviderOptions = new Set<string>();

export type ModelSlot = "main" | "fast";

export type ResolvedModelSlot = {
  slot: ModelSlot;
  /** If models.<slot>.model was an alias, this is set. */
  alias?: string;
  /** Canonical model spec in provider/model format. */
  spec: string;
  provider: string;
  modelId: string;
  /** Model instance created from the configured provider. */
  model: LanguageModel;
  /** AI SDK providerOptions; may include multiple provider namespaces. */
  providerOptions?: { [x: string]: JSONObject };
  /** Portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;
  /** Optional Responses API commentary-phase behavior toggle for OpenAI/Codex providers. */
  responseCommentary?: boolean;
  /** Explicit opt-in for OpenAI server-side compaction. */
  openaiServerCompaction?: true;
  /** Opt-in Anthropic cache-control injection for system prompt + latest user message. */
  anthropicPromptCache?: boolean;
  /** Durable workflow candidates may retain the display policy from their dispatch. */
  reasoningDisplay?: CoreConfig["agent"]["reasoningDisplay"];
};

export type ResolvedModelRef = Omit<ResolvedModelSlot, "slot">;

export type ResolvedModelPlan = {
  head: ResolvedModelRef;
  fallbacks: readonly ResolvedModelRef[];
};

export class ModelResolutionFailed extends TaggedError("ModelResolutionFailed")<{
  readonly issue:
    | "invalid-spec"
    | "durable-mismatch"
    | "unsupported-compaction-provider"
    | "unknown-alias"
    | "invalid-alias-target"
    | "unknown-provider"
    | "provider-not-configured"
    | "invalid-server-compaction-option";
  readonly source: string;
  readonly message: string;
}> {}

export type DurableJsonValue =
  | null
  | string
  | number
  | boolean
  | DurableJsonObject
  | DurableJsonArray;
export interface DurableJsonObject {
  [key: string]: DurableJsonValue;
}
export interface DurableJsonArray extends Array<DurableJsonValue> {}

type DurableResolvedModelRequestBase = {
  alias?: string;
  spec: string;
  provider: string;
  modelId: string;
  providerOptions?: Record<string, DurableJsonObject>;
  reasoning?: ModelReasoningEffort;
  responseCommentary?: boolean;
  openaiServerCompaction?: true;
  anthropicPromptCache?: boolean;
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"];
};

export type DurableResolvedModelRequest = DurableResolvedModelRequestBase & {
  /** Optional for compatibility with policies persisted before model fallback support. */
  fallbacks?: DurableResolvedModelRequestBase[];
};

export function toDurableResolvedModelRequest(
  resolved: ResolvedModelRef,
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"],
): DurableResolvedModelRequest {
  const compactJsonObject = (value: JSONObject): DurableJsonObject =>
    Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        child === undefined ? [] : [[key, compactJsonValue(child)]],
      ),
    );
  const compactJsonValue = (value: JSONValue): DurableJsonValue => {
    if (value === null || typeof value !== "object") return value;
    if (isRecord(value)) return compactJsonObject(value);
    return value.map(compactJsonValue);
  };
  const providerOptions = resolved.providerOptions
    ? Object.fromEntries(
        Object.entries(resolved.providerOptions).map(([key, value]) => [
          key,
          compactJsonObject(value),
        ]),
      )
    : undefined;
  return {
    ...(resolved.alias ? { alias: resolved.alias } : {}),
    spec: resolved.spec,
    provider: resolved.provider,
    modelId: resolved.modelId,
    ...(providerOptions ? { providerOptions } : {}),
    ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
    ...(resolved.responseCommentary ? { responseCommentary: true } : {}),
    ...(resolved.openaiServerCompaction ? { openaiServerCompaction: true } : {}),
    ...(resolved.anthropicPromptCache ? { anthropicPromptCache: true } : {}),
    reasoningDisplay: resolved.reasoningDisplay ?? reasoningDisplay,
  };
}

export function toDurableResolvedModelPlan(
  plan: ResolvedModelPlan,
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"],
): DurableResolvedModelRequest {
  return {
    ...toDurableResolvedModelRequest(plan.head, reasoningDisplay),
    fallbacks: plan.fallbacks.map((fallback) =>
      toDurableResolvedModelRequest(fallback, reasoningDisplay),
    ),
  };
}

export function fromDurableResolvedModelRequestResult(
  request: DurableResolvedModelRequest,
): ResultType<ResolvedModelRef, ModelResolutionFailed> {
  const parsed = parseModelSpecifierResult(request.spec).match<
    { provider: string; model: string } | string
  >({
    ok: (value) => value,
    err: (error) => error.message,
  });
  if (typeof parsed === "string") {
    return Result.err(
      new ModelResolutionFailed({
        issue: "invalid-spec",
        source: "durable model request",
        message: parsed,
      }),
    );
  }
  if (parsed.provider !== request.provider || parsed.model !== request.modelId) {
    return Result.err(
      new ModelResolutionFailed({
        issue: "durable-mismatch",
        source: "durable model request",
        message: "Durable model request does not match its canonical model spec",
      }),
    );
  }
  if (
    request.openaiServerCompaction &&
    request.provider !== "openai" &&
    request.provider !== "codex"
  ) {
    return Result.err(
      new ModelResolutionFailed({
        issue: "unsupported-compaction-provider",
        source: "durable model request",
        message: "Durable OpenAI server compaction is supported only by openai and codex providers",
      }),
    );
  }
  const provider = providers[request.provider as Providers];
  if (typeof provider !== "function") {
    return Result.err(
      new ModelResolutionFailed({
        issue: "provider-not-configured",
        source: "durable model request",
        message: `Provider '${request.provider}' is not configured for durable dispatch`,
      }),
    );
  }
  return Result.ok({
    ...(request.alias ? { alias: request.alias } : {}),
    spec: request.spec,
    provider: request.provider,
    modelId: request.modelId,
    model: provider(request.modelId),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.responseCommentary ? { responseCommentary: true } : {}),
    ...(request.openaiServerCompaction ? { openaiServerCompaction: true } : {}),
    ...(request.anthropicPromptCache ? { anthropicPromptCache: true } : {}),
    reasoningDisplay: request.reasoningDisplay,
  });
}

export function fromDurableResolvedModelRequest(
  request: DurableResolvedModelRequest,
): ResolvedModelRef {
  const result = fromDurableResolvedModelRequestResult(request);
  const resolved = result.match<
    { readonly value: ResolvedModelRef } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function fromDurableResolvedModelPlan(
  request: DurableResolvedModelRequest,
): ResolvedModelPlan {
  const result = fromDurableResolvedModelPlanResult(request);
  const resolved = result.match<
    { readonly value: ResolvedModelPlan } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function fromDurableResolvedModelPlanResult(
  request: DurableResolvedModelRequest,
): ResultType<ResolvedModelPlan, ModelResolutionFailed> {
  const head = fromDurableResolvedModelRequestResult(request);
  const headValue = head.match<ResolvedModelRef | ModelResolutionFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(headValue)) return Result.err(headValue);
  const fallbacks: ResolvedModelRef[] = [];
  for (const fallback of request.fallbacks ?? []) {
    const resolved = fromDurableResolvedModelRequestResult(fallback);
    const fallbackValue = resolved.match<ResolvedModelRef | ModelResolutionFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelResolutionFailed.is(fallbackValue)) return Result.err(fallbackValue);
    fallbacks.push(fallbackValue);
  }
  return Result.ok({ head: headValue, fallbacks });
}

function cloneJson(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, JSONValue | undefined>;
    const next: Record<string, JSONValue | undefined> = {};
    for (const [k, v] of Object.entries(source)) {
      next[k] = v === undefined ? undefined : cloneJson(v as JSONValue);
    }
    return next;
  }
  return value;
}

function deepMergeJson(base: JSONValue, override: JSONValue): JSONValue {
  // Arrays are replaced, not merged.
  if (Array.isArray(base) || Array.isArray(override)) {
    return cloneJson(override);
  }

  if (
    base !== null &&
    typeof base === "object" &&
    override !== null &&
    typeof override === "object"
  ) {
    const baseRecord = base as Record<string, JSONValue | undefined>;
    const overrideRecord = override as Record<string, JSONValue | undefined>;
    const out: Record<string, JSONValue | undefined> = {};

    const baseEntries = Object.entries(baseRecord);
    for (const [k, v] of baseEntries) {
      out[k] = v === undefined ? undefined : cloneJson(v as JSONValue);
    }

    for (const [k, vOverride] of Object.entries(overrideRecord)) {
      if (vOverride === undefined) continue;

      const vBase = baseRecord[k];
      if (vBase === undefined) {
        out[k] = cloneJson(vOverride as JSONValue);
        continue;
      }

      out[k] = deepMergeJson(vBase as JSONValue, vOverride as JSONValue);
    }

    return out;
  }

  return cloneJson(override);
}

function deepMergeObjects(base?: JSONObject, override?: JSONObject): JSONObject | undefined {
  if (!base && !override) return undefined;
  if (!base) return cloneJson(override ?? {}) as JSONObject;
  if (!override) return cloneJson(base) as JSONObject;
  return deepMergeJson(base, override) as JSONObject;
}

function withOpenAIParallelToolCallsDefault(
  provider: string,
  providerOptions?: { [x: string]: JSONObject },
): { [x: string]: JSONObject } | undefined {
  if (provider !== "openai" && provider !== "codex") return providerOptions;

  const openaiOptions = providerOptions?.openai;
  if (
    openaiOptions !== null &&
    openaiOptions !== undefined &&
    typeof openaiOptions === "object" &&
    "parallelToolCalls" in openaiOptions
  ) {
    return providerOptions;
  }

  const base = providerOptions ?? {};

  return {
    ...base,
    openai: {
      ...(openaiOptions !== null && typeof openaiOptions === "object"
        ? (openaiOptions as JSONObject)
        : {}),
      parallelToolCalls: true,
    },
  };
}

function buildProviderOptionsResult(params: {
  provider: string;
  options?: JSONObject;
  basePrompt?: string;
}): ResultType<
  {
    providerOptions?: { [x: string]: JSONObject };
    responseCommentary?: boolean;
    openaiServerCompaction?: true;
    anthropicPromptCache?: boolean;
  },
  ModelResolutionFailed
> {
  const options = params.options ?? {};

  const {
    anthropic_prompt_cache,
    codex_instructions,
    openai_server_compaction,
    response_commentary,
  } = options as JSONObject & {
    anthropic_prompt_cache?: JSONValue;
    codex_instructions?: JSONValue;
    openai_server_compaction?: JSONValue;
    response_commentary?: JSONValue;
  };
  const codexInstructions =
    typeof codex_instructions === "string" && codex_instructions.length > 0
      ? codex_instructions
      : undefined;
  const basePrompt =
    typeof params.basePrompt === "string" && params.basePrompt.length > 0
      ? params.basePrompt
      : undefined;

  const responseCommentary =
    response_commentary === true && (params.provider === "openai" || params.provider === "codex")
      ? true
      : undefined;

  let openaiServerCompaction: true | undefined;
  if (Object.hasOwn(options, "openai_server_compaction")) {
    if (openai_server_compaction !== true) {
      return Result.err(
        new ModelResolutionFailed({
          issue: "invalid-server-compaction-option",
          source: "model options",
          message: "Model option 'openai_server_compaction' must be literal boolean true",
        }),
      );
    }
    if (params.provider !== "openai" && params.provider !== "codex") {
      return Result.err(
        new ModelResolutionFailed({
          issue: "unsupported-compaction-provider",
          source: "model options",
          message:
            "Model option 'openai_server_compaction' is supported only by openai and codex providers",
        }),
      );
    }
    openaiServerCompaction = true;
  }

  const anthropicPromptCache = anthropic_prompt_cache === true ? true : undefined;

  const provider = params.provider;
  const providerOptions = normalizeConfiguredModelProviderOptions(provider, options);

  if (provider !== "codex") {
    // Non-codex: codex_instructions is ignored; also not forwarded.
    return Result.ok({
      providerOptions: withOpenAIParallelToolCallsDefault(provider, providerOptions),
      responseCommentary,
      openaiServerCompaction,
      anthropicPromptCache,
    });
  }

  // Codex: ensure OpenAI namespace exists + has instructions.
  const openaiKey = "openai";
  const existing = providerOptions?.[openaiKey] ?? {};
  const resolvedInstructions = codexInstructions ?? basePrompt ?? CODEX_BASE_INSTRUCTIONS;

  const nextOpenAI = {
    ...existing,
    instructions: resolvedInstructions,
    // Codex backend requires store=false (items are not persisted).
    store: false,
  } satisfies JSONObject;

  return Result.ok({
    providerOptions: withOpenAIParallelToolCallsDefault(provider, {
      ...providerOptions,
      [openaiKey]: nextOpenAI,
    }),
    responseCommentary,
    openaiServerCompaction,
    anthropicPromptCache,
  });
}

function resolveModelSpecFromRawResult(
  cfg: CoreConfig,
  raw: string,
  source: string,
): ResultType<
  {
    spec: string;
    alias?: string;
    presetOptions?: JSONObject;
    presetReasoning?: ModelReasoningEffort;
  },
  ModelResolutionFailed
> {
  if (raw.includes("/")) {
    const defaults = modelRuleDefaults(cfg, raw);
    return Result.ok({
      spec: raw,
      presetOptions: defaults.options,
      presetReasoning: defaults.reasoning,
    });
  }

  const alias = raw;
  const preset = cfg.models.def?.[alias];
  if (!preset) {
    const available = Object.keys(cfg.models.def ?? {}).slice(0, 10);
    const hint =
      available.length > 0
        ? ` Available aliases (sample): ${available.join(", ")}`
        : " No aliases are configured under models.def.";
    return Result.err(
      new ModelResolutionFailed({
        issue: "unknown-alias",
        source,
        message: `Unknown model alias '${alias}' (${source}).${hint}`,
      }),
    );
  }

  if (!preset.model.includes("/")) {
    return Result.err(
      new ModelResolutionFailed({
        issue: "invalid-alias-target",
        source,
        message: `Invalid models.def.${alias}.model: expected provider/model format (got '${preset.model}')`,
      }),
    );
  }

  return Result.ok({
    spec: preset.model,
    alias,
    presetOptions: mergeModelOptions(modelRuleDefaults(cfg, preset.model).options, preset.options),
    presetReasoning: preset.reasoning ?? modelRuleDefaults(cfg, preset.model).reasoning,
  });
}

function resolveSlotSpecResult(
  cfg: CoreConfig,
  slot: ModelSlot,
): ResultType<
  {
    spec: string;
    alias?: string;
    presetOptions?: JSONObject;
    presetReasoning?: ModelReasoningEffort;
    slotOptions?: JSONObject;
    slotReasoning?: ModelReasoningEffort;
  },
  ModelResolutionFailed
> {
  const slotCfg = cfg.models[slot];
  const baseResult = resolveModelSpecFromRawResult(cfg, slotCfg.model, `models.${slot}.model`);
  const base = baseResult.match<
    | {
        spec: string;
        alias?: string;
        presetOptions?: JSONObject;
        presetReasoning?: ModelReasoningEffort;
      }
    | ModelResolutionFailed
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(base)) return Result.err(base);

  return Result.ok({
    spec: base.spec,
    alias: base.alias,
    presetOptions: base.presetOptions,
    presetReasoning: base.presetReasoning,
    slotOptions: slotCfg.options,
    slotReasoning: slotCfg.reasoning,
  });
}

function resolveModelResult(params: {
  source: string;
  spec: string;
  alias?: string;
  options?: JSONObject;
  reasoning?: ModelReasoningEffort;
  basePrompt?: string;
}): ResultType<ResolvedModelRef, ModelResolutionFailed> {
  const parsed = parseModelSpecifierResult(params.spec);
  const parsedSpec = parsed.match<{ provider: string; model: string } | string>({
    ok: (value) => value,
    err: (error) => error.message,
  });
  if (typeof parsedSpec === "string") {
    return Result.err(
      new ModelResolutionFailed({
        issue: "invalid-spec",
        source: params.source,
        message: parsedSpec,
      }),
    );
  }
  const provider = parsedSpec.provider;
  const modelId = parsedSpec.model;
  const builtOptions = buildProviderOptionsResult({
    provider,
    options: params.options,
    basePrompt: params.basePrompt,
  });
  const options = builtOptions.match<
    | {
        providerOptions?: { [x: string]: JSONObject };
        responseCommentary?: boolean;
        openaiServerCompaction?: true;
        anthropicPromptCache?: boolean;
      }
    | ModelResolutionFailed
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(options)) return Result.err(options);
  const { providerOptions, responseCommentary, openaiServerCompaction, anthropicPromptCache } =
    options;

  const p = providers[provider as Providers];
  const hasProvider = Object.prototype.hasOwnProperty.call(providers, provider);
  if (!hasProvider) {
    return Result.err(
      new ModelResolutionFailed({
        issue: "unknown-provider",
        source: params.source,
        message: `Unknown provider '${provider}' (${params.source}='${params.alias ?? params.spec}')`,
      }),
    );
  }
  if (typeof p !== "function") {
    return Result.err(
      new ModelResolutionFailed({
        issue: "provider-not-configured",
        source: params.source,
        message: `Provider '${provider}' is not configured (${params.source}='${params.alias ?? params.spec}')`,
      }),
    );
  }

  for (const warning of validateModelProviderOptions(providerOptions)) {
    const warningKey = `${params.source}:${warning.namespace}:${warning.option}`;
    if (warnedProviderOptions.has(warningKey)) continue;
    warnedProviderOptions.add(warningKey);

    logger.warn(formatModelProviderOptionWarning(warning, params.source));
  }

  return Result.ok({
    alias: params.alias,
    spec: params.spec,
    provider,
    modelId,
    model: p(modelId),
    providerOptions,
    reasoning: params.reasoning,
    responseCommentary,
    openaiServerCompaction,
    anthropicPromptCache,
  });
}

export function resolveModelRefResult(
  cfg: CoreConfig,
  ref: ConfiguredModelRef,
  source: string,
): ResultType<ResolvedModelRef, ModelResolutionFailed> {
  const base = resolveModelSpecFromRawResult(cfg, ref.model, source);
  const baseValue = base.match<
    | {
        spec: string;
        alias?: string;
        presetOptions?: JSONObject;
        presetReasoning?: ModelReasoningEffort;
      }
    | ModelResolutionFailed
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(baseValue)) return Result.err(baseValue);
  const mergedOptions = deepMergeObjects(baseValue.presetOptions, ref.options);
  const reasoning = ref.reasoning ?? baseValue.presetReasoning;
  return resolveModelResult({
    source,
    spec: baseValue.spec,
    alias: baseValue.alias,
    options: mergedOptions,
    reasoning,
    basePrompt: cfg.basePrompt,
  });
}

export function resolveModelRef(
  cfg: CoreConfig,
  ref: ConfiguredModelRef,
  source: string,
): ResolvedModelRef {
  const result = resolveModelRefResult(cfg, ref, source);
  const resolved = result.match<
    { readonly value: ResolvedModelRef } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function resolveModelChain(
  cfg: CoreConfig,
  entries: readonly ConfiguredModelChainEntry[],
  source: string,
  reasoningOverride?: ModelReasoningEffort,
): ResolvedModelRef[] {
  const result = resolveModelChainResult(cfg, entries, source, reasoningOverride);
  const resolved = result.match<
    { readonly value: ResolvedModelRef[] } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function resolveModelChainResult(
  cfg: CoreConfig,
  entries: readonly ConfiguredModelChainEntry[],
  source: string,
  reasoningOverride?: ModelReasoningEffort,
): ResultType<ResolvedModelRef[], ModelResolutionFailed> {
  const resolved: ResolvedModelRef[] = [];
  for (const [index, entry] of entries.entries()) {
    const ref = typeof entry === "string" ? { model: entry } : entry;
    const model = resolveModelRefResult(
      cfg,
      reasoningOverride === undefined ? ref : { ...ref, reasoning: reasoningOverride },
      `${source}[${index}]`,
    );
    const modelValue = model.match<ResolvedModelRef | ModelResolutionFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ModelResolutionFailed.is(modelValue)) return Result.err(modelValue);
    resolved.push(modelValue);
  }
  return Result.ok(resolved);
}

export function resolveModelPlanResult(
  cfg: CoreConfig,
  params: {
    head: ConfiguredModelRef;
    fallback?: readonly ConfiguredModelChainEntry[];
    headSource: string;
    fallbackSource: string;
    reasoningOverride?: ModelReasoningEffort;
  },
): ResultType<ResolvedModelPlan, ModelResolutionFailed> {
  const aliasFallback = params.head.model.includes("/")
    ? undefined
    : cfg.models.def[params.head.model]?.fallback;
  const fallback = params.fallback ?? aliasFallback ?? [];
  const fallbackSource =
    params.fallback === undefined && aliasFallback !== undefined
      ? `models.def.${params.head.model}.fallback`
      : params.fallbackSource;
  const head = resolveModelRefResult(
    cfg,
    params.reasoningOverride === undefined
      ? params.head
      : { ...params.head, reasoning: params.reasoningOverride },
    params.headSource,
  );
  const headValue = head.match<ResolvedModelRef | ModelResolutionFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(headValue)) return Result.err(headValue);
  const fallbacks = resolveModelChainResult(
    cfg,
    fallback,
    fallbackSource,
    params.reasoningOverride,
  );
  const fallbackValues = fallbacks.match<ResolvedModelRef[] | ModelResolutionFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(fallbackValues)) return Result.err(fallbackValues);

  return Result.ok({ head: headValue, fallbacks: fallbackValues });
}

export function resolveModelPlan(
  cfg: CoreConfig,
  params: {
    head: ConfiguredModelRef;
    fallback?: readonly ConfiguredModelChainEntry[];
    headSource: string;
    fallbackSource: string;
    reasoningOverride?: ModelReasoningEffort;
  },
): ResolvedModelPlan {
  const result = resolveModelPlanResult(cfg, params);
  const resolved = result.match<
    { readonly value: ResolvedModelPlan } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function withModelPlanReasoning(
  plan: ResolvedModelPlan,
  reasoning: ModelReasoningEffort,
): ResolvedModelPlan {
  return {
    head: { ...plan.head, reasoning },
    fallbacks: plan.fallbacks.map((fallback) => ({ ...fallback, reasoning })),
  };
}

export function resolveModelSlotResult(
  cfg: CoreConfig,
  slot: ModelSlot,
): ResultType<ResolvedModelSlot, ModelResolutionFailed> {
  const slotSpec = resolveSlotSpecResult(cfg, slot);
  const slotSpecValue = slotSpec.match<
    | {
        spec: string;
        alias?: string;
        presetOptions?: JSONObject;
        presetReasoning?: ModelReasoningEffort;
        slotOptions?: JSONObject;
        slotReasoning?: ModelReasoningEffort;
      }
    | ModelResolutionFailed
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(slotSpecValue)) return Result.err(slotSpecValue);
  const { spec, alias, presetOptions, presetReasoning, slotOptions, slotReasoning } = slotSpecValue;
  const mergedOptions = deepMergeObjects(presetOptions, slotOptions);
  const reasoning = slotReasoning ?? presetReasoning;
  const resolved = resolveModelResult({
    source: `models.${slot}.model`,
    spec,
    alias,
    options: mergedOptions,
    reasoning,
    basePrompt: cfg.basePrompt,
  });
  const resolvedValue = resolved.match<ResolvedModelRef | ModelResolutionFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ModelResolutionFailed.is(resolvedValue)) return Result.err(resolvedValue);

  return Result.ok({
    slot,
    ...resolvedValue,
  });
}

export function resolveModelSlot(cfg: CoreConfig, slot: ModelSlot): ResolvedModelSlot {
  const result = resolveModelSlotResult(cfg, slot);
  const resolved = result.match<
    { readonly value: ResolvedModelSlot } | { readonly error: ModelResolutionFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function resolveModelSlotPlanResult(
  cfg: CoreConfig,
  slot: ModelSlot,
  reasoningOverride?: ModelReasoningEffort,
): ResultType<ResolvedModelPlan, ModelResolutionFailed> {
  const slotConfig = cfg.models[slot];
  return resolveModelPlanResult(cfg, {
    head: slotConfig,
    fallback: slotConfig.fallback,
    headSource: `models.${slot}.model`,
    fallbackSource: `models.${slot}.fallback`,
    reasoningOverride,
  });
}

export function resolveModelSlotPlan(
  cfg: CoreConfig,
  slot: ModelSlot,
  reasoningOverride?: ModelReasoningEffort,
): ResolvedModelPlan {
  const slotConfig = cfg.models[slot];
  return resolveModelPlan(cfg, {
    head: slotConfig,
    fallback: slotConfig.fallback,
    headSource: `models.${slot}.model`,
    fallbackSource: `models.${slot}.fallback`,
    reasoningOverride,
  });
}
