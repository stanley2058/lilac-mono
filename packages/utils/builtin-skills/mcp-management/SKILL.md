---
name: mcp-management
description: Manage Core's configured always-on MCP servers and credentials with the mcp.* tools; load this before adding, removing, authenticating, inspecting, or reloading a server.
---

# MCP management

Use the Level 2 `mcp.*` tools to manage MCP servers owned by the Core process. These commands update Core's MCP registry and persisted configuration. The separate `mcporter` skill is only for ad-hoc/direct calls, independent mcporter configuration and authentication, and code generation; it does not modify or authenticate Core's registry.

## Commands

- List definitions: `tools mcp.list`
- Add or replace: `tools mcp.add <server-id> --transport=http --url=https://example.com/mcp`
- Inspect status: `tools mcp.status [server-id]`
- Start authorization-code OAuth: `tools mcp.auth <server-id>`
- Reload one server: `tools mcp.reload <server-id>`
- Reload all unavailable or changed servers: `tools mcp.reload`
- Remove a definition: `tools mcp.remove <server-id>`

Run `tools --help mcp.add` before constructing uncommon inputs. Space-separated flag values are not supported; use `--field=value`, `--input=@file.json`, or `--stdin`.

## HTTP servers

For a simple Streamable HTTP server:

```bash
tools mcp.add docs --transport=http --url=https://mcp.example.com/mcp
```

Use structured JSON for headers, value sources, or OAuth:

```bash
tools mcp.add --stdin <<'JSON'
{
  "serverId": "docs",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": { "env": "DOCS_MCP_AUTHORIZATION" },
    "X-Workspace": { "file": "secret/mcp-values.json", "pointer": "/docs/workspace" }
  }
}
JSON
```

A value source may be an inline string, `{ "env": "NAME" }`, or `{ "file": "path", "pointer": "/optional/json/pointer" }`. Keep credentials out of inline JSON and transcripts.

For authorization-code OAuth, configure OAuth instead of an `Authorization` header:

```bash
tools mcp.add --stdin <<'JSON'
{
  "serverId": "linear",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "type": "oauth",
    "grant": "authorization_code",
    "scopes": ["read", "write"],
    "client": { "type": "dynamic" }
  }
}
JSON
```

## Stdio servers

Stdio definitions support a command, arguments, working directory, and environment value sources:

```bash
tools mcp.add --stdin <<'JSON'
{
  "serverId": "local-docs",
  "transport": "stdio",
  "command": "bun",
  "args": ["run", "/opt/lilac/mcp/docs-server.ts"],
  "cwd": "/opt/lilac",
  "env": {
    "DOCS_TOKEN": { "env": "DOCS_TOKEN" }
  }
}
JSON
```

## Status and reload

Core attempts every configured server at startup. Status distinguishes `available`, `unavailable`, and `authentication_required`. An unavailable server is not retried automatically, and upstream manifest changes are not discovered automatically. After fixing configuration, credentials, or the server, run `tools mcp.reload <server-id>`; use an unqualified reload to reconcile all servers.

`mcp.add` and `mcp.remove` reconcile the registry after changing configuration. Removing a server closes its client and removes its tools, but deliberately retains its credential file. There is no logout or credential-removal command.

## Protocol support

Core negotiates the stateless MCP `2026-07-28` tool protocol over HTTP and stdio, then falls back to
the legacy initialization handshake when needed. Core exposes tool discovery and execution. It does
not advertise elicitation, sampling, or roots capabilities, and a server response that requires
multi-round-trip client input fails that tool call without removing the server's other tools.

## Browser OAuth flow

The owner can also add a server and sign in from Settings > MCP in the web UI. The callback URL depends on the native gateway. When `surface.native.enabled` is true, the native gateway serves the callback at `<surface.native.publicUrl>/api/mcp/oauth/callback`. Otherwise Core listens on `http://localhost:1456/mcp/oauth/callback`. `mcp.auth` returns the URL in `callbackUrl`. A static OAuth client must have that exact URL registered with its provider. Core registers a new dynamic client when the stored registration names a different callback URL.

1. Run `tools mcp.auth <server-id>` and send the returned authorization URL to the user.
2. The user opens the URL and completes authorization in their browser.
3. If the browser can reach the callback URL, completion happens directly. A public native URL is reachable from any browser that can open the web UI.
4. With the loopback callback in a container deployment, the browser may fail to reach its own `localhost` callback. The user must copy the complete final callback URL from the address bar and paste it back, including its path, code, and state.
5. Run `curl '<complete-callback-url>'` inside the Core container or host namespace.
6. Core reloads the server after the callback stores tokens. Check `tools mcp.status <server-id>`.

Never accept a bare authorization code; only the complete callback URL with matching state is valid. The agent-assisted copy/paste flow exposes callback material to the agent transcript. Use it only when the user accepts that leakage; prefer direct browser callback completion when reachable.

## Security boundary

MCP OAuth credentials persist under `DATA_DIR/secret/mcp-oauth`. Normal filesystem tools and direct static Bash analysis deny that tree unless an explicit dangerous bypass is used. These are best-effort accidental-access guards, not isolation: trusted same-user code, dynamic shell construction, plugins, or other service-UID processes can bypass them. Use OS/container isolation when commands must not be able to access credentials.
