import type { ConfigValue } from "@stanley2058/lilac-utils/config-document";
import type { ConfigKind } from "./schemas";

/**
 * Widgets the schema cannot imply. Everything else picks its editor from the field's type and
 * `x-lilac` kind.
 */
export type WidgetOverride =
  /** YAML text for the whole subtree. */
  | "yaml"
  /** Ordered model references. */
  | "modelList"
  /** Ordered `models.rules` entries. */
  | "modelRules"
  /** A one-line string long enough to wrap while editing. */
  | "longText"
  /** Key to scalar rows, editing values with the item schema's widget. */
  | "map"
  /** Picks a union member by its constant field and resets the other members' fields. */
  | "discriminator"
  /** `false`, `true`, or `{verbose: true}`. */
  | "stats"
  /** None, dynamic OAuth, or a static OAuth client. */
  | "mcpAuth";

/** Widgets that edit every field below their own path. */
export const SUBTREE_WIDGETS: ReadonlySet<WidgetOverride> = new Set([
  "yaml",
  "modelList",
  "modelRules",
  "map",
  "stats",
  "mcpAuth",
]);

/**
 * Child fields that fixed-control editors handle, relative to the edited value (to each item
 * for lists). The coverage test fails when the schema adds a child that is not listed here.
 * Value sources and provider options inside these values are checked on their own.
 */
type FixedEditor = "modelList" | "modelRules" | "stats" | "mcpAuth" | "valueSource";

export const FIXED_EDITOR_FIELDS: Record<FixedEditor, readonly string[]> = {
  modelList: ["model", "reasoning", "options"],
  modelRules: ["match", "options", "reasoning", "unset", "legacy"],
  stats: ["verbose"],
  mcpAuth: [
    "type",
    "grant",
    "scopes",
    "client",
    "client.type",
    "client.clientId",
    "client.clientSecret",
  ],
  valueSource: ["env", "prefix", "file", "pointer"],
};

export type Condition<P extends string> =
  | { readonly path: P; readonly equals: ConfigValue | readonly ConfigValue[] }
  | { readonly path: P; readonly present: boolean };

export type FieldEntry<P extends string> = {
  readonly path: P;
  readonly label: string;
  /** Web copy for the title's tooltip. Without it, the tooltip shows the schema description. */
  readonly help?: string;
  /** A short line under the title, only for titles that are unclear on their own. */
  readonly hint?: string;
  readonly widget?: WidgetOverride;
  /** Labels for enum or constant values, keyed by JSON value. */
  readonly options?: Readonly<Record<string, string>>;
  /** Label for the choice that removes the field. Discriminators only. */
  readonly unsetLabel?: string;
  readonly placeholder?: string;
  /** Extra values offered by list and text fields, or the keys a map offers. */
  readonly suggestions?: readonly string[];
  readonly visibleWhen?: Condition<P>;
  /** When unset, the field uses the first of these fields that has a value. */
  readonly inherits?: readonly [P] | readonly [P, P];
};

/** Paths below `${C}.*.` with that prefix removed. */
export type ItemPath<P extends string, C extends string> = P extends `${C}.*.${infer R}`
  ? R
  : never;

type CollectionFields = {
  readonly label: string;
  readonly help?: string;
  /** Singular noun for buttons, such as "alias". */
  readonly itemNoun: string;
  readonly keyLabel: string;
  readonly keyPlaceholder?: string;
  /** Keys that always exist and cannot be removed or renamed. */
  readonly fixedKeys?: readonly string[];
  readonly newItem?: ConfigValue;
  /** Item keys are Discord channel IDs; show their aliases beside them. */
  readonly channelKeys?: boolean;
  /** Adds items through a guided dialog instead of a name field. */
  readonly addDialog?: "mcpServer";
};

export type CollectionEntry<P extends string> = CollectionFields & {
  readonly collection: P;
  /** A string item is shorthand for this item field. Editing expands it to an object. */
  readonly shorthand?: string;
  /** Item fields shown beside the key while the item is collapsed. */
  readonly summary?: readonly string[];
  /** Paths relative to one item. */
  readonly fields: readonly FieldEntry<string>[];
};

/** A collection whose item paths are checked against the record at `C`. */
export type TypedCollection<P extends string, C extends P> = CollectionFields & {
  readonly collection: C;
  readonly shorthand?: ItemPath<P, C>;
  readonly summary?: readonly ItemPath<P, C>[];
  readonly fields: readonly FieldEntry<ItemPath<P, C>>[];
};

export type Entry<P extends string> = FieldEntry<P> | CollectionEntry<P>;

export type Section<P extends string> = {
  readonly title: string;
  readonly help?: string;
  /** Collapsed until opened. */
  readonly advanced?: boolean;
  readonly visibleWhen?: Condition<P>;
  readonly entries: readonly Entry<P>[];
};

export type Page<P extends string> = {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly Section<P>[];
  /** Marks the page's features as experimental on its tab and at its top. */
  readonly experimental?: boolean;
};

export type Manifest<P extends string> = {
  readonly kind: ConfigKind;
  readonly pages: readonly Page<P>[];
  /** Fields deliberately left to the YAML editor, with the reason. */
  readonly unplaced: Partial<Record<P, string>>;
};

export function isCollection<P extends string>(entry: Entry<P>): entry is CollectionEntry<P> {
  return "collection" in entry;
}

/** Builds a collection entry with item paths checked against `C`. */
export function collection<P extends string, C extends P>(
  spec: TypedCollection<P, C>,
): CollectionEntry<P> {
  return spec;
}

function matchesPattern(pattern: string, path: readonly (string | number)[]): boolean {
  const parts = pattern.split(".");
  return (
    parts.length === path.length &&
    parts.every((part, index) => part === "*" || part === String(path[index]))
  );
}

/** Every entry of a manifest with the page and section that hold it. */
export function manifestEntries<P extends string>(
  manifest: Manifest<P>,
): { page: Page<P>; section: Section<P>; entry: Entry<P> }[] {
  return manifest.pages.flatMap((page) =>
    page.sections.flatMap((section) => section.entries.map((entry) => ({ page, section, entry }))),
  );
}

function entryLabel(entry: Entry<string>, path: readonly (string | number)[]): string | undefined {
  if (!isCollection(entry)) return matchesPattern(entry.path, path) ? entry.label : undefined;
  const field = entry.fields.find((candidate) =>
    matchesPattern(`${entry.collection}.*.${candidate.path}`, path),
  );
  if (!field) return undefined;
  return `${String(path[entry.collection.split(".").length])} › ${field.label}`;
}

/** The label a reader knows a field by, such as "Bot name" or "writer › Model". */
export function manifestLabel<P extends string>(
  manifest: Manifest<P>,
  path: readonly (string | number)[],
): string | undefined {
  for (const { entry } of manifestEntries(manifest)) {
    const label = entryLabel(entry, path);
    if (label) return label;
  }
  return undefined;
}
