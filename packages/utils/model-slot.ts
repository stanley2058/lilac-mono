import type { LanguageModel } from "ai";

import { providers, type Providers } from "./model-provider";
import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions";
import type { CoreConfig, JSONObject, JSONValue, ModelReasoningEffort } from "./core-config";
import { createLogger } from "./logging";
import { parseModelSpecifier } from "./model-capability";
import { validateModelProviderOptions } from "./model-provider-option-validation";

const logger = createLogger({ module: "utils:model-slot" });
const warnedProviderOptions = new Set<string>();

export type ModelSlot = "main" | "fast";

export type ConfiguredModelRef = {
  /** Model ref in provider/model format or alias from models.def. */
  model: string;
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;
  /** Optional providerOptions override. */
  options?: JSONObject;
};

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
  /** Opt-in Anthropic cache-control injection for system prompt + latest user message. */
  anthropicPromptCache?: boolean;
};

export type ResolvedModelRef = Omit<ResolvedModelSlot, "slot">;

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

function looksLikeProviderOptionsMap(obj: JSONObject): boolean {
  const values = Object.values(obj);
  if (values.length === 0) return false;
  // A providerOptions map has only object values at the top-level.
  // If there are scalars at the top-level, treat as shorthand.
  for (const v of values) {
    if (v === undefined) continue;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  }
  return true;
}

