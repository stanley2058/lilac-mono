import { createContext, useCallback, useContext, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  configValuesEqual,
  readConfigValue,
  type ConfigPatchOperation,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import type { ConfigSchemaNode } from "@stanley2058/lilac-utils/config-schema";
import {
  useConfigDirty,
  useConfigDrafts,
  useConfigDraftStore,
  useConfigValue,
} from "../../config-ui/draft-store";
import {
  describedDefault,
  fieldDefault,
  fieldInfo,
  fieldNode,
  requiresRestart,
  type FieldInfo,
} from "../../config-ui/field-model";
import type { ConfigKind } from "../../config-ui/schemas";
import type { FieldEntry } from "../../config-ui/manifest";

/** Where relative manifest paths resolve: the file, or one collection item in it. */
export type ConfigScope = {
  readonly kind: ConfigKind;
  readonly base: ConfigPath;
  /** A string item value stands for this item field. */
  readonly shorthand?: string;
  readonly disabled: boolean;
};

export const ConfigScopeContext = createContext<ConfigScope | null>(null);

export function useConfigScope(): ConfigScope {
  return useContext(ConfigScopeContext)!;
}

export function splitPath(path: string): ConfigPath {
  return path.split(".");
}

export type ConfigField = {
  readonly path: ConfigPath;
  readonly node: ConfigSchemaNode;
  readonly info: FieldInfo;
  readonly value: ConfigValue | undefined;
  /** The value Core uses when the field is absent. */
  readonly defaultValue: ConfigValue | undefined;
  readonly defaultText?: string;
  readonly dirty: boolean;
  readonly restart: boolean;
  readonly disabled: boolean;
  /** Writes the value, or removes the field when it equals the default. */
  commit(value: ConfigValue | undefined): string | undefined;
  apply(operations: readonly ConfigPatchOperation[]): string | undefined;
};

/**
 * The item's string value when it is shorthand for this field. Subscribing to a string keeps
 * other fields of the item from rerendering when a sibling changes.
 */
function useShorthandItem(kind: ConfigKind, base: ConfigPath, active: boolean): string | undefined {
  return useConfigDrafts((state) => {
    if (!active) return undefined;
    const item = readConfigValue(state.drafts[kind]?.value ?? null, base);
    return typeof item === "string" ? item : undefined;
  });
}

/** Reads and edits one field relative to the current scope. Returns `undefined` when the schema has no such field for the current value. */
export function useConfigField(relative: string): ConfigField | undefined {
  const scope = useConfigScope();
  const store = useConfigDraftStore();
  const { kind, base, shorthand } = scope;
  const path = useMemo(() => [...base, ...splitPath(relative)], [base, relative]);
  const node = useConfigDrafts((state) => fieldNode(kind, path, state.drafts[kind]?.value));
  const item = useShorthandItem(kind, base, shorthand === relative);
  const stored = useConfigValue(kind, path);
  const isShorthand = item !== undefined;
  const value = isShorthand ? item : stored;
  const dirty = useConfigDirty(kind, isShorthand ? base : path);
  const defaultValue = useConfigDrafts(
    useShallow((state) => fieldDefault(kind, path, state.drafts[kind]?.value)),
  );
  const restart = useMemo(() => requiresRestart(kind, path), [kind, path]);
  const apply = useCallback(
    (operations: readonly ConfigPatchOperation[]) => {
      const current = readConfigValue(store.getState().drafts[kind]?.value ?? null, base);
      // Expand a shorthand string item before writing one of its fields.
      const expand: ConfigPatchOperation[] =
        shorthand && typeof current === "string" && base.length > 0
          ? [{ op: "set", path: base, value: { [shorthand]: current } }]
          : [];
      return store.getState().apply(kind, [...expand, ...operations]);
    },
    [store, kind, base, shorthand],
  );
  const commit = useCallback(
    (next: ConfigValue | undefined) => {
      if (next === undefined || configValuesEqual(next, defaultValue))
        return apply([{ op: "unset", path }]);
      return apply([{ op: "set", path, value: next }]);
    },
    [apply, path, defaultValue],
  );
  if (!node) return undefined;
  const info = fieldInfo(kind, node);
  return {
    path,
    node,
    info,
    value,
    defaultValue,
    defaultText: defaultValue === undefined ? describedDefault(node.description) : undefined,
    dirty,
    restart,
    disabled: scope.disabled,
    commit,
    apply,
  };
}

/** The effective value at a scope-relative path: the draft value or its default. */
export function useEffectiveValue(relative: string): ConfigValue | undefined {
  const { kind, base, shorthand } = useConfigScope();
  const path = useMemo(() => [...base, ...splitPath(relative)], [base, relative]);
  const item = useShorthandItem(kind, base, shorthand === relative);
  const value = useConfigValue(kind, path);
  const fallback = useConfigDrafts(
    useShallow((state) => fieldDefault(kind, path, state.drafts[kind]?.value)),
  );
  if (item !== undefined) return item;
  return value ?? fallback;
}

/** The value an unset field takes from the fields named in its `inherits`. */
export function useInheritedValue(entry: FieldEntry<string>): string | undefined {
  const [first = "", second = ""] = entry.inherits ?? [];
  const primary = useEffectiveValue(first);
  const secondary = useEffectiveValue(second);
  if (!entry.inherits) return undefined;
  if (typeof primary === "string") return primary;
  return typeof secondary === "string" ? secondary : undefined;
}
