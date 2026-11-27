import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  LockOpen,
  LogIn,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { ConfigValue } from "@stanley2058/lilac-utils/config-document";
import { Result } from "better-result";
import { Button, buttonVariants } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { LoadingSpinner } from "../ui/loading-spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { IconButton } from "../ui";
import {
  accessErrors,
  connectionErrors,
  EMPTY_MCP_SERVER_DRAFT,
  mcpServerConfig,
  type McpDraftErrors,
  type McpServerDraft,
  type SecretDraft,
  type SecretSource,
} from "../../config-ui/mcp-server-draft";

export type McpServerState = {
  readonly state: "available" | "unavailable" | "authentication_required" | "missing";
  readonly toolCount?: number;
  readonly error?: string;
};

export type McpAuthorization =
  | { readonly status: "authorized" }
  | { readonly status: "authorization_required"; readonly authorizationUrl: string };

/** Core operations the setup dialog needs. Errors are readable messages. */
export type McpSetupApi = {
  /** Redirect URL that an OAuth app must allow. */
  readonly callbackUrl?: string;
  /** Writes `servers.<id>`. `replace` allows overwriting the entry this dialog saved earlier. */
  save(
    id: string,
    server: Record<string, ConfigValue>,
    replace: boolean,
  ): Promise<Result<void, string>>;
  /** Reloads MCP servers and reports this one. */
  connect(id: string): Promise<Result<McpServerState, string>>;
  status(id: string): Promise<Result<McpServerState, string>>;
  authorize(id: string): Promise<Result<McpAuthorization, string>>;
};

export type McpSetupMode =
  | { readonly kind: "add"; readonly takenIds: readonly string[] }
  | { readonly kind: "signIn"; readonly serverId: string };

type Step = "server" | "access" | "connect";

type Phase =
  | { readonly kind: "saving" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly toolCount?: number }
  | { readonly kind: "authorizing" }
  | { readonly kind: "signIn"; readonly url: string; readonly opened: boolean }
  | { readonly kind: "failed"; readonly message: string; readonly stage: "save" | "connect" };

const STEPS: readonly { id: Step; label: string }[] = [
  { id: "server", label: "Server" },
  { id: "access", label: "Access" },
  { id: "connect", label: "Connect" },
];

/** The phase a connection attempt ends in, unless it needs OAuth sign-in. */
function connectionPhase(result: Result<McpServerState, string>): Phase {
  return result.match<Phase>({
    ok: (state) =>
      state.state === "available"
        ? { kind: "connected", toolCount: state.toolCount }
        : {
            kind: "failed",
            message: state.error ?? "The server did not load. Reload MCP after fixing it.",
            stage: "connect",
          },
    err: (message) => ({ kind: "failed", message, stage: "connect" }),
  });
}

/** The phase a status poll ends sign-in with, or `undefined` while sign-in continues. */
function signInOutcome(state: McpServerState | null | undefined): Phase | undefined {
  if (!state || state.state === "authentication_required") return undefined;
  return connectionPhase(Result.ok(state));
}

function needsSignIn(result: Result<McpServerState, string>): boolean {
  return result.match({
    ok: (state) => state.state === "authentication_required",
    err: () => false,
  });
}

