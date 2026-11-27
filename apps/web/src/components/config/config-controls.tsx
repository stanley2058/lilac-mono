import { useId, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Eye, EyeOff, Infinity as InfinityIcon, Plus, X } from "lucide-react";
import {
  formatConfigYamlValue,
  isConfigArray,
  isConfigObject,
  parseConfigYaml,
  readConfigValue,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { useShallow } from "zustand/react/shallow";
import {
  objectAlternative,
  schemaAlternatives,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { IconButton } from "../ui";
import type { FieldEntry } from "../../config-ui/manifest";
import { choiceKey, fieldInfo, formatConfigValue } from "../../config-ui/field-model";
import { configSchema } from "../../config-ui/schemas";
import { useConfigDrafts, useConfigValue } from "../../config-ui/draft-store";
import { useConfigScope, useInheritedValue, type ConfigField } from "./use-config-field";
import { TextEditorField } from "./ConfigTextEditor";

export type ControlProps = {
  readonly id: string;
  readonly field: ConfigField;
  readonly entry: FieldEntry<string>;
  readonly label: string;
  readonly onError: (message: string | undefined) => void;
};

function report(props: ControlProps, message: string | undefined) {
  props.onError(message);
}

export function CommitInput({
  id,
  value,
  validate,
  placeholder,
  className,
  inputClassName,
  inputMode,
  type = "text",
  label,
  disabled,
  lead,
  addon,
  trim = true,
  onCommit,
}: {
  id?: string;
  value: string;
  validate?: (text: string) => string | undefined;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  inputMode?: "decimal" | "numeric" | "text";
  type?: "text" | "password";
  label?: string;
  disabled?: boolean;
  /** A label inside the field, before the text. */
  lead?: ReactNode;
  addon?: ReactNode;
  /** Whether surrounding spaces are dropped. Prefixes such as `Bearer ` keep them. */
  trim?: boolean;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(value);
  }
  const clean = (raw: string) => (trim ? raw.trim() : raw);
  const problem = text.trim() === "" ? undefined : validate?.(clean(text));
  function commit() {
    if (problem || clean(text) === clean(value)) return;
    onCommit(clean(text));
  }
  return (
    <InputGroup className={cn("flex-none", className)}>
      {lead ? <InputGroupAddon className="pr-0 pl-2.5 text-xs">{lead}</InputGroupAddon> : null}
      <InputGroupInput
        id={id}
        type={type}
        aria-label={label}
        className={inputClassName}
        inputMode={inputMode}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        title={problem}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape" && text !== value) {
            event.stopPropagation();
            setText(value);
          }
        }}
      />
      {addon}
    </InputGroup>
  );
}

const MONO_KINDS = new Set([
  "embeddingModel",
  "env",
  "cron",
  "clockTime",
  "discordChannel",
  "discordGuild",
  "discordUser",
]);

function placeholderFor(field: ConfigField, entry: FieldEntry<string>): string | undefined {
  if (entry.placeholder) return entry.placeholder;
  if (field.defaultValue !== undefined && field.defaultValue !== null)
    return typeof field.defaultValue === "object" ? undefined : String(field.defaultValue);
  return field.defaultText;
}

export function SwitchControl(props: ControlProps) {
  const { field } = props;
  const checked = (field.value ?? field.defaultValue ?? false) === true;
  return (
    <div className="flex h-8 flex-none items-center">
      <Switch
        id={props.id}
        checked={checked}
        disabled={field.disabled}
        onCheckedChange={(next) => report(props, field.commit(next))}
      />
    </div>
  );
}

export function choiceLabel(entry: FieldEntry<string>, value: ConfigValue): string {
  return entry.options?.[choiceKey(value)] ?? formatConfigValue(value);
}

