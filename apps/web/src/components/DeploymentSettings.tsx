import { useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NativeDeploymentSettings,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { attempt, ErrorNotice } from "./ui";
import { cn } from "cn";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { StreamingModeSelect } from "./StreamingSettings";

type DeploymentDocument = NativeRpcOutputs["config"]["readDeployment"];

const deploymentKey = ["config", "deployment"] as const;
const minute = 60_000;
const day = 24 * 60 * minute;

function formatDuration(ms: number | null, unit: number) {
  if (ms === null) return "";
  return String(Number((ms / unit).toFixed(3)));
}

/** Returns `undefined` for invalid input and `null` for an empty optional value. */
function parseDuration(text: string, unit: number, optional: boolean) {
  const trimmed = text.trim();
  if (trimmed === "") return optional ? null : undefined;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) return undefined;
  const ms = Math.round(amount * unit);
  return ms >= 1 ? ms : undefined;
}

function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id?: string;
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row flex items-start justify-between gap-6">
      <div className="settings-row-description min-w-0">
        {id ? (
          <label htmlFor={id} className="block py-2">
            {label}
          </label>
        ) : (
          <span>{label}</span>
        )}
        {description ? <p className="muted text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function CommitInput({
  id,
  value,
  parse,
  suffix,
  placeholder,
  className,
  inputClassName,
  inputMode,
  onCommit,
}: {
  id: string;
  value: string;
  parse: (text: string) => boolean;
  suffix?: string;
  placeholder?: string;
  className: string;
  inputClassName?: string;
  inputMode?: "decimal";
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setText(value);
  }
  const invalid = !parse(text);
  const visibleSuffix = text === "" ? undefined : suffix;
  function commit() {
    if (invalid || text.trim() === value) return;
    onCommit(text);
  }
  return (
    <InputGroup className={cn("flex-none", className)}>
      <InputGroupInput
        id={id}
        className={cn(inputClassName, visibleSuffix && "pr-1.5")}
        inputMode={inputMode}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        value={text}
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
      {visibleSuffix ? <InputGroupAddon>{visibleSuffix}</InputGroupAddon> : null}
    </InputGroup>
  );
}

function DurationRow({
  label,
  description,
  value,
  unit,
  suffix,
  optional = false,
  onChange,
}: {
  label: string;
  description: string;
  value: number | null;
  unit: number;
  suffix: string;
  optional?: boolean;
  onChange: (ms: number | null) => void;
}) {
  const id = useId();
  return (
    <SettingRow id={id} label={label} description={description}>
      <CommitInput
        id={id}
        className="w-28"
        inputClassName="text-right"
        inputMode="decimal"
        suffix={suffix}
        placeholder={optional ? "None" : undefined}
        value={formatDuration(value, unit)}
        parse={(text) => parseDuration(text, unit, optional) !== undefined}
        onCommit={(text) => {
          const ms = parseDuration(text, unit, optional);
          if (ms !== undefined) onChange(ms);
        }}
      />
    </SettingRow>
  );
}

