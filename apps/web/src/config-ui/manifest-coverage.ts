import {
  configFieldUi,
  enumerateConfigFields,
  schemaAlternatives,
  type ConfigSchema,
  type ConfigSchemaField,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";
import {
  FIXED_EDITOR_FIELDS,
  isCollection,
  manifestEntries,
  SUBTREE_WIDGETS,
  type FieldEntry,
  type Manifest,
} from "./manifest";
import { configSchema, type ConfigKind } from "./schemas";

type Coverage = {
  readonly exact: Set<string>;
  readonly subtrees: string[];
  readonly records: string[];
};

function addField(coverage: Coverage, prefix: string, field: FieldEntry<string>) {
  const path = `${prefix}${field.path}`;
  coverage.exact.add(path);
  if (field.widget && SUBTREE_WIDGETS.has(field.widget)) coverage.subtrees.push(`${path}.`);
}

function collect<P extends string>(manifest: Manifest<P>): Coverage {
  const coverage: Coverage = { exact: new Set(), subtrees: [], records: [] };
  for (const page of manifest.pages)
    for (const section of page.sections)
      for (const entry of section.entries) {
        if (!isCollection(entry)) {
          addField(coverage, "", entry);
          continue;
        }
        coverage.exact.add(entry.collection);
        coverage.exact.add(`${entry.collection}.*`);
        coverage.records.push(`${entry.collection}.`);
        for (const field of entry.fields) addField(coverage, `${entry.collection}.*.`, field);
      }
  for (const path of Object.keys(manifest.unplaced)) coverage.exact.add(path);
  return coverage;
}

/** Rewrites `records.<name>.x` to `records.*.x`, since named record entries share item fields. */
function normalize(pattern: string, records: readonly string[]): string {
  for (const record of records) {
    if (!pattern.startsWith(record)) continue;
    const rest = pattern.slice(record.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) continue;
    return `${record}*${rest.slice(dot)}`;
  }
  return pattern;
}

function needsPlacement(field: ConfigSchemaField, kind: ConfigKind): boolean {
  if (field.shape === "leaf") return true;
  if (field.shape !== "union") return false;
  // Unions with scalar members, such as `false | {verbose}`, need a deliberate editor.
  const { schema } = configSchema(kind);
  return schemaAlternatives(schema, field.node).some(
    (node) => node.type !== "object" && node.properties === undefined,
  );
}

/** Schema fields that no page, collection, subtree editor, or `unplaced` reason covers. */
export function uncoveredConfigFields<P extends string>(manifest: Manifest<P>): string[] {
  const { schema, root } = configSchema(manifest.kind);
  const coverage = collect(manifest);
  const valueSources = enumerateConfigFields(schema, root)
    .filter((field) => configFieldUi(schema, field.node).kind === "valueSource")
    .map((field) => `${normalize(field.pattern, coverage.records)}.`);
  const subtrees = [...coverage.subtrees, ...valueSources];
  return enumerateConfigFields(schema, root)
    .filter((field) => needsPlacement(field, manifest.kind))
    .map((field) => normalize(field.pattern, coverage.records))
    .filter((pattern) => !coverage.exact.has(pattern))
    .filter((pattern) => !subtrees.some((prefix) => pattern.startsWith(prefix)));
}

/** Manifest paths that no longer name a schema field. */
export function staleConfigPaths<P extends string>(manifest: Manifest<P>): string[] {
  const { schema, root } = configSchema(manifest.kind);
  const coverage = collect(manifest);
  const known = new Set(
    enumerateConfigFields(schema, root).map((field) => normalize(field.pattern, coverage.records)),
  );
  return [...coverage.exact].filter((path) => !known.has(path));
}

/** Child fields of a value, or of each item for a list, minus what nested editors own. */
function childFields(schema: ConfigSchema, node: ConfigSchemaNode): string[] {
  const list = schemaAlternatives(schema, node).find((member) => member.items !== undefined);
  const owned: string[] = [];
  return enumerateConfigFields(schema, list?.items ?? node)
    .filter((field) => {
      if (owned.some((prefix) => field.pattern.startsWith(prefix))) return false;
      const kind = configFieldUi(schema, field.node).kind;
      if (kind === "valueSource" || kind === "providerOptions") owned.push(`${field.pattern}.`);
      return true;
    })
    .map((field) => field.pattern);
}

/** Schema children that a fixed-control editor has no control for, as `path: child`. */
export function unhandledEditorFields<P extends string>(manifest: Manifest<P>): string[] {
  const { schema, root } = configSchema(manifest.kind);
  const coverage = collect(manifest);
  const nodes = new Map(
    enumerateConfigFields(schema, root).map((field) => [
      normalize(field.pattern, coverage.records),
      field.node,
    ]),
  );
  const problems: string[] = [];
  const check = (path: string, editor: keyof typeof FIXED_EDITOR_FIELDS) => {
    const node = nodes.get(path);
    if (!node) return;
    const known: readonly string[] = FIXED_EDITOR_FIELDS[editor];
    for (const child of childFields(schema, node))
      if (!known.includes(child)) problems.push(`${path}: ${child}`);
  };
  for (const { entry } of manifestEntries(manifest)) {
    const fields = isCollection(entry)
      ? entry.fields.map((field) => ({
          ...field,
          path: `${entry.collection}.*.${field.path}`,
        }))
      : [entry];
    for (const field of fields)
      switch (field.widget) {
        case "modelList":
        case "modelRules":
        case "stats":
        case "mcpAuth":
          check(field.path, field.widget);
      }
  }
  for (const [path, node] of nodes)
    if (configFieldUi(schema, node).kind === "valueSource") check(path, "valueSource");
  return problems;
}

/** `unplaced` entries without a reason. */
export function unexplainedUnplacedFields<P extends string>(manifest: Manifest<P>): string[] {
  const reasons: Partial<Record<string, string>> = manifest.unplaced;
  return Object.entries(reasons)
    .filter(([, reason]) => typeof reason !== "string" || reason.trim() === "")
    .map(([path]) => path);
}
