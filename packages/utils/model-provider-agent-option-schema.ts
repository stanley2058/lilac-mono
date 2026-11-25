import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { CoreConfig, JSONObject, JSONValue } from "./core-config/types";
import { MODEL_PROVIDER_OPTION_SCHEMAS } from "./model-provider-option-schema.generated";
import {
  providerOptionsNamespace,
  suggestOption,
  type ProviderOptionSchema,
} from "./model-provider-option-validation";
import { isRecord } from "./runtime-utils";

export { providerOptionsNamespace };

type OptionSchemas = typeof MODEL_PROVIDER_OPTION_SCHEMAS;
type ProviderOptionNamespace = keyof OptionSchemas;
type ProviderOptionKey<N extends ProviderOptionNamespace> = keyof OptionSchemas[N]["properties"] &
  string;

/**
 * Options hidden from agents. Core sets these itself (continuation, caching, history, tools,
 * identity), they duplicate a Core-owned control such as `reasoning`, or Core discards their output.
 */
const AGENT_BLOCKED_PROVIDER_OPTIONS: {
  readonly [N in ProviderOptionNamespace]: readonly ProviderOptionKey<N>[];
} = {
  anthropic: [
    "anthropicBeta",
    "cacheControl",
    "compaction",
    "container",
    "contextManagement",
    "effort",
    "fallbacks",
    "mcpServers",
    "metadata",
    "sendReasoning",
    "structuredOutputMode",
    "thinking",
    "toolStreaming",
  ],
  "claude-code": [],
  google: [
    "cachedContent",
    "labels",
    "streamFunctionCallArguments",
    "structuredOutputs",
    "thinkingConfig",
  ],
  groq: ["reasoningEffort", "reasoningFormat", "strictJsonSchema", "structuredOutputs", "user"],
  openai: [
    "allowedTools",
    "compactionTrigger",
    "contextManagement",
    "conversation",
    "forceReasoning",
    "include",
    "includeWebSearchSources",
    "instructions",
    "logprobs",
    "maxToolCalls",
    "metadata",
    "passThroughUnsupportedFiles",
    "previousResponseId",
    "promptCacheKey",
    "promptCacheOptions",
    "promptCacheRetention",
    "reasoningEffort",
    "reasoningEffortUpdate",
    "reasoningSummary",
    "safetyIdentifier",
    "store",
    "strictJsonSchema",
    "systemMessageMode",
    "truncation",
    "user",
  ],
  openaiCompatible: ["reasoningEffort", "strictJsonSchema", "user"],
  xai: [
    "include",
    "logprobs",
    "maxTurns",
    "previousResponseId",
    "promptCacheKey",
    "reasoningEffort",
    "reasoningSummary",
    "safetyIdentifier",
    "store",
    "topLogprobs",
    "user",
  ],
};

export type AgentProviderOptionSchema = {
  readonly namespace: string;
  readonly schema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, ProviderOptionSchema>>;
    readonly additionalProperties: false;
  };
};

export class AgentProviderOptionsInvalid extends TaggedError("AgentProviderOptionsInvalid")<{
  readonly message: string;
}> {}

function isOptionNamespace(namespace: string): namespace is ProviderOptionNamespace {
  return Object.hasOwn(MODEL_PROVIDER_OPTION_SCHEMAS, namespace);
}

/** The provider options an agent may set for a model provider, as JSON Schema. */
export function agentProviderOptionSchema(provider: string): AgentProviderOptionSchema | undefined {
  const namespace = providerOptionsNamespace(provider);
  if (!isOptionNamespace(namespace)) return undefined;
  const blocked = new Set<string>(AGENT_BLOCKED_PROVIDER_OPTIONS[namespace]);
  const properties: Record<string, ProviderOptionSchema> = Object.fromEntries(
    Object.entries(MODEL_PROVIDER_OPTION_SCHEMAS[namespace].properties).filter(
      ([key]) => !blocked.has(key),
    ),
  );
  return {
    namespace,
    schema: { type: "object", properties, additionalProperties: false },
  };
}

/**
 * The options in effect for a model that an agent could have set: alias and requested options
 * together, without keys Core owns, which can include credentials.
 */
