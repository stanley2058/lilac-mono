import type { ListToolsResult, MCPClient, MCPClientConfig, OAuthClientProvider } from "@ai-sdk/mcp";
import type { Result } from "better-result";

import type { CatalogToolIdentity } from "./catalog-identity";
import type { McpServerDefinition, McpTransportConfig } from "./config-types";
import type { McpConfigFileResult } from "./config-file";
import type { McpRegistryReloadFailure, McpRegistryStateError } from "./registry";
import type { McpValueResolutionContext } from "./value-source";

export type McpRegistryPhase = "configuration" | "connection" | "discovery" | "runtime";
export type McpServerAvailability = "available" | "unavailable" | "authentication_required";
export type McpConvertedTool = ReturnType<MCPClient["toolsFromDefinitions"]>[string];

export type McpRegistryConfigStatus =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly error: string };

export type McpServerInfo = {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
};

export type McpCatalogServer = {
  readonly serverId: string;
  readonly allowSubagents: boolean;
  readonly serverInfo: McpServerInfo;
  /** Configured description first, then the server-advertised description. */
  readonly description?: string;
};

type McpServerStatusBase = {
  readonly serverId: string;
  readonly transport: McpTransportConfig["transport"];
};

export type McpServerStatus =
  | (McpServerStatusBase & {
      readonly status: "available";
      readonly toolCount: number;
    })
  | (McpServerStatusBase & {
      readonly status: "unavailable" | "authentication_required";
      readonly phase: McpRegistryPhase;
      readonly error: string;
    });

export type McpCatalogTool = {
  readonly serverId: string;
  readonly rawName: string;
  readonly title?: string;
  /** The complete server-provided description, without catalog truncation. */
  readonly description?: string;
  readonly identity: CatalogToolIdentity;
  readonly stableId: string;
  readonly tool: McpConvertedTool;
};

export type McpReloadReconciliation =
  | "new"
  | "changed"
  | "removed"
  | "unchanged"
  | "unavailable"
  | "not_found";

export type McpReloadOutcome = {
  readonly serverId: string;
  readonly reconciliation: McpReloadReconciliation;
  readonly result: McpServerAvailability | "removed" | "retained" | "not_found";
  /** Safe failure text. Present when a candidate or cleanup failed. */
  readonly error?: string;
};

export interface McpRegistryClient {
  readonly serverInfo: MCPClient["serverInfo"];
  listTools(options?: Parameters<MCPClient["listTools"]>[0]): Promise<ListToolsResult>;
  toolsFromDefinitions(definitions: ListToolsResult): ReturnType<MCPClient["toolsFromDefinitions"]>;
  close(): Promise<void>;
}

export type McpRegistryTransportInput =
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly authProvider?: OAuthClientProvider;
    }
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly env: Readonly<Record<string, string>>;
    };

export type McpRegistryDependencies = {
  readonly readConfig?: (configPath: string) => Promise<McpConfigFileResult>;
  readonly createClient?: (config: MCPClientConfig) => Promise<McpRegistryClient>;
  readonly createTransport?: (input: McpRegistryTransportInput) => MCPClientConfig["transport"];
  readonly createAuthProvider?: (options: {
    readonly server: McpServerDefinition;
    readonly configPath: string;
    readonly valueContext: McpValueResolutionContext;
  }) => OAuthClientProvider | undefined | Promise<OAuthClientProvider | undefined>;
  readonly scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
};

export type McpRegistryOptions = {
  readonly configPath: string;
  readonly reportFatalError: (error: Error) => void;
  readonly initDeadlineMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
  readonly dependencies?: McpRegistryDependencies;
};

export interface McpRegistryApi {
  init(): Promise<void>;
  waitUntilInitialized?(): Promise<Result<void, McpRegistryStateError>>;
  reload(serverId?: string): Promise<Result<readonly McpReloadOutcome[], McpRegistryReloadFailure>>;
  getConfigStatus?(): McpRegistryConfigStatus;
  list(): readonly McpServerStatus[];
  getCatalogServers(): readonly McpCatalogServer[];
  getTools(): readonly McpCatalogTool[];
  shutdown(): Promise<void>;
}