/** Guides the owner through adding an MCP server, or signing in to one that needs OAuth. */
export function McpServerSetupDialog({
  open,
  onOpenChange,
  mode,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: McpSetupMode;
  api: McpSetupApi;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(34rem,_calc(100vw-2rem))] max-w-none flex-col gap-4 p-5 sm:max-w-none">
        <McpServerSetup mode={mode} api={api} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Dialog body, separate from the dialog so the design system can show it inline. */
export function McpServerSetup({
  mode,
  api,
  onClose,
}: {
  mode: McpSetupMode;
  api: McpSetupApi;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<McpServerDraft>(EMPTY_MCP_SERVER_DRAFT);
  const [step, setStep] = useState<Step>(mode.kind === "signIn" ? "connect" : "server");
  const [errors, setErrors] = useState<McpDraftErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: "authorizing" });
  // The name this dialog saved; later saves replace it and the name stays fixed.
  const [savedId, setSavedId] = useState<string>();
  const started = useRef(false);
  const serverId = mode.kind === "signIn" ? mode.serverId : draft.id.trim();
  const oauth = mode.kind === "signIn" || (draft.transport === "http" && draft.access === "oauth");

  const update = (changes: Partial<McpServerDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setErrors({});
  };

  const authorize = async (id: string) => {
    setPhase({ kind: "authorizing" });
    const authorized = await api.authorize(id);
    if (authorized.isErr())
      return setPhase({ kind: "failed", message: authorized.error, stage: "connect" });
    if (authorized.value.status === "authorization_required")
      return setPhase({ kind: "signIn", url: authorized.value.authorizationUrl, opened: false });
    // Stored tokens were still valid; connect with them.
    setPhase(connectionPhase(await api.connect(id)));
  };

  const finishConnect = async (id: string) => {
    setPhase({ kind: "connecting" });
    const connected = await api.connect(id);
    if (oauth && needsSignIn(connected)) return authorize(id);
    setPhase(connectionPhase(connected));
  };

  const connect = async () => {
    const id = draft.id.trim();
    setStep("connect");
    setPhase({ kind: "saving" });
    const saved = await api.save(id, mcpServerConfig(draft), savedId === id);
    if (saved.isErr()) return setPhase({ kind: "failed", message: saved.error, stage: "save" });
    setSavedId(id);
    await finishConnect(id);
  };

  const retry = () => {
    if (mode.kind === "signIn") return void authorize(serverId);
    // A failed save is retried as a save, so a retry never connects with older settings.
    if (phase.kind === "failed" && phase.stage === "save") return void connect();
    void finishConnect(serverId);
  };

  useEffect(() => {
    if (mode.kind !== "signIn" || started.current) return;
    started.current = true;
    void authorize(mode.serverId);
    // Sign-in starts once, when the dialog opens for an existing server.
  }, []);

  const next = () => {
    if (step === "server") {
      const found = connectionErrors(
        draft,
        mode.kind === "add" ? mode.takenIds.filter((id) => id !== savedId) : [],
      );
      if (Object.keys(found).length > 0) return setErrors(found);
      return setStep("access");
    }
    const found = accessErrors(draft);
    if (Object.keys(found).length > 0) return setErrors(found);
    void connect();
  };

  // Core reloads the server after the OAuth callback stores tokens.
  const waiting = phase.kind === "signIn" && phase.opened;
  const status = useQuery({
    // Each sign-in link polls afresh, so an earlier failure does not end a new attempt.
    queryKey: ["config", "mcp-setup", serverId, phase.kind === "signIn" ? phase.url : ""],
    queryFn: async () => (await api.status(serverId)).unwrapOr(null),
    enabled: waiting,
    refetchInterval: (query) => (signInOutcome(query.state.data) ? false : 2_000),
    gcTime: 0,
  });
  const view: Phase = (waiting && signInOutcome(status.data)) || phase;

  const title = mode.kind === "signIn" ? `Sign in to ${mode.serverId}` : "Add MCP server";
  return (
    <>
      <div className="flex items-center gap-3 pr-8">
        <DialogTitle className="mr-auto">{title}</DialogTitle>
        {mode.kind === "add" ? <Stepper step={step} /> : null}
      </div>
      <form
        className="-m-1 grid min-h-0 gap-4 overflow-y-auto p-1"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (step !== "connect") next();
        }}
      >
        {step === "server" ? (
          <ServerStep
            draft={draft}
            errors={errors}
            locked={savedId !== undefined}
            update={update}
          />
        ) : null}
        {step === "access" ? (
          <AccessStep draft={draft} errors={errors} callbackUrl={api.callbackUrl} update={update} />
        ) : null}
        {step === "connect" ? (
          <ConnectStep
            view={view}
            serverId={serverId}
            showSave={mode.kind === "add"}
            onOpened={() =>
              setPhase((current) =>
                current.kind === "signIn" ? { ...current, opened: true } : current,
              )
            }
            onRetrySignIn={() => void authorize(serverId)}
          />
        ) : null}
        {/* Enter submits the form without a visible submit control. */}
        <button type="submit" hidden />
      </form>
      <div className="flex items-center justify-end gap-2">
        {step === "server" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={next}>Next</Button>
          </>
        ) : null}
        {step === "access" ? (
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => setStep("server")}>
              Back
            </Button>
            <Button onClick={next}>{savedId ? "Save and connect" : "Add server"}</Button>
          </>
        ) : null}
        {step === "connect" ? (
          <>
            {view.kind === "failed" && mode.kind === "add" ? (
              <Button variant="ghost" className="mr-auto" onClick={() => setStep("access")}>
                Back
              </Button>
            ) : null}
            {view.kind === "failed" ? (
              <Button variant="outline" onClick={retry}>
                Retry
              </Button>
            ) : null}
            <Button variant={view.kind === "connected" ? "default" : "ghost"} onClick={onClose}>
              {view.kind === "connected" ? "Done" : "Close"}
            </Button>
          </>
        ) : null}
      </div>
    </>
  );
}

