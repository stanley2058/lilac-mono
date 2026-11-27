import { useId, useState } from "react";
import { cn } from "cn";
import { ArrowDown, ArrowUp, ChevronRight, Plus, X } from "lucide-react";
import {
  isConfigArray,
  isConfigObject,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { objectAlternative } from "@stanley2058/lilac-utils/config-schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";
import { IconButton } from "../ui";
import { configSchema } from "../../config-ui/schemas";
import { CommitInput, StringChips, YamlEditorField, type ControlProps } from "./config-controls";
import { useConfigScope } from "./use-config-field";

type Rule = Readonly<Record<string, ConfigValue>>;

const UNSET = "__unset__";
const LEGACY = [
  { value: UNSET, label: "Not set" },
  { value: "true", label: "Legacy" },
  { value: "false", label: "Current" },
];

function stringList(value: ConfigValue | undefined): string[] {
  return isConfigArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Short notes on a collapsed rule's details. */
function ruleSummary(rule: Rule): string {
  const parts: string[] = [];
  if (isConfigObject(rule.options)) parts.push(plural(Object.keys(rule.options).length, "option"));
  const unset = stringList(rule.unset).length;
  if (unset > 0) parts.push(`${unset} removed`);
  if (rule.legacy === true) parts.push("legacy");
  if (rule.legacy === false) parts.push("current");
  return parts.join(" · ");
}

const MAX_MATCH = 512;

function matchProblem(text: string): string | undefined {
  return text.length > MAX_MATCH ? `Use at most ${MAX_MATCH} characters` : undefined;
}

/** Pads or trims row keys to `count`, so new rows get fresh keys. */
function fitKeys(keys: readonly string[], count: number): string[] {
  if (keys.length >= count) return keys.slice(0, count);
  return [...keys, ...Array.from({ length: count - keys.length }, () => crypto.randomUUID())];
}

/** Ordered `models.rules` entries: a glob, a reasoning level, and optional details. */
export function ModelRulesControl(props: ControlProps) {
  const { field, entry } = props;
  const { kind } = useConfigScope();
  const itemNode = field.info.itemNode
    ? objectAlternative(configSchema(kind).schema, field.info.itemNode, undefined)
    : undefined;
  const reasoning = (itemNode?.properties?.reasoning?.enum ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  // Every entry keeps its YAML index; only map entries are shown, the rest stay in place.
  const items: readonly ConfigValue[] = isConfigArray(field.value) ? field.value : [];
  const rows = items.flatMap((item, index) =>
    isConfigObject(item) ? [{ rule: item, index }] : [],
  );
  const [adding, setAdding] = useState("");
  // Row keys move with their rules, so an expanded row stays expanded after reordering.
  const [keys, setKeys] = useState(() => fitKeys([], items.length));
  if (keys.length !== items.length) setKeys(fitKeys(keys, items.length));
  function write(next: readonly ConfigValue[], nextKeys: readonly string[] = keys): boolean {
    const error = field.commit(next.length === 0 ? undefined : [...next]);
    props.onError(error);
    if (error) return false;
    setKeys(fitKeys(nextKeys, next.length));
    return true;
  }
  // Field edits patch only that field, so YAML formatting elsewhere in the list survives.
  function setField(index: number, key: string, value: ConfigValue | undefined) {
    const path = [...field.path, index, key];
    const error = field.apply([
      value === undefined ? { op: "unset", path } : { op: "set", path, value },
    ]);
    props.onError(error);
    return error;
  }
  function move(index: number, by: -1 | 1) {
    const next = [...items];
    const nextKeys = [...keys];
    const [moved] = next.splice(index, 1);
    const [movedKey] = nextKeys.splice(index, 1);
    if (moved) next.splice(index + by, 0, moved);
    if (movedKey) nextKeys.splice(index + by, 0, movedKey);
    write(next, nextKeys);
  }
  function remove(index: number) {
    write(
      items.filter((_, at) => at !== index),
      keys.filter((_, at) => at !== index),
    );
  }
  function add() {
    const match = adding.trim();
    if (!match) return;
    const problem = matchProblem(match);
    if (problem) return props.onError(problem);
    if (write([...items, { match }])) setAdding("");
  }
  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)] gap-2">
      {rows.length > 0 ? (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {rows.map(({ rule, index }, position) => (
            <RuleRow
              key={keys[index] ?? index}
              position={position}
              first={index === 0}
              last={index === items.length - 1}
              rule={rule}
              reasoning={reasoning}
              labels={entry.options}
              disabled={field.disabled}
              onChange={(key, value) => setField(index, key, value)}
              onMove={(by) => move(index, by)}
              onRemove={() => remove(index)}
            />
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <InputGroup className="w-60 max-w-full flex-none">
          <InputGroupInput
            aria-label="New rule model glob"
            className="font-mono text-xs"
            placeholder="provider/model-*"
            value={adding}
            disabled={field.disabled}
            spellCheck={false}
            onChange={(event) => setAdding(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
          />
        </InputGroup>
        <Button variant="ghost" size="sm" disabled={field.disabled || !adding.trim()} onClick={add}>
          <Plus />
          Add rule
        </Button>
      </div>
    </div>
  );
}

function RuleRow({
  position,
  first,
  last,
  rule,
  reasoning,
  labels,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  /** Place among the shown rules, for labels. */
  position: number;
  first: boolean;
  last: boolean;
  rule: Rule;
  reasoning: readonly string[];
  labels?: Readonly<Record<string, string>>;
  disabled: boolean;
  /** Returns a message when the edit is rejected. */
  onChange: (key: string, value: ConfigValue | undefined) => string | undefined;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unsetId = useId();
  const match = typeof rule.match === "string" ? rule.match : "";
  const reasoningItems = [
    { value: UNSET, label: "Not set" },
    ...reasoning.map((value) => ({
      value,
      label: labels?.[JSON.stringify(value)] ?? value,
    })),
  ];
  const summary = ruleSummary(rule);
  return (
    <li className="group/rule">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 p-1.5">
          <CollapsibleTrigger
            aria-label={`Details for ${match}`}
            className="flex h-7 flex-none items-center gap-1 rounded-md px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
            <span className="w-4 text-right text-xs tabular-nums">{position + 1}</span>
          </CollapsibleTrigger>
          <CommitInput
            label={`Rule ${position + 1} model glob`}
            className="min-w-40 flex-1"
            inputClassName="font-mono text-xs"
            value={match}
            disabled={disabled}
            validate={matchProblem}
            onCommit={(next) => {
              if (next) onChange("match", next);
            }}
          />
          <Select
            items={reasoningItems}
            value={typeof rule.reasoning === "string" ? rule.reasoning : UNSET}
            disabled={disabled}
            onValueChange={(next) =>
              onChange("reasoning", next === UNSET || typeof next !== "string" ? undefined : next)
            }
          >
            <SelectTrigger aria-label={`Rule ${position + 1} reasoning`} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {reasoningItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="w-24 truncate text-xs text-muted-foreground">{summary}</span>
          <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover/rule:opacity-100 group-focus-within/rule:opacity-100">
            <IconButton
              label={`Move rule ${position + 1} up`}
              tooltip="Move up"
              className="size-7"
              disabled={disabled || first}
              onClick={() => onMove(-1)}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              label={`Move rule ${position + 1} down`}
              tooltip="Move down"
              className="size-7"
              disabled={disabled || last}
              onClick={() => onMove(1)}
            >
              <ArrowDown />
            </IconButton>
            <IconButton
              label={`Remove rule ${position + 1}`}
              tooltip="Remove"
              className="size-7"
              disabled={disabled}
              onClick={onRemove}
            >
              <X />
            </IconButton>
          </span>
        </div>
        <CollapsibleContent>
          <div className="grid gap-3 px-3 pt-1 pb-3 pl-10">
            <div className="grid gap-1">
              <span className="text-sm font-medium">Provider options</span>
              <YamlEditorField
                label={`Rule ${position + 1} provider options`}
                value={rule.options}
                disabled={disabled}
                onCommit={(next) => {
                  if (next !== undefined && !isConfigObject(next)) return "Enter a YAML map";
                  return onChange("options", next);
                }}
              />
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-medium">Remove inherited options</span>
              <StringChips
                id={unsetId}
                label={`Rule ${position + 1} removed options`}
                values={stringList(rule.unset)}
                placeholder="openai.someOption"
                mono
                disabled={disabled}
                onChange={(next) => onChange("unset", next.length === 0 ? undefined : next)}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Catalog status</span>
              <Select
                items={LEGACY}
                value={typeof rule.legacy === "boolean" ? String(rule.legacy) : UNSET}
                disabled={disabled}
                onValueChange={(next) =>
                  onChange("legacy", next === UNSET ? undefined : next === "true")
                }
              >
                <SelectTrigger aria-label={`Rule ${position + 1} catalog status`} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEGACY.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