export function ChoiceControl(props: ControlProps) {
  const { field, entry } = props;
  const current = field.value ?? field.defaultValue;
  const items = field.info.choices.map((value) => ({
    value: choiceKey(value),
    label: choiceLabel(entry, value),
  }));
  return (
    <Select
      items={items}
      value={current === undefined ? null : choiceKey(current)}
      disabled={field.disabled}
      onValueChange={(key) => {
        const value = field.info.choices.find((choice) => choiceKey(choice) === key);
        if (value !== undefined) report(props, field.commit(value));
      }}
    >
      <SelectTrigger
        id={props.id}
        aria-label={props.label}
        className={cn("min-w-36", field.value === undefined && "text-muted-foreground")}
      >
        <SelectValue placeholder="Not set" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UnlimitedToggle({
  field,
  onError,
}: {
  field: ConfigField;
  onError: (m?: string) => void;
}) {
  if (!field.info.unlimited) return null;
  const active = field.value === "unlimited";
  return (
    <InputGroupAddon className="pr-1">
      <IconButton
        label={active ? "Set a limit" : "No limit"}
        aria-pressed={active}
        className="size-6"
        disabled={field.disabled}
        onClick={() => onError(field.commit(active ? undefined : "unlimited"))}
      >
        <InfinityIcon />
      </IconButton>
    </InputGroupAddon>
  );
}

function NumberAddon({ field, onError }: { field: ConfigField; onError: (m?: string) => void }) {
  if (field.info.unlimited) return <UnlimitedToggle field={field} onError={onError} />;
  // Millisecond fields are plain numbers in the schema; name the unit beside them.
  if (String(field.path.at(-1)).endsWith("Ms")) return <InputGroupAddon>ms</InputGroupAddon>;
  return null;
}

export function NumberControl(props: ControlProps) {
  const { field, entry } = props;
  const { info } = field;
  const shown = typeof field.value === "number" ? String(field.value) : "";
  const unlimited = field.value === "unlimited";
  return (
    <CommitInput
      id={props.id}
      className="w-36"
      inputClassName="text-right tabular-nums"
      inputMode={info.integer ? "numeric" : "decimal"}
      placeholder={unlimited ? "No limit" : placeholderFor(field, entry)}
      value={shown}
      disabled={field.disabled}
      validate={(text) => {
        const number = Number(text);
        if (!Number.isFinite(number)) return "Enter a number";
        if (info.integer && !Number.isInteger(number)) return "Enter a whole number";
        if (info.min !== undefined && number < info.min) return `Use ${info.min} or more`;
        if (info.max !== undefined && number > info.max) return `Use ${info.max} or less`;
        return undefined;
      }}
      addon={<NumberAddon field={field} onError={props.onError} />}
      onCommit={(text) => report(props, field.commit(text === "" ? undefined : Number(text)))}
    />
  );
}

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ["w", 604_800_000],
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
];
const BYTE_UNITS: readonly (readonly [string, number])[] = [
  ["GiB", 1_073_741_824],
  ["MiB", 1_048_576],
  ["KiB", 1_024],
];

/** Shows a stored millisecond or byte count in the largest exact unit. */
export function formatUnitValue(value: ConfigValue | undefined, kind: "duration" | "bytes") {
  if (typeof value === "string") return value;
  if (typeof value !== "number") return "";
  for (const [unit, size] of kind === "duration" ? DURATION_UNITS : BYTE_UNITS)
    if (value >= size && value % size === 0) return `${value / size}${unit}`;
  return kind === "duration" ? `${value}ms` : `${value}B`;
}

const DURATION_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]+)?(ms|s|m|h|d|w|mo)$/u;
const BYTES_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]+)?(B|KB|MB|GB|KiB|MiB|GiB)$/u;

export function UnitControl(props: ControlProps) {
  const { field, entry } = props;
  const kind = field.info.kind === "bytes" ? "bytes" : "duration";
  const unlimited = field.value === "unlimited";
  const fallback = placeholderFor(field, entry);
  return (
    <CommitInput
      id={props.id}
      className="w-36"
      inputClassName="text-right tabular-nums"
      placeholder={
        unlimited
          ? "No limit"
          : ((fallback && /^\d+$/u.test(fallback)
              ? formatUnitValue(Number(fallback), kind)
              : fallback) ?? (kind === "duration" ? "30m" : "1MiB"))
      }
      value={unlimited ? "" : formatUnitValue(field.value, kind)}
      disabled={field.disabled}
      validate={(text) => {
        if (/^\d+$/u.test(text)) return undefined;
        if ((kind === "duration" ? DURATION_TEXT : BYTES_TEXT).test(text)) return undefined;
        return kind === "duration"
          ? "Use a number with ms, s, m, h, d, w, or mo"
          : "Use a number with B, KB, MB, GB, KiB, MiB, or GiB";
      }}
      addon={<UnlimitedToggle field={field} onError={props.onError} />}
      onCommit={(text) => {
        if (text === "") return report(props, field.commit(undefined));
        report(props, field.commit(/^\d+$/u.test(text) ? Number(text) : text));
      }}
    />
  );
}

