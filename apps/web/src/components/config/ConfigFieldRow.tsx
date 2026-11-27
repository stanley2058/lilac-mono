import { memo, useId, useState, type ComponentType } from "react";
import { cn } from "cn";
import { Code2, RotateCcw, Undo2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  configValuesEqual,
  formatConfigPath,
  type ConfigPath,
} from "@stanley2058/lilac-utils/config-document";
import type { ConfigFieldKind } from "@stanley2058/lilac-utils/config-schema";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { IconButton } from "../ui";
import type { Condition, FieldEntry, WidgetOverride } from "../../config-ui/manifest";
import { cleanDescription, formatConfigValue, humanizeKey } from "../../config-ui/field-model";
import { useConfigDraftStore } from "../../config-ui/draft-store";
import {
  ChoiceControl,
  DiscriminatorControl,
  ListControl,
  LongTextControl,
  MapControl,
  McpAuthControl,
  MultilineControl,
  NumberControl,
  StatsControl,
  SwitchControl,
  TextControl,
  UnitControl,
  ValueSourceControl,
  YamlControl,
  formatUnitValue,
  type ControlProps,
} from "./config-controls";
import { ModelControl, ModelListControl } from "./ConfigModelPicker";
import { ModelRulesControl } from "./ConfigModelRules";
import { ConfigText } from "./ConfigText";
import {
  useConfigField,
  useConfigScope,
  useEffectiveValue,
  type ConfigField,
} from "./use-config-field";

type Control = {
  readonly component: ComponentType<ControlProps>;
  readonly wide: boolean;
};

const OVERRIDES: Record<WidgetOverride, Control> = {
  yaml: { component: YamlControl, wide: true },
  modelList: { component: ModelListControl, wide: true },
  modelRules: { component: ModelRulesControl, wide: true },
  longText: { component: LongTextControl, wide: true },
  map: { component: MapControl, wide: true },
  discriminator: { component: DiscriminatorControl, wide: false },
  stats: { component: StatsControl, wide: false },
  mcpAuth: { component: McpAuthControl, wide: false },
};

function kindControl(kind: ConfigFieldKind): Control {
  switch (kind) {
    case "duration":
    case "bytes":
      return { component: UnitControl, wide: false };
    case "model":
      return { component: ModelControl, wide: false };
    // The catalog lists chat models only, so embedding models are typed in.
    case "embeddingModel":
      return { component: TextControl, wide: false };
    case "multiline":
      return { component: MultilineControl, wide: true };
    case "providerOptions":
      return { component: YamlControl, wide: true };
    case "valueSource":
      return { component: ValueSourceControl, wide: true };
    case "discordChannel":
    case "discordGuild":
    case "discordUser":
    case "env":
    case "cron":
    case "clockTime":
      return { component: TextControl, wide: false };
    case "toolName":
    case "toolPlugin":
    case "callableName":
    case "callablePlugin":
    case "pluginId":
      return { component: ListControl, wide: true };
  }
}

function controlFor(field: ConfigField, entry: FieldEntry<string>): Control {
  if (entry.widget) return OVERRIDES[entry.widget];
  if (field.info.type === "array")
    return field.info.itemKind === "model"
      ? { component: ModelListControl, wide: true }
      : { component: ListControl, wide: true };
  const byKind = field.info.kind ? kindControl(field.info.kind) : undefined;
  if (byKind) return byKind;
  switch (field.info.type) {
    case "boolean":
      return { component: SwitchControl, wide: false };
    case "choice":
      return { component: ChoiceControl, wide: false };
    case "integer":
    case "number":
      return { component: NumberControl, wide: false };
    case "string":
      return { component: TextControl, wide: false };
    case "object":
      return { component: YamlControl, wide: true };
  }
}

/** The default as the reader would type it, for the reset tooltip. */
function defaultLabel(field: ConfigField, entry: FieldEntry<string>): string | undefined {
  const value = field.defaultValue;
  if (value === undefined) return field.defaultText;
  if (field.info.kind === "duration" || field.info.kind === "bytes")
    return formatUnitValue(value, field.info.kind);
  if (field.info.type === "object" || Array.isArray(value)) return undefined;
  if (field.info.type === "choice")
    return entry.options?.[JSON.stringify(value)] ?? formatConfigValue(value);
  return formatConfigValue(value);
}

const PATH_TAIL_MAX = 32;

/**
 * The YAML path on one line. The parent path truncates first so the field's own key stays
 * visible; a key longer than `PATH_TAIL_MAX` keeps only its end.
 */
