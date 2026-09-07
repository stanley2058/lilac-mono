import { expect, test } from "bun:test";
import { createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import {
  bindMcpToolToSession,
  hashMcpSession,
  LILAC_SESSION_HEADER,
  withMcpSessionHeaders,
} from "../../src/mcp/session-context";
import { enforceModernMcpResultContract } from "../../src/mcp/modern-result-validation";

const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({ arguments: z.object({ label: z.string() }).optional() })
    .passthrough()
    .optional(),
});

test("one shared HTTP MCP client isolates overlapping sessions and reserves its routing header", async () => {
  const both = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: Array<{ method: string; hash: string | null; auth: string | null; label?: string }> =
    [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = messageSchema.parse(await request.json());
      const label = message.params?.arguments?.label;
      const hash = request.headers.get(LILAC_SESSION_HEADER);
      calls.push({
        method: message.method,
        hash,
        auth: request.headers.get("authorization"),
        label,
      });
      const response = (result: Record<string, unknown>) =>
        Response.json({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "server/discover")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      if (message.method === "initialize")
        return response({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      if (message.method === "tools/list")
        return response({
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
              },
            },
          ],
        });
      if (message.method !== "tools/call") return new Response(null, { status: 202 });
      if (label === "A" || label === "B") {
        if (calls.filter((call) => call.method === "tools/call").length === 2) both.resolve();
        await release.promise;
      }
      return response({ content: [{ type: "text", text: hash ?? "none" }] });
    },
  });
  const headers = { Authorization: "Bearer test", "X-LILAC-SESSION-HASH": "configured-spoof" };
  const client = await createMCPClient({
    maxRetries: 0,
    protocolVersionDiscovery: true,
    transport: enforceModernMcpResultContract(
      withMcpSessionHeaders({ type: "http", url: server.url.toString(), headers }),
    ),
  });
  try {
    const original = (await client.tools()).echo!;
    const a = bindMcpToolToSession(original, "session-A");
    const b = bindMcpToolToSession(original, "session-B");
    const options = { toolCallId: "test", messages: [], context: {} };
    const first = a.execute!({ label: "A" }, options);
    const second = b.execute!({ label: "B" }, options);
    await both.promise;
    release.resolve();
    expect(await first).toMatchObject({
      content: [{ type: "text", text: hashMcpSession("session-A") }],
    });
    expect(await second).toMatchObject({
      content: [{ type: "text", text: hashMcpSession("session-B") }],
    });
    expect(hashMcpSession("session-A")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpSession("session-A")).not.toBe(hashMcpSession("session-B"));
    await original.execute!({ label: "unbound" }, options);
    const discovering = bindMcpToolToSession(
      {
        ...original,
        execute: async (input, opts) => {
          await client.listTools();
          const result = await original.execute!(input, opts);
          if (Symbol.asyncIterator in result) throw new Error("Expected completed result");
          return result;
        },
      },
      "session-A",
    );
    await discovering.execute!({ label: "nested" }, options);
    expect(
      calls.filter((call) => call.method !== "tools/call").every((call) => call.hash === null),
    ).toBe(true);
    expect(calls.find((call) => call.label === "unbound")?.hash).toBeNull();
    expect(calls.find((call) => call.label === "nested")?.hash).toBe(hashMcpSession("session-A"));
    expect(calls.every((call) => call.auth === "Bearer test")).toBe(true);
    expect(headers["X-LILAC-SESSION-HASH"]).toBe("configured-spoof");
  } finally {
    release.resolve();
    await client.close();
    await server.stop(true);
  }
});

test("stdio transports are unchanged and cancellation stays on the outgoing request", async () => {
  const transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  expect(withMcpSessionHeaders(transport)).toBe(transport);
  const aborted = new AbortController();
  const seen: Array<{ hash: string | null; aborted: boolean }> = [];
  const fetchFn = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ hash: request.headers.get(LILAC_SESSION_HEADER), aborted: request.signal.aborted });
    return new Response("ok");
  }, fetch);
  const wrapped = withMcpSessionHeaders({
    type: "http",
    url: "http://example.test",
    fetch: fetchFn,
  });
  if ("start" in wrapped || wrapped.type !== "http" || !wrapped.fetch)
    throw new Error("Expected HTTP fetch");
  const send = wrapped.fetch;
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const tool = bindMcpToolToSession(
    {
      inputSchema: z.object({}),
      execute: async () => {
        entered.resolve();
        await proceed.promise;
        await send("http://example.test", {
          method: "POST",
          body: JSON.stringify({ method: "tools/call" }),
          signal: aborted.signal,
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
    "cancelled-session",
  );
  const pending = tool.execute!({}, { toolCallId: "test", messages: [], context: {} });
  await entered.promise;
  aborted.abort();
  proceed.resolve();
  await pending;
  expect(seen).toEqual([{ hash: hashMcpSession("cancelled-session"), aborted: true }]);
  await send("http://example.test", {
    method: "POST",
    body: JSON.stringify({ method: "tools/call" }),
  });
  expect(seen[1]?.hash).toBeNull();
});