function textProblem(node: ConfigSchemaNode, kind: string | undefined, text: string) {
  if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(text))
    return "Use letters, digits, and underscores";
  if (kind === "clockTime" && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(text)) return "Use HH:MM";
  if (kind === "cron" && text.split(/\s+/u).filter(Boolean).length !== 5)
    return "Use five cron fields";
  if (node.pattern && !new RegExp(node.pattern, "u").test(text)) return "Invalid format";
  if (node.maxLength !== undefined && text.length > node.maxLength)
    return `Use at most ${node.maxLength} characters`;
  return undefined;
}

export function TextControl(props: ControlProps) {
  const { field, entry } = props;
  const stringNode =
    schemaAlternatives(configSchema(useConfigScope().kind).schema, field.node).find(
      (node) => node.type === "string",
    ) ?? field.node;
  const inherited = useInheritedValue(entry);
  return (
    <CommitInput
      id={props.id}
      className="w-72"
      inputClassName={cn(MONO_KINDS.has(field.info.kind ?? "") && "font-mono text-xs")}
      placeholder={entry.placeholder ?? inherited ?? placeholderFor(field, entry)}
      value={typeof field.value === "string" ? field.value : ""}
      disabled={field.disabled}
      validate={(text) => textProblem(stringNode, field.info.kind, text)}
      onCommit={(text) => report(props, field.commit(text === "" ? undefined : text))}
    />
  );
}

export function MultilineControl(props: ControlProps) {
  const { field, entry } = props;
  return (
    <TextEditorField
      id={props.id}
      label={props.label}
      language="markdown"
      value={typeof field.value === "string" ? field.value : ""}
      placeholder={placeholderFor(field, entry)}
      disabled={field.disabled}
      onSave={(text) => field.commit(text.trim() === "" ? undefined : text)}
    />
  );
}

/** A one-line string in a textarea that wraps; Enter commits instead of adding a line break. */
export function LongTextControl(props: ControlProps) {
  const { field, entry } = props;
  const value = typeof field.value === "string" ? field.value : "";
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(value);
  }
  function commit() {
    const next = text.trim();
    if (next === value.trim()) return;
    report(props, field.commit(next === "" ? undefined : next));
  }
  return (
    <Textarea
      id={props.id}
      rows={1}
      className="min-h-8 resize-none py-1.5"
      placeholder={placeholderFor(field, entry)}
      value={text}
      disabled={field.disabled}
      spellCheck={false}
      onChange={(event) => setText(event.target.value.replace(/\r?\n/gu, " "))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape" && text !== value) {
          event.stopPropagation();
          setText(value);
        }
      }}
    />
  );
}

/**
 * Text state for editing a value as YAML. The text resets when the value changes elsewhere, and
 * `commit` parses it, treating blank text as unset.
 */
export function useYamlText(
  value: ConfigValue | undefined,
  onCommit: (value: ConfigValue | undefined) => void,
) {
  const formatted = formatConfigYamlValue(value);
  const [text, setText] = useState(formatted);
  const [synced, setSynced] = useState(formatted);
  const [problem, setProblem] = useState<string>();
  if (synced !== formatted) {
    setSynced(formatted);
    setText(formatted);
    setProblem(undefined);
  }
  function commit() {
    if (text === formatted || text.trim() === "") setProblem(undefined);
    if (text === formatted) return;
    if (text.trim() === "") return onCommit(undefined);
    parseConfigYaml(text).match({
      ok: ({ value: next }) => {
        setProblem(undefined);
        onCommit(next);
      },
      err: (error) => setProblem(error.message.split("\n")[0]),
    });
  }
  return { text, setText, problem, commit };
}