export function DeploymentSettingsForm({
  value,
  disabled,
  onChange,
}: {
  value: NativeDeploymentSettings;
  disabled?: boolean;
  onChange: (settings: NativeDeploymentSettings) => void;
}) {
  const titleModelId = useId();
  const triggerRunId = useId();
  const update = (changes: Partial<NativeDeploymentSettings>) => onChange({ ...value, ...changes });
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-6">
      <SettingRow
        label="Transport"
        description="Applies to all clients. Auto tries WebSocket, then falls back to HTTP+SSE."
      >
        <Select
          value={value.transport}
          items={[
            { value: "auto", label: "Auto (default)" },
            { value: "websocket", label: "WebSocket" },
            { value: "http-sse", label: "HTTP+SSE" },
          ]}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== "auto" && next !== "websocket" && next !== "http-sse") return;
            update({ transport: next });
          }}
        >
          <SelectTrigger aria-label="Transport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (default)</SelectItem>
            <SelectItem value="websocket">WebSocket</SelectItem>
            <SelectItem value="http-sse">HTTP+SSE</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        id={titleModelId}
        label="Title model"
        description="Use fast, main, or a provider/model reference."
      >
        <CommitInput
          id={titleModelId}
          className="w-40"
          value={value.titleModel}
          parse={(text) => text.trim() !== ""}
          onCommit={(text) => update({ titleModel: text.trim() })}
        />
      </SettingRow>
      <SettingRow
        label="Response streaming"
        description="Show completed paragraphs or wait for the full response."
      >
        <StreamingModeSelect
          value={value.outputStreaming}
          disabled={disabled}
          onChange={(mode) => update({ outputStreaming: mode })}
        />
      </SettingRow>
      <DurationRow
        label="DM context gap"
        description="Default: 2 hours. A longer pause starts a new context. Messages remain in your DM."
        value={value.dmContextGapMs}
        unit={minute}
        suffix="min"
        onChange={(ms) => {
          if (ms !== null) update({ dmContextGapMs: ms });
        }}
      />
      <DurationRow
        label="DM timestamp gap"
        description="Default: 30 minutes. Timestamps also appear when the day changes."
        value={value.dmTimestampGapMs}
        unit={minute}
        suffix="min"
        onChange={(ms) => {
          if (ms !== null) update({ dmTimestampGapMs: ms });
        }}
      />
      <DurationRow
        label="Old message selection max age"
        description="Leave blank for no age limit."
        value={value.oldMessageSelectionMaxAgeMs}
        unit={day}
        suffix="days"
        optional
        onChange={(ms) => update({ oldMessageSelectionMaxAgeMs: ms })}
      />
      <DurationRow
        label="Storage retention max age"
        description="Inactive ordinary threads older than this limit are deleted. Leave blank to keep them."
        value={value.storageRetentionMaxAgeMs}
        unit={day}
        suffix="days"
        optional
        onChange={(ms) => update({ storageRetentionMaxAgeMs: ms })}
      />
      <SettingRow id={triggerRunId} label="Start a run for cross-thread messages">
        <div className="flex h-9 flex-none items-center">
          <Switch
            id={triggerRunId}
            checked={value.crossThreadSend.triggerRun}
            disabled={disabled}
            onCheckedChange={(checked) => update({ crossThreadSend: { triggerRun: checked } })}
          />
        </div>
      </SettingRow>
    </fieldset>
  );
}

function DeploymentEditor({ document, online }: { document: DeploymentDocument; online: boolean }) {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const [pending, setPending] = useState<NativeDeploymentSettings>();
  const [error, setError] = useState<string>();
  const [formVersion, setFormVersion] = useState(0);
  const queued = useRef<NativeDeploymentSettings>(undefined);
  const running = useRef(false);
  // Each write replaces the whole document at an expected revision, so writes run one at a time
  // and only the latest queued settings are sent after the in-flight write finishes.
  async function flush() {
    running.current = true;
    while (queued.current) {
      const settings = queued.current;
      queued.current = undefined;
      await queries.cancelQueries({ queryKey: deploymentKey });
      const expectedRevision = (queries.getQueryData<DeploymentDocument>(deploymentKey) ?? document)
        .revision;
      const saved = await attempt(
        () => client.rpc!.config.setDeployment({ settings, expectedRevision }),
        setError,
      );
      if (!saved) {
        queued.current = undefined;
        running.current = false;
        setPending(undefined);
        setFormVersion((version) => version + 1);
        return;
      }
      queries.setQueryData(deploymentKey, saved);
    }
    running.current = false;
    setPending(undefined);
    void queries.invalidateQueries({ queryKey: ["recent-context"] });
  }
  function save(settings: NativeDeploymentSettings) {
    setError(undefined);
    setPending(settings);
    queued.current = settings;
    if (!running.current) void flush();
  }
  const reload = useMutation({
    mutationFn: () => client.rpc!.config.readDeployment({}),
    onSuccess: (value) => {
      setError(undefined);
      setFormVersion((version) => version + 1);
      queries.setQueryData(deploymentKey, value);
      void queries.invalidateQueries({ queryKey: ["recent-context"] });
    },
  });
  const failure = error ?? reload.error?.message;
  return (
    <>
      {failure ? (
        <div className="mb-6 grid justify-items-start gap-3">
          <ErrorNotice message={failure} />
          <Button
            variant="outline"
            disabled={!online || reload.isPending}
            onClick={() => reload.mutate()}
          >
            Reload settings
          </Button>
        </div>
      ) : null}
      <DeploymentSettingsForm
        key={formVersion}
        value={pending ?? document.settings}
        disabled={!online || reload.isPending}
        onChange={save}
      />
    </>
  );
}

export function DeploymentSettings() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const settings = useQuery({
    queryKey: deploymentKey,
    enabled: online,
    queryFn: ({ signal }) => client.rpc!.config.readDeployment({}, { signal }),
    staleTime: 0,
  });
  if (!settings.data)
    return <ErrorNotice message={settings.error?.message ?? (online ? "Loading…" : "Offline")} />;
  return <DeploymentEditor document={settings.data} online={online} />;
}
