import { describe, expect, it } from "bun:test";

import {
  createMCPClient,
  UnauthorizedError,
  type MCPClientConfig,
  type MCPTransport,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { Panic, Result } from "better-result";
import { z } from "zod";

import {
  McpConfigError,
  McpRegistry,
  type McpRegistryClient,
  type McpRegistryTransportInput,
  type UniversalMcpConfig,
} from "../../src/mcp";
import {
  configSnapshot,
  deferred,
  FakeClientFactory,
  FakeMcpClient,
  httpDefinition,
  mcpConfig,
  mcpToolDefinition,
  stdioDefinition,
} from "./fixtures/registry-fixture";

const mcpHttpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

type StdioServerMode =
  | "invalid-result"
  | "legacy"
  | "legacy-version-error"
  | "missing-cache"
  | "modern";

function stdioServerSource(mode: StdioServerMode): string {
  return `
const mode = ${JSON.stringify(mode)};
let buffer = "";
const modernMeta = {
  "io.modelcontextprotocol/serverInfo": { name: mode + "-stdio-server", version: "1.0.0" }
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const complete = (body) => ({ ...body, resultType: "complete", _meta: modernMeta });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "server/discover") {
      if (mode === "legacy") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        continue;
      }
      if (mode === "legacy-version-error") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { requested: "2026-07-28", supported: ["2025-11-25"] }
          }
        });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: complete({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private"
        })
      });
      continue;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy-stdio-server", version: "1.0.0" }
        }
      });
      continue;
    }
    if (message.method === "notifications/initialized") continue;
    if (message.method === "tools/list") {
      const result = {
        tools: [{ name: mode + "-stdio-tool", inputSchema: { type: "object" } }],
        ...(mode === "legacy" || mode === "legacy-version-error" || mode === "missing-cache"
          ? {}
          : { ttlMs: 0, cacheScope: "private" })
      };
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: mode === "legacy" || mode === "legacy-version-error" ? result : complete(result)
      });
      continue;
    }
    if (message.method === "tools/call") {
      const result = { content: [{ type: "text", text: mode + " stdio call" }] };
      const responseResult = mode === "legacy" || mode === "legacy-version-error"
        ? result
        : mode === "invalid-result"
          ? { ...result, resultType: "task", _meta: modernMeta }
          : complete(result);
      send({ jsonrpc: "2.0", id: message.id, result: responseResult });
    }
  }
});
`;
}

function realStdioDefinition(id: string, mode: StdioServerMode) {
  return {
    id,
    allowSubagents: false,
    transportConfig: {
      transport: "stdio" as const,
      command: process.execPath,
      args: ["-e", stdioServerSource(mode)],
      env: {},
    },
  };
}

async function reloadRegistry(registry: McpRegistry, serverId?: string) {
  const result = await registry.reload(serverId);
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

function fakeAuthProvider(tokens: OAuthTokens | undefined): OAuthClientProvider {
  return {
    tokens: async () => tokens,
    saveTokens: async () => undefined,
    redirectToAuthorization: () => undefined,
    saveCodeVerifier: () => undefined,
    codeVerifier: () => "verifier",
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
    clientInformation: async () => undefined,
  };
}

function reportUnexpectedFatalError(error: Error): never {
  throw error;
}

describe("McpRegistry startup and discovery", () => {
  it("initializes empty and retains a safe diagnostic when startup config is malformed", async () => {
    let createCount = 0;
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => {
          return Result.err(
            new McpConfigError({
              configPath: "/data/mcp-config.yaml",
              issues: ["<root>: failed to parse YAML: Unexpected token"],
            }),
          );
        },
        createClient: async () => {
          createCount += 1;
          return new FakeMcpClient();
        },
      },
    });

    await expect(registry.init()).resolves.toBeUndefined();
    await expect(registry.waitUntilInitialized()).resolves.toEqual(Result.ok(undefined));
    expect(registry.list()).toEqual([]);
    expect(registry.getTools()).toEqual([]);
    expect(registry.getConfigStatus()).toEqual({
      status: "invalid",
      error:
        'Invalid MCP configuration at "/data/mcp-config.yaml": <root>: failed to parse YAML: Unexpected token Fix the file, then run mcp.reload.',
    });
    expect(createCount).toBe(0);
    await registry.shutdown();
  });

  it("reads the configured path and attempts every server in parallel", async () => {
    const firstGate = deferred<McpRegistryClient>();
    const secondGate = deferred<McpRegistryClient>();
    const bothStarted = deferred<void>();
    const started: string[] = [];
    const readPaths: string[] = [];
    const first = new FakeMcpClient();
    const second = new FakeMcpClient();
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async (configPath) => {
          readPaths.push(configPath);
          return configSnapshot(mcpConfig([stdioDefinition("first"), httpDefinition("second")]));
        },
        createClient: async (config) => {
          const id = config.clientName?.replace("lilac-mcp-", "") ?? "";
          started.push(id);
          if (started.length === 2) bothStarted.resolve();
          return id === "first" ? firstGate.promise : secondGate.promise;
        },
      },
    });

    const initializing = registry.init();
    await bothStarted.promise;
    let initializationBarrierResolved = false;
    const initializationBarrier = registry.waitUntilInitialized().then(() => {
      initializationBarrierResolved = true;
    });
    await Promise.resolve();
    expect(initializationBarrierResolved).toBe(false);
    expect(started.sort()).toEqual(["first", "second"]);
    firstGate.resolve(first);
    secondGate.resolve(second);
    await initializing;
    await initializationBarrier;

    expect(readPaths).toEqual(["/data/mcp-config.yaml"]);
    expect(registry.list().map((status) => status.status)).toEqual(["available", "available"]);
    await registry.shutdown();
  });

  it("propagates Panic from value-source resolution", async () => {
    const panic = new Panic({ message: "value-source invariant failed" });
    const baseDefinition = stdioDefinition("panic");
    const definition = {
      ...baseDefinition,
      transportConfig: {
        ...baseDefinition.transportConfig,
        env: { TOKEN: { file: "token.txt" } },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      readTextFile: () => Promise.reject(panic),
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([definition])),
      },
    });

    await expect(registry.init()).rejects.toBe(panic);
  });

  it("initiates client cleanup before propagating a discovery Panic", async () => {
    const panic = new Panic({ message: "discovery invariant failed" });
    const client = new FakeMcpClient();
    client.listTools = async () => {
      throw panic;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("panic")])),
        createClient: async () => client,
      },
    });

    await expect(registry.init()).rejects.toBe(panic);
    expect(client.closeCount).toBe(1);
  });

  it("uses SDK HTTP and stdio transports, resolved values, and maxRetries zero", async () => {
    const factory = new FakeClientFactory();
    const local = new FakeMcpClient();
    const remote = new FakeMcpClient();
    factory.enqueue("local", local);
    factory.enqueue("remote", remote);
    const config: UniversalMcpConfig = mcpConfig([
      {
        id: "local",
        allowSubagents: false,
        transportConfig: {
          transport: "stdio",
          command: "bun",
          args: ["server.ts"],
          env: { TOKEN: { env: "STDIO_TOKEN" } },
        },
      },
      {
        id: "remote",
        allowSubagents: false,
        transportConfig: {
          transport: "http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: { env: "HTTP_TOKEN" } },
        },
      },
    ]);
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      env: { STDIO_TOKEN: "stdio-secret", HTTP_TOKEN: "Bearer http-secret" },
      dependencies: {
        readConfig: async () => configSnapshot(config),
        createClient: factory.create,
      },
    });

    await registry.init();
    expect(factory.configs).toHaveLength(2);
    expect(factory.configs.every((clientConfig) => clientConfig.maxRetries === 0)).toBe(true);
    expect(
      factory.configs.every((clientConfig) => clientConfig.protocolVersionDiscovery === true),
    ).toBe(true);
    const localConfig = factory.configs.find((value) => value.clientName === "lilac-mcp-local");
    const remoteConfig = factory.configs.find((value) => value.clientName === "lilac-mcp-remote");
    expect(localConfig?.transport).toMatchObject({ supportsProtocolVersionDiscovery: true });
    expect(remoteConfig?.transport).toMatchObject({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer http-secret" },
      onSessionExpired: expect.any(Function),
    });
    await registry.shutdown();
  });

  it("uses stateless 2026-07-28 discovery and request headers over HTTP", async () => {
    const requests: Array<{
      readonly headers: Headers;
      readonly message: z.infer<typeof mcpHttpRequestSchema>;
    }> = [];
    let getCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") {
          getCount += 1;
          return new Response(null, { status: 405 });
        }

        const message = mcpHttpRequestSchema.parse(await request.json());
        requests.push({ headers: new Headers(request.headers), message });
        const response = (result: Record<string, unknown>) =>
          Response.json({ jsonrpc: "2.0", id: message.id, result });
        const complete = (result: Record<string, unknown>) => ({
          ...result,
          resultType: "complete",
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "modern-http-server",
              version: "1.0.0",
            },
          },
        });

        if (message.method === "server/discover") {
          return response(
            complete({
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              ttlMs: 0,
              cacheScope: "private",
            }),
          );
        }
        if (message.method === "tools/list") {
          return response(
            complete({
              tools: [{ name: "modern-http-tool", inputSchema: { type: "object" } }],
              ttlMs: 0,
              cacheScope: "private",
            }),
          );
        }
        if (message.method === "tools/call") {
          return response(complete({ content: [{ type: "text", text: "modern http call" }] }));
        }
        return response(complete({}));
      },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([httpDefinition("modern-http", server.url.toString())])),
      },
    });

    try {
      await registry.init();
      const execute = registry.getTools()[0]?.tool.execute;
      if (!execute) throw new Error("Expected modern HTTP tool");
      await expect(
        execute({}, { toolCallId: "modern-http-call", messages: [], context: {} }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "modern http call" }] });

      expect(requests.map(({ message }) => message.method)).toEqual([
        "server/discover",
        "tools/list",
        "tools/call",
      ]);
      expect(getCount).toBe(0);
      for (const { headers, message } of requests) {
        expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
        expect(headers.get("mcp-method")).toBe(message.method);
        expect(message.params?._meta).toMatchObject({
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "lilac-mcp-modern-http",
          },
        });
      }
      expect(requests[0]?.headers.get("mcp-name")).toBeNull();
      expect(requests[1]?.headers.get("mcp-name")).toBeNull();
      expect(requests[2]?.headers.get("mcp-name")).toBe("modern-http-tool");
    } finally {
      await registry.shutdown();
      server.stop(true);
    }
  });

  it("does not fall back after a malformed modern discovery result", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response(null, { status: 405 });
        const message = mcpHttpRequestSchema.parse(await request.json());
        methods.push(message.method);
        if (message.method === "server/discover") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              capabilities: { tools: {} },
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-server", version: "1.0.0" },
          },
        });
      },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([httpDefinition("bad-discovery", server.url.toString())])),
      },
    });

    try {
      await registry.init();

      expect(methods).toEqual(["server/discover"]);
      expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });
      expect(registry.getTools()).toEqual([]);
    } finally {
      await registry.shutdown();
      server.stop(true);
    }
  });

  for (const downgrade of [
    "unsupported-version-error",
    "legacy-discover-result",
    "method-not-found",
    "unknown-json-rpc-error",
  ] as const) {
    const responseKind = {
      "unsupported-version-error": "a structured unsupported-version error",
      "legacy-discover-result": "a legacy-only discovery result",
      "method-not-found": "an HTTP method-not-found response",
      "unknown-json-rpc-error": "an unknown HTTP JSON-RPC error",
    }[downgrade];
    it(`falls back after ${responseKind}`, async () => {
      const methods: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method === "GET") return new Response(null, { status: 405 });
          const message = mcpHttpRequestSchema.parse(await request.json());
          methods.push(message.method);
          if (message.method === "server/discover") {
            if (downgrade === "legacy-discover-result") {
              return Response.json({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  resultType: "complete",
                  supportedVersions: ["2025-11-25"],
                  capabilities: { tools: {} },
                  ttlMs: 0,
                  cacheScope: "private",
                },
              });
            }
            if (downgrade === "method-not-found") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Method not found" },
                },
                { status: 404 },
              );
            }
            if (downgrade === "unknown-json-rpc-error") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32000, message: "Server not initialized" },
                },
                { status: 400 },
              );
            }
            return Response.json(
              {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: -32022,
                  message: "Unsupported protocol version",
                  data: { requested: "2026-07-28", supported: ["2025-11-25"] },
                },
              },
              { status: 400 },
            );
          }
          if (message.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "legacy-version-server", version: "1.0.0" },
              },
            });
          }
          if (message.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [{ name: "legacy-version-tool", inputSchema: { type: "object" } }],
              },
            });
          }
          return new Response(null, { status: 202 });
        },
      });
      const registry = new McpRegistry({
        configPath: "/data/mcp-config.yaml",
        reportFatalError: reportUnexpectedFatalError,
        dependencies: {
          readConfig: async () =>
            configSnapshot(mcpConfig([httpDefinition("legacy-version", server.url.toString())])),
        },
      });

      try {
        await registry.init();

        expect(methods).toEqual([
          "server/discover",
          "initialize",
          "notifications/initialized",
          "tools/list",
        ]);
        expect(registry.list()).toEqual([
          { serverId: "legacy-version", transport: "http", status: "available", toolCount: 1 },
        ]);
      } finally {
        await registry.shutdown();
        server.stop(true);
      }
    });
  }

  it("does not fall back when modern discovery returns an empty accepted response", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const message = mcpHttpRequestSchema.parse(await request.json());
        methods.push(message.method);
        if (message.method === "server/discover") {
          return new Response(null, { status: 202 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-server", version: "1.0.0" },
          },
        });
      },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([httpDefinition("empty-discovery", server.url.toString())])),
      },
    });

    try {
      await registry.init();

      expect(methods).toEqual(["server/discover"]);
      expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });
      expect(registry.getTools()).toEqual([]);
    } finally {
      await registry.shutdown();
      server.stop(true);
    }
  });

  for (const failure of [
    "http",
    "http-json-success",
    "http-method-not-found",
    "modern-protocol-error",
  ] as const) {
    it(`does not fall back after a modern discovery ${failure} failure`, async () => {
      const methods: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const message = mcpHttpRequestSchema.parse(await request.json());
          methods.push(message.method);
          if (message.method === "server/discover") {
            if (failure === "http") return new Response("unavailable", { status: 503 });
            if (failure === "http-method-not-found") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Method not found" },
                },
                { status: 503 },
              );
            }
            if (failure === "http-json-success") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    resultType: "complete",
                    supportedVersions: ["2026-07-28"],
                    capabilities: { tools: {} },
                    ttlMs: 0,
                    cacheScope: "private",
                  },
                },
                { status: 503 },
              );
            }
            return Response.json(
              {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32020, message: "Modern request header mismatch" },
              },
              { status: 400 },
            );
          }
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-server", version: "1.0.0" },
            },
          });
        },
      });
      const registry = new McpRegistry({
        configPath: "/data/mcp-config.yaml",
        reportFatalError: reportUnexpectedFatalError,
        dependencies: {
          readConfig: async () =>
            configSnapshot(mcpConfig([httpDefinition(`failed-${failure}`, server.url.toString())])),
        },
      });

      try {
        await registry.init();

        expect(methods).toEqual(["server/discover"]);
        expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });
        expect(registry.getTools()).toEqual([]);
      } finally {
        await registry.shutdown();
        server.stop(true);
      }
    });
  }

  it("preserves a Panic from OAuth recovery during modern discovery", async () => {
    const panic = new Panic({ message: "OAuth recovery invariant failed" });
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response("not found", { status: 404 });
        const message = mcpHttpRequestSchema.parse(await request.json());
        methods.push(message.method);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          },
          { status: 401 },
        );
      },
    });
    const definition = {
      id: "oauth-panic",
      allowSubagents: false,
      transportConfig: {
        transport: "http" as const,
        url: server.url.toString(),
        headers: {},
        auth: {
          type: "oauth" as const,
          grant: "authorization_code" as const,
          client: { type: "dynamic" as const },
        },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([definition])),
        createAuthProvider: async () => ({
          ...fakeAuthProvider({ access_token: "stale-token", token_type: "Bearer" }),
          validateAuthorizationServerURL: () => {
            throw panic;
          },
        }),
      },
    });

    try {
      await expect(registry.init()).rejects.toBe(panic);
      expect(methods).toEqual(["server/discover"]);
    } finally {
      await registry.shutdown();
      server.stop(true);
    }
  });

  for (const invalidResultType of [undefined, "task"] as const) {
    const expectation = invalidResultType === undefined ? "omits" : "uses an unsupported";
    it(`fails closed when a modern tools/list result ${expectation} resultType`, async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const message = mcpHttpRequestSchema.parse(await request.json());
          const response = (result: Record<string, unknown>) =>
            Response.json({ jsonrpc: "2.0", id: message.id, result });

          if (message.method === "server/discover") {
            return response({
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "private",
              _meta: {
                "io.modelcontextprotocol/serverInfo": {
                  name: "modern-http-server",
                  version: "1.0.0",
                },
              },
            });
          }

          return response({
            tools: [],
            ...(invalidResultType === undefined ? {} : { resultType: invalidResultType }),
          });
        },
      });
      const registry = new McpRegistry({
        configPath: "/data/mcp-config.yaml",
        reportFatalError: reportUnexpectedFatalError,
        dependencies: {
          readConfig: async () =>
            configSnapshot(mcpConfig([httpDefinition("bad-modern", server.url.toString())])),
        },
      });

      try {
        await registry.init();

        expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "discovery" });
        expect(registry.getTools()).toEqual([]);
      } finally {
        await registry.shutdown();
        server.stop(true);
      }
    });
  }

  for (const mode of ["modern", "legacy", "legacy-version-error"] as const) {
    it(`negotiates ${mode} MCP tools over stdio`, async () => {
      const serverId = `${mode}-stdio`;
      const registry = new McpRegistry({
        configPath: "/data/mcp-config.yaml",
        reportFatalError: reportUnexpectedFatalError,
        dependencies: {
          readConfig: async () => configSnapshot(mcpConfig([realStdioDefinition(serverId, mode)])),
        },
      });

      await registry.init();
      const execute = registry.getTools()[0]?.tool.execute;
      if (!execute) throw new Error(`Expected ${mode} stdio tool`);
      await expect(
        execute({}, { toolCallId: `${mode}-stdio-call`, messages: [], context: {} }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: `${mode} stdio call` }] });
      expect(registry.list()).toEqual([
        { serverId, transport: "stdio", status: "available", toolCount: 1 },
      ]);
      await registry.shutdown();
    });
  }

  it("fails closed when a modern tools/list stdio result omits cache metadata", async () => {
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([realStdioDefinition("missing-cache-stdio", "missing-cache")])),
      },
    });

    await registry.init();
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "discovery" });
    expect(registry.getTools()).toEqual([]);
    await registry.shutdown();
  });

  it("rejects an unsupported modern result type over stdio without retiring the server", async () => {
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(
            mcpConfig([realStdioDefinition("invalid-result-stdio", "invalid-result")]),
          ),
      },
    });

    await registry.init();
    const execute = registry.getTools()[0]?.tool.execute;
    if (!execute) throw new Error("Expected invalid-result stdio tool");
    await expect(
      execute({}, { toolCallId: "invalid-result-call", messages: [], context: {} }),
    ).rejects.toThrow('Unsupported modern MCP resultType "task"');
    expect(registry.list()[0]).toMatchObject({ status: "available", toolCount: 1 });
    expect(registry.getTools()).toHaveLength(1);
    await registry.shutdown();
  });

  it("keeps native HTTP available when the optional inbound SSE stream is unavailable", async () => {
    const inboundError = deferred<unknown>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") {
          return new Response("Session not found", { status: 404 });
        }

        const message = mcpHttpRequestSchema.parse(await request.json());
        if (message.method === "server/discover" && message.id !== undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        if (message.method === "initialize" && message.id !== undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "native-http-test", version: "1.0.0" },
            },
          });
        }
        if (message.method === "tools/list" && message.id !== undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "native-http-tool", inputSchema: { type: "object" } }],
            },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([httpDefinition("native-http", server.url.toString())])),
        createClient: async (config) =>
          createMCPClient({
            ...config,
            onUncaughtError: (error) => {
              inboundError.resolve(error);
              config.onUncaughtError?.(error);
            },
          }),
      },
    });

    try {
      const initializing = registry.init();
      await expect(inboundError.promise).resolves.toMatchObject({
        name: "MCPClientError",
        message: "MCP HTTP Transport Error: GET SSE failed: 404 Not Found",
        statusCode: 404,
        url: server.url.toString(),
      });
      await initializing;

      expect(registry.list()).toEqual([
        {
          serverId: "native-http",
          transport: "http",
          status: "available",
          toolCount: 1,
        },
      ]);
      expect(registry.getTools().map((tool) => tool.rawName)).toEqual(["native-http-tool"]);
    } finally {
      await registry.shutdown();
      server.stop(true);
    }
  });

  it("retires native HTTP when an established session expires on the inbound stream", async () => {
    const sessionGetStarted = deferred<void>();
    const releaseSessionGet = deferred<void>();
    const sessionExpiredError = deferred<unknown>();
    const sessionId = "native-http-session";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") {
          if (request.headers.get("mcp-session-id") !== sessionId) {
            return new Response(null, { status: 405 });
          }
          sessionGetStarted.resolve();
          await releaseSessionGet.promise;
          return new Response("Session not found", { status: 404 });
        }

        const message = mcpHttpRequestSchema.parse(await request.json());
        if (message.method === "server/discover" && message.id !== undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        if (message.method === "initialize" && message.id !== undefined) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "native-http-session-test", version: "1.0.0" },
              },
            },
            { headers: { "mcp-session-id": sessionId } },
          );
        }
        if (message.method === "tools/list" && message.id !== undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "stateful-http-tool", inputSchema: { type: "object" } }],
            },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([httpDefinition("stateful-http", server.url.toString())])),
        createClient: async (config) =>
          createMCPClient({
            ...config,
            onUncaughtError: (error) => {
              sessionExpiredError.resolve(error);
              config.onUncaughtError?.(error);
            },
          }),
      },
    });

    try {
      await registry.init();
      await sessionGetStarted.promise;
      expect(registry.list()[0]).toMatchObject({ status: "available", toolCount: 1 });

      releaseSessionGet.resolve();
      await expect(sessionExpiredError.promise).resolves.toMatchObject({
        name: "MCPClientError",
        message: "MCP HTTP Transport Error: GET SSE failed: 404 Not Found",
        statusCode: 404,
        url: server.url.toString(),
      });
      expect(registry.list()[0]).toMatchObject({
        serverId: "stateful-http",
        status: "unavailable",
        phase: "runtime",
      });
      expect(registry.getTools()).toEqual([]);
    } finally {
      releaseSessionGet.resolve();
      await registry.shutdown();
      server.stop(true);
    }
  });

  it("injects resolved transport and auth-provider dependencies", async () => {
    const transportInputs: McpRegistryTransportInput[] = [];
    let authProviderCalls = 0;
    let tokenCalls = 0;
    let clientCalls = 0;
    const authServer = {
      id: "auth",
      allowSubagents: false,
      transportConfig: {
        transport: "http" as const,
        url: "https://example.invalid/mcp",
        headers: {},
        auth: {
          type: "oauth" as const,
          grant: "authorization_code" as const,
          client: { type: "dynamic" as const },
        },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([authServer])),
        createAuthProvider: async () => {
          authProviderCalls += 1;
          const provider = fakeAuthProvider(undefined);
          return {
            ...provider,
            tokens: async () => {
              tokenCalls += 1;
              return undefined;
            },
          };
        },
        createTransport: (input) => {
          transportInputs.push(input);
          return { type: "http", url: "https://unused.invalid" };
        },
        createClient: async () => {
          clientCalls += 1;
          return new FakeMcpClient();
        },
      },
    });

    await registry.init();
    expect(authProviderCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(transportInputs).toEqual([]);
    expect(clientCalls).toBe(0);
    expect(registry.list()[0]).toMatchObject({
      status: "authentication_required",
      phase: "configuration",
      error: 'MCP server "auth" requires authentication',
    });
    await registry.shutdown();
  });

  it("returns auth adapter failures as retained outcomes and propagates Panic", async () => {
    type AuthState =
      | "authorized"
      | "provider_absent"
      | "tokens_absent"
      | "provider_error"
      | "tokens_error"
      | "provider_hostile"
      | "provider_panic"
      | "tokens_panic";
    let authState: AuthState = "authorized";
    const panic = new Panic({ message: "auth invariant failed" });
    const secretSentinel = "auth-cause-secret-sentinel";
    const hostileCause = {
      toString: () => {
        throw new Error("must not coerce rejection");
      },
      [Symbol.toPrimitive]: () => {
        throw new Error("must not coerce rejection");
      },
    };
    const client = new FakeMcpClient();
    const authServer = {
      id: "auth",
      allowSubagents: false,
      transportConfig: {
        transport: "http" as const,
        url: "https://example.invalid/mcp",
        headers: {},
        auth: {
          type: "oauth" as const,
          grant: "authorization_code" as const,
          client: { type: "dynamic" as const },
        },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([authServer])),
        createAuthProvider: async () => {
          if (authState === "provider_absent") return undefined;
          if (authState === "provider_error") {
            throw new Error(`provider resolution failed ${secretSentinel}`);
          }
          if (authState === "provider_hostile") throw hostileCause;
          if (authState === "provider_panic") throw panic;
          const provider = fakeAuthProvider(undefined);
          return {
            ...provider,
            tokens: async () => {
              if (authState === "tokens_error") {
                throw new Error(`token resolution failed ${secretSentinel}`);
              }
              if (authState === "tokens_panic") throw panic;
              return authState === "authorized"
                ? { access_token: "access-token", token_type: "Bearer" }
                : undefined;
            },
          };
        },
        createClient: async () => client,
      },
    });
    await registry.init();
    const retainedStatus = registry.list()[0];

    authState = "provider_absent";
    expect(await reloadRegistry(registry, "auth")).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "retained",
        error: 'MCP server "auth" requires authentication',
      },
    ]);

    authState = "tokens_absent";
    expect(await reloadRegistry(registry, "auth")).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "retained",
        error: 'MCP server "auth" requires authentication',
      },
    ]);

    authState = "provider_error";
    const providerFailureOutcome = await reloadRegistry(registry, "auth");
    expect(providerFailureOutcome).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "retained",
        error: 'Failed to create OAuth provider for MCP server "auth"',
      },
    ]);
    expect(JSON.stringify(providerFailureOutcome)).not.toContain(secretSentinel);

    authState = "tokens_error";
    const tokenFailureOutcome = await reloadRegistry(registry, "auth");
    expect(tokenFailureOutcome).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "retained",
        error: 'Failed to read OAuth tokens for MCP server "auth"',
      },
    ]);
    expect(JSON.stringify(tokenFailureOutcome)).not.toContain(secretSentinel);

    authState = "provider_hostile";
    expect(await reloadRegistry(registry, "auth")).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "retained",
        error: 'Failed to create OAuth provider for MCP server "auth"',
      },
    ]);

    authState = "provider_panic";
    await expect(registry.reload("auth")).rejects.toBeInstanceOf(Panic);
    authState = "tokens_panic";
    await expect(registry.reload("auth")).rejects.toBeInstanceOf(Panic);
    expect(registry.list()[0]).toBe(retainedStatus);
    expect(client.closeCount).toBe(0);
    await registry.shutdown();

    const failedRegistry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([authServer])),
        createAuthProvider: async () => {
          throw new Error(`provider initialization failed ${secretSentinel}`);
        },
      },
    });
    await failedRegistry.init();
    expect(failedRegistry.list()[0]).toMatchObject({
      status: "unavailable",
      phase: "configuration",
      error: 'Failed to create OAuth provider for MCP server "auth"',
    });
    expect(JSON.stringify(failedRegistry.list())).not.toContain(secretSentinel);
    await failedRegistry.shutdown();
  });

  it("passes stored authorization-code tokens to the SDK so it can refresh them", async () => {
    const client = new FakeMcpClient();
    const tokens = {
      access_token: "expired-access-token",
      token_type: "Bearer",
      expires_in: 0,
      refresh_token: "refresh-token",
    } satisfies OAuthTokens;
    const provider = fakeAuthProvider(tokens);
    let transportInput: McpRegistryTransportInput | undefined;
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(
            mcpConfig([
              {
                id: "auth",
                allowSubagents: false,
                transportConfig: {
                  transport: "http",
                  url: "https://example.invalid/mcp",
                  headers: {},
                  auth: {
                    type: "oauth",
                    grant: "authorization_code",
                    client: { type: "dynamic" },
                  },
                },
              },
            ]),
          ),
        createAuthProvider: async () => provider,
        createTransport: (input) => {
          transportInput = input;
          return { type: "http", url: "https://unused.invalid" };
        },
        createClient: async () => client,
      },
    });

    await registry.init();
    expect(transportInput).toMatchObject({ transport: "http", authProvider: provider });
    expect(registry.list()[0]).toMatchObject({ status: "available" });
    await registry.shutdown();
  });

  it("collects complete large manifests and publishes immutable rich catalog records", async () => {
    const definitions = Array.from({ length: 2_001 }, (_, index) =>
      mcpToolDefinition(
        `tool-${index}`,
        index === 2_000 ? { title: "Final title", description: "x".repeat(4_096) } : {},
      ),
    );
    const client = new FakeMcpClient({
      first: { tools: definitions.slice(0, 1_000), nextCursor: "page-2" },
      "page-2": { tools: definitions.slice(1_000, 2_000), nextCursor: "page-3" },
      "page-3": { tools: definitions.slice(2_000) },
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("large")])),
        createClient: async () => client,
      },
    });

    await registry.init();
    const statuses = registry.list();
    const tools = registry.getTools();
    expect(client.cursors).toEqual([undefined, "page-2", "page-3"]);
    expect(client.convertedDefinitions[0]?.tools).toHaveLength(2_001);
    expect(statuses).toEqual([
      { serverId: "large", transport: "stdio", status: "available", toolCount: 2_001 },
    ]);
    expect(tools).toHaveLength(2_001);
    expect(tools[2_000]).toMatchObject({
      serverId: "large",
      rawName: "tool-2000",
      title: "Final title",
      description: "x".repeat(4_096),
      identity: { source: "mcp", sourceId: "large", rawToolName: "tool-2000" },
    });
    expect(tools[2_000]?.stableId).toContain('"mcp","large","tool-2000"');
    expect(typeof tools[2_000]?.tool.execute).toBe("function");
    expect(Object.isFrozen(statuses)).toBe(true);
    expect(Object.isFrozen(statuses[0])).toBe(true);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(tools[2_000])).toBe(true);
    expect("modelName" in (tools[2_000] ?? {})).toBe(false);
    expect(registry.getTools()).toBe(tools);
    await registry.shutdown();
  });

  it("retains serverInfo and resolves configured descriptions before advertised descriptions", async () => {
    const configuredDefinition = {
      ...stdioDefinition("configured"),
      description: "Configured catalog description.",
    };
    const advertisedDefinition = stdioDefinition("advertised");
    let config = mcpConfig([configuredDefinition, advertisedDefinition]);
    const clients = new Map([
      [
        "configured",
        new FakeMcpClient(
          { first: { tools: [mcpToolDefinition("configured-tool")] } },
          {
            name: "configured-server",
            title: "Configured Server",
            version: "1.0.0",
            description: "Advertised description that must lose precedence.",
          },
        ),
      ],
      [
        "advertised",
        new FakeMcpClient(
          { first: { tools: [mcpToolDefinition("advertised-tool")] } },
          {
            name: "advertised-server",
            version: "2.0.0",
            description: "Advertised catalog description.",
          },
        ),
      ],
    ]);
    let createCount = 0;
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(config),
        createClient: async (clientConfig) => {
          createCount += 1;
          const serverId = clientConfig.clientName?.replace(/^lilac-mcp-/, "") ?? "";
          const client = clients.get(serverId);
          if (!client) throw new Error(`Missing client for ${serverId}`);
          return client;
        },
      },
    });

    await registry.init();
    const initial = registry.getCatalogServers();
    expect(initial).toEqual([
      {
        serverId: "advertised",
        allowSubagents: false,
        serverInfo: {
          name: "advertised-server",
          version: "2.0.0",
          description: "Advertised catalog description.",
        },
        description: "Advertised catalog description.",
      },
      {
        serverId: "configured",
        allowSubagents: false,
        serverInfo: {
          name: "configured-server",
          title: "Configured Server",
          version: "1.0.0",
          description: "Advertised description that must lose precedence.",
        },
        description: "Configured catalog description.",
      },
    ]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial[0])).toBe(true);
    expect(Object.isFrozen(initial[0]?.serverInfo)).toBe(true);

    config = mcpConfig([
      { ...configuredDefinition, description: "Updated configured description." },
      advertisedDefinition,
    ]);
    expect(await reloadRegistry(registry, "configured")).toEqual([
      { serverId: "configured", reconciliation: "unchanged", result: "available" },
    ]);
    expect(createCount).toBe(2);
    expect(registry.getCatalogServers()[1]?.description).toBe("Updated configured description.");
    await registry.shutdown();
  });

  it("rejects malformed advertised serverInfo before publishing catalog metadata", async () => {
    const client = new FakeMcpClient(
      { first: { tools: [mcpToolDefinition("must-not-be-discovered")] } },
      {
        name: "malformed-server",
        version: "1.0.0",
        description: 123,
      },
    );
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("malformed")])),
        createClient: async () => client,
      },
    });

    await registry.init();
    expect(registry.list()).toEqual([
      {
        serverId: "malformed",
        transport: "stdio",
        status: "unavailable",
        phase: "discovery",
        error: expect.stringContaining("Invalid MCP serverInfo"),
      },
    ]);
    expect(registry.getCatalogServers()).toEqual([]);
    expect(registry.getTools()).toEqual([]);
    expect(client.cursors).toEqual([]);
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
  });

  it("returns after discovery failure when once-only client cleanup hangs", async () => {
    const secret = "do-not-leak";
    const closeStarted = deferred<void>();
    const hangingClose = deferred<void>();
    const client = new FakeMcpClient({
      first: { tools: [], nextCursor: secret },
      [secret]: { tools: [], nextCursor: secret },
    });
    client.close = async () => {
      client.closeCount += 1;
      closeStarted.resolve();
      return hangingClose.promise;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("loop")])),
        createClient: async () => client,
      },
    });

    await registry.init();
    await closeStarted.promise;
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "discovery" });
    expect(registry.getTools()).toEqual([]);
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
    expect(client.closeCount).toBe(1);
  });

  it("isolates duplicate raw tool names to the candidate server", async () => {
    const duplicate = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("same"), mcpToolDefinition("same")] },
    });
    const healthy = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("healthy-tool")] },
    });
    const factory = new FakeClientFactory();
    factory.enqueue("duplicate", duplicate);
    factory.enqueue("healthy", healthy);
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(mcpConfig([stdioDefinition("duplicate"), stdioDefinition("healthy")])),
        createClient: factory.create,
      },
    });

    await registry.init();
    expect(registry.list()).toEqual([
      expect.objectContaining({
        serverId: "duplicate",
        status: "unavailable",
        phase: "discovery",
      }),
      { serverId: "healthy", transport: "stdio", status: "available", toolCount: 1 },
    ]);
    expect((registry.list()[0] as { error: string }).error).toContain("duplicate tool name");
    expect(registry.getTools().map((entry) => entry.rawName)).toEqual(["healthy-tool"]);
    expect(duplicate.closeCount).toBe(1);
    expect(healthy.closeCount).toBe(0);
    await registry.shutdown();
  });

  it("applies one fixed deadline across connection and paginated discovery", async () => {
    const secondPageStarted = deferred<void>();
    const never = deferred<never>();
    let deadlineCallback: (() => void) | undefined;
    const client = new FakeMcpClient({ first: { tools: [], nextCursor: "next" } });
    client.listTools = async (options) => {
      if (options?.params?.cursor === "next") {
        secondPageStarted.resolve();
        return never.promise;
      }
      return { tools: [], nextCursor: "next" };
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      initDeadlineMs: 10,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("slow")])),
        createClient: async () => client,
        scheduleDeadline: (callback) => {
          deadlineCallback = callback;
          return () => undefined;
        },
      },
    });

    const initializing = registry.init();
    await secondPageStarted.promise;
    deadlineCallback?.();
    await initializing;
    expect(registry.list()[0]).toMatchObject({
      status: "unavailable",
      phase: "discovery",
    });
    expect((registry.list()[0] as { error: string }).error).toContain("exceeded 10ms");
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
  });

  it("bounds createMCPClient and closes an exposed stalled transport", async () => {
    const createStarted = deferred<void>();
    const never = deferred<McpRegistryClient>();
    let deadlineCallback: (() => void) | undefined;
    let transportCloseCount = 0;
    const hangingClose = deferred<void>();
    const transport: MCPTransport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => {
        transportCloseCount += 1;
        return hangingClose.promise;
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      initDeadlineMs: 25,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("silent")])),
        createTransport: () => transport,
        createClient: async () => {
          createStarted.resolve();
          return never.promise;
        },
        scheduleDeadline: (callback) => {
          deadlineCallback = callback;
          return () => undefined;
        },
      },
    });

    const initializing = registry.init();
    await createStarted.promise;
    deadlineCallback?.();
    await initializing;
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });
    expect(transportCloseCount).toBe(1);
    await registry.shutdown();
    expect(transportCloseCount).toBe(1);
  });

  it("reports a detached transport cleanup Panic with exact identity", async () => {
    const panic = new Panic({ message: "transport cleanup invariant failed" });
    const fatalObserved = deferred<Error>();
    const createStarted = deferred<void>();
    const never = deferred<McpRegistryClient>();
    let deadlineCallback: (() => void) | undefined;
    const transport: MCPTransport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => {
        throw panic;
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      initDeadlineMs: 25,
      reportFatalError: (error) => fatalObserved.resolve(error),
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("panic-cleanup")])),
        createTransport: () => transport,
        createClient: async () => {
          createStarted.resolve();
          return never.promise;
        },
        scheduleDeadline: (callback) => {
          deadlineCallback = callback;
          return () => undefined;
        },
      },
    });

    const initializing = registry.init();
    await createStarted.promise;
    deadlineCallback?.();
    expect(await fatalObserved.promise).toBe(panic);
    await initializing;
  });

  it("closes a client that is created after the deadline exactly once", async () => {
    const createGate = deferred<McpRegistryClient>();
    const createStarted = deferred<void>();
    const closeStarted = deferred<void>();
    const hangingClose = deferred<void>();
    let deadlineCallback: (() => void) | undefined;
    const lateClient = new FakeMcpClient();
    lateClient.close = async () => {
      lateClient.closeCount += 1;
      closeStarted.resolve();
      return hangingClose.promise;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      initDeadlineMs: 10,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("late")])),
        createClient: async () => {
          createStarted.resolve();
          return createGate.promise;
        },
        createTransport: () => ({
          start: async () => undefined,
          send: async () => undefined,
          close: async () => undefined,
        }),
        scheduleDeadline: (callback) => {
          deadlineCallback = callback;
          return () => undefined;
        },
      },
    });

    const initializing = registry.init();
    await createStarted.promise;
    deadlineCallback?.();
    await initializing;
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });

    createGate.resolve(lateClient);
    await closeStarted.promise;
    expect(lateClient.closeCount).toBe(1);
    await registry.shutdown();
    expect(lateClient.closeCount).toBe(1);
  });

  it("bounds hanging shutdown cleanup and completes the lifecycle", async () => {
    const closeStarted = deferred<void>();
    const hangingClose = deferred<void>();
    let captureDeadline: ReturnType<typeof deferred<() => void>> | undefined;
    const client = new FakeMcpClient();
    client.close = async () => {
      client.closeCount += 1;
      closeStarted.resolve();
      return hangingClose.promise;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      initDeadlineMs: 15,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("hanging")])),
        createClient: async () => client,
        scheduleDeadline: (callback) => {
          captureDeadline?.resolve(callback);
          return () => undefined;
        },
      },
    });
    await registry.init();

    captureDeadline = deferred<() => void>();
    const shuttingDown = registry.shutdown();
    await closeStarted.promise;
    const deadlineCallback = await captureDeadline.promise;
    deadlineCallback();
    await expect(shuttingDown).rejects.toThrow(
      'Failed to close MCP clients: hanging: MCP server "hanging" client close exceeded 15ms',
    );
    expect(registry.list()).toEqual([]);
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
    expect(client.closeCount).toBe(1);
    const stopped = await registry.waitUntilInitialized();
    expect(stopped.status).toBe("error");
    if (stopped.status === "error") {
      expect(stopped.error.message).toBe("MCP registry has been shut down");
    }
  });

  it("preserves and reports a client shutdown Panic instead of stringifying it", async () => {
    const panic = new Panic({ message: "client cleanup invariant failed" });
    const reported: Error[] = [];
    const client = new FakeMcpClient();
    client.close = async () => {
      client.closeCount += 1;
      throw panic;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: (error) => reported.push(error),
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("panic-cleanup")])),
        createClient: async () => client,
      },
    });
    await registry.init();

    await expect(registry.shutdown()).rejects.toBe(panic);
    expect(reported).toEqual([panic]);
    expect(client.closeCount).toBe(1);
  });
});

