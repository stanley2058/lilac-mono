import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { LogIn, Plus, RefreshCw } from "lucide-react";
import { Result } from "better-result";
import {
  applyConfigPatch,
  isConfigObject,
  parseConfigYaml,
  readConfigValue,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { IconButton, uiError } from "../ui";
import type { NativeClient } from "@stanley2058/lilac-client";
import { queryNativeRPC, useNativeOnline } from "../../queries";
import { useWorkspace } from "../../workspace-context";
import {
  useConfigDraftStore,
  useConfigValue,
  type ConfigDocument,
  type ConfigDraftState,
} from "../../config-ui/draft-store";
import { configSaveLock } from "../../config-ui/save-lock";
import type { McpServerState, McpSetupApi, McpSetupMode } from "./McpServerSetup";
import type { StoreApi } from "zustand/vanilla";

const McpServerSetupDialog = lazy(() =>
  import("./McpServerSetup").then((module) => ({ default: module.McpServerSetupDialog })),
);

const STATUS_KEY = ["config", "mcp-status"] as const;

type StatusReply = NativeRpcOutputs["config"]["mcpStatus"];

function useMcpStatusQuery<T>(select: (reply: StatusReply) => T) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => queryNativeRPC(client, (rpc) => rpc.config.mcpStatus({}, { signal })),
    enabled: online,
    staleTime: 5_000,
    select,
  });
}

const callbackUrlOf = (reply: StatusReply) => reply.oauthCallbackUrl;

type ReloadReply = NativeRpcOutputs["config"]["reloadMcp"];

/** Names the servers that failed to load, with the first error. */
function reloadFailure(reply: ReloadReply): string | undefined {
  const failed = reply.servers.filter((server) => server.error !== undefined);
  const [first] = failed;
  if (!first) return undefined;
  const names = failed.map((server) => server.name).join(", ");
  return `${names} did not load: ${first.error}`;
}

/**
 * Reloads MCP servers and refreshes their status. Returns an error message when the reload
 * fails or a server does not load.
 */
export function useMcpReload(): () => Promise<string | undefined> {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  return useCallback(async () => {
    const rpc = client.rpc;
    if (!rpc) return "MCP reload failed: offline.";
    const result = await Result.tryPromise({ try: () => rpc.config.reloadMcp({}), catch: uiError });
    await queries.invalidateQueries({ queryKey: STATUS_KEY });
    return result.match({ ok: reloadFailure, err: (message) => `MCP reload failed: ${message}` });
  }, [client, queries]);
}

export function McpReloadButton() {
  const reload = useMcpReload();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(await reload());
          setPending(false);
        }}
      >
        <RefreshCw className={cn(pending && "animate-spin")} />
        Reload
      </Button>
    </span>
  );
}

const TONES = {
  available: "bg-success",
  authentication_required: "bg-warning",
  unavailable: "bg-danger",
} as const;

type ServerStatus = StatusReply["servers"][number];

function serverLabel(server: ServerStatus | undefined): string {
  switch (server?.state) {
    case undefined:
      return "Not loaded";
    case "available":
      return server.toolCount === 1 ? "1 tool" : `${server.toolCount ?? 0} tools`;
    case "authentication_required":
      return "Needs sign-in";
    case "unavailable":
      return "Unavailable";
  }
}

export function McpItemStatus({ serverId }: { serverId: string }) {
  // `null` is a loaded reply without this server; `undefined` is a reply still loading.
  const selectServer = useCallback(
    (reply: StatusReply) => reply.servers.find((candidate) => candidate.name === serverId) ?? null,
    [serverId],
  );
  const loaded = useMcpStatusQuery(selectServer).data;
  const auth = useConfigValue("mcp", ["servers", serverId, "auth"], "saved");
  if (loaded === undefined) return null;
  const server = loaded ?? undefined;
  if (!isConfigObject(auth)) return <McpStatusBadge server={server} />;
  return (
    <span className="flex items-center gap-1">
      <McpStatusBadge server={server} />
      <McpSignInButton serverId={serverId} needed={server?.state === "authentication_required"} />
    </span>
  );
}

function McpStatusBadge({ server }: { server: ServerStatus | undefined }) {
  const label = serverLabel(server);
  const badge = (
    <span className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          server ? TONES[server.state] : "bg-muted-foreground/40",
        )}
      />
      {label}
    </span>
  );
  if (!server?.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipContent className="max-w-80 whitespace-pre-wrap">{server.error}</TooltipContent>
    </Tooltip>
  );
}

function serverState(reply: StatusReply, serverId: string): McpServerState {
  const server = reply.servers.find((candidate) => candidate.name === serverId);
  if (!server) return { state: "missing", error: "Core did not load this server." };
  return {
    state: server.state,
    ...(server.toolCount === undefined ? {} : { toolCount: server.toolCount }),
    ...(server.error === undefined ? {} : { error: server.error }),
  };
}

