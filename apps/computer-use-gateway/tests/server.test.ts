import { expect, test } from "bun:test";
import { createMCPClient } from "@ai-sdk/mcp";
import { Result } from "better-result";
import { createGatewayHandler } from "../src/server";
import { failure } from "../src/contracts";

const hash = "a".repeat(64);
const calls: string[] = [];
const operations = {
  isReady: () => true,
  provision: async (session: string) => {
    calls.push(session);
    return Result.ok({
      status: "ready" as const,
      generation: "test",
      viewer_url: "http://localhost:17000/vnc.html",
      viewer_password: "testonly",
      idle_timeout_seconds: 3600,
      expires_at: "later",
      created: false,
      message: "Runner already exists",
    });
  },
  execute: async () =>
    Result.ok({
      content: [
        { type: "text" as const, text: "hello" },
        { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" as const },
      ],
      isError: false,
    }),
  terminate: async () => Result.ok(undefined),
};

function host(handler = createGatewayHandler(operations, "test-bearer")) {
  return Bun.serve({ port: 0, idleTimeout: 0, maxRequestBodySize: 262144, fetch: handler });
}

test("pinned Core MCP client falls back from modern discovery and projects images/text", async () => {
  calls.length = 0;
  const server = host();
  const methods: string[] = [];
  const client = await createMCPClient({
    maxRetries: 0,
    protocolVersionDiscovery: true,
    transport: {
      type: "http",
      url: `${server.url}mcp`,
      headers: { Authorization: "Bearer test-bearer", "x-lilac-session-hash": hash },
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") methods.push(JSON.parse(init.body).method);
        return fetch(input, init);
      }, fetch),
    },
  });
  try {
    const tools = await client.tools();
    expect(Object.keys(tools).sort()).toEqual(["execute", "provision", "terminate"]);
    expect(calls).toEqual([]);
    expect(methods).toContain("server/discover");
    expect(methods).toContain("initialize");
    const options = { toolCallId: "call", messages: [], context: undefined };
    const info = await tools.provision!.execute!({}, options);
    expect(info).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("viewer_url") }],
    });
    expect(calls).toEqual([hash]);
    const output = await tools.execute!.execute!({ code: "print('hello')" }, options);
    if (Symbol.asyncIterator in output) throw new Error("Expected one completed tool result");
    const model = await tools.execute!.toModelOutput!({ toolCallId: "call", input: {}, output });
    expect(model).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "hello" },
        { type: "file", data: { type: "data", data: "aGVsbG8=" }, mediaType: "image/png" },
      ],
    });
  } finally {
    await client.close();
    await server.stop(true);
  }
});

test("authentication covers discovery and session header is required only for tool calls", async () => {
  const server = host();
  try {
    expect((await fetch(`${server.url}mcp`)).status).toBe(401);
    const client = await createMCPClient({
      transport: {
        type: "http",
        url: `${server.url}mcp`,
        headers: { Authorization: "Bearer test-bearer" },
      },
    });
    const tools = await client.tools();
    const output = await tools.provision!.execute!(
      {},
      { toolCallId: "call", messages: [], context: undefined },
    );
    expect(output).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("session header") }],
    });
    await client.close();
  } finally {
    await server.stop(true);
  }
});

test("HTTP disconnect reaches active execution without replay", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let executions = 0;
  const server = host(
    createGatewayHandler(
      {
        ...operations,
        execute: async (_session, _code, signal) => {
          executions++;
          entered.resolve();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          cancelled.resolve();
          return Result.err(failure("cancelled", "Cancelled"));
        },
      },
      "test-bearer",
    ),
  );
  try {
    const abort = new AbortController();
    const response = fetch(`${server.url}mcp`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: "Bearer test-bearer",
        "x-lilac-session-hash": hash,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute", arguments: { code: "await forever" } },
      }),
    });
    const settled = Promise.allSettled([response]);
    await entered.promise;
    abort.abort();
    await cancelled.promise;
    await settled;
    expect(executions).toBe(1);
  } finally {
    await server.stop(true);
  }
}, 10000);