type ParsedYaml = { value: ConfigValue | undefined; problem?: undefined } | { problem: string };

/** Parses YAML text for a value, treating blank text as unset. */
function parseYamlValue(text: string): ParsedYaml {
  if (text.trim() === "") return { value: undefined };
  return parseConfigYaml(text).match<ParsedYaml>({
    ok: ({ value }) => ({ value }),
    err: (error) => ({ problem: error.message.split("\n")[0] ?? "Invalid YAML" }),
  });
}

/** A YAML value previewed in place and edited in a code editor dialog. */
export function YamlEditorField({
  id,
  label,
  value,
  disabled,
  onCommit,
}: {
  id?: string;
  label: string;
  value: ConfigValue | undefined;
  disabled: boolean;
  onCommit: (value: ConfigValue | undefined) => string | undefined;
}) {
  return (
    <TextEditorField
      id={id}
      label={label}
      language="yaml"
      value={value === undefined ? "" : formatConfigYamlValue(value)}
      disabled={disabled}
      onSave={(text) => {
        const parsed = parseYamlValue(text);
        if (parsed.problem !== undefined) return parsed.problem;
        return onCommit(parsed.value);
      }}
    />
  );
}

export function YamlControl(props: ControlProps) {
  const { field } = props;
  return (
    <YamlEditorField
      id={props.id}
      label={props.label}
      value={field.value}
      disabled={field.disabled}
      onCommit={(next) => field.commit(next)}
    />
  );
}

const ALIAS_PATHS: Partial<Record<string, ConfigPath>> = {
  discordChannel: ["entity", "sessions", "discord"],
  discordUser: ["entity", "users"],
};
const NO_ALIASES: Readonly<Record<string, string>> = {};

function aliasFor(target: ConfigValue, id: string): boolean {
  return (isConfigObject(target) ? target.discord : target) === id;
}

/** The alias name of one Discord ID, for rows that show a single ID. */
export function useAliasLabel(kind: string | undefined, id: string): string | undefined {
  const { kind: file } = useConfigScope();
  const path = kind === undefined ? undefined : ALIAS_PATHS[kind];
  return useConfigDrafts((state) => {
    const root = state.drafts[file]?.value;
    const aliases = path && root !== undefined ? readConfigValue(root, path) : undefined;
    if (!isConfigObject(aliases)) return undefined;
    return Object.keys(aliases).find((alias) => {
      const target = aliases[alias];
      return target !== undefined && aliasFor(target, id);
    });
  });
}

/** Alias names by Discord ID. Subscribes only when `kind` names an ID with aliases. */
export function useAliasLabels(kind: string | undefined): (id: string) => string | undefined {
  const { kind: file } = useConfigScope();
  const path = kind === undefined ? undefined : ALIAS_PATHS[kind];
  const labels = useConfigDrafts(
    useShallow((state) => {
      const root = state.drafts[file]?.value;
      const aliases = path && root !== undefined ? readConfigValue(root, path) : undefined;
      if (!isConfigObject(aliases)) return NO_ALIASES;
      const byId: Record<string, string> = {};
      for (const [alias, target] of Object.entries(aliases)) {
        const id = isConfigObject(target) ? target.discord : target;
        if (typeof id === "string") byId[id] = alias;
      }
      return byId;
    }),
  );
  return (id: string) => labels[id];
}

