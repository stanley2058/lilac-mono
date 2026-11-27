import { describe, expect, it } from "bun:test";
import {
  accessErrors,
  connectionErrors,
  EMPTY_MCP_SERVER_DRAFT,
  mcpServerConfig,
  splitCommandLine,
  type McpServerDraft,
} from "./mcp-server-draft";

const draft = (changes: Partial<McpServerDraft>): McpServerDraft => ({
  ...EMPTY_MCP_SERVER_DRAFT,
  id: "docs",
  url: "https://example.com/mcp",
  ...changes,
});

describe("MCP server setup draft", () => {
  it("splits command lines like a shell", () => {
    expect(splitCommandLine(`npx -y "@scope/server name" 'it''s' a\\ b`)).toEqual([
      "npx",
      "-y",
      "@scope/server name",
      "its",
      "a b",
    ]);
    expect(splitCommandLine(`uvx "unterminated`)).toBeUndefined();
    expect(splitCommandLine("   ")).toEqual([]);
    expect(splitCommandLine(`run ""`)).toEqual(["run", ""]);
  });

  it("checks the name, URL, and command", () => {
    expect(connectionErrors(draft({ id: "" }), [])).toEqual({ id: "Enter a name" });
    expect(connectionErrors(draft({ id: "-bad" }), []).id).toBeDefined();
    expect(connectionErrors(draft({}), ["docs"])).toEqual({ id: "That name is taken" });
    expect(connectionErrors(draft({ url: "ftp://example.com" }), []).url).toBeDefined();
    expect(connectionErrors(draft({ transport: "stdio", command: "" }), []).command).toBe(
      "Enter the command that starts the server",
    );
    expect(connectionErrors(draft({ transport: "stdio", command: "npx tool" }), [])).toEqual({});
  });

  it("writes a bearer token header from an environment variable", () => {
    const value = draft({ access: "token", token: { source: "env", value: "DOCS_TOKEN" } });
    expect(accessErrors(value)).toEqual({});
    expect(mcpServerConfig(value)).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { env: "DOCS_TOKEN", prefix: "Bearer " } },
    });
    expect(
      mcpServerConfig(
        draft({
          access: "token",
          header: "X-Api-Key",
          prefix: "",
          token: { source: "text", value: "k" },
        }),
      ).headers,
    ).toEqual({ "X-Api-Key": "k" });
    expect(accessErrors(draft({ access: "token" }))).toEqual({ token: "Enter the token" });
  });

  it("writes dynamic and static OAuth clients", () => {
    expect(mcpServerConfig(draft({ access: "oauth", scopes: "read, write" })).auth).toEqual({
      type: "oauth",
      grant: "authorization_code",
      scopes: ["read", "write"],
      client: { type: "dynamic" },
    });
    const staticClient = draft({
      access: "oauth",
      client: "static",
      clientId: { source: "text", value: "client" },
      clientSecret: { source: "file", value: "/run/secret" },
    });
    expect(accessErrors(staticClient)).toEqual({});
    expect(mcpServerConfig(staticClient).auth).toEqual({
      type: "oauth",
      grant: "authorization_code",
      client: { type: "static", clientId: "client", clientSecret: { file: "/run/secret" } },
    });
    expect(accessErrors(draft({ access: "oauth", client: "static" }))).toEqual({
      clientId: "Enter the client ID",
    });
  });

  it("writes a local command with environment variables", () => {
    const value = draft({
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-github",
      env: [
        { key: "a", name: "GITHUB_TOKEN", source: "env", value: "GH_TOKEN" },
        { key: "b", name: "MODE", source: "text", value: "read" },
      ],
    });
    expect(accessErrors(value)).toEqual({});
    expect(mcpServerConfig(value)).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { env: "GH_TOKEN" }, MODE: "read" },
    });
    expect(
      accessErrors(
        draft({
          transport: "stdio",
          env: [
            { key: "a", name: "A", source: "text", value: "1" },
            { key: "b", name: "A", source: "env", value: "lower-case" },
          ],
        }),
      ),
    ).toEqual({
      "env.b.name": "Already set",
      "env.b.value": "Use a variable name such as API_TOKEN",
    });
  });
});