function PathLine({ path }: { path: ConfigPath }) {
  const head = formatConfigPath(path.slice(0, -1));
  const full = formatConfigPath(path);
  const tail = full.slice(head.length);
  const shownTail = tail.length > PATH_TAIL_MAX ? `…${tail.slice(1 - PATH_TAIL_MAX)}` : tail;
  return (
    <div className="flex min-w-0 font-mono text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{head}</span>
      <span className="flex-none whitespace-pre">{shownTail}</span>
    </div>
  );
}

/**
 * The field title. When help text exists, the title has a dotted underline and shows the help
 * on hover, or on a tap on touch screens. The tooltip also names the YAML path.
 */
function FieldTitle({
  id,
  label,
  help,
  path,
}: {
  id: string;
  label: string;
  help?: string;
  path: ConfigPath;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={300}
          aria-label={`About ${label}`}
          className={cn(
            "min-w-0 truncate rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            help &&
              "cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-4",
          )}
        >
          {label}
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="max-h-80 w-80 max-w-[calc(100vw-2rem)] gap-2 overflow-y-auto p-3"
        >
          {help ? (
            <div className="text-sm leading-relaxed break-words">
              <ConfigText text={help} />
            </div>
          ) : null}
          <PathLine path={path} />
        </PopoverContent>
      </Popover>
    </>
  );
}

export function useConditionMet(condition: Condition<string> | undefined): boolean {
  const value = useEffectiveValue(condition?.path ?? "");
  if (!condition) return true;
  if ("present" in condition) return (value !== undefined) === condition.present;
  const allowed = Array.isArray(condition.equals) ? condition.equals : [condition.equals];
  return allowed.some((option) => configValuesEqual(option, value));
}

export const ConfigFieldRow = memo(function ConfigFieldRow({
  entry,
  yamlPage,
}: {
  entry: FieldEntry<string>;
  /** Page id of the YAML view, for "Show in YAML". */
  yamlPage: string;
}) {
  const visible = useConditionMet(entry.visibleWhen);
  if (!visible) return null;
  return <VisibleFieldRow entry={entry} yamlPage={yamlPage} />;
});

function VisibleFieldRow({ entry, yamlPage }: { entry: FieldEntry<string>; yamlPage: string }) {
  const id = useId();
  const field = useConfigField(entry.path);
  const scope = useConfigScope();
  const store = useConfigDraftStore();
  const [error, setError] = useState<string>();
  if (!field) return null;
  const label = entry.label || humanizeKey(String(field.path.at(-1)));
  const { component: Control, wide } = controlFor(field, entry);
  const help = entry.help ?? cleanDescription(field.node.description);
  const fallback = defaultLabel(field, entry);
  const explicit = field.value !== undefined;
  const pathText = formatConfigPath(field.path);
  return (
    <div
      data-config-path={pathText}
      className={cn(
        "config-row group/row grid gap-x-6 gap-y-2 rounded-md py-2",
        wide ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto] items-start",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-h-8 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none rounded-full bg-primary transition-opacity",
              field.dirty ? "opacity-100" : "opacity-0",
            )}
          />
          <FieldTitle id={id} label={label} help={help} path={field.path} />
          {field.dirty ? <span className="sr-only">(unsaved)</span> : null}
          {field.restart ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="inline-flex items-center text-warning"
                    aria-label="Applies after Core restarts"
                  >
                    <RotateCcw className="size-3.5" />
                  </span>
                }
              />
              <TooltipContent>Applies after Core restarts</TooltipContent>
            </Tooltip>
          ) : null}
          <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            <IconButton
              label={`Show ${label} in YAML`}
              tooltip="Show in YAML"
              className="size-6"
              onClick={() => store.getState().reveal(scope.kind, yamlPage, field.path)}
            >
              <Code2 />
            </IconButton>
            {explicit ? (
              <IconButton
                label={`Reset ${label}`}
                tooltip={fallback ? `Reset to ${fallback}` : "Reset to default"}
                className="size-6"
                disabled={field.disabled}
                onClick={() => setError(field.commit(undefined))}
              >
                <Undo2 />
              </IconButton>
            ) : null}
          </span>
        </div>
        {entry.hint ? (
          <p className="pl-3 text-sm text-muted-foreground">
            <ConfigText text={entry.hint} />
          </p>
        ) : null}
      </div>
      <div className={cn("min-w-0", wide && "pl-3")}>
        <Control id={id} field={field} entry={entry} label={label} onError={setError} />
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
