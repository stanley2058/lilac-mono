import type { CallToolResult, ListToolsResult, MCPClient, MCPClientConfig } from "@ai-sdk/mcp";
import { jsonSchema, tool } from "ai";
import { Result } from "better-result";

import type {
  McpConfigFileResult,
  McpRegistryClient,
  McpServerDefinition,
  UniversalMcpConfig,
} from "../../../src/mcp";

export function mcpToolDefinition(
  name: string,
  options: { readonly title?: string; readonly description?: string } = {},
): ListToolsResult["tools"][number] {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

export function stdioDefinition(id: string, command = "bun"): McpServerDefinition {
  return {
    id,
    allowSubagents: false,
    transportConfig: { transport: "stdio", command, args: [], env: {} },
  };
}

export function httpDefinition(
  id: string,
  url = "https://example.invalid/mcp",
): McpServerDefinition {
  return {
    id,
    allowSubagents: false,
    transportConfig: { transport: "http", url, headers: {} },
  };
}

export function mcpConfig(definitions: readonly McpServerDefinition[]): UniversalMcpConfig {
  return {
    configVersion: 1,
    servers: Object.fromEntries(definitions.map((definition) => [definition.id, definition])),
  };
}

export function configSnapshot(
  config: UniversalMcpConfig,
  configPath = "/tmp/lilac/mcp-config.yaml",
): McpConfigFileResult {
  return Result.ok({ configPath, exists: true, config });
}

export class FakeMcpClient implements McpRegistryClient {
  readonly serverInfo: McpRegistryClient["serverInfo"];
  readonly cursors: Array<string | undefined> = [];
  readonly convertedDefinitions: ListToolsResult[] = [];
  closeCount = 0;
  executeTool: (name: string, input: unknown) => Promise<CallToolResult> = async (name, input) => ({
    content: [{ type: "text", text: JSON.stringify({ name, input }) }],
  });

  constructor(
    private pages: Readonly<Record<string, ListToolsResult>> = {
      first: { tools: [] },
    },
    serverInfo: McpRegistryClient["serverInfo"] = {
      name: "fixture-mcp-server",
      version: "1.0.0",
    },
  ) {
    this.serverInfo = serverInfo;
  }

  setPages(pages: Readonly<Record<string, ListToolsResult>>): void {
    this.pages = pages;
  }

  async listTools(options?: Parameters<MCPClient["listTools"]>[0]): Promise<ListToolsResult> {
    const cursor = options?.params?.cursor;
    this.cursors.push(cursor);
    const page = this.pages[cursor ?? "first"];
    if (!page) throw new Error(`No fake page for cursor ${JSON.stringify(cursor)}`);
    return page;
  }

  toolsFromDefinitions(
    definitions: ListToolsResult,
  ): ReturnType<MCPClient["toolsFromDefinitions"]> {
    this.convertedDefinitions.push(definitions);
    const tools = Object.fromEntries(
      definitions.tools.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
          execute: async (input): Promise<CallToolResult> =>
            this.executeTool(definition.name, input),
        }),
      ]),
    );
    return tools as ReturnType<MCPClient["toolsFromDefinitions"]>;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

export class FakeClientFactory {
  readonly configs: MCPClientConfig[] = [];
  readonly created: FakeMcpClient[] = [];
  private readonly queued = new Map<string, Array<FakeMcpClient | Error>>();

  enqueue(serverId: string, client: FakeMcpClient | Error): void {
    const queue = this.queued.get(serverId) ?? [];
    queue.push(client);
    this.queued.set(serverId, queue);
  }

  create = async (config: MCPClientConfig): Promise<McpRegistryClient> => {
    this.configs.push(config);
    const serverId = config.clientName?.replace(/^lilac-mcp-/, "") ?? "";
    const next = this.queued.get(serverId)?.shift() ?? new FakeMcpClient();
    if (next instanceof Error) throw next;
    this.created.push(next);
    return next;
  };
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
