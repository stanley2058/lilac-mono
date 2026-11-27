import type { McpConfigFieldPattern as P } from "../../../core/src/generated/config-schemas/config-fields";
import { collection, type Manifest } from "./manifest";

const STDIO = { path: "transport", equals: "stdio" } as const;
const HTTP = { path: "transport", equals: "http" } as const;
const STATIC_CLIENT = { path: "auth.client.type", equals: "static" } as const;

export const MCP_SERVERS_PAGE = "servers";

export const mcpManifest: Manifest<P> = {
  kind: "mcp",
  unplaced: { configVersion: "Shown as a notice; version 1 is the only MCP format." },
  pages: [
    {
      id: MCP_SERVERS_PAGE,
      title: "Servers",
      sections: [
        {
          title: "Servers",
          entries: [
            collection<P, "servers">({
              collection: "servers",
              label: "Servers",
              itemNoun: "server",
              addDialog: "mcpServer",
              keyLabel: "Server ID",
              keyPlaceholder: "github",
              newItem: { transport: "stdio", command: "" },
              summary: ["transport"],
              fields: [
                {
                  path: "transport",
                  label: "Connection",
                  help: "How Lilac connects to this server. Local command runs a `stdio` process; HTTP connects to a remote URL.",
                  widget: "discriminator",
                  options: { '"stdio"': "Local command", '"http"': "HTTP" },
                },
                {
                  path: "command",
                  label: "Command",
                  help: "Executable to launch for the local MCP server, such as `npx` or `uvx`.",
                  placeholder: "npx",
                  visibleWhen: STDIO,
                },
                {
                  path: "args",
                  label: "Arguments",
                  help: "Arguments passed to the server executable in order.",
                  placeholder: "Argument",
                  visibleWhen: STDIO,
                },
                {
                  path: "cwd",
                  label: "Working directory",
                  help: "Directory the local server process runs in.",
                  visibleWhen: STDIO,
                },
                {
                  path: "env",
                  label: "Environment",
                  help: "Environment variables passed to the local process. Values can be literal text, read from an environment variable, or read from a file.",
                  placeholder: "VAR_NAME",
                  widget: "map",
                  visibleWhen: STDIO,
                },
                {
                  path: "url",
                  label: "URL",
                  help: "Streamable HTTP endpoint URL for this MCP server.",
                  placeholder: "https://example.com/mcp",
                  widget: "longText",
                  visibleWhen: HTTP,
                },
                {
                  path: "headers",
                  label: "Headers",
                  help: "HTTP headers sent on every request. Values can be literal text, read from an environment variable, or read from a file.",
                  placeholder: "Header-Name",
                  widget: "map",
                  visibleWhen: HTTP,
                },
                {
                  path: "auth",
                  label: "Authorization",
                  help: "OAuth authorization for this server. OAuth registers a client dynamically; OAuth with client ID uses a static client ID and a secret if needed.",
                  widget: "mcpAuth",
                  visibleWhen: HTTP,
                },
                {
                  path: "auth.scopes",
                  label: "Scopes",
                  help: "OAuth permission scopes requested during sign-in.",
                  placeholder: "Scope",
                  visibleWhen: { path: "auth", present: true },
                },
                {
                  path: "auth.client.clientId",
                  label: "Client ID",
                  help: "Static OAuth client ID. Can be literal text, read from an environment variable, or read from a file.",
                  visibleWhen: STATIC_CLIENT,
                },
                {
                  path: "auth.client.clientSecret",
                  label: "Client secret",
                  help: "Static OAuth client secret, when your client has one. Can be literal text, read from an environment variable, or read from a file.",
                  visibleWhen: STATIC_CLIENT,
                },
                {
                  path: "description",
                  label: "Description",
                  help: "Summary shown to the agent before the server's own description.",
                },
                {
                  path: "allowSubagents",
                  label: "Available to subagents",
                  help: "Exposes this server's tools to subagents whose permission profile allows this plugin.",
                },
              ],
            }),
          ],
        },
      ],
    },
  ],
};
