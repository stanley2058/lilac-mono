import { memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "cn";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import {
  formatConfigPath,
  isConfigObject,
  readConfigValue,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { schemaAtPath } from "@stanley2058/lilac-utils/config-schema";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Button } from "../ui/button";
import { IconButton } from "../ui";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import type { CollectionEntry } from "../../config-ui/manifest";
import {
  useConfigDirty,
  useConfigDraftStore,
  useConfigDrafts,
  useConfigValue,
} from "../../config-ui/draft-store";
import { cleanDescription, formatConfigValue } from "../../config-ui/field-model";
import { configSchema } from "../../config-ui/schemas";
import { ConfigFieldRow } from "./ConfigFieldRow";
import { ConfigText } from "./ConfigText";
import { choiceLabel, useAliasLabel } from "./config-controls";
import { McpAddServerButton } from "./McpServerStatus";
import {
  ConfigScopeContext,
  splitPath,
  useConfigScope,
  type ConfigScope,
} from "./use-config-field";

const EMPTY: readonly string[] = [];

function keyProblem(
  kind: ConfigScope["kind"],
  path: ConfigPath,
  key: string,
  existing: readonly string[],
) {
  if (!key) return "Enter a name";
  if (existing.includes(key)) return "That name is taken";
  const { schema, root } = configSchema(kind);
  const pattern = schemaAtPath(schema, root, path)?.propertyNames?.pattern;
  if (pattern && !new RegExp(pattern, "u").test(key)) return "Use letters, digits, - or _";
  return undefined;
}

/** Status shown on a collection item header, such as an MCP server's connection state. */
export type ItemStatus = (key: string) => ReactNode;

export const ConfigCollection = memo(function ConfigCollection({
  entry,
  yamlPage,
  status,
}: {
  entry: CollectionEntry<string>;
  yamlPage: string;
  status?: ItemStatus;
}) {
  const scope = useConfigScope();
  const store = useConfigDraftStore();
  const path = useMemo(
    () => [...scope.base, ...splitPath(entry.collection)],
    [scope.base, entry.collection],
  );
  // Subscribe to the key list only; each item row subscribes to its own value.
  const keys = useConfigDrafts(
    useShallow((state) => {
      const record = readConfigValue(state.drafts[scope.kind]?.value ?? null, path);
      const present = isConfigObject(record) ? Object.keys(record) : [];
      const fixed = entry.fixedKeys ?? EMPTY;
      return [...fixed, ...present.filter((key) => !fixed.includes(key))];
    }),
  );
  const focus = useConfigDrafts((state) => state.focus[scope.kind]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string>();
  const [error, setError] = useState<string>();
  const focusedKey =
    focus && formatConfigPath(focus.path.slice(0, path.length)) === formatConfigPath(path)
      ? String(focus.path[path.length] ?? "")
      : undefined;
  const toggle = (key: string, next: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  function add() {
    const key = adding?.trim() ?? "";
    const problem = keyProblem(scope.kind, [...path, key], key, keys);
    if (problem) return setError(problem);
    const failed = store
      .getState()
      .apply(scope.kind, [{ op: "set", path: [...path, key], value: entry.newItem ?? {} }]);
    if (failed) return setError(failed);
    setAdding(undefined);
    setError(undefined);
    toggle(key, true);
  }
  const help = entry.help ?? cleanDescription(undefined);
  return (
    <div className="grid gap-2 py-2" data-config-path={formatConfigPath(path)}>
      {help ? (
        <p className="text-sm text-muted-foreground">
          <ConfigText text={help} />
        </p>
      ) : null}
      <div className="grid gap-1.5">
        {keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            No {entry.itemNoun}s yet
          </p>
        ) : null}
        {keys.map((key) => (
          <CollectionItem
            key={key}
            entry={entry}
            path={path}
            itemKey={key}
            keys={keys}
            open={open.has(key) || focusedKey === key}
            onOpenChange={(next) => toggle(key, next)}
            yamlPage={yamlPage}
            status={status}
          />
        ))}
      </div>
      {entry.addDialog === "mcpServer" ? (
        <McpAddServerButton takenIds={keys} disabled={scope.disabled} />
      ) : null}
      {!entry.addDialog && adding === undefined ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={scope.disabled}
            onClick={() => {
              setAdding("");
              setError(undefined);
            }}
          >
            <Plus />
            Add {entry.itemNoun}
          </Button>
        </div>
      ) : null}
      {!entry.addDialog && adding !== undefined ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <InputGroup className="w-64 flex-none">
              <InputGroupInput
                autoFocus
                aria-label={entry.keyLabel}
                className="font-mono text-xs"
                placeholder={entry.keyPlaceholder ?? entry.keyLabel}
                value={adding}
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setAdding(event.target.value);
                  setError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") add();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setAdding(undefined);
                  }
                }}
              />
            </InputGroup>
            <Button size="sm" onClick={add}>
              Add
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(undefined)}>
              Cancel
            </Button>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
});