describe("McpRegistry reload and terminal failures", () => {
  it("retains an unchanged server for a transport Err and propagates Panic", async () => {
    const panic = new Panic({ message: "transport resolution invariant failed" });
    let readMode: "ok" | "error" | "panic" = "ok";
    const definition = {
      id: "resolved",
      allowSubagents: false,
      transportConfig: {
        transport: "stdio" as const,
        command: "bun",
        args: [],
        env: { VALUE: { file: "value.txt" } },
      },
    };
    const client = new FakeMcpClient();
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      readTextFile: async () => {
        if (readMode === "panic") throw panic;
        if (readMode === "error") throw new Error("credential file unavailable");
        return "secret";
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([definition])),
        createClient: async () => client,
      },
    });
    await registry.init();
    const retainedStatus = registry.list()[0];

    readMode = "error";
    expect(await reloadRegistry(registry, "resolved")).toEqual([
      {
        serverId: "resolved",
        reconciliation: "unchanged",
        result: "retained",
        error:
          "Failed to resolve stdio environment: VALUE: failed to read value.txt: credential file unavailable",
      },
    ]);
    expect(registry.list()[0]).toBe(retainedStatus);
    expect(client.closeCount).toBe(0);

    readMode = "panic";
    await expect(registry.reload("resolved")).rejects.toBeInstanceOf(Panic);
    expect(registry.list()[0]).toBe(retainedStatus);
    await registry.shutdown();
  });

  it("preserves healthy state on invalid reload and clears the diagnostic after repair", async () => {
    const secret = "config-secret-value";
    const healthyConfig = mcpConfig([stdioDefinition("healthy")]);
    let readResult: "valid" | "invalid" = "valid";
    let createCount = 0;
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("healthy-tool")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => {
          if (readResult === "invalid") {
            return Result.err(
              new McpConfigError({
                configPath: "/data/mcp-config.yaml",
                issues: [
                  `servers.healthy.headers.Authorization: Bearer ${secret}`,
                  "servers.healthy.transport: Invalid option: expected one of stdio|http",
                ],
              }),
            );
          }
          return configSnapshot(healthyConfig);
        },
        createClient: async () => {
          createCount += 1;
          return client;
        },
      },
    });
    await registry.init();
    const retainedStatus = registry.list();
    const retainedTools = registry.getTools();

    readResult = "invalid";
    const invalidReload = await registry.reload();
    expect(invalidReload.status).toBe("error");
    if (invalidReload.status === "error") {
      expect(invalidReload.error.message).toContain("Fix the file, then run mcp.reload");
    }
    expect(registry.list()).toBe(retainedStatus);
    expect(registry.getTools()).toBe(retainedTools);
    const configStatus = registry.getConfigStatus();
    expect(configStatus).toMatchObject({ status: "invalid" });
    if (configStatus.status === "valid") throw new Error("Expected invalid MCP config status");
    expect(configStatus.error).toContain("servers.healthy.transport");
    expect(configStatus.error).not.toContain(secret);
    expect(client.closeCount).toBe(0);
    expect(createCount).toBe(1);

    readResult = "valid";
    expect(await reloadRegistry(registry)).toEqual([
      { serverId: "healthy", reconciliation: "unchanged", result: "available" },
    ]);
    expect(registry.getConfigStatus()).toEqual({ status: "valid" });
    expect(createCount).toBe(1);
    await registry.shutdown();
  });

  it("atomically refreshes an unchanged server manifest on the retained client", async () => {
    const client = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("keep"), mcpToolDefinition("remove")] },
    });
    let createCount = 0;
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("stable")])),
        createClient: async () => {
          createCount += 1;
          return client;
        },
      },
    });
    await registry.init();

    client.setPages({
      first: { tools: [mcpToolDefinition("keep")], nextCursor: "second" },
      second: { tools: [mcpToolDefinition("add")] },
    });
    expect(await reloadRegistry(registry, "stable")).toEqual([
      { serverId: "stable", reconciliation: "unchanged", result: "available" },
    ]);
    expect(registry.getTools().map((entry) => entry.rawName)).toEqual(["keep", "add"]);
    expect(client.convertedDefinitions.at(-1)?.tools.map((tool) => tool.name)).toEqual([
      "keep",
      "add",
    ]);
    expect(createCount).toBe(1);
    expect(client.closeCount).toBe(0);

    const retainedTools = registry.getTools();
    const retainedStatus = registry.list()[0];
    client.setPages({
      first: { tools: [mcpToolDefinition("partial")], nextCursor: "loop" },
      loop: { tools: [mcpToolDefinition("ignored")], nextCursor: "loop" },
    });
    expect(await reloadRegistry(registry, "stable")).toEqual([
      expect.objectContaining({
        serverId: "stable",
        reconciliation: "unchanged",
        result: "retained",
        error: "MCP tools/list returned a repeated cursor",
      }),
    ]);
    expect(registry.getTools()).toEqual(retainedTools);
    expect(registry.getTools()[0]).toBe(retainedTools[0]);
    expect(registry.getTools()[1]).toBe(retainedTools[1]);
    expect(registry.list()[0]).toBe(retainedStatus);
    expect(createCount).toBe(1);
    expect(client.closeCount).toBe(0);

    const toolsBeforePanic = registry.getTools();
    const statusBeforePanic = registry.list()[0];
    const panic = new Panic({ message: "refresh invariant failed" });
    client.listTools = async () => {
      throw panic;
    };
    await expect(registry.reload("stable")).rejects.toBe(panic);
    expect(registry.getTools()).toBe(toolsBeforePanic);
    expect(registry.list()[0]).toBe(statusBeforePanic);
    await registry.shutdown();
  });

  it("replaces a healthy client when a resolved transport value changes", async () => {
    const first = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    const second = new FakeMcpClient({ first: { tools: [mcpToolDefinition("after")] } });
    const clients = [first, second];
    const transportInputs: McpRegistryTransportInput[] = [];
    let secret = "first-secret";
    const definition = {
      id: "resolved",
      allowSubagents: false,
      transportConfig: {
        transport: "stdio" as const,
        command: "bun",
        args: ["server.ts"],
        env: { TOKEN: { file: "secret.txt" } },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      readTextFile: async () => secret,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([definition])),
        createTransport: (input) => {
          transportInputs.push(input);
          return { type: "http", url: "https://unused.invalid" };
        },
        createClient: async () => {
          const client = clients.shift();
          if (!client) throw new Error("Unexpected extra MCP client");
          return client;
        },
      },
    });
    await registry.init();

    secret = "second-secret";
    expect(await reloadRegistry(registry, "resolved")).toEqual([
      { serverId: "resolved", reconciliation: "changed", result: "available" },
    ]);
    expect(transportInputs).toEqual([
      {
        transport: "stdio",
        command: "bun",
        args: ["server.ts"],
        env: { TOKEN: "first-secret" },
      },
      {
        transport: "stdio",
        command: "bun",
        args: ["server.ts"],
        env: { TOKEN: "second-secret" },
      },
    ]);
    expect(registry.getTools().map((tool) => tool.rawName)).toEqual(["after"]);
    expect(first.closeCount).toBe(1);
    await registry.shutdown();
  });

  it("reports unavailable when terminal failure interrupts unchanged refresh", async () => {
    let clientConfig: MCPClientConfig | undefined;
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("stable")])),
        createClient: async (config) => {
          clientConfig = config;
          return client;
        },
      },
    });
    await registry.init();
    client.listTools = async () => {
      clientConfig?.onUncaughtError?.(new Error("refresh transport failed"));
      throw new Error("refresh list rejected");
    };

    expect(await reloadRegistry(registry, "stable")).toEqual([
      {
        serverId: "stable",
        reconciliation: "unchanged",
        result: "unavailable",
        error: "refresh transport failed",
      },
    ]);
    expect(registry.list()[0]).toMatchObject({
      serverId: "stable",
      status: "unavailable",
      phase: "runtime",
      error: "refresh transport failed",
    });
    expect(registry.getTools()).toEqual([]);
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
  });

  it("reports authentication required when runtime OAuth refresh cannot authorize", async () => {
    let clientConfig: MCPClientConfig | undefined;
    const client = new FakeMcpClient();
    const authServer = {
      id: "auth",
      allowSubagents: false,
      transportConfig: {
        transport: "http" as const,
        url: "https://example.invalid/mcp",
        headers: {},
        auth: {
          type: "oauth" as const,
          grant: "authorization_code" as const,
          client: { type: "dynamic" as const },
        },
      },
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([authServer])),
        createAuthProvider: async () =>
          fakeAuthProvider({
            access_token: "expired-access-token",
            token_type: "Bearer",
            refresh_token: "rejected-refresh-token",
          }),
        createTransport: () => ({ type: "http", url: "https://unused.invalid" }),
        createClient: async (config) => {
          clientConfig = config;
          return client;
        },
      },
    });
    await registry.init();
    client.listTools = async () => {
      const error = new UnauthorizedError();
      clientConfig?.onUncaughtError?.(error);
      throw error;
    };

    expect(await reloadRegistry(registry, "auth")).toEqual([
      {
        serverId: "auth",
        reconciliation: "unchanged",
        result: "authentication_required",
        error: "Unauthorized",
      },
    ]);

    expect(registry.list()[0]).toMatchObject({
      serverId: "auth",
      status: "authentication_required",
      phase: "runtime",
    });
    expect(registry.getTools()).toEqual([]);
    await registry.shutdown();
  });

  it("bounds a hanging unavailable-client close before retrying", async () => {
    const closeStarted = deferred<void>();
    const hangingClose = deferred<void>();
    let captureDeadline: ReturnType<typeof deferred<() => void>> | undefined;
    let firstConfig: MCPClientConfig | undefined;
    let createCount = 0;
    const first = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    first.close = async () => {
      first.closeCount += 1;
      closeStarted.resolve();
      return hangingClose.promise;
    };
    const second = new FakeMcpClient({ first: { tools: [mcpToolDefinition("after")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      initDeadlineMs: 20,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("retry")])),
        createClient: async (config) => {
          createCount += 1;
          if (createCount === 1) {
            firstConfig = config;
            return first;
          }
          return second;
        },
        scheduleDeadline: (callback) => {
          captureDeadline?.resolve(callback);
          return () => undefined;
        },
      },
    });
    await registry.init();
    firstConfig?.onUncaughtError?.(new Error("connection lost"));
    await closeStarted.promise;

    captureDeadline = deferred<() => void>();
    const reloading = reloadRegistry(registry, "retry");
    const deadlineCallback = await captureDeadline.promise;
    deadlineCallback();
    expect(await reloading).toEqual([
      {
        serverId: "retry",
        reconciliation: "unavailable",
        result: "available",
        error: 'MCP server "retry" client close exceeded 20ms',
      },
    ]);
    expect(first.closeCount).toBe(1);
    expect(createCount).toBe(2);
    expect(registry.getTools()[0]?.rawName).toBe("after");
    await registry.shutdown();
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });

  it("returns not_found for an unknown targeted reload", async () => {
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([])),
      },
    });
    await registry.init();

    expect(await reloadRegistry(registry, "absent")).toEqual([
      { serverId: "absent", reconciliation: "not_found", result: "not_found" },
    ]);
    await registry.shutdown();
  });

  it("reconciles every state and retains a healthy client after failed replacement", async () => {
    let config = mcpConfig([
      stdioDefinition("changed", "old-command"),
      stdioDefinition("missing"),
      stdioDefinition("removed"),
      stdioDefinition("stable"),
    ]);
    const factory = new FakeClientFactory();
    const changedOld = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("old-tool")] },
    });
    const unavailableFailure = new Error("initial failure");
    const removed = new FakeMcpClient();
    const stable = new FakeMcpClient();
    factory.enqueue("changed", changedOld);
    factory.enqueue("missing", unavailableFailure);
    factory.enqueue("removed", removed);
    factory.enqueue("stable", stable);
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(config),
        createClient: factory.create,
      },
    });
    await registry.init();

    const failedReplacement = new FakeMcpClient({
      first: { tools: [], nextCursor: "same" },
      same: { tools: [], nextCursor: "same" },
    });
    const recovered = new FakeMcpClient({ first: { tools: [mcpToolDefinition("recovered")] } });
    const added = new FakeMcpClient({ first: { tools: [mcpToolDefinition("added")] } });
    factory.enqueue("changed", failedReplacement);
    factory.enqueue("missing", recovered);
    factory.enqueue("new", added);
    config = mcpConfig([
      stdioDefinition("changed", "new-command"),
      stdioDefinition("missing"),
      httpDefinition("new"),
      stdioDefinition("stable"),
    ]);

    const outcomes = await reloadRegistry(registry);
    expect(outcomes).toEqual([
      expect.objectContaining({
        serverId: "changed",
        reconciliation: "changed",
        result: "retained",
      }),
      { serverId: "missing", reconciliation: "unavailable", result: "available" },
      { serverId: "new", reconciliation: "new", result: "available" },
      { serverId: "removed", reconciliation: "removed", result: "removed" },
      { serverId: "stable", reconciliation: "unchanged", result: "available" },
    ]);
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(changedOld.closeCount).toBe(0);
    expect(failedReplacement.closeCount).toBe(1);
    expect(removed.closeCount).toBe(1);
    expect(registry.getTools().some((entry) => entry.rawName === "old-tool")).toBe(true);
    expect(factory.configs.filter((value) => value.clientName === "lilac-mcp-stable")).toHaveLength(
      1,
    );

    const changedNew = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("replacement-tool")] },
    });
    factory.enqueue("changed", changedNew);
    expect(await reloadRegistry(registry, "changed")).toEqual([
      { serverId: "changed", reconciliation: "changed", result: "available" },
    ]);
    expect(changedOld.closeCount).toBe(1);
    expect(registry.getTools().some((entry) => entry.rawName === "replacement-tool")).toBe(true);

    await registry.shutdown();
    await registry.shutdown();
    for (const client of [
      changedOld,
      failedReplacement,
      removed,
      stable,
      recovered,
      added,
      changedNew,
    ]) {
      expect(client.closeCount).toBeLessThanOrEqual(1);
    }
    expect(stable.closeCount).toBe(1);
    expect(recovered.closeCount).toBe(1);
    expect(added.closeCount).toBe(1);
    expect(changedNew.closeCount).toBe(1);
  });

  it("chains actual transport close and invalidates only the identity-matched entry", async () => {
    let sdkCloseCount = 0;
    let transport: MCPTransport | undefined;
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("local")])),
        createTransport: () => {
          transport = {
            start: async () => undefined,
            send: async () => undefined,
            close: async () => undefined,
          };
          return transport;
        },
        createClient: async (config) => {
          if ("start" in config.transport) {
            config.transport.onclose = () => {
              sdkCloseCount += 1;
            };
          }
          return client;
        },
      },
    });

    await registry.init();
    transport?.onclose?.();
    expect(sdkCloseCount).toBe(1);
    expect(registry.getTools()).toEqual([]);
    expect(registry.list()[0]).toMatchObject({
      serverId: "local",
      status: "unavailable",
      phase: "runtime",
      error: "MCP transport closed",
    });
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
    expect(client.closeCount).toBe(1);
  });

  it("reports a cached terminal cleanup Panic once and preserves it through shutdown", async () => {
    const panic = new Panic({ message: "terminal cleanup invariant failed" });
    const reported = Promise.withResolvers<void>();
    const reports: Error[] = [];
    let clientConfig: MCPClientConfig | undefined;
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    client.close = async () => {
      client.closeCount += 1;
      throw panic;
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: (error) => {
        reports.push(error);
        reported.resolve();
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("terminal-panic")])),
        createClient: async (config) => {
          clientConfig = config;
          return client;
        },
      },
    });
    await registry.init();

    clientConfig?.onUncaughtError?.(new Error("terminal transport failure"));
    await reported.promise;
    expect(client.closeCount).toBe(1);

    await expect(registry.shutdown()).rejects.toBe(panic);
    expect(reports).toEqual([panic]);
    expect(client.closeCount).toBe(1);
  });

  it("preserves MCP application errors but retires on transport rejection", async () => {
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("run")] } });
    client.executeTool = async () => ({
      isError: true,
      content: [{ type: "text", text: "server-reported failure" }],
    });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("local")])),
        createClient: async () => client,
      },
    });
    await registry.init();
    const execute = registry.getTools()[0]?.tool.execute;
    if (!execute) throw new Error("Expected converted MCP tool to be executable");

    await expect(
      execute({}, { toolCallId: "first", messages: [], context: {} }),
    ).resolves.toMatchObject({ isError: true });
    expect(registry.list()[0]).toMatchObject({ status: "available" });
    expect(client.closeCount).toBe(0);

    client.executeTool = async () => {
      throw Object.assign(new Error("invalid tool arguments"), {
        name: "MCPClientError",
        code: -32602,
      });
    };
    await expect(execute({}, { toolCallId: "second", messages: [], context: {} })).rejects.toThrow(
      "invalid tool arguments",
    );
    expect(registry.list()[0]).toMatchObject({ status: "available" });
    expect(registry.getTools()).toHaveLength(1);
    expect(client.closeCount).toBe(0);

    client.executeTool = async () => {
      throw new Error("transport request rejected");
    };
    await expect(execute({}, { toolCallId: "third", messages: [], context: {} })).rejects.toThrow(
      "transport request rejected",
    );
    expect(registry.getTools()).toEqual([]);
    expect(registry.list()[0]).toMatchObject({
      status: "unavailable",
      phase: "runtime",
      error: "transport request rejected",
    });
    expect(client.closeCount).toBe(1);
    await registry.shutdown();
  });

  it("keeps the server available when a modern tool requires unsupported client input", async () => {
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("interactive")] } });
    client.executeTool = async () => {
      throw Object.assign(
        new Error(
          "Server requested additional input, but multi round-trip requests are not supported yet",
        ),
        { name: "MCPClientError" },
      );
    };
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("interactive")])),
        createClient: async () => client,
      },
    });
    await registry.init();
    const execute = registry.getTools()[0]?.tool.execute;
    if (!execute) throw new Error("Expected interactive MCP tool");

    await expect(
      execute({}, { toolCallId: "interactive", messages: [], context: {} }),
    ).rejects.toThrow("multi round-trip requests are not supported yet");
    expect(registry.list()[0]).toMatchObject({ status: "available", toolCount: 1 });
    expect(registry.getTools()).toHaveLength(1);
    expect(client.closeCount).toBe(0);
    await registry.shutdown();
  });

  it("propagates callback and wrapped tool Panics without changing available state", async () => {
    let clientConfig: MCPClientConfig | undefined;
    const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("run")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("local")])),
        createClient: async (config) => {
          clientConfig = config;
          return client;
        },
      },
    });
    await registry.init();
    const availableStatus = registry.list()[0];
    const availableTools = registry.getTools();

    const callbackPanic = new Panic({ message: "callback invariant failed" });
    expect(() => clientConfig?.onUncaughtError?.(callbackPanic)).toThrow(callbackPanic);
    expect(registry.list()[0]).toBe(availableStatus);
    expect(registry.getTools()).toBe(availableTools);
    expect(client.closeCount).toBe(0);

    const execute = registry.getTools()[0]?.tool.execute;
    if (!execute) throw new Error("Expected converted MCP tool to be executable");
    const toolPanic = new Panic({ message: "tool invariant failed" });
    client.executeTool = async () => {
      throw toolPanic;
    };
    await expect(execute({}, { toolCallId: "panic", messages: [], context: {} })).rejects.toBe(
      toolPanic,
    );
    expect(registry.list()[0]).toBe(availableStatus);
    expect(registry.getTools()).toBe(availableTools);
    expect(client.closeCount).toBe(0);
    await registry.shutdown();
  });

  it("terminally removes tools on uncaught errors and retries only on explicit reload", async () => {
    const token = "super-secret-token";
    let config: MCPClientConfig | undefined;
    let createCount = 0;
    const first = new FakeMcpClient({ first: { tools: [mcpToolDefinition("before")] } });
    const second = new FakeMcpClient({ first: { tools: [mcpToolDefinition("after")] } });
    const registry = new McpRegistry({
      configPath: "/data/mcp-config.yaml",
      reportFatalError: reportUnexpectedFatalError,
      dependencies: {
        readConfig: async () =>
          configSnapshot(
            mcpConfig([
              {
                id: "remote",
                allowSubagents: false,
                transportConfig: {
                  transport: "http",
                  url: "https://example.invalid/mcp",
                  headers: { Authorization: token },
                },
              },
            ]),
          ),
        createClient: async (clientConfig) => {
          config = clientConfig;
          createCount += 1;
          return createCount === 1 ? first : second;
        },
      },
    });

    await registry.init();
    expect(registry.getTools()).toHaveLength(1);
    config?.onUncaughtError?.(
      new Error(
        `Authorization: Bearer ${token} from https://example.invalid/mcp?token=${token}&state=nope`,
      ),
    );
    expect(registry.getTools()).toEqual([]);
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "runtime" });
    const error = (registry.list()[0] as { error: string }).error;
    expect(error).not.toContain(token);
    expect(error).not.toContain("state=nope");
    expect(first.closeCount).toBe(1);
    expect(createCount).toBe(1);

    expect(await reloadRegistry(registry, "remote")).toEqual([
      { serverId: "remote", reconciliation: "unavailable", result: "available" },
    ]);
    expect(createCount).toBe(2);
    expect(registry.getTools()[0]?.rawName).toBe("after");
    await registry.shutdown();
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });
});