function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((item) => item.id === step);
  return (
    <ol className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Steps">
      {STEPS.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5",
            index === current && "font-medium text-foreground",
          )}
        >
          {index > 0 ? <span aria-hidden className="h-px w-3 bg-border" /> : null}
          <span
            className={cn(
              "flex size-4 items-center justify-center rounded-full border border-border text-[0.625rem]",
              index < current && "border-primary bg-primary text-primary-foreground",
              index === current && "border-foreground",
            )}
          >
            {index < current ? <Check className="size-2.5" /> : index + 1}
          </span>
          {item.label}
        </li>
      ))}
    </ol>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {optional ? (
          <span className="ml-1.5 font-normal text-muted-foreground">Optional</span>
        ) : null}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {!error && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function TextInput({
  id,
  value,
  onChange,
  error,
  mono,
  placeholder,
  disabled,
  autoFocus,
  label,
  type = "text",
  addon,
  readOnly,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
  type?: "text" | "password";
  addon?: ReactNode;
  readOnly?: boolean;
}) {
  return (
    <InputGroup className="min-w-0">
      <InputGroupInput
        id={id}
        type={type}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        className={cn(mono && "font-mono text-xs")}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        readOnly={readOnly}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {addon}
    </InputGroup>
  );
}

type Choice<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly detail: string;
  readonly icon: ReactNode;
};

