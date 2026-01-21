import type { LanguageModel } from "ai";

import { providers, type Providers } from "./model-provider";
import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions";
import type { CoreConfig, JSONObject, JSONValue } from "./core-config";
import { parseModelSpecifier } from "./model-capability";

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function cloneJson(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const next: Record<string, JSONValue | undefined> = {};
    for (const [k, v] of Object.entries(value)) {
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

  if (isRecord(base) && isRecord(override)) {
    const out: Record<string, JSONValue | undefined> = {};

    const baseEntries = Object.entries(base);
    for (const [k, v] of baseEntries) {
      out[k] = v === undefined ? undefined : cloneJson(v as JSONValue);
    }

    for (const [k, vOverride] of Object.entries(override)) {
      if (vOverride === undefined) continue;

      const vBase = (base as Record<string, unknown>)[k];
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

function deepMergeObjects(
  base?: JSONObject,
  override?: JSONObject,
): JSONObject | undefined {
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
    if (!isRecord(v)) return false;
  }
  return true;
}

function providerOptionsNamespace(provider: string): string {
  // Codex uses the OpenAI provider under the hood.
  if (provider === "codex") return "openai";

  // Our provider id is "vercel" but the AI SDK namespace is "gateway".
  if (provider === "vercel") return "gateway";

  return provider;
}

function buildProviderOptions(params: {
  provider: string;
  options?: JSONObject;
}): { [x: string]: JSONObject } | undefined {
  const options = params.options;
  if (!options) return undefined;

  const { codex_instructions, ...rest } = options as JSONObject & {
    codex_instructions?: JSONValue;
  };

  const hasRest = Object.keys(rest).length > 0;
  const codexInstructions =
    typeof codex_instructions === "string" && codex_instructions.length > 0
      ? codex_instructions
      : undefined;

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
    return providerOptions;
  }

  // Codex: ensure OpenAI namespace exists + has instructions.
  const openaiKey = "openai";
  const existing = providerOptions?.[openaiKey] ?? {};
  const existingInstructions =
    typeof existing.instructions === "string" && existing.instructions.length > 0
      ? existing.instructions
      : undefined;

  const resolvedInstructions =
    existingInstructions ?? codexInstructions ?? CODEX_BASE_INSTRUCTIONS;

  const nextOpenAI = {
    ...existing,
    instructions: resolvedInstructions,
  } satisfies JSONObject;

  return {
    ...(providerOptions ?? {}),
    [openaiKey]: nextOpenAI,
  };
}

function resolveSlotSpec(cfg: CoreConfig, slot: ModelSlot): {
  spec: string;
  alias?: string;
  presetOptions?: JSONObject;
  slotOptions?: JSONObject;
} {
  const slotCfg = cfg.models[slot];

  const raw = slotCfg.model;
  if (raw.includes("/")) {
    return {
      spec: raw,
      slotOptions: slotCfg.options,
    };
  }

  const alias = raw;
  const preset = cfg.models.def?.[alias];
  if (!preset) {
    const available = Object.keys(cfg.models.def ?? {}).slice(0, 10);
    const hint =
      available.length > 0
        ? ` Available aliases (sample): ${available.join(", ")}`
        : " No aliases are configured under models.def.";
    throw new Error(
      `Unknown model alias '${alias}' (models.${slot}.model).${hint}`,
    );
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
    slotOptions: slotCfg.options,
  };
}

export function resolveModelSlot(cfg: CoreConfig, slot: ModelSlot): ResolvedModelSlot {
  const { spec, alias, presetOptions, slotOptions } = resolveSlotSpec(cfg, slot);

  const parsed = parseModelSpecifier(spec);
  const provider = parsed.provider;
  const modelId = parsed.model;

  const mergedOptions = deepMergeObjects(presetOptions, slotOptions);
  const providerOptions = buildProviderOptions({ provider, options: mergedOptions });

  const p = providers[provider as Providers];
  if (!p) {
    throw new Error(
      `Unknown provider '${provider}' (models.${slot}.model='${alias ?? spec}')`,
    );
  }
  if (typeof p !== "function") {
    throw new Error(
      `Provider '${provider}' is not configured (models.${slot}.model='${alias ?? spec}')`,
    );
  }

  return {
    slot,
    alias,
    spec,
    provider,
    modelId,
    model: p(modelId),
    providerOptions,
  };
}
