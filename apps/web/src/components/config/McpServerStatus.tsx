import { useCallback, useState } from "react";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { Result } from "better-result";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { uiError } from "../ui";
import { queryNativeRPC, useNativeOnline } from "../../queries";
import { useWorkspace } from "../../workspace-context";

const STATUS_KEY = ["config", "mcp-status"] as const;

export function useMcpStatus() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => queryNativeRPC(client, (rpc) => rpc.config.mcpStatus({}, { signal })),
    enabled: online,
    staleTime: 5_000,
  });
}

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

type ServerStatus = NonNullable<ReturnType<typeof useMcpStatus>["data"]>["servers"][number];

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
  const status = useMcpStatus();
  const server = status.data?.servers.find((candidate) => candidate.name === serverId);
  if (!status.data) return null;
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
