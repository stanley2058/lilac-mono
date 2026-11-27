import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  isConfigArray,
  isConfigObject,
  readConfigValue,
  type ConfigPath,
  type ConfigValue,
} from "./config-document";

/** JSON Schema key that carries editor hints from `configUi` metadata. */
export const CONFIG_UI_KEY = "x-lilac";

export const CONFIG_FIELD_KINDS = [
  "duration",
  "bytes",
  "model",
  "embeddingModel",
  "discordChannel",
  "discordGuild",
  "discordUser",
  "env",
  "toolName",
  "toolPlugin",
  "callableName",
  "callablePlugin",
  "pluginId",
  "multiline",
  "cron",
  "clockTime",
  "providerOptions",
  "valueSource",
] as const;
export type ConfigFieldKind = (typeof CONFIG_FIELD_KINDS)[number];

export type ConfigFieldUi = {
  /** Picks the editor widget. Plain types need no kind. */
  readonly kind?: ConfigFieldKind;
  /** Core reads the value only at startup. */
  readonly restart?: boolean;
};

export type ConfigSchemaNode = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly default?: ConfigValue;
  readonly const?: ConfigValue;
  readonly enum?: readonly ConfigValue[];
  readonly properties?: { readonly [key: string]: ConfigSchemaNode };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ConfigSchemaNode;
  readonly propertyNames?: ConfigSchemaNode;
  readonly items?: ConfigSchemaNode;
  readonly anyOf?: readonly ConfigSchemaNode[];
  readonly oneOf?: readonly ConfigSchemaNode[];
  readonly not?: ConfigSchemaNode;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly pattern?: string;
  readonly definitions?: { readonly [key: string]: ConfigSchemaNode };
  readonly [CONFIG_UI_KEY]?: ConfigFieldUi;
};

const uiSchema = z.object({
  kind: z.enum(CONFIG_FIELD_KINDS).optional(),
  restart: z.boolean().optional(),
});

const nodeSchema: z.ZodType<ConfigSchemaNode> = z.lazy(() =>
  z.looseObject({
    $ref: z.string().optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.json().optional(),
    const: z.json().optional(),
    enum: z.array(z.json()).optional(),
    properties: z.record(z.string(), nodeSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), nodeSchema]).optional(),
    propertyNames: nodeSchema.optional(),
    items: nodeSchema.optional(),
    anyOf: z.array(nodeSchema).optional(),
    oneOf: z.array(nodeSchema).optional(),
    not: nodeSchema.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    minItems: z.number().optional(),
    pattern: z.string().optional(),
    definitions: z.record(z.string(), nodeSchema).optional(),
    [CONFIG_UI_KEY]: uiSchema.optional(),
  }),
);

export class ConfigSchemaInvalid extends TaggedError("ConfigSchemaInvalid")<{
  message: string;
}> {}

/** A generated editor schema with its shared definitions. */
export type ConfigSchema = {
  readonly root: ConfigSchemaNode;
  readonly definitions: { readonly [key: string]: ConfigSchemaNode };
};

export function decodeConfigSchema(input: unknown): ResultType<ConfigSchema, ConfigSchemaInvalid> {
  const parsed = nodeSchema.safeParse(input);
  if (!parsed.success)
    return Result.err(new ConfigSchemaInvalid({ message: "Invalid configuration schema" }));
  return Result.ok({ root: parsed.data, definitions: parsed.data.definitions ?? {} });
}

export function resolveSchemaNode(schema: ConfigSchema, node: ConfigSchemaNode): ConfigSchemaNode {
  let current = node;
  for (let depth = 0; current.$ref && depth < 32; depth += 1) {
    const name = current.$ref.split("/").at(-1) ?? "";
    const target = schema.definitions[name];
    if (!target) return current;
    current = target;
  }
  return current;
}

/** The schema of one `configVersion`, or the root when the schema has no version union. */
export function versionSchemaNode(schema: ConfigSchema, version?: number): ConfigSchemaNode {
  const root = resolveSchemaNode(schema, schema.root);
  const versions = (root.anyOf ?? []).map((node) => resolveSchemaNode(schema, node));
  if (versions.length === 0) return root;
  const matching = versions.find((node) => node.properties?.configVersion?.const === version);
  return matching ?? versions.at(-1) ?? root;
}

export function isRemovedSchemaNode(node: ConfigSchemaNode): boolean {
  return node.not !== undefined && Object.keys(node.not).length === 0;
}

export function schemaAlternatives(
  schema: ConfigSchema,
  node: ConfigSchemaNode,
): readonly ConfigSchemaNode[] {
  const resolved = resolveSchemaNode(schema, node);
  const alternatives = resolved.anyOf ?? resolved.oneOf;
  if (!alternatives) return [resolved];
  return alternatives.flatMap((alternative) => schemaAlternatives(schema, alternative));
}

function isObjectNode(node: ConfigSchemaNode): boolean {
  return node.type === "object" || node.properties !== undefined;
}

function matchesDiscriminators(node: ConfigSchemaNode, value: ConfigValue | undefined): boolean {
  if (!isConfigObject(value)) return true;
  return Object.entries(node.properties ?? {}).every(([key, property]) => {
    if (property.const === undefined || !Object.hasOwn(value, key)) return true;
    return value[key] === property.const;
  });
}

/** Object alternatives of a union, preferring the one whose constant fields match `value`. */
export function objectAlternative(
  schema: ConfigSchema,
  node: ConfigSchemaNode,
  value: ConfigValue | undefined,
): ConfigSchemaNode | undefined {
  const objects = schemaAlternatives(schema, node).filter(isObjectNode);
  return objects.find((candidate) => matchesDiscriminators(candidate, value)) ?? objects[0];
}