/** Keeps unsaved form edits after the dialog writes a server to the file. */
function syncDraft(store: StoreApi<ConfigDraftState>, saved: ConfigDocument) {
  const draft = store.getState().drafts.mcp;
  if (!draft || draft.text === draft.saved.text) return store.getState().replace(saved);
  if (draft.operations && store.getState().rebase(saved, draft.operations) === undefined) return;
  // YAML edits cannot move to the new file; the save bar reports the conflict.
}

/** Runs one Core call, turning a rejection into its message. */
function call<T>(operation: () => Promise<T>): Promise<Result<T, string>> {
  return Result.tryPromise({ try: operation, catch: uiError });
}

function serverPatch(
  document: ConfigDocument,
  serverId: string,
  server: Record<string, ConfigValue>,
  replace: boolean,
): Result<string, string> {
  const parsed = parseConfigYaml(document.text);
  if (parsed.isErr()) return Result.err(`Fix the MCP YAML first: ${parsed.error.message}`);
  if (!replace && readConfigValue(parsed.value.value, ["servers", serverId]) !== undefined)
    return Result.err(`A server named ${serverId} exists.`);
  return applyConfigPatch(document.text, [
    { op: "set", path: ["servers", serverId], value: server },
  ]).mapError((error) => error.message);
}

async function saveServer(
  rpc: NonNullable<NativeClient["rpc"]>,
  store: StoreApi<ConfigDraftState>,
  serverId: string,
  server: Record<string, ConfigValue>,
  replace: boolean,
): Promise<Result<void, string>> {
  const latest = await call(() => rpc.config.read({ kind: "mcp" }));
  if (latest.isErr()) return Result.err(latest.error);
  const text = serverPatch(latest.value, serverId, server, replace);
  if (text.isErr()) return Result.err(text.error);
  const saved = await call(() =>
    rpc.config.save({ kind: "mcp", expectedRevision: latest.value.revision, text: text.value }),
  );
  return saved.map((document) => syncDraft(store, document));
}

const OFFLINE = Result.err("Lilac is offline.");

export function useMcpSetupApi(): McpSetupApi {
  const { client } = useWorkspace();
  const store = useConfigDraftStore();
  const queries = useQueryClient();
  // Subscribe to the callback URL only, so status polling does not rerender the dialog.
  const callbackUrl = useMcpStatusQuery(callbackUrlOf).data;
  return useMemo<McpSetupApi>(() => {
    const readStatus = async (serverId: string) => {
      const rpc = client.rpc;
      if (!rpc) return OFFLINE;
      const reply = await call(() => rpc.config.mcpStatus({}));
      return reply.map((value) => {
        queries.setQueryData(STATUS_KEY, value);
        return serverState(value, serverId);
      });
    };
    return {
      ...(callbackUrl ? { callbackUrl } : {}),
      async save(serverId, server, replace) {
        const rpc = client.rpc;
        if (!rpc) return OFFLINE;
        const attempt = configSaveLock.getState().begin("mcp");
        if (attempt === undefined) return Result.err("Another save is in progress. Try again.");
        const saved = await call(() => saveServer(rpc, store, serverId, server, replace));
        configSaveLock.getState().end("mcp", attempt);
        return saved.andThen((result) => result);
      },
      async connect(serverId) {
        const rpc = client.rpc;
        if (!rpc) return OFFLINE;
        const reloaded = await call(() => rpc.config.reloadMcp({}));
        if (reloaded.isErr()) return Result.err(reloaded.error);
        return readStatus(serverId);
      },
      status: readStatus,
      async authorize(serverId) {
        const rpc = client.rpc;
        if (!rpc) return OFFLINE;
        return call(() => rpc.config.authorizeMcp({ serverId }));
      },
    };
  }, [client, store, queries, callbackUrl]);
}

function McpSetupLauncher({
  mode,
  open,
  onOpenChange,
}: {
  mode: McpSetupMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useMcpSetupApi();
  return (
    <Suspense fallback={null}>
      <McpServerSetupDialog open={open} onOpenChange={onOpenChange} mode={mode} api={api} />
    </Suspense>
  );
}

/** Opens the guided setup for a new MCP server. */
export function McpAddServerButton({
  takenIds,
  disabled,
}: {
  takenIds: readonly string[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Keep the dialog mounted after it closes so its exit animation plays.
  const [mounted, setMounted] = useState(false);
  const mode = useMemo<McpSetupMode>(() => ({ kind: "add", takenIds }), [takenIds]);
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <Plus />
        Add server
      </Button>
      {mounted ? <McpSetupLauncher mode={mode} open={open} onOpenChange={setOpen} /> : null}
    </div>
  );
}

/** The dialog stays open after sign-in succeeds, when the trigger itself disappears. */
function McpSignInButton({ serverId, needed }: { serverId: string; needed: boolean }) {
  const [open, setOpen] = useState(false);
  const mode = useMemo<McpSetupMode>(() => ({ kind: "signIn", serverId }), [serverId]);
  return (
    <>
      {needed ? (
        <IconButton
          label={`Sign in to ${serverId}`}
          tooltip="Sign in"
          className="size-7"
          onClick={() => setOpen(true)}
        >
          <LogIn />
        </IconButton>
      ) : null}
      {open ? <McpSetupLauncher mode={mode} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