function providerOptionsNamespace(provider: string): string {
  // Codex uses the OpenAI provider under the hood.
  if (provider === "codex") return "openai";

  // The OpenAI-compatible provider uses the openaiCompatible options namespace.
  if (provider === "openai-compatible") return "openaiCompatible";

  // Our provider id is "vercel" but the AI SDK namespace is "gateway".
  if (provider === "vercel") return "gateway";

  return provider;
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

function buildProviderOptions(params: { provider: string; options?: JSONObject }): {
  providerOptions?: { [x: string]: JSONObject };
  responseCommentary?: boolean;
  anthropicPromptCache?: boolean;
} {
  const options = params.options ?? {};

  const { anthropic_prompt_cache, codex_instructions, response_commentary, ...rest } =
    options as JSONObject & {
      anthropic_prompt_cache?: JSONValue;
      codex_instructions?: JSONValue;
      response_commentary?: JSONValue;
    };

  const hasRest = Object.keys(rest).length > 0;
  const codexInstructions =
    typeof codex_instructions === "string" && codex_instructions.length > 0
      ? codex_instructions
      : undefined;

  const responseCommentary =
    response_commentary === true && (params.provider === "openai" || params.provider === "codex")
      ? true
      : undefined;

  const anthropicPromptCache = anthropic_prompt_cache === true ? true : undefined;

  const provider = params.provider;
  const ns = providerOptionsNamespace(provider);

  let providerOptions: { [x: string]: JSONObject } | undefined;

  if (hasRest) {
    providerOptions = looksLikeProviderOptionsMap(rest)
      ? (rest as unknown as { [x: string]: JSONObject })
      : ({ [ns]: rest } as { [x: string]: JSONObject });
  }

  if (provider !== "codex") {
    // Non-codex: codex_instructions is ignored; also not forwarded.
    return {
      providerOptions: withOpenAIParallelToolCallsDefault(provider, providerOptions),
      responseCommentary,
      anthropicPromptCache,
    };
  }

  // Codex: ensure OpenAI namespace exists + has instructions.
  const openaiKey = "openai";
  const existing = providerOptions?.[openaiKey] ?? {};
  const existingInstructions =
    typeof existing.instructions === "string" && existing.instructions.length > 0
      ? existing.instructions
      : undefined;

  const resolvedInstructions = existingInstructions ?? codexInstructions ?? CODEX_BASE_INSTRUCTIONS;

  const nextOpenAI = {
    ...existing,
    instructions: resolvedInstructions,
    // Codex backend requires store=false (items are not persisted).
    store: false,
  } satisfies JSONObject;

  return {
    providerOptions: withOpenAIParallelToolCallsDefault(provider, {
      ...providerOptions,
      [openaiKey]: nextOpenAI,
    }),
    responseCommentary,
    anthropicPromptCache,
  };
}

function resolveModelSpecFromRaw(
  cfg: CoreConfig,
  raw: string,
  source: string,
): {
  spec: string;
  alias?: string;
  presetOptions?: JSONObject;
  presetReasoning?: ModelReasoningEffort;
} {
  if (raw.includes("/")) {
    return { spec: raw };
  }

  const alias = raw;
  const preset = cfg.models.def?.[alias];
  if (!preset) {
    const available = Object.keys(cfg.models.def ?? {}).slice(0, 10);
    const hint =
      available.length > 0
        ? ` Available aliases (sample): ${available.join(", ")}`
        : " No aliases are configured under models.def.";
    throw new Error(`Unknown model alias '${alias}' (${source}).${hint}`);
  }

  if (!preset.model.includes("/")) {
    throw new Error(
      `Invalid models.def.${alias}.model: expected provider/model format (got '${preset.model}')`,
    );
  }

  return {
    spec: preset.model,
    alias,
    presetOptions: preset.options,
    presetReasoning: preset.reasoning,
  };
}

function resolveSlotSpec(
  cfg: CoreConfig,
  slot: ModelSlot,
): {
  spec: string;
  alias?: string;
  presetOptions?: JSONObject;
  presetReasoning?: ModelReasoningEffort;
  slotOptions?: JSONObject;
  slotReasoning?: ModelReasoningEffort;
} {
  const slotCfg = cfg.models[slot];
  const base = resolveModelSpecFromRaw(cfg, slotCfg.model, `models.${slot}.model`);

  return {
    spec: base.spec,
    alias: base.alias,
    presetOptions: base.presetOptions,
    presetReasoning: base.presetReasoning,
    slotOptions: slotCfg.options,
    slotReasoning: slotCfg.reasoning,
  };
}

function resolveModel(params: {
  source: string;
  spec: string;
  alias?: string;
  options?: JSONObject;
  reasoning?: ModelReasoningEffort;
}): ResolvedModelRef {
  const parsed = parseModelSpecifier(params.spec);
  const provider = parsed.provider;
  const modelId = parsed.model;
  const { providerOptions, responseCommentary, anthropicPromptCache } = buildProviderOptions({
    provider,
    options: params.options,
  });

  const p = providers[provider as Providers];
  const hasProvider = Object.prototype.hasOwnProperty.call(providers, provider);
  if (!hasProvider) {
    throw new Error(
      `Unknown provider '${provider}' (${params.source}='${params.alias ?? params.spec}')`,
    );
  }
  if (typeof p !== "function") {
    throw new Error(
      `Provider '${provider}' is not configured (${params.source}='${params.alias ?? params.spec}')`,
    );
  }

  for (const warning of validateModelProviderOptions(providerOptions)) {
    const warningKey = `${params.source}:${warning.namespace}:${warning.option}`;
    if (warnedProviderOptions.has(warningKey)) continue;
    warnedProviderOptions.add(warningKey);

    const suggestion = warning.suggestion
      ? ` Did you mean '${warning.namespace}.${warning.suggestion}'?`
      : "";
    logger.warn(
      `Unknown model provider option '${warning.namespace}.${warning.option}' (${params.source}); AI SDK will ignore it.${suggestion}`,
    );
  }

  return {
    alias: params.alias,
    spec: params.spec,
    provider,
    modelId,
    model: p(modelId),
    providerOptions,
    reasoning: params.reasoning,
    responseCommentary,
    anthropicPromptCache,
  };
}

export function resolveModelRef(
  cfg: CoreConfig,
  ref: ConfiguredModelRef,
  source: string,
): ResolvedModelRef {
  const base = resolveModelSpecFromRaw(cfg, ref.model, source);
  const mergedOptions = deepMergeObjects(base.presetOptions, ref.options);
  const reasoning = ref.reasoning ?? base.presetReasoning;
  return resolveModel({
    source,
    spec: base.spec,
    alias: base.alias,
    options: mergedOptions,
    reasoning,
  });
}

export function resolveModelSlot(cfg: CoreConfig, slot: ModelSlot): ResolvedModelSlot {
  const { spec, alias, presetOptions, presetReasoning, slotOptions, slotReasoning } =
    resolveSlotSpec(cfg, slot);
  const mergedOptions = deepMergeObjects(presetOptions, slotOptions);
  const reasoning = slotReasoning ?? presetReasoning;
  const resolved = resolveModel({
    source: `models.${slot}.model`,
    spec,
    alias,
    options: mergedOptions,
    reasoning,
  });

  return {
    slot,
    ...resolved,
  };
}