function summaryText(entry: CollectionEntry<string>, item: ConfigValue | undefined): string {
  if (typeof item === "string") return item;
  if (!isConfigObject(item)) return "";
  return (entry.summary ?? [])
    .map((field) => {
      const value = readConfigValue(item, splitPath(field));
      if (value === undefined || value === "") return undefined;
      const options = entry.fields.find((candidate) => candidate.path === field);
      return options?.options ? choiceLabel(options, value) : formatConfigValue(value);
    })
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function CollectionItem({
  entry,
  path,
  itemKey,
  keys,
  open,
  onOpenChange,
  yamlPage,
  status,
}: {
  entry: CollectionEntry<string>;
  path: ConfigPath;
  itemKey: string;
  keys: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yamlPage: string;
  status?: ItemStatus;
}) {
  const parent = useConfigScope();
  const store = useConfigDraftStore();
  const itemPath = useMemo(() => [...path, itemKey], [path, itemKey]);
  const item = useConfigValue(parent.kind, itemPath);
  const added = useConfigDrafts((state) => {
    const draft = state.drafts[parent.kind];
    if (draft?.savedValue === undefined || draft.value === undefined) return false;
    return (
      readConfigValue(draft.savedValue, itemPath) === undefined &&
      readConfigValue(draft.value, itemPath) !== undefined
    );
  });
  const dirty = useConfigDirty(parent.kind, itemPath);
  const resets = useConfigDrafts((state) => state.drafts[parent.kind]?.resets ?? 0);
  const [renaming, setRenaming] = useState<string>();
  const [error, setError] = useState<string>();
  const fixed = entry.fixedKeys?.includes(itemKey) ?? false;
  const alias = useAliasLabel(entry.channelKeys ? "discordChannel" : undefined, itemKey);
  const scope = useMemo<ConfigScope>(
    () => ({
      ...parent,
      base: itemPath,
      ...(entry.shorthand ? { shorthand: entry.shorthand } : {}),
    }),
    [parent, itemPath, entry.shorthand],
  );
  function rename() {
    const next = renaming?.trim() ?? "";
    if (next === itemKey) return setRenaming(undefined);
    const problem = keyProblem(parent.kind, [...path, next], next, keys);
    if (problem) return setError(problem);
    const failed = store.getState().apply(parent.kind, [
      { op: "set", path: [...path, next], value: item ?? {} },
      { op: "unset", path: itemPath },
    ]);
    if (failed) return setError(failed);
    setRenaming(undefined);
    setError(undefined);
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn(
        "group/item rounded-lg border border-border bg-background transition-colors",
        open && "bg-surface/40",
      )}
    >
      <div className="flex min-h-10 items-center gap-2 pr-1.5 pl-2">
        {renaming === undefined ? (
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            data-config-path={formatConfigPath(itemPath)}
          >
            <ChevronRight
              className={cn(
                "size-4 flex-none text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span
              aria-hidden
              className={cn(
                "size-1.5 flex-none rounded-full bg-primary",
                dirty ? "opacity-100" : "opacity-0",
              )}
            />
            {alias ? <span className="text-sm font-medium">#{alias}</span> : null}
            <span
              className={cn("truncate font-mono text-sm", alias && "text-xs text-muted-foreground")}
            >
              {itemKey}
            </span>
            {fixed ? <span className="text-xs text-muted-foreground">Built-in</span> : null}
            {added ? <span className="text-xs text-primary">New</span> : null}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {summaryText(entry, item)}
            </span>
          </CollapsibleTrigger>
        ) : (
          <div className="flex flex-1 items-center gap-1.5 py-1">
            <InputGroup className="w-64 flex-none">
              <InputGroupInput
                autoFocus
                aria-label={`Rename ${itemKey}`}
                className="font-mono text-xs"
                value={renaming}
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setRenaming(event.target.value);
                  setError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") rename();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setRenaming(undefined);
                  }
                }}
              />
            </InputGroup>
            <Button size="sm" onClick={rename}>
              Rename
            </Button>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
          </div>
        )}
        {status && renaming === undefined ? status(itemKey) : null}
        {fixed || renaming !== undefined ? null : (
          <span className="flex items-center opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100">
            <IconButton
              label={`Rename ${itemKey}`}
              tooltip="Rename"
              className="size-7"
              disabled={parent.disabled}
              onClick={() => setRenaming(itemKey)}
            >
              <Pencil />
            </IconButton>
            <IconButton
              label={`Remove ${itemKey}`}
              tooltip="Remove"
              className="size-7 hover:text-danger"
              disabled={parent.disabled}
              onClick={() => {
                const failed = store
                  .getState()
                  .apply(parent.kind, [{ op: "unset", path: itemPath }]);
                if (failed) setError(failed);
              }}
            >
              <Trash2 />
            </IconButton>
          </span>
        )}
      </div>
      <CollapsibleContent className="border-t border-border px-3 pb-2">
        <ConfigScopeContext value={scope}>
          {entry.fields.map((field) => (
            <ConfigFieldRow key={`${field.path}:${resets}`} entry={field} yamlPage={yamlPage} />
          ))}
        </ConfigScopeContext>
      </CollapsibleContent>
    </Collapsible>
  );
}
