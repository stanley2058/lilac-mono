import {
  configFieldUi,
  schemaAlternatives,
  schemaAtPath,
  schemaDefaultAtPath,
  type ConfigFieldKind,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";
import {
  isConfigArray,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { configSchema, type ConfigKind } from "./schemas";

export type FieldType = "boolean" | "integer" | "number" | "string" | "array" | "object" | "choice";

export type FieldInfo = {
  readonly node: ConfigSchemaNode;
  readonly type: FieldType;
  readonly kind?: ConfigFieldKind;
  readonly itemKind?: ConfigFieldKind;
  readonly itemNode?: ConfigSchemaNode;
  /** Constant or enum values when the field is a closed choice. */
  readonly choices: readonly ConfigValue[];
  /** The field also accepts the string `unlimited`. */
  readonly unlimited: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
};

function scalarType(node: ConfigSchemaNode): string | undefined {
  return typeof node.type === "string" ? node.type : node.type?.[0];
}

function choicesOf(alternatives: readonly ConfigSchemaNode[]): ConfigValue[] | undefined {
  const values: ConfigValue[] = [];
  for (const node of alternatives) {
    if (node.const !== undefined) values.push(node.const);
    else if (node.enum) values.push(...node.enum);
    else return undefined;
  }
  return values;
}

const infoCache = new WeakMap<ConfigSchemaNode, FieldInfo>();

export function fieldInfo(kind: ConfigKind, node: ConfigSchemaNode): FieldInfo {
  const cached = infoCache.get(node);
  if (cached) return cached;
  const { schema } = configSchema(kind);
  const ui = configFieldUi(schema, node);
  const alternatives = schemaAlternatives(schema, node);
  const unlimited = alternatives.some((alternative) => alternative.const === "unlimited");
  const rest = alternatives.filter((alternative) => alternative.const !== "unlimited");
  const choices = choicesOf(alternatives) ?? [];
  const numeric = rest.find((alternative) => {
    const type = scalarType(alternative);
    return type === "integer" || type === "number";
  });
  const list = rest.find((alternative) => alternative.items !== undefined);
  const itemNode = list?.items;
  let type: FieldType;
  switch (true) {
    case choices.length > 0 && !unlimited:
      type = "choice";
      break;
    case ui.kind === "duration" || ui.kind === "bytes":
      type = "string";
      break;
    case rest.some((alternative) => scalarType(alternative) === "string") && !list:
      type = "string";
      break;
    case list !== undefined:
      type = "array";
      break;
    case numeric !== undefined:
      type = scalarType(numeric) === "integer" ? "integer" : "number";
      break;
    case rest.some((alternative) => scalarType(alternative) === "boolean"):
      type = "boolean";
      break;
    default:
      type = "object";
  }
  const info: FieldInfo = {
    node,
    type,
    ...(ui.kind ? { kind: ui.kind } : {}),
    ...(itemNode ? { itemNode, itemKind: configFieldUi(schema, itemNode).kind } : {}),
    choices,
    unlimited,
    min: numeric?.minimum ?? numeric?.exclusiveMinimum,
    max: numeric?.maximum ?? numeric?.exclusiveMaximum,
    integer: numeric !== undefined && scalarType(numeric) === "integer",
  };
  infoCache.set(node, info);
  return info;
}

export function fieldNode(
  kind: ConfigKind,
  path: ConfigPath,
  value: ConfigValue | undefined,
): ConfigSchemaNode | undefined {
  const { schema, root } = configSchema(kind);
  return schemaAtPath(schema, root, path, value);
}

/** Core reads the field, or one of its parents, only at startup. */
export function requiresRestart(kind: ConfigKind, path: ConfigPath): boolean {
  const { schema, root } = configSchema(kind);
  for (let length = 1; length <= path.length; length += 1) {
    const node = schemaAtPath(schema, root, path.slice(0, length));
    if (node && configFieldUi(schema, node).restart) return true;
  }
  return false;
}

export function fieldDefault(
  kind: ConfigKind,
  path: ConfigPath,
  value: ConfigValue | undefined,
): ConfigValue | undefined {
  const { schema, root } = configSchema(kind);
  return schemaDefaultAtPath(schema, root, path, value);
}

const DEFAULT_SENTENCE =
  /(?:\n\n)?(?:^|\s)(?:Defaults? to\b.*?(?:\.(?=\s|$)|$)|Default: (?:`[^`]*`|.*?)(?:\.(?=\s|$)|$))/gmu;
const UNITS_SENTENCE =
  /\s*Accepts (?:positive milliseconds|a positive|positive bytes|bytes)[^.]*\.(?:\s*Units:[^.]*\.)?/gu;

/** The schema description without default and unit boilerplate the form shows elsewhere. */
export function cleanDescription(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(DEFAULT_SENTENCE, "").replace(UNITS_SENTENCE, "").trim();
  return cleaned || undefined;
}

/** A default stated only in prose, such as `Default: 7d.` */
export function describedDefault(text: string | undefined): string | undefined {
  const match = text?.match(/Default(?:s to|:)\s+`?(\S+?)`?(?:[.,;](?:\s|$)|\s|$)/u);
  return match?.[1]?.replace(/^"(.*)"$/u, "$1");
}

export function formatConfigValue(value: ConfigValue | undefined): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number") return value.toLocaleString();
  if (isConfigArray(value))
    return value.length === 0 ? "None" : value.map((item) => formatConfigValue(item)).join(", ");
  return `${Object.keys(value).length} settings`;
}

export function choiceKey(value: ConfigValue): string {
  return JSON.stringify(value);
}

/** Title-cases a schema key for fields the manifest does not label. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Splits help text after its first sentence so the form can show the rest on request. */
export function splitDescription(text: string): { lead: string; rest?: string } {
  const match = /^([\s\S]*?[.!?])\s+(?=[A-Z`])/u.exec(text);
  if (!match?.[1]) return { lead: text };
  const rest = text.slice(match[0].length).trim();
  return rest ? { lead: match[1], rest } : { lead: match[1] };
}