function ChoiceCards<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid gap-2", choices.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}
      onKeyDown={(event) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const index = choices.findIndex((choice) => choice.value === value);
        const target = choices[(index + delta + choices.length) % choices.length]!;
        onChange(target.value);
        event.currentTarget.querySelector<HTMLElement>(`[data-choice="${target.value}"]`)?.focus();
      }}
    >
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-choice={choice.value}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-lg border border-border px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4",
              checked && "border-primary bg-primary/5 hover:bg-primary/5",
            )}
            onClick={() => onChange(choice.value)}
          >
            <span
              className={cn("row-span-2 pt-0.5 text-muted-foreground", checked && "text-primary")}
            >
              {choice.icon}
            </span>
            <span className="text-sm font-medium">{choice.label}</span>
            <span className="text-xs text-muted-foreground">{choice.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

const TRANSPORTS: readonly Choice<McpServerDraft["transport"]>[] = [
  { value: "http", label: "Remote", detail: "Connect to a URL", icon: <Globe /> },
  {
    value: "stdio",
    label: "Local command",
    detail: "Start a process on the Core host",
    icon: <SquareTerminal />,
  },
];

function ServerStep({
  draft,
  errors,
  locked,
  update,
}: {
  draft: McpServerDraft;
  errors: McpDraftErrors;
  locked: boolean;
  update: (changes: Partial<McpServerDraft>) => void;
}) {
  const id = useId();
  return (
    <>
      <Field
        label="Name"
        htmlFor={`${id}-name`}
        error={errors.id}
        hint={locked ? "Saved under this name" : "Letters, digits, - and _"}
      >
        <TextInput
          id={`${id}-name`}
          value={draft.id}
          onChange={(value) => update({ id: value })}
          error={errors.id}
          mono
          placeholder="github"
          disabled={locked}
          autoFocus={!locked}
        />
      </Field>
      <ChoiceCards
        label="Connection"
        value={draft.transport}
        choices={TRANSPORTS}
        onChange={(transport) => update({ transport })}
      />
      {draft.transport === "http" ? (
        <Field label="URL" htmlFor={`${id}-url`} error={errors.url}>
          <TextInput
            id={`${id}-url`}
            value={draft.url}
            onChange={(value) => update({ url: value })}
            error={errors.url}
            mono
            placeholder="https://example.com/mcp"
          />
        </Field>
      ) : (
        <Field
          label="Command"
          htmlFor={`${id}-command`}
          error={errors.command}
          hint="Quote arguments that contain spaces"
        >
          <TextInput
            id={`${id}-command`}
            value={draft.command}
            onChange={(value) => update({ command: value })}
            error={errors.command}
            mono
            placeholder="npx -y @modelcontextprotocol/server-filesystem /data"
          />
        </Field>
      )}
    </>
  );
}

const ACCESS: readonly Choice<McpServerDraft["access"]>[] = [
  { value: "none", label: "None", detail: "No credentials", icon: <LockOpen /> },
  { value: "token", label: "Access token", detail: "Sent in a header", icon: <KeyRound /> },
  { value: "oauth", label: "OAuth", detail: "Browser sign-in", icon: <LogIn /> },
];

const CLIENTS: readonly Choice<McpServerDraft["client"]>[] = [
  {
    value: "dynamic",
    label: "Register automatically",
    detail: "For servers that allow client registration",
    icon: <Plus />,
  },
  {
    value: "static",
    label: "Use my OAuth app",
    detail: "Enter a client ID you created",
    icon: <KeyRound />,
  },
];

function AccessStep({
  draft,
  errors,
  callbackUrl,
  update,
}: {
  draft: McpServerDraft;
  errors: McpDraftErrors;
  callbackUrl?: string;
  update: (changes: Partial<McpServerDraft>) => void;
}) {
  const id = useId();
  if (draft.transport === "stdio")
    return <EnvironmentEditor draft={draft} errors={errors} update={update} />;
  return (
    <>
      <ChoiceCards
        label="Access"
        value={draft.access}
        choices={ACCESS}
        onChange={(access) => update({ access })}
      />
      {draft.access === "token" ? (
        <>
          <Field label="Token" error={errors.token}>
            <SecretInput
              label="Token"
              value={draft.token}
              error={errors.token}
              onChange={(token) => update({ token })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Header" htmlFor={`${id}-header`} error={errors.header}>
              <TextInput
                id={`${id}-header`}
                value={draft.header}
                onChange={(header) =>
                  update({
                    header,
                    // Bearer belongs to Authorization; other headers usually take the bare key.
                    ...(draft.prefix === "Bearer " && header.toLowerCase() !== "authorization"
                      ? { prefix: "" }
                      : {}),
                  })
                }
                error={errors.header}
                mono
              />
            </Field>
            <Field label="Prefix" htmlFor={`${id}-prefix`}>
              <TextInput
                id={`${id}-prefix`}
                value={draft.prefix}
                onChange={(prefix) => update({ prefix })}
                mono
                placeholder="None"
              />
            </Field>
          </div>
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            Sends{" "}
            <span className="font-mono whitespace-pre text-foreground">
              {draft.header.trim() || "Header"}: {draft.prefix}
              {secretPreview(draft.token)}
            </span>
          </p>
        </>
      ) : null}
      {draft.access === "oauth" ? (
        <>
          <ChoiceCards
            label="OAuth client"
            value={draft.client}
            choices={CLIENTS}
            onChange={(client) => update({ client })}
          />
          {draft.client === "static" ? (
            <>
              <Field label="Client ID" error={errors.clientId}>
                <SecretInput
                  label="Client ID"
                  value={draft.clientId}
                  error={errors.clientId}
                  reveal
                  onChange={(clientId) => update({ clientId })}
                />
              </Field>
              <Field label="Client secret" error={errors.clientSecret} optional>
                <SecretInput
                  label="Client secret"
                  value={draft.clientSecret}
                  error={errors.clientSecret}
                  onChange={(clientSecret) => update({ clientSecret })}
                />
              </Field>
              {callbackUrl ? <CallbackUrl url={callbackUrl} /> : null}
            </>
          ) : null}
          <Field label="Scopes" htmlFor={`${id}-scopes`} hint="Separate with spaces" optional>
            <TextInput
              id={`${id}-scopes`}
              value={draft.scopes}
              onChange={(scopes) => update({ scopes })}
              mono
              placeholder="read write"
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

function secretPreview(secret: SecretDraft): string {
  if (secret.source === "env") return `$${secret.value.trim() || "VARIABLE"}`;
  if (secret.source === "file") return `‹${secret.value.trim() || "file"}›`;
  return secret.value ? "•".repeat(Math.min(secret.value.length, 12)) : "token";
}

function CallbackUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label="Redirect URL" hint="Add this URL to your OAuth app">
      <TextInput
        label="Redirect URL"
        value={url}
        onChange={() => undefined}
        readOnly
        mono
        addon={
          <InputGroupAddon className="pr-1">
            <IconButton
              label="Copy redirect URL"
              tooltip={copied ? "Copied" : "Copy"}
              className="size-6"
              onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
            >
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </InputGroupAddon>
        }
      />
    </Field>
  );
}

const SOURCES: readonly { value: SecretSource; label: string }[] = [
  { value: "text", label: "Paste" },
  { value: "env", label: "Env variable" },
  { value: "file", label: "File" },
];

const SOURCE_PLACEHOLDER: Record<SecretSource, string> = {
  text: "Value",
  env: "API_TOKEN",
  file: "/data/secret/token.txt",
};

/** A secret typed into the config file, or read from Core's environment or a file. */
function SecretInput({
  label,
  value,
  error,
  reveal: alwaysReveal = false,
  onChange,
}: {
  label: string;
  value: SecretDraft;
  error?: string;
  /** Shows typed text, for values that are not secret such as a client ID. */
  reveal?: boolean;
  onChange: (value: SecretDraft) => void;
}) {
  const [shown, setShown] = useState(alwaysReveal);
  const text = value.source === "text";
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select
          items={SOURCES}
          value={value.source}
          onValueChange={(source) => {
            if (source) onChange({ source, value: "" });
          }}
        >
          <SelectTrigger aria-label={`${label} source`} className="w-32 flex-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="min-w-0 flex-1">
          <TextInput
            label={text ? label : `${label} ${value.source === "env" ? "variable" : "file"}`}
            value={value.value}
            onChange={(next) => onChange({ ...value, value: next })}
            error={error}
            mono={!text || shown}
            type={text && !shown ? "password" : "text"}
            placeholder={SOURCE_PLACEHOLDER[value.source]}
            addon={
              text && !alwaysReveal ? (
                <InputGroupAddon className="pr-1">
                  <IconButton
                    label={shown ? `Hide ${label}` : `Show ${label}`}
                    className="size-6"
                    onClick={() => setShown(!shown)}
                  >
                    {shown ? <EyeOff /> : <Eye />}
                  </IconButton>
                </InputGroupAddon>
              ) : undefined
            }
          />
        </div>
      </div>
      {text && !alwaysReveal && value.value ? (
        <p className="text-xs text-muted-foreground">Saved in mcp-config.yaml</p>
      ) : null}
    </div>
  );
}

let envKey = 0;

function EnvironmentEditor({
  draft,
  errors,
  update,
}: {
  draft: McpServerDraft;
  errors: McpDraftErrors;
  update: (changes: Partial<McpServerDraft>) => void;
}) {
  const change = (key: string, changes: Partial<McpServerDraft["env"][number]>) =>
    update({
      env: draft.env.map((variable) =>
        variable.key === key ? { ...variable, ...changes } : variable,
      ),
    });
  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium">Environment variables</p>
        <p className="text-xs text-muted-foreground">
          Pass API keys or tokens the command reads. Leave empty if it needs none.
        </p>
      </div>
      {draft.env.map((variable) => (
        <div key={variable.key} className="grid gap-1 rounded-lg border border-border p-2">
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <TextInput
                label="Variable name"
                value={variable.name}
                onChange={(name) => change(variable.key, { name })}
                error={errors[`env.${variable.key}.name`]}
                mono
                placeholder="GITHUB_TOKEN"
              />
            </div>
            <IconButton
              label={`Remove ${variable.name || "variable"}`}
              tooltip="Remove"
              className="size-7 hover:text-danger"
              onClick={() => update({ env: draft.env.filter((item) => item.key !== variable.key) })}
            >
              <Trash2 />
            </IconButton>
          </div>
          {errors[`env.${variable.key}.name`] ? (
            <p className="text-xs text-danger">{errors[`env.${variable.key}.name`]}</p>
          ) : null}
          <SecretInput
            label={variable.name || "Value"}
            value={variable}
            error={errors[`env.${variable.key}.value`]}
            onChange={(secret) => change(variable.key, secret)}
          />
          {errors[`env.${variable.key}.value`] ? (
            <p className="text-xs text-danger">{errors[`env.${variable.key}.value`]}</p>
          ) : null}
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            envKey += 1;
            update({
              env: [...draft.env, { key: `env-${envKey}`, name: "", source: "text", value: "" }],
            });
          }}
        >
          <Plus />
          Add variable
        </Button>
      </div>
    </div>
  );
}

type ProgressState = "done" | "active" | "failed" | "pending";

function ProgressLine({ state, children }: { state: ProgressState; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span className="flex size-5 flex-none items-center justify-center">
        {state === "active" ? <LoadingSpinner size={14} /> : null}
        {state === "done" ? <Check className="size-4 text-success" /> : null}
        {state === "failed" ? <X className="size-4 text-danger" /> : null}
        {state === "pending" ? (
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        ) : null}
      </span>
      <div
        className={cn(
          "grid min-w-0 flex-1 gap-2 pt-px",
          state === "pending" && "text-muted-foreground",
        )}
      >
        {children}
      </div>
    </li>
  );
}

function connectionLine(view: Phase): { state: ProgressState; label: string } {
  switch (view.kind) {
    case "connected":
      return { state: "done", label: `Connected with ${toolText(view.toolCount)}` };
    case "failed":
      return view.stage === "connect"
        ? { state: "failed", label: "Could not connect" }
        : { state: "pending", label: "Connect" };
    case "authorizing":
      return { state: "active", label: "Preparing sign-in" };
    case "connecting":
      return { state: "active", label: "Connecting" };
    case "saving":
    case "signIn":
      return { state: "pending", label: "Connect" };
  }
}

function toolText(count: number | undefined) {
  return count === 1 ? "1 tool" : `${count ?? 0} tools`;
}

function ConnectStep({
  view,
  serverId,
  showSave,
  onOpened,
  onRetrySignIn,
}: {
  view: Phase;
  serverId: string;
  showSave: boolean;
  onOpened: () => void;
  onRetrySignIn: () => void;
}) {
  const savedState = view.kind === "saving" ? "active" : "done";
  const failedSave = view.kind === "failed" && view.stage === "save";
  return (
    <ol className="grid gap-3 py-1" aria-live="polite">
      {showSave ? (
        <ProgressLine state={failedSave ? "failed" : savedState}>
          <span>
            {view.kind === "saving" ? "Saving" : "Saved"}{" "}
            <span className="font-mono text-xs">{serverId}</span> to mcp-config.yaml
          </span>
          {failedSave ? <ErrorText message={view.message} /> : null}
        </ProgressLine>
      ) : null}
      {view.kind === "signIn" ? (
        <ProgressLine state="active">
          <span>{view.opened ? "Waiting for you to finish signing in" : "Sign in to connect"}</span>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={view.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({
                variant: view.opened ? "outline" : "default",
                size: "sm",
              })}
              onClick={onOpened}
            >
              <ExternalLink />
              {view.opened ? "Open again" : "Open sign-in page"}
            </a>
            {view.opened ? (
              <Button variant="ghost" size="sm" onClick={onRetrySignIn}>
                New link
              </Button>
            ) : null}
          </div>
        </ProgressLine>
      ) : (
        <ProgressLine state={connectionLine(view).state}>
          <span>{connectionLine(view).label}</span>
          {view.kind === "failed" && view.stage === "connect" ? (
            <ErrorText message={view.message} />
          ) : null}
        </ProgressLine>
      )}
    </ol>
  );
}

function ErrorText({ message }: { message: string }) {
  return (
    <p className="rounded-md bg-danger/10 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger wrap-anywhere">
      {message}
    </p>
  );
}
