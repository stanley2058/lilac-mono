import path from "node:path";
import { Result } from "better-result";
import { readMcpConfigFile } from "../../../src/mcp/config-file";
import type { McpServerDefinition } from "../../../src/mcp/config-types";
import { McpOAuthControlError } from "../../../src/mcp/oauth-control";
import { mcpOAuthCallbackResponse } from "../../../src/mcp/oauth-callback";
import { resolveMcpOAuthCallbackUrl } from "../../../src/mcp/oauth-provider";
import type { McpServerStatus } from "../../../src/mcp/registry-types";
import type { NativeRuntimeOptions } from "../../../src/surface/native/runtime";

/**
 * A simulated MCP registry for browser development. Servers whose URL host contains
 * `unreachable` fail; OAuth servers need sign-in, which the fixture callback grants.
 */
export function createFixtureMcp(options: { dataDir: () => string; publicUrl: string }) {
  const authorized = new Set<string>();
  let servers: readonly McpServerDefinition[] = [];
  const callbackUrl = resolveMcpOAuthCallbackUrl({ enabled: true, publicUrl: options.publicUrl });
  async function read() {
    const config = await readMcpConfigFile(path.join(options.dataDir(), "mcp-config.yaml"));
    if (config.isOk()) servers = Object.values(config.value.config.servers);
  }
  function status(server: McpServerDefinition): McpServerStatus {
    const transport = server.transportConfig;
    const base = { serverId: server.id, transport: transport.transport };
    if (transport.transport === "http" && new URL(transport.url).hostname.includes("unreachable"))
      return {
        ...base,
        status: "unavailable",
        phase: "connection",
        error: "fetch failed: ECONNREFUSED",
      };
    if (transport.transport === "http" && transport.auth && !authorized.has(server.id))
      return {
        ...base,
        status: "authentication_required",
        phase: "connection",
        error: "Sign in with mcp.auth",
      };
    return { ...base, status: "available", toolCount: transport.transport === "stdio" ? 3 : 7 };
  }
  const registry: NonNullable<NativeRuntimeOptions["mcpRegistry"]> = {
    reload: async () => {
      await read();
      return Result.ok(
        servers.map((server) => {
          const current = status(server);
          return {
            serverId: server.id,
            result: current.status,
            reconciliation: "unchanged" as const,
            ...(current.status === "available" ? {} : { error: current.error }),
          };
        }),
      );
    },
    list: () => servers.map(status),
    getCatalogServers: () => [],
    getTools: () => [],
  };
  const mcpOAuth: NonNullable<NativeRuntimeOptions["mcpOAuth"]> = {
    callbackUrl,
    reconcile: read,
    async authorize(serverId) {
      await read();
      const server = servers.find((candidate) => candidate.id === serverId);
      if (server?.transportConfig.transport !== "http" || !server.transportConfig.auth)
        return Result.err(
          new McpOAuthControlError({
            code: "not-found",
            message: `Server ${JSON.stringify(serverId)} is not saved with OAuth`,
          }),
        );
      if (authorized.has(serverId)) return Result.ok({ status: "authorized" });
      const authorizationUrl = new URL(callbackUrl);
      authorizationUrl.searchParams.set("code", "fixture");
      authorizationUrl.searchParams.set("state", serverId);
      return Result.ok({
        status: "authorization_required",
        authorizationUrl: authorizationUrl.href,
        callbackUrl,
      });
    },
  };
  const mcpOAuthCallback: NonNullable<NativeRuntimeOptions["mcpOAuthCallback"]> = {
    async handleRequest(request) {
      const state = new URL(request.url).searchParams.get("state") ?? "";
      if (!servers.some((server) => server.id === state))
        return mcpOAuthCallbackResponse(request, { outcome: "invalid" });
      authorized.add(state);
      return mcpOAuthCallbackResponse(request, { outcome: "completed", serverId: state });
    },
  };
  return { registry, mcpOAuth, mcpOAuthCallback };
}
