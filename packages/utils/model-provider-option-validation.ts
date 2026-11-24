import type { CoreConfigModelOptionWarning, JSONObject, JSONValue } from "./core-config/types";
import { MODEL_PROVIDER_OPTION_SCHEMAS } from "./model-provider-option-schema.generated";
import { isRecord } from "./runtime-utils";

export type ModelProviderOptionWarning = CoreConfigModelOptionWarning;

const MODEL_OPTION_META_KEYS = new Set([
  "anthropic_prompt_cache",
  "codex_instructions", // Accepted by v1/v2 and ignored at model resolution.
  "openai_server_compaction",
  "response_commentary",
]);

/** The JSON Schema subset emitted by scripts/generate-provider-option-schema.ts. */
export type ProviderOptionSchema = {
  readonly type?: "string" | "number" | "boolean" | "null" | "array" | "object";
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: ProviderOptionSchema;
  readonly properties?: Readonly<Record<string, ProviderOptionSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: ProviderOptionSchema | false;
  readonly anyOf?: readonly ProviderOptionSchema[];
};

export const PROVIDER_OPTION_SCHEMAS = MODEL_PROVIDER_OPTION_SCHEMAS as Readonly<
  Record<string, ProviderOptionSchema>
>;

function looksLikeProviderOptionsMap(options: JSONObject): boolean {
  const values = Object.values(options);
  return values.length > 0 && values.every(isRecord);
}

export function providerOptionsNamespace(provider: string): string {
  if (provider === "codex") return "openai";
  if (provider === "openai-compatible") return "openaiCompatible";
  if (provider === "vercel") return "gateway";
  return provider;
}

export function normalizeConfiguredModelProviderOptions(
  provider: string,
  options?: JSONObject,
): { [x: string]: JSONObject } | undefined {
  if (!options) return undefined;

  const providerOptions: JSONObject = {};
  for (const [key, value] of Object.entries(options)) {
    if (!MODEL_OPTION_META_KEYS.has(key) && value !== undefined) providerOptions[key] = value;
  }
  if (Object.keys(providerOptions).length === 0) return undefined;

  if (looksLikeProviderOptionsMap(providerOptions)) {
    return Object.fromEntries(
      Object.entries(providerOptions).filter((entry): entry is [string, JSONObject] =>
        isRecord(entry[1]),
      ),
    );
  }

  return { [providerOptionsNamespace(provider)]: providerOptions };
}

function editDistance(a: string, b: string): number {
  let previous: number[] = [];
  for (let index = 0; index <= b.length; index += 1) previous.push(index);

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      const substitutionCost = a[aIndex - 1] === b[bIndex - 1] ? 0 : 1;
      current[bIndex] = Math.min(
        (current[bIndex - 1] ?? 0) + 1,
        (previous[bIndex] ?? 0) + 1,
        (previous[bIndex - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[b.length] ?? b.length;
}

export function suggestOption(option: string, candidates: readonly string[]): string | undefined {
  const normalizedOption = option.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const distance = editDistance(normalizedOption, normalizedCandidate);
    if (!best || distance < best.distance) best = { candidate, distance };
  }

  if (!best) return undefined;
  const normalizedCandidate = best.candidate.toLowerCase();
  const substringMatch = normalizedCandidate.includes(normalizedOption);
  const threshold = Math.max(2, Math.floor(normalizedCandidate.length * 0.35));
  return substringMatch || best.distance <= threshold ? best.candidate : undefined;
}

function arrayPath(path: readonly string[]): readonly string[] {
  const last = path.at(-1);
  return last ? [...path.slice(0, -1), `${last}[]`] : path;
}

/** Flattens `anyOf` so a value can be checked against every variant at once. */
function schemaVariants(schemas: readonly ProviderOptionSchema[]): ProviderOptionSchema[] {
  return schemas.flatMap((schema) => (schema.anyOf ? schemaVariants(schema.anyOf) : [schema]));
}

// Config validation checks key names only: union variants merge their keys, and open records
// (any additionalProperties schema) accept every key, because AI SDK strips unknown keys.
function validateKeys(params: {
  namespace: string;
  path: readonly string[];
  value: JSONValue;
  schemas: readonly ProviderOptionSchema[];
  warnings: ModelProviderOptionWarning[];
}): void {
  const { namespace, path, value, warnings } = params;
  const variants = schemaVariants(params.schemas);

  if (Array.isArray(value)) {
    const items = variants.flatMap((variant) =>
      variant.type === "array" && variant.items ? [variant.items] : [],
    );
    if (items.length === 0) return;
    for (const item of value) {
      validateKeys({ namespace, path: arrayPath(path), value: item, schemas: items, warnings });
    }
    return;
  }

  if (!isRecord(value)) return;
  const objects = variants.filter((variant) => variant.type === "object");
  if (objects.length === 0) return;
  if (objects.some((variant) => variant.additionalProperties !== false)) return;

  const propertySchemas = new Map<string, ProviderOptionSchema[]>();
  for (const variant of objects) {
    for (const [key, schema] of Object.entries(variant.properties ?? {})) {
      propertySchemas.set(key, [...(propertySchemas.get(key) ?? []), schema]);
    }
  }
  const knownKeys = [...propertySchemas.keys()];
  for (const [option, nestedValue] of Object.entries(value)) {
    const optionPath = [...path, option];
    const schemas = propertySchemas.get(option);
    if (!schemas) {
      const suggestion = suggestOption(option, knownKeys);
      warnings.push({
        namespace,
        option: optionPath.join("."),
        ...(suggestion ? { suggestion: [...path, suggestion].join(".") } : {}),
      });
      continue;
    }
    if (nestedValue === undefined) continue;
    validateKeys({ namespace, path: optionPath, value: nestedValue, schemas, warnings });
  }
}

export function validateModelProviderOptions(providerOptions?: {
  [x: string]: JSONObject;
}): ModelProviderOptionWarning[] {
  if (!providerOptions) return [];

  const warnings: ModelProviderOptionWarning[] = [];
  for (const [namespace, options] of Object.entries(providerOptions)) {
    const schema = PROVIDER_OPTION_SCHEMAS[namespace];
    if (!schema) continue;
    validateKeys({ namespace, path: [], value: options, schemas: [schema], warnings });
  }

  return warnings;
}

export function validateConfiguredModelProviderOptions(
  provider: string,
  options?: JSONObject,
): ModelProviderOptionWarning[] {
  return validateModelProviderOptions(normalizeConfiguredModelProviderOptions(provider, options));
}

export function formatModelProviderOptionWarning(
  warning: ModelProviderOptionWarning,
  source: string,
): string {
  const suggestion = warning.suggestion
    ? ` Did you mean '${warning.namespace}.${warning.suggestion}'?`
    : "";
  return `Unknown model provider option '${warning.namespace}.${warning.option}' (${source}); the provider will ignore it.${suggestion}`;
}
