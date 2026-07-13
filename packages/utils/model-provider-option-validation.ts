import type { CoreConfigModelOptionWarning, JSONObject, JSONValue } from "./core-config/types";
import { MODEL_PROVIDER_OPTION_SHAPES } from "./model-provider-option-shapes.generated";

export type ModelProviderOptionWarning = CoreConfigModelOptionWarning;

const MODEL_OPTION_META_KEYS = new Set([
  "anthropic_prompt_cache",
  "codex_instructions",
  "response_commentary",
]);

type ProviderOptionShape =
  | null
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, ProviderOptionShape>>;
    }
  | {
      readonly kind: "array";
      readonly element: ProviderOptionShape;
    }
  | {
      readonly kind: "union";
      readonly variants: readonly ProviderOptionShape[];
    };

const OPTION_SHAPES_BY_NAMESPACE = MODEL_PROVIDER_OPTION_SHAPES as Readonly<
  Record<string, ProviderOptionShape>
>;

function isObject(value: JSONValue | undefined): value is JSONObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function looksLikeProviderOptionsMap(options: JSONObject): boolean {
  const values = Object.values(options);
  return values.length > 0 && values.every(isObject);
}

function providerOptionsNamespace(provider: string): string {
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
        isObject(entry[1]),
      ),
    );
  }

  return { [providerOptionsNamespace(provider)]: providerOptions };
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

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

function suggestOption(option: string, candidates: readonly string[]): string | undefined {
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

function validateShape(params: {
  namespace: string;
  path: readonly string[];
  value: JSONValue;
  shape: ProviderOptionShape;
  warnings: ModelProviderOptionWarning[];
}): void {
  const { namespace, path, value, shape, warnings } = params;
  if (!shape) return;

  if (shape.kind === "array") {
    if (!Array.isArray(value)) return;
    const itemPath = arrayPath(path);
    for (const item of value) {
      validateShape({ namespace, path: itemPath, value: item, shape: shape.element, warnings });
    }
    return;
  }

  if (shape.kind === "union") {
    const matchingShape = shape.variants.find(
      (variant) =>
        variant !== null &&
        ((variant.kind === "array" && Array.isArray(value)) ||
          (variant.kind === "object" && isObject(value))),
    );
    if (matchingShape) {
      validateShape({ namespace, path, value, shape: matchingShape, warnings });
    }
    return;
  }

  if (!isObject(value)) return;
  const knownKeys = Object.keys(shape.properties);
  for (const [option, nestedValue] of Object.entries(value)) {
    const optionPath = [...path, option];
    const fullOption = optionPath.join(".");
    if (!Object.hasOwn(shape.properties, option)) {
      const suggestion = suggestOption(option, knownKeys);
      warnings.push({
        namespace,
        option: fullOption,
        ...(suggestion ? { suggestion: [...path, suggestion].join(".") } : {}),
      });
      continue;
    }
    if (nestedValue === undefined) continue;

    validateShape({
      namespace,
      path: optionPath,
      value: nestedValue,
      shape: shape.properties[option] ?? null,
      warnings,
    });
  }
}

export function validateModelProviderOptions(providerOptions?: {
  [x: string]: JSONObject;
}): ModelProviderOptionWarning[] {
  if (!providerOptions) return [];

  const warnings: ModelProviderOptionWarning[] = [];
  for (const [namespace, options] of Object.entries(providerOptions)) {
    const shape = OPTION_SHAPES_BY_NAMESPACE[namespace];
    if (!shape) continue;
    validateShape({ namespace, path: [], value: options, shape, warnings });
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
  return `Unknown model provider option '${warning.namespace}.${warning.option}' (${source}); AI SDK will ignore it.${suggestion}`;
}