function childNode(
  schema: ConfigSchema,
  node: ConfigSchemaNode,
  segment: string | number,
  value: ConfigValue | undefined,
): ConfigSchemaNode | undefined {
  const alternatives = schemaAlternatives(schema, node);
  if (typeof segment === "number") {
    const list = alternatives.find((candidate) => candidate.items !== undefined);
    return list?.items;
  }
  const object = objectAlternative(schema, node, value);
  if (!object) return undefined;
  const property = object.properties?.[segment];
  if (property) return property;
  if (typeof object.additionalProperties === "object") return object.additionalProperties;
  return undefined;
}

/** Finds the schema for a concrete path, choosing union members from the current value. */
export function schemaAtPath(
  schema: ConfigSchema,
  root: ConfigSchemaNode,
  path: ConfigPath,
  rootValue?: ConfigValue,
): ConfigSchemaNode | undefined {
  let node: ConfigSchemaNode | undefined = root;
  for (let index = 0; index < path.length && node; index += 1) {
    const segment = path[index];
    if (segment === undefined) return undefined;
    const value =
      rootValue === undefined ? undefined : readConfigValue(rootValue, path.slice(0, index));
    node = childNode(schema, node, segment, value);
    if (node && isRemovedSchemaNode(resolveSchemaNode(schema, node))) return undefined;
  }
  return node ? resolveSchemaNode(schema, node) : undefined;
}

/**
 * The default that applies when `path` is absent. Defaults come from the first level of the path
 * missing from `rootValue`, so a parent default such as a built-in profile wins over the plain
 * default of its child field.
 */
export function schemaDefaultAtPath(
  schema: ConfigSchema,
  root: ConfigSchemaNode,
  path: ConfigPath,
  rootValue?: ConfigValue,
): ConfigValue | undefined {
  let present = 0;
  while (
    rootValue !== undefined &&
    present < path.length - 1 &&
    readConfigValue(rootValue, path.slice(0, present + 1)) !== undefined
  )
    present += 1;
  for (let length = present + 1; length <= path.length; length += 1) {
    const node = schemaAtPath(schema, root, path.slice(0, length), rootValue);
    const fallback = node?.default ?? defaultFromAlternatives(schema, node);
    const value =
      fallback === undefined ? undefined : readConfigValue(fallback, path.slice(length));
    if (value !== undefined) return value;
  }
  return undefined;
}

function defaultFromAlternatives(
  schema: ConfigSchema,
  node: ConfigSchemaNode | undefined,
): ConfigValue | undefined {
  if (!node) return undefined;
  for (const alternative of schemaAlternatives(schema, node)) {
    if (alternative.default !== undefined) return alternative.default;
  }
  return undefined;
}

/** Editor hints on the node or on any member of its union, searched breadth-first. */
export function configFieldUi(schema: ConfigSchema, node: ConfigSchemaNode): ConfigFieldUi {
  const queue = [node];
  for (let index = 0; index < queue.length && index < 64; index += 1) {
    const current = resolveSchemaNode(schema, queue[index] ?? {});
    const ui = current[CONFIG_UI_KEY];
    if (ui) return ui;
    queue.push(...(current.anyOf ?? current.oneOf ?? []));
  }
  return {};
}

export type ConfigFieldShape = "leaf" | "object" | "record" | "union";

export type ConfigSchemaField = {
  /** Dot path with `*` for record keys, such as `models.def.*.model`. */
  readonly pattern: string;
  readonly shape: ConfigFieldShape;
  readonly node: ConfigSchemaNode;
};

/** Lists every editable position in the schema. Lists are leaves; removed fields are skipped. */
export function enumerateConfigFields(
  schema: ConfigSchema,
  root: ConfigSchemaNode,
): readonly ConfigSchemaField[] {
  const fields: ConfigSchemaField[] = [];
  const visit = (node: ConfigSchemaNode, pattern: string, depth: number) => {
    const resolved = resolveSchemaNode(schema, node);
    if (isRemovedSchemaNode(resolved) || depth > 24) return;
    const alternatives = schemaAlternatives(schema, resolved);
    const objects = alternatives.filter(isObjectNode);
    if (objects.length === 0) {
      if (pattern) fields.push({ pattern, shape: "leaf", node: resolved });
      return;
    }
    const properties = new Map<string, ConfigSchemaNode>();
    let record: ConfigSchemaNode | undefined;
    for (const object of objects) {
      for (const [key, property] of Object.entries(object.properties ?? {})) {
        if (!properties.has(key)) properties.set(key, property);
      }
      if (typeof object.additionalProperties === "object") record ??= object.additionalProperties;
    }
    let shape: ConfigFieldShape = properties.size === 0 && record ? "record" : "object";
    if (alternatives.length > 1) shape = "union";
    if (pattern) fields.push({ pattern, shape, node: resolved });
    const prefix = pattern ? `${pattern}.` : "";
    for (const [key, property] of properties) visit(property, `${prefix}${key}`, depth + 1);
    if (record) visit(record, `${prefix}*`, depth + 1);
  };
  visit(root, "", 0);
  return fields;
}

/** Converts a concrete path to its field pattern, given which segments are record keys. */
export function matchesConfigPattern(pattern: string, path: ConfigPath): boolean {
  const parts = pattern.split(".");
  if (parts.length !== path.length) return false;
  return parts.every((part, index) => part === "*" || part === String(path[index]));
}

export function configValueKind(value: ConfigValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (isConfigArray(value)) return "array";
  return typeof value;
}
