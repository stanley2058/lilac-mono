import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, CornerDownLeft, Search, X } from "lucide-react";
import { cn } from "cn";
import {
  isConfigArray,
  isConfigObject,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { objectAlternative } from "@stanley2058/lilac-utils/config-schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { configSchema } from "../../config-ui/schemas";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { IconButton } from "../ui";
import { ProviderIcon, providerName } from "../ProviderIcon";
import { queryNativeRPC, useNativeOnline } from "../../queries";
import { useWorkspace } from "../../workspace-context";
import { useConfigValue } from "../../config-ui/draft-store";
import { useConfigScope, useInheritedValue } from "./use-config-field";
import { useYamlText, type ControlProps } from "./config-controls";

type Choice = { id: string; title: string; detail?: string; provider?: string };

const BUILT_IN = new Set(["main", "fast"]);

function useAliases(): Choice[] {
  const { kind } = useConfigScope();
  const models = useConfigValue(kind, ["models"]);
  return useMemo(() => {
    const record = isConfigObject(models) ? models : {};
    const def = isConfigObject(record.def) ? record.def : {};
    const target = (value: ConfigValue | undefined) =>
      isConfigObject(value) && typeof value.model === "string" ? value.model : undefined;
    return [
      {
        id: "main",
        title: "main",
        detail: target(record.main) ?? "Main model",
      },
      {
        id: "fast",
        title: "fast",
        detail: target(record.fast) ?? "Fast model",
      },
      ...Object.entries(def).map(([name, value]) => ({
        id: name,
        title: name,
        detail: target(value),
      })),
    ];
  }, [models]);
}

/** Which aliases a field accepts: every alias, only `models.def` aliases, or none. */
export type AliasMode = "all" | "custom" | "none";

/** How a model field at `path` may refer to other models. */
export function modelReferenceRules(field: ControlProps["field"]): {
  aliases: AliasMode;
} {
  if (field.node.pattern?.includes("/")) return { aliases: "none" };
  // `main` and `fast` resolve through the models section, so fields inside it cannot name them.
  return { aliases: field.path[0] === "models" ? "custom" : "all" };
}

/**
 * Picks a model reference: an alias from this file, a catalog model, or any typed
 * `provider/model` value.
 */
export function ModelPicker({
  id,
  label,
  value,
  placeholder,
  aliases: aliasMode,
  disabled,
  trigger,
  onSelect,
}: {
  id?: string;
  label: string;
  value?: string;
  placeholder?: string;
  aliases: AliasMode;
  disabled: boolean;
  trigger?: ReactNode;
  onSelect: (id: string) => void;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // `null` follows the current value until the keyboard or pointer moves the highlight.
  const [activeOverride, setActive] = useState<number | null>(null);
  const query = useDeferredValue(search.trim());
  const aliases = useAliases();
  const catalog = useQuery({
    queryKey: ["config-model-catalog", query],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.catalogs.models({ search: query }, { signal })),
    enabled: open && online,
    staleTime: 60_000,
  });
  const lower = query.toLowerCase();
  const allowedAliases = aliases.filter(
    (alias) => aliasMode === "all" || (aliasMode === "custom" && !BUILT_IN.has(alias.id)),
  );
  const matchingAliases = allowedAliases.filter(
    (alias) => !lower || `${alias.id} ${alias.detail ?? ""}`.toLowerCase().includes(lower),
  );
  const catalogModels = catalog.data?.models ?? [];
  const choices: Choice[] = [
    ...matchingAliases,
    ...catalogModels.map((model) => ({
      id: model.id,
      title: model.label,
      detail: model.id,
      provider: model.provider,
    })),
  ];
  const custom = query && !choices.some((choice) => choice.id === query) ? query : undefined;
  // A value that is neither an alias nor a catalog model still gets a row to mark as selected.
  // Waiting for the catalog keeps a catalog model from showing here and then moving.
  const listed = (catalog.isFetched || !online) && !query;
  const current =
    listed && value && !choices.some((choice) => choice.id === value) ? value : undefined;
  let all = choices;
  if (custom) all = [{ id: custom, title: `Use “${custom}”` }, ...choices];
  if (current) all = [{ id: current, title: current }, ...choices];
  // Clamped because the list can shrink or arrive after the highlight moved.
  const wanted = activeOverride ?? all.findIndex((choice) => choice.id === value);
  const active = wanted < 0 ? 0 : Math.min(wanted, all.length - 1);
  const list = useRef<HTMLDivElement | null>(null);
  const revealed = useRef(false);
  // Scrolls the current value into view once per opening. The list mounts after the popover
  // opens, and catalog models can arrive later, so this runs on mount and when choices change.
  function reveal(node: HTMLDivElement | null) {
    list.current = node;
    if (!node || revealed.current) return;
    const selected = node.querySelector('[aria-selected="true"]');
    if (!selected) return;
    selected.scrollIntoView({ block: "nearest" });
    revealed.current = true;
  }
  useEffect(() => reveal(list.current), [all.length]);
  function pick(next: string) {
    onSelect(next);
    setOpen(false);
    setSearch("");
  }
  function onKeyDown(event: KeyboardEvent) {
    // Moving on an empty list would pin the highlight before the current value arrives.
    if (all.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(all.length - 1, active + 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, active - 1));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = all[active];
      if (choice) pick(choice.id);
    }
  }
  const aliasCount = matchingAliases.length;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setActive(null);
        revealed.current = false;
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger
        render={
          trigger ? (
            <Button variant="ghost" size="sm" disabled={disabled} aria-label={label} />
          ) : (
            <Button
              id={id}
              variant="outline"
              disabled={disabled}
              aria-label={label}
              className="w-60 justify-between font-normal"
            />
          )
        }
      >
        {trigger ?? (
          <>
            <span className={cn("truncate font-mono text-xs", !value && "text-muted-foreground")}>
              {value || placeholder || "Choose a model"}
            </span>
            <ChevronDown className="text-muted-foreground" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Search models"
            className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-input-placeholder"
            placeholder={aliasMode === "none" ? "provider/model" : "Alias or provider/model"}
            value={search}
            spellCheck={false}
            onChange={(event) => {
              setSearch(event.target.value);
              setActive(event.target.value.trim() ? 0 : null);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          ref={reveal}
          role="listbox"
          aria-label={label}
          className="max-h-72 overflow-y-auto p-1"
        >
          {all.map((choice, index) => {
            const first = custom || current ? 1 : 0;
            let heading: string | undefined;
            if (index === first && aliasCount > 0) heading = "Aliases";
            else if (index === first + aliasCount && choice.provider) heading = "Catalog";
            const selected = choice.id === value;
            return (
              <div key={`${choice.id}-${index}`}>
                {heading ? (
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {heading}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(choice.id)}
                >
                  {choice.provider ? (
                    <ProviderIcon provider={choice.provider} className="size-4 flex-none" />
                  ) : null}
                  {index === 0 && custom ? (
                    <CornerDownLeft className="size-4 flex-none text-muted-foreground" />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", !choice.provider && "font-mono text-xs")}>
                      {choice.title}
                    </span>
                    {choice.detail ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {choice.provider ? providerName(choice.provider) : choice.detail}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <Check aria-hidden className="size-4 flex-none text-primary" />
                  ) : null}
                </button>
              </div>
            );
          })}
          {all.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {catalog.isFetching ? "Searching" : "Type a provider/model reference"}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ModelControl(props: ControlProps) {
  const { field, entry } = props;
  const value = typeof field.value === "string" ? field.value : undefined;
  const inherited = useInheritedValue(entry);
  const fallback =
    entry.placeholder ??
    inherited ??
    (typeof field.defaultValue === "string" ? field.defaultValue : undefined);
  return (
    <ModelPicker
      id={props.id}
      label={props.label}
      value={value}
      placeholder={fallback}
      {...modelReferenceRules(field)}
      disabled={field.disabled}
      onSelect={(next) => props.onError(field.commit(next))}
    />
  );
}

function modelName(item: ConfigValue): string {
  if (typeof item === "string") return item;
  return isConfigObject(item) && typeof item.model === "string" ? item.model : "Custom";
}

/** Ordered model references. Object entries keep their extra settings. */
type EntrySettings = {
  readonly reasoning?: string;
  readonly options?: ConfigValue;
};

function entrySettings(item: ConfigValue): EntrySettings {
  if (!isConfigObject(item)) return {};
  return {
    ...(typeof item.reasoning === "string" ? { reasoning: item.reasoning } : {}),
    ...(item.options === undefined ? {} : { options: item.options }),
  };
}

/** A list entry is a bare reference until it carries its own reasoning or options. */
function withSettings(item: ConfigValue, settings: EntrySettings): ConfigValue {
  const model = modelName(item);
  const next: Record<string, ConfigValue> = { model };
  if (settings.reasoning !== undefined) next.reasoning = settings.reasoning;
  if (settings.options !== undefined) next.options = settings.options;
  return Object.keys(next).length === 1 ? model : next;
}

const UNSET = "__unset__";

/** Reasoning and provider options for one fallback entry. */
function EntrySettingsEditor({
  item,
  reasoning,
  labels,
  disabled,
  onChange,
}: {
  item: ConfigValue;
  reasoning: readonly string[];
  labels?: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (item: ConfigValue) => void;
}) {
  const settings = entrySettings(item);
  const {
    text,
    setText,
    problem,
    commit: commitOptions,
  } = useYamlText(settings.options, (options) =>
    onChange(withSettings(item, { ...settings, options })),
  );
  const items = [
    { value: UNSET, label: "Not set" },
    ...reasoning.map((value) => ({
      value,
      label: labels?.[JSON.stringify(value)] ?? value,
    })),
  ];
  return (
    <div className="grid gap-3 p-1.5">
      <div className="truncate font-mono text-xs">{modelName(item)}</div>
      <label className="grid gap-1 text-sm">
        Reasoning
        <Select
          items={items}
          value={settings.reasoning ?? UNSET}
          disabled={disabled}
          onValueChange={(next) =>
            onChange(
              withSettings(item, {
                ...settings,
                reasoning: next === UNSET || typeof next !== "string" ? undefined : next,
              }),
            )
          }
        >
          <SelectTrigger aria-label="Reasoning" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="grid gap-1 text-sm">
        Provider options
        <Textarea
          className="max-h-60 min-h-16 resize-y font-mono text-xs"
          spellCheck={false}
          placeholder="temperature: 0.2"
          value={text}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitOptions}
        />
        {problem ? <span className="text-xs text-danger">{problem}</span> : null}
      </label>
    </div>
  );
}

export function ModelListControl(props: ControlProps) {
  const { field } = props;
  const { kind } = useConfigScope();
  // Lists such as fallbacks also accept `{model, reasoning, options}` entries.
  const entryNode = field.info.itemNode
    ? objectAlternative(configSchema(kind).schema, field.info.itemNode, undefined)
    : undefined;
  const reasoning = (entryNode?.properties?.reasoning?.enum ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  const current = field.value ?? field.defaultValue;
  let items: readonly ConfigValue[] = [];
  if (isConfigArray(current)) items = current;
  else if (typeof current === "string") items = [current];
  const write = (next: readonly ConfigValue[]) =>
    props.onError(field.commit(next.length === 0 ? undefined : [...next]));
  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-input-background p-1">
      {items.map((item, index) => (
        <span
          key={`${modelName(item)}-${index}`}
          className={cn(
            "group/model inline-flex max-w-full items-center gap-1 rounded-md bg-surface py-0.5 pr-0.5 pl-2 text-xs",
            field.value === undefined ? "text-muted-foreground" : "text-surface-foreground",
          )}
        >
          <span className="text-muted-foreground tabular-nums">{index + 1}</span>
          {entryNode ? (
            <Popover>
              <PopoverTrigger
                className="flex min-w-0 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`Settings for ${modelName(item)}`}
              >
                <span className="truncate font-mono">{modelName(item)}</span>
                {typeof item === "string" ? null : (
                  <span className="text-muted-foreground" aria-label="Has its own settings">
                    +
                  </span>
                )}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80">
                <EntrySettingsEditor
                  item={item}
                  reasoning={reasoning}
                  labels={props.entry.options}
                  disabled={field.disabled}
                  onChange={(next) =>
                    write(items.map((other, at) => (at === index ? next : other)))
                  }
                />
              </PopoverContent>
            </Popover>
          ) : (
            <span className="truncate font-mono">{modelName(item)}</span>
          )}
          {index > 0 ? (
            <button
              type="button"
              className="rounded-sm px-0.5 text-muted-foreground opacity-0 group-hover/model:opacity-100 hover:text-foreground focus-visible:opacity-100"
              aria-label={`Move ${modelName(item)} earlier`}
              disabled={field.disabled}
              onClick={() => {
                const next = [...items];
                const [moved] = next.splice(index, 1);
                if (moved !== undefined) next.splice(index - 1, 0, moved);
                write(next);
              }}
            >
              ‹
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            aria-label={`Remove ${modelName(item)}`}
            disabled={field.disabled}
            onClick={() => write(items.filter((_, other) => other !== index))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <ModelPicker
        {...modelReferenceRules(field)}
        label={`Add to ${props.label}`}
        disabled={field.disabled}
        trigger={<span className="text-muted-foreground">Add model</span>}
        onSelect={(next) => write([...items, next])}
      />
      {items.length === 0 ? null : (
        <IconButton
          label={`Clear ${props.label}`}
          className="ml-auto size-6"
          disabled={field.disabled}
          onClick={() => write([])}
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}