export function agentVisibleProviderOptions(
  provider: string,
  providerOptions: Readonly<Record<string, JSONObject>> | undefined,
): JSONObject | undefined {
  const agentSchema = agentProviderOptionSchema(provider);
  const options = agentSchema && providerOptions?.[agentSchema.namespace];
  if (!agentSchema || !options) return undefined;
  const visible = Object.fromEntries(
    Object.entries(options).filter(([key]) => Object.hasOwn(agentSchema.schema.properties, key)),
  );
  return Object.keys(visible).length > 0 ? visible : undefined;
}

/** The provider/model spec a model reference names now: an alias, a spec, or the main model. */
export function modelSelectionSpec(config: CoreConfig, model?: string): string {
  const ref = model ?? config.models.main.model;
  return config.models.def[ref]?.model ?? ref;
}

/** The provider of a model reference: an alias, a provider/model spec, or the main model. */
export function modelSelectionProvider(config: CoreConfig, model?: string): string | undefined {
  const spec = modelSelectionSpec(config, model);
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : undefined;
}

function formatPath(path: readonly string[]): string {
  return path.length > 0 ? path.join(".").replaceAll(".[", "[") : "options";
}

function jsonType(value: JSONValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function schemaTypes(schema: ProviderOptionSchema): string[] {
  if (schema.anyOf) return schema.anyOf.flatMap(schemaTypes);
  if (!schema.type) return [];
  if (schema.enum) return [schema.enum.map((value) => JSON.stringify(value)).join(" | ")];
  return [schema.type];
}

function valueIssues(
  schema: ProviderOptionSchema,
  value: JSONValue,
  path: readonly string[],
): string[] {
  if (schema.anyOf) {
    const results = schema.anyOf.map((variant) => valueIssues(variant, value, path));
    if (results.some((issues) => issues.length === 0)) return [];
    const sameType = schema.anyOf.flatMap((variant, index) =>
      variant.type === jsonType(value) ? [results[index]!] : [],
    );
    if (sameType.length === 1) return sameType[0]!;
    return [`${formatPath(path)} must be ${[...new Set(schemaTypes(schema))].join(" or ")}`];
  }
  if (!schema.type) return [];

  const actual = jsonType(value);
  if (schema.type !== actual) return [`${formatPath(path)} must be ${schemaTypes(schema)[0]}`];
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return [`${formatPath(path)} must be ${schemaTypes(schema)[0]}`];
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    if (!items) return [];
    return value.flatMap((item, index) => valueIssues(items, item, [...path, `[${index}]`]));
  }
  if (!isRecord(value)) return [];

  const properties = schema.properties ?? {};
  const issues = (schema.required ?? [])
    .filter((key) => value[key] === undefined)
    .map((key) => `${formatPath([...path, key])} is required`);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (propertySchema) {
      issues.push(...valueIssues(propertySchema, child, [...path, key]));
      continue;
    }
    if (schema.additionalProperties !== false && schema.additionalProperties !== undefined) {
      issues.push(...valueIssues(schema.additionalProperties, child, [...path, key]));
      continue;
    }
    const suggestion = suggestOption(key, Object.keys(properties));
    issues.push(
      `${formatPath([...path, key])} is not a supported option${
        suggestion ? `; did you mean '${formatPath([...path, suggestion])}'?` : ""
      }`,
    );
  }
  return issues;
}

/**
 * Validates options an agent supplied for a model and returns them under the provider's
 * namespace, for example `{ speed: "fast" }` on an Anthropic model becomes
 * `{ anthropic: { speed: "fast" } }`.
 */
export function parseAgentProviderOptions(
  provider: string,
  options: JSONObject,
): ResultType<Record<string, JSONObject>, AgentProviderOptionsInvalid> {
  if (Object.keys(options).length === 0) return Result.ok({});
  const agentSchema = agentProviderOptionSchema(provider);
  if (!agentSchema) {
    return Result.err(
      new AgentProviderOptionsInvalid({
        message: `Models from provider '${provider}' accept no agent options; omit options`,
      }),
    );
  }
  const issues = valueIssues(agentSchema.schema, options, []);
  if (issues.length > 0) {
    const available = Object.keys(agentSchema.schema.properties).join(", ") || "none";
    return Result.err(
      new AgentProviderOptionsInvalid({
        message: `Invalid ${agentSchema.namespace} options: ${issues.slice(0, 5).join("; ")}. Supported options: ${available}. See model_catalog for the schema.`,
      }),
    );
  }
  return Result.ok({ [agentSchema.namespace]: options });
}