/** An "Add" button that lists the values still available. Renders nothing when none are left. */
export function AddMenu({
  label,
  options,
  className,
  disabled,
  onPick,
}: {
  label: string;
  options: readonly string[];
  className?: string;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={className}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        <Plus />
        Add
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-40">
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            className="font-mono text-xs"
            onClick={() => onPick(option)}
          >
            {option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Ordered chips for a string list. Entries come from an input, or from an Add menu when the
 * list only accepts `choices`.
 */
export function StringChips({
  id,
  values,
  suggestions,
  choices,
  placeholder,
  mono,
  label,
  disabled,
  describe,
  inherited,
  onChange,
}: {
  id: string;
  values: readonly string[];
  suggestions?: readonly string[];
  /** The only values the list accepts. */
  choices?: readonly string[];
  placeholder?: string;
  mono?: boolean;
  label: string;
  disabled: boolean;
  describe?: (value: string) => string | undefined;
  /** The entries are the default, not values from the file. */
  inherited?: boolean;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const options = (suggestions ?? []).filter((option) => !values.includes(option));
  function add() {
    const next = draft.trim();
    if (!next) return;
    setDraft("");
    if (!values.includes(next)) onChange([...values, next]);
  }
  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-input-background p-1">
      {values.map((value, index) => {
        const alias = describe?.(value);
        return (
          <span
            key={`${value}-${index}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-md bg-surface py-0.5 pr-0.5 pl-2 text-xs",
              inherited ? "text-muted-foreground" : "text-surface-foreground",
            )}
          >
            {alias ? <span className="font-medium">#{alias}</span> : null}
            <span className={cn("truncate", mono && "font-mono", alias && "text-muted-foreground")}>
              {value === "*" ? "All" : value}
            </span>
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              aria-label={`Remove ${value}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((_, other) => other !== index))}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
      {choices ? (
        <AddMenu
          label={`Add to ${label}`}
          className="h-6 px-1.5 text-muted-foreground"
          options={choices.filter((choice) => !values.includes(choice))}
          disabled={disabled}
          onPick={(choice) => onChange([...values, choice])}
        />
      ) : (
        <input
          id={id}
          aria-label={`Add to ${label}`}
          list={options.length > 0 ? listId : undefined}
          className={cn(
            "h-6 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-input-placeholder",
            mono && "font-mono text-xs",
          )}
          placeholder={values.length === 0 ? (placeholder ?? "Add") : "Add"}
          value={draft}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
            if (event.key === "Backspace" && draft === "" && values.length > 0)
              onChange(values.slice(0, -1));
          }}
        />
      )}
      {options.length > 0 ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

export function ListControl(props: ControlProps) {
  const { field, entry } = props;
  const current = field.value ?? field.defaultValue;
  const values = isConfigArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
  // Hints on a list describe its items.
  const itemKind = field.info.itemKind ?? field.info.kind;
  const describe = useAliasLabels(itemKind);
  const enumValues = field.info.itemNode?.enum?.filter(
    (value): value is string => typeof value === "string",
  );
  return (
    <StringChips
      id={props.id}
      label={props.label}
      values={values}
      suggestions={entry.suggestions}
      choices={enumValues}
      placeholder={entry.placeholder}
      mono={MONO_KINDS.has(itemKind ?? "")}
      disabled={field.disabled}
      describe={itemKind === "discordChannel" ? describe : undefined}
      inherited={field.value === undefined}
      onChange={(next) => report(props, field.commit(next))}
    />
  );
}

export function StatsControl(props: ControlProps) {
  const { field } = props;
  const current = field.value ?? field.defaultValue ?? false;
  let selected = "off";
  if (current === true) selected = "on";
  if (isConfigObject(current) && current.verbose === true) selected = "verbose";
  return (
    <Select
      items={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
        { value: "verbose", label: "Verbose" },
      ]}
      value={selected}
      disabled={field.disabled}
      onValueChange={(next) => {
        const values: Record<string, ConfigValue> = {
          off: false,
          on: true,
          verbose: { verbose: true },
        };
        report(props, field.commit(values[String(next)] ?? false));
      }}
    >
      <SelectTrigger
        id={props.id}
        aria-label={props.label}
        className={cn("min-w-36", field.value === undefined && "text-muted-foreground")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="off">Off</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="verbose">Verbose</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Field that names one union member, such as `blobStorage.kind` or `servers.*.transport`. */
export function DiscriminatorControl(props: ControlProps) {
  const { field, entry } = props;
  const { kind } = useConfigScope();
  const { schema } = configSchema(kind);
  const parentPath = field.path.slice(0, -1);
  const key = String(field.path.at(-1));
  const parent = useConfigValue(kind, parentPath);
  const parentNode = useParentNode(parentPath);
  const members = parentNode
    ? schemaAlternatives(schema, parentNode).filter(
        (node) => node.properties?.[key]?.const !== undefined,
      )
    : [];
  const choices = members.map((node) => node.properties?.[key]?.const ?? null);
  const current = isConfigObject(parent) ? parent[key] : undefined;
  const UNSET = "__unset__";
  const unsetValue = entry.unsetLabel ? UNSET : null;
  const items = [
    ...(entry.unsetLabel ? [{ value: UNSET, label: entry.unsetLabel }] : []),
    ...choices.map((value) => ({
      value: choiceKey(value),
      label: choiceLabel(entry, value),
    })),
  ];
  return (
    <Select
      items={items}
      value={current === undefined ? unsetValue : choiceKey(current)}
      disabled={field.disabled}
      onValueChange={(next) => {
        if (next === UNSET) return report(props, field.apply([{ op: "unset", path: parentPath }]));
        const value = choices.find((choice) => choiceKey(choice) === next);
        if (value === undefined || !parentNode) return;
        const target = objectAlternative(schema, parentNode, { [key]: value });
        // Keep fields the new member shares, such as a server description.
        const kept = isConfigObject(parent)
          ? Object.fromEntries(
              Object.entries(parent).filter(
                ([name]) => name !== key && target?.properties?.[name] !== undefined,
              ),
            )
          : {};
        report(
          props,
          field.apply([{ op: "set", path: parentPath, value: { [key]: value, ...kept } }]),
        );
      }}
    >
      <SelectTrigger
        id={props.id}
        aria-label={props.label}
        className={cn("min-w-40", current === undefined && "text-muted-foreground")}
      >
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function useParentNode(path: readonly (string | number)[]): ConfigSchemaNode | undefined {
  const { kind } = useConfigScope();
  const { schema, root } = configSchema(kind);
  let node: ConfigSchemaNode | undefined = root;
  for (const segment of path) {
    if (!node) return undefined;
    const object = objectAlternative(schema, node, undefined);
    const next: ConfigSchemaNode | undefined =
      object?.properties?.[String(segment)] ??
      (typeof object?.additionalProperties === "object" ? object.additionalProperties : undefined);
    node = next;
  }
  return node;
}

type ValueSourceMode = "env" | "file" | "text";

function valueSourceMode(value: ConfigValue | undefined): ValueSourceMode {
  if (isConfigObject(value)) return "file" in value ? "file" : "env";
  return value === undefined ? "env" : "text";
}

const VALUE_SOURCE_MODES = [
  { value: "text", label: "Text" },
  { value: "env", label: "Env variable" },
  { value: "file", label: "File" },
] as const;

/** What the value becomes once read, such as `Bearer $GITHUB_TOKEN`. */
function valueSourcePreview(mode: ValueSourceMode, text: (name: string) => string): string {
  const pointer = text("pointer") ? `#${text("pointer")}` : "";
  const source =
    mode === "env" ? `$${text("env") || "VARIABLE"}` : `‹${text("file") || "file"}${pointer}›`;
  return `${text("prefix")}${source}`;
}

/**
 * An MCP value: literal text, `{env, prefix}`, or `{file, pointer, prefix}`. The first row picks
 * the source and names it; the second holds the optional prefix and JSON pointer.
 */
export function ValueSourceEditor({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: ConfigValue | undefined;
  disabled: boolean;
  onChange: (value: ConfigValue | undefined) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const mode = valueSourceMode(value);
  const object = isConfigObject(value) ? value : {};
  const text = (name: string) => (typeof object[name] === "string" ? String(object[name]) : "");
  const update = (changes: Record<string, string>) => {
    const next = Object.fromEntries(
      Object.entries({ ...object, ...changes }).filter(([, part]) => part !== ""),
    );
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <div className="grid min-w-0 flex-1 gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select
          items={VALUE_SOURCE_MODES}
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === mode) return;
            if (next === "text") onChange("");
            else if (next === "file") onChange({ file: "" });
            else onChange({ env: "" });
          }}
        >
          <SelectTrigger aria-label={`${label} source`} className="w-32 flex-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VALUE_SOURCE_MODES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "text" ? (
          <CommitInput
            id={id}
            label={label}
            className="min-w-0 flex-1"
            type={reveal ? "text" : "password"}
            placeholder="Value"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            addon={
              <InputGroupAddon className="pr-1">
                <IconButton
                  label={reveal ? "Hide value" : "Show value"}
                  className="size-6"
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff /> : <Eye />}
                </IconButton>
              </InputGroupAddon>
            }
            onCommit={(next) => onChange(next)}
          />
        ) : (
          <CommitInput
            id={id}
            label={mode === "env" ? `${label} variable` : `${label} file`}
            className="min-w-0 flex-1"
            inputClassName="font-mono text-xs"
            placeholder={mode === "env" ? "VARIABLE_NAME" : "/path/to/secret.json"}
            value={text(mode)}
            disabled={disabled}
            onCommit={(next) => update({ [mode]: next })}
          />
        )}
      </div>
      {mode === "text" ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CommitInput
            label={`${label} prefix`}
            className="min-w-36 flex-1"
            inputClassName="font-mono text-xs"
            lead="Prefix"
            placeholder="Optional"
            trim={false}
            value={text("prefix")}
            disabled={disabled}
            onCommit={(next) => update({ prefix: next })}
          />
          {mode === "file" ? (
            <CommitInput
              label={`${label} JSON pointer`}
              className="min-w-36 flex-1"
              inputClassName="font-mono text-xs"
              lead="JSON pointer"
              placeholder="/token"
              value={text("pointer")}
              disabled={disabled}
              onCommit={(next) => update({ pointer: next })}
            />
          ) : null}
        </div>
      )}
      {mode !== "text" && text("prefix") ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          Sends{" "}
          <span className="font-mono whitespace-pre text-foreground">
            {valueSourcePreview(mode, text)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export function ValueSourceControl(props: ControlProps) {
  const { field } = props;
  return (
    <ValueSourceEditor
      id={props.id}
      label={props.label}
      value={field.value}
      disabled={field.disabled}
      onChange={(value) => report(props, field.commit(value))}
    />
  );
}

/** Rows of key and value for a record whose values are scalars or MCP value sources. */
export function MapControl(props: ControlProps) {
  const { field, entry } = props;
  const { kind } = useConfigScope();
  const record = isConfigObject(field.value) ? field.value : {};
  const valueNode =
    typeof field.node.additionalProperties === "object"
      ? field.node.additionalProperties
      : undefined;
  const valueInfo = valueNode ? fieldInfo(kind, valueNode) : undefined;
  const [adding, setAdding] = useState("");
  const keys = Object.keys(record);
  const commitRecord = (next: Record<string, ConfigValue>) =>
    report(props, field.commit(Object.keys(next).length === 0 ? undefined : next));
  function rename(from: string, to: string) {
    if (!to || to === from || Object.hasOwn(record, to)) return;
    commitRecord(
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key === from ? to : key, value]),
      ),
    );
  }
  function add(name = adding) {
    const key = name.trim();
    if (!key || Object.hasOwn(record, key)) return;
    setAdding("");
    const initial: ConfigValue =
      valueInfo?.kind === "valueSource" ? { env: "" } : (valueInfo?.choices[0] ?? "");
    commitRecord({ ...record, [key]: initial });
  }
  // Suggested keys are the known names, so they are picked from a menu and not renamed.
  const known = entry.suggestions;
  // Value sources take two rows, so the name and remove button align with the first.
  const sourced = valueInfo?.kind === "valueSource";
  return (
    <div className={cn("grid w-full", sourced ? "gap-3" : "gap-1.5")}>
      {keys.map((key) => (
        <div
          key={key}
          className={cn(
            "group/map min-w-0 gap-1.5",
            sourced
              ? "grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-start"
              : "flex flex-wrap items-center",
          )}
        >
          {known ? (
            <span className="w-40 truncate px-2.5 font-mono text-xs">{key}</span>
          ) : (
            <CommitInput
              label={`${props.label} name`}
              className={sourced ? "w-full" : "w-40"}
              inputClassName="font-mono text-xs"
              value={key}
              disabled={field.disabled}
              onCommit={(next) => rename(key, next)}
            />
          )}
          <MapValue
            label={`${props.label} ${key}`}
            entry={entry}
            value={record[key]}
            info={valueInfo}
            disabled={field.disabled}
            onChange={(value) =>
              commitRecord({
                ...record,
                [key]: value ?? (valueInfo?.kind === "valueSource" ? "" : ""),
              })
            }
          />
          <IconButton
            label={`Remove ${key}`}
            className="size-7 opacity-0 group-hover/map:opacity-100 focus-visible:opacity-100"
            disabled={field.disabled}
            onClick={() => {
              commitRecord(
                Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)),
              );
            }}
          >
            <X />
          </IconButton>
        </div>
      ))}
      {known ? (
        <AddMenu
          label={`Add to ${props.label}`}
          className="justify-self-start"
          options={known.filter((name) => !Object.hasOwn(record, name))}
          disabled={field.disabled}
          onPick={add}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <InputGroup className="w-40 flex-none">
            <InputGroupInput
              aria-label={`New ${props.label} name`}
              className="font-mono text-xs"
              placeholder={entry.placeholder ?? "Name"}
              value={adding}
              disabled={field.disabled}
              spellCheck={false}
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
          </InputGroup>
          <Button
            variant="ghost"
            size="sm"
            disabled={field.disabled || !adding.trim()}
            onClick={() => add()}
          >
            <Plus />
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function MapValue({
  label,
  entry,
  value,
  info,
  disabled,
  onChange,
}: {
  label: string;
  entry: FieldEntry<string>;
  value: ConfigValue | undefined;
  info: ReturnType<typeof fieldInfo> | undefined;
  disabled: boolean;
  onChange: (value: ConfigValue | undefined) => void;
}) {
  const id = useId();
  if (info?.kind === "valueSource")
    return (
      <ValueSourceEditor
        id={id}
        label={label}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (info && info.choices.length > 0)
    return (
      <Select
        items={info.choices.map((choice) => ({
          value: choiceKey(choice),
          label: choiceLabel(entry, choice),
        }))}
        value={value === undefined ? null : choiceKey(value)}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(info.choices.find((choice) => choiceKey(choice) === next))
        }
      >
        <SelectTrigger aria-label={label} className="min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {info.choices.map((choice) => (
            <SelectItem key={choiceKey(choice)} value={choiceKey(choice)}>
              {choiceLabel(entry, choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  return (
    <CommitInput
      label={label}
      className="min-w-40 flex-1"
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      onCommit={(next) => onChange(next)}
    />
  );
}

const OAUTH_BASE = { type: "oauth", grant: "authorization_code" } as const;

/** MCP HTTP authorization: none, a dynamically registered client, or a static client. */
export function McpAuthControl(props: ControlProps) {
  const { field } = props;
  const auth = isConfigObject(field.value) ? field.value : undefined;
  const client = auth && isConfigObject(auth.client) ? auth.client : undefined;
  let mode = "none";
  if (auth) mode = client?.type === "static" ? "static" : "dynamic";
  return (
    <Select
      items={[
        { value: "none", label: "None" },
        { value: "dynamic", label: "OAuth" },
        { value: "static", label: "OAuth with client ID" },
      ]}
      value={mode}
      disabled={field.disabled}
      onValueChange={(next) => {
        if (next === mode) return;
        if (next === "none") return report(props, field.commit(undefined));
        const value: Record<string, ConfigValue> = {
          ...OAUTH_BASE,
          client:
            next === "static" ? { type: "static", clientId: { env: "" } } : { type: "dynamic" },
        };
        if (auth?.scopes !== undefined) value.scopes = auth.scopes;
        report(props, field.commit(value));
      }}
    >
      <SelectTrigger
        id={props.id}
        aria-label={props.label}
        className={cn("min-w-44", field.value === undefined && "text-muted-foreground")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">None</SelectItem>
        <SelectItem value="dynamic">OAuth</SelectItem>
        <SelectItem value="static">OAuth with client ID</SelectItem>
      </SelectContent>
    </Select>
  );
}
