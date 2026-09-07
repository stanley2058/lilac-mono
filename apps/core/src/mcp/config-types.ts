export const MCP_CONFIG_VERSION = 1 as const;
export const MCP_CONFIG_FILE_NAME = "mcp-config.yaml";
export const MCP_MAX_SERVER_ID_LENGTH = 64;

/** A literal value, environment lookup, or UTF-8 file lookup. */
export type McpValueSource = string | { env: string } | { file: string; pointer?: string };

export type McpStaticOAuthClient = {
  type: "static";
  clientId: McpValueSource;
  clientSecret?: McpValueSource;
};

export type McpDynamicOAuthClient = { type: "dynamic" };

export type McpAuthorizationCodeAuth = {
  type: "oauth";
  grant: "authorization_code";
  scopes?: readonly string[];
  client: McpStaticOAuthClient | McpDynamicOAuthClient;
};

export type McpAuthConfig = McpAuthorizationCodeAuth;

export type McpStdioTransportConfig = {
  transport: "stdio";
  command: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, McpValueSource>>;
};

export type McpHttpTransportConfig = {
  transport: "http";
  url: string;
  headers: Readonly<Record<string, McpValueSource>>;
  auth?: McpAuthConfig;
};

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export type McpServerDefinition = {
  readonly id: string;
  readonly allowSubagents: boolean;
  readonly description?: string;
  readonly transportConfig: McpTransportConfig;
};

export type UniversalMcpConfig = {
  readonly configVersion: typeof MCP_CONFIG_VERSION;
  readonly servers: Readonly<Record<string, McpServerDefinition>>;
};

export function createEmptyMcpConfig(): UniversalMcpConfig {
  return { configVersion: MCP_CONFIG_VERSION, servers: {} };
}

export function isHttpMcpServer(
  definition: McpServerDefinition,
): definition is McpServerDefinition & { transportConfig: McpHttpTransportConfig } {
  return definition.transportConfig.transport === "http";
}

export function isStdioMcpServer(
  definition: McpServerDefinition,
): definition is McpServerDefinition & { transportConfig: McpStdioTransportConfig } {
  return definition.transportConfig.transport === "stdio";
}

export function usesAuthorizationCodeOAuth(definition: McpServerDefinition): boolean {
  const transport = definition.transportConfig;
  return transport.transport === "http" && transport.auth?.grant === "authorization_code";
}
