import { describe, expect, it } from "bun:test";
import { createMCPClient, type MCPTransport, type OAuthClientProvider } from "@ai-sdk/mcp";

import { enforceModernMcpResultContract } from "../../src/mcp/modern-result-validation";

function mockFetch(
  implementation: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, { preconnect() {} });
}

function modernRequestInit(method = "tools/call"): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        name: "interactive",
        arguments: {},
      },
    }),
  };
}

describe("modern MCP result validation", () => {
  it("fails closed when the modern HTTP discovery fetch rejects", async () => {
    const methods: string[] = [];
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        methods.push(request.method);
        throw new Error("network unavailable");
      }),
    });

    await expect(
      createMCPClient({
        transport,
        protocolVersionDiscovery: true,
        clientName: "http-rejection-test",
      }),
    ).rejects.toThrow("Modern MCP discovery request failed");
    expect(methods).toEqual(["server/discover"]);
  });

  it("blocks legacy initialization when OAuth recovery throws during discovery", async () => {
    const methods: string[] = [];
    const recoveryFailure = new Error("OAuth recovery failed");
    const authProvider: OAuthClientProvider = {
      tokens: async () => undefined,
      saveTokens: async () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
      redirectUrl: "http://127.0.0.1/callback",
      clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
      clientInformation: async () => ({ client_id: "registered-client" }),
      validateAuthorizationServerURL: () => {
        throw recoveryFailure;
      },
    };
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      authProvider,
      fetch: mockFetch(async (_input, init) => {
        if (typeof init?.body !== "string") return new Response("not found", { status: 404 });
        const request = JSON.parse(init.body) as { id: string | number; method: string };
        methods.push(request.method);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          },
          { status: 401 },
        );
      }),
    });

    await expect(
      createMCPClient({
        transport,
        protocolVersionDiscovery: true,
        clientName: "http-oauth-recovery-test",
      }),
    ).rejects.toThrow("Legacy initialization lacks valid discovery evidence");
    expect(methods).toEqual(["server/discover"]);
  });

  it("fails closed when a custom transport rejects modern discovery", async () => {
    const methods: string[] = [];
    const rejectingTransport: MCPTransport = {
      supportsProtocolVersionDiscovery: true,
      async start() {},
      async send(message) {
        if ("method" in message) methods.push(message.method);
        throw new Error("transport unavailable");
      },
      async close() {},
    };

    await expect(
      createMCPClient({
        transport: enforceModernMcpResultContract(rejectingTransport),
        protocolVersionDiscovery: true,
        clientName: "custom-rejection-test",
      }),
    ).rejects.toThrow("Modern MCP discovery request failed");
    expect(methods).toEqual(["server/discover"]);
  });

  it("falls back after a custom transport returns an unknown discovery error", async () => {
    const methods: string[] = [];
    const customTransport: MCPTransport = {
      supportsProtocolVersionDiscovery: true,
      async start() {},
      async send(message) {
        if (!("method" in message)) return;
        methods.push(message.method);
        if (!("id" in message)) return;
        if (message.method === "server/discover") {
          customTransport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Server not initialized" },
          });
          return;
        }
        if (message.method !== "initialize") return;
        customTransport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "legacy-custom-server", version: "1.0.0" },
          },
        });
      },
      async close() {},
    };

    const client = await createMCPClient({
      transport: enforceModernMcpResultContract(customTransport),
      protocolVersionDiscovery: true,
      clientName: "custom-unknown-error-test",
    });

    expect(client.serverInfo.name).toBe("legacy-custom-server");
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized"]);
    await client.close();
  });

  it("preserves external cancellation of a modern HTTP discovery fetch", async () => {
    const cancellation = new Error("cancelled by caller");
    const controller = new AbortController();
    controller.abort(cancellation);
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async () => {
        throw cancellation;
      }),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const fetching = transport.fetch(transport.url, {
      ...modernRequestInit("server/discover"),
      signal: controller.signal,
    });

    await expect(fetching).rejects.toBe(cancellation);
  });

  it("cancels HTTP discovery through the caller deadline without downgrading", async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        methods.push(request.method);
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected discovery cancellation signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort(new Error("caller deadline reached"));
        });
      }),
    });

    await expect(
      createMCPClient({
        transport,
        protocolVersionDiscovery: true,
        initializationOptions: { signal: controller.signal },
        clientName: "http-timeout-test",
      }),
    ).rejects.toThrow("MCP client initialization was aborted");
    expect(methods).toEqual(["server/discover"]);
  });

  for (const status of [401, 403, 407, 408, 429, 503]) {
    it(`does not treat an unknown discovery error over HTTP ${status} as a downgrade`, async () => {
      const transport = enforceModernMcpResultContract({
        type: "http",
        url: "https://mcp.example.test",
        fetch: mockFetch(async () =>
          Response.json(
            {
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "Unknown discovery failure" },
            },
            { status },
          ),
        ),
      });
      if ("start" in transport || transport.type !== "http" || !transport.fetch) {
        throw new Error("Expected validating HTTP transport config");
      }

      const response = await transport.fetch(transport.url, modernRequestInit("server/discover"));

      expect(await response.json()).toMatchObject({
        error: { code: -32022, message: "Modern MCP discovery request failed" },
      });
    });
  }

  for (const malformedResponse of [
    { name: "an empty batch", body: [] },
    {
      name: "a response with the wrong ID",
      body: {
        jsonrpc: "2.0",
        id: 999,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        },
      },
    },
  ]) {
    it(`blocks legacy initialization after discovery returns ${malformedResponse.name}`, async () => {
      const methods: string[] = [];
      const transport = enforceModernMcpResultContract({
        type: "http",
        url: "https://mcp.example.test",
        fetch: mockFetch(async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { method: string };
          methods.push(request.method);
          return Response.json(malformedResponse.body);
        }),
      });

      await expect(
        createMCPClient({
          transport,
          protocolVersionDiscovery: true,
          clientName: "http-invalid-identity-test",
        }),
      ).rejects.toThrow();
      expect(methods).toEqual(["server/discover"]);
    });
  }

  it("blocks legacy initialization after a response-less discovery SSE stream", async () => {
    const methods: string[] = [];
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        methods.push(request.method);
        return new Response(": keepalive\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    });

    await expect(
      createMCPClient({
        transport,
        protocolVersionDiscovery: true,
        clientName: "http-empty-sse-test",
      }),
    ).rejects.toThrow("Modern MCP discovery request failed");
    expect(methods).toEqual(["server/discover"]);
  });

  it("keeps custom discovery context after a colliding server request", async () => {
    const methods: string[] = [];
    const customTransport: MCPTransport = {
      supportsProtocolVersionDiscovery: true,
      async start() {},
      async send(message) {
        if (!("method" in message) || !("id" in message)) return;
        methods.push(message.method);
        if (message.method !== "server/discover") return;
        customTransport.onmessage?.({ jsonrpc: "2.0", id: message.id, method: "ping" });
        customTransport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        });
      },
      async close() {},
    };

    await expect(
      createMCPClient({
        transport: enforceModernMcpResultContract(customTransport),
        protocolVersionDiscovery: true,
        clientName: "custom-collision-test",
      }),
    ).rejects.toThrow("Invalid modern MCP discovery result");
    expect(methods).toEqual(["server/discover"]);
  });

  it("fails closed when a custom transport closes during discovery", async () => {
    const methods: string[] = [];
    const customTransport: MCPTransport = {
      supportsProtocolVersionDiscovery: true,
      async start() {},
      async send(message) {
        if (!("method" in message) || !("id" in message)) return;
        methods.push(message.method);
        if (message.method === "server/discover") customTransport.onclose?.();
      },
      async close() {},
    };

    await expect(
      createMCPClient({
        transport: enforceModernMcpResultContract(customTransport),
        protocolVersionDiscovery: true,
        clientName: "custom-close-test",
      }),
    ).rejects.toThrow("Modern MCP discovery transport closed");
    expect(methods).toEqual(["server/discover"]);
  });

  it("rewrites unsupported result types in HTTP SSE message events", async () => {
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(
        async () =>
          new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                resultType: "task",
                content: [{ type: "text", text: "pending" }],
              },
            })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const response = await transport.fetch(transport.url, modernRequestInit());

    expect(await response.text()).toContain(
      '"code":-32022,"message":"Unsupported modern MCP resultType \\"task\\""',
    );
  });

  it("preserves complete HTTP SSE message events", async () => {
    const body = `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "done" }],
      },
    })}\n\n`;
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(
        async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const response = await transport.fetch(transport.url, modernRequestInit());

    expect(await response.text()).toBe(body);
  });

  it("preserves complete HTTP SSE message events with CR-only line endings", async () => {
    const body = `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "done" }],
      },
    })}\r\r`;
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(
        async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const response = await transport.fetch(transport.url, modernRequestInit());

    expect(await response.text()).toBe(body);
  });

  it("rejects discovery results that do not contain a mutually supported version", async () => {
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            resultType: "complete",
            supportedVersions: ["2099-01-01"],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: "private",
          },
        }),
      ),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const response = await transport.fetch(transport.url, modernRequestInit("server/discover"));

    expect(await response.json()).toMatchObject({
      error: { code: -32022, message: "Invalid modern MCP discovery result" },
    });
  });

  it("rejects complete tools/list results without required cache metadata", async () => {
    const transport = enforceModernMcpResultContract({
      type: "http",
      url: "https://mcp.example.test",
      fetch: mockFetch(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            resultType: "complete",
            tools: [],
          },
        }),
      ),
    });
    if ("start" in transport || transport.type !== "http" || !transport.fetch) {
      throw new Error("Expected validating HTTP transport config");
    }

    const response = await transport.fetch(transport.url, modernRequestInit("tools/list"));

    expect(await response.json()).toMatchObject({
      error: { code: -32022, message: "Invalid modern MCP tools/list result" },
    });
  });

  for (const cacheMetadata of [
    { ttlMs: -1, cacheScope: "private" },
    { ttlMs: 1.5, cacheScope: "private" },
    { ttlMs: 0, cacheScope: "shared" },
  ]) {
    it(`rejects invalid tools/list cache metadata ${JSON.stringify(cacheMetadata)}`, async () => {
      const transport = enforceModernMcpResultContract({
        type: "http",
        url: "https://mcp.example.test",
        fetch: mockFetch(async () =>
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              resultType: "complete",
              tools: [],
              ...cacheMetadata,
            },
          }),
        ),
      });
      if ("start" in transport || transport.type !== "http" || !transport.fetch) {
        throw new Error("Expected validating HTTP transport config");
      }

      const response = await transport.fetch(transport.url, modernRequestInit("tools/list"));

      expect(await response.json()).toMatchObject({
        error: { code: -32022, message: "Invalid modern MCP tools/list result" },
      });
    });
  }
});
