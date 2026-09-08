import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JSONRPCMessage, ListToolsResult, MCPTransport } from "@ai-sdk/mcp";
import { asSchema, type ToolSet } from "ai";
import { executeAtomicToolCall } from "@stanley2058/lilac-agent/atomic-tool-execution";

import { McpRegistry } from "../../src/mcp/registry";
import { assignOpaqueTool } from "../../src/plugins/manager";
import {
  createMcpBinaryResultMaterializer,
  wrapMcpToolWithBinaryMaterialization,
} from "../../src/mcp/binary-result-materializer";
import { configSnapshot, deferred, httpDefinition, mcpConfig } from "./fixtures/registry-fixture";

class ToolTransport implements MCPTransport {
  supportsMcpToolParameterHeaders = true;
  onmessage?: MCPTransport["onmessage"];
  onclose?: MCPTransport["onclose"];
  onerror?: MCPTransport["onerror"];
  calls: string[] = [];
  closeCount = 0;
  hasTools = true;
  result: Record<string, unknown> = { content: [{ type: "text", text: "ok" }] };
  definitions: ListToolsResult["tools"] = [{ name: "echo", inputSchema: { type: "object" } }];
  callStarted = deferred<void>();
  holdCall = false;
  heldReply?: () => void;
  lastArguments: unknown;

  constructor(readonly supportsProtocolVersionDiscovery: boolean) {}

  async start() {}
  async close() {
    this.closeCount++;
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    this.calls.push(message.method);
    const complete = (result: Record<string, unknown>) => {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          ...result,
          ...(this.supportsProtocolVersionDiscovery
            ? {
                resultType: "complete",
                _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
              }
            : {}),
        },
      });
    };
    if (message.method === "server/discover") {
      complete({
        supportedVersions: ["2026-07-28"],
        capabilities: this.hasTools ? { tools: {} } : { resources: {} },
        ttlMs: 0,
        cacheScope: "private",
      });
      return;
    }
    if (message.method === "initialize") {
      complete({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture", version: "1" },
        capabilities: this.hasTools ? { tools: {} } : { resources: {} },
      });
      return;
    }
    if (message.method === "tools/list") {
      complete({ tools: this.definitions, ttlMs: 0, cacheScope: "private" });
      return;
    }
    if (message.method === "tools/call") {
      this.lastArguments = message.params?.arguments;
      this.callStarted.resolve();
      if (this.holdCall) {
        this.heldReply = () => complete(this.result);
        return;
      }
      complete(this.result);
    }
  }
}

const registries: McpRegistry[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.shutdown()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function connect(transport: ToolTransport) {
  const registry = new McpRegistry({
    configPath: "/unused/mcp-config.yaml",
    reportFatalError: (error) => {
      throw error;
    },
    dependencies: {
      readConfig: async () => configSnapshot(mcpConfig([httpDefinition("fixture")])),
      createTransport: () => transport,
    },
  });
  registries.push(registry);
  await registry.init();
  return registry;
}

async function execute(registry: McpRegistry) {
  const entry = registry.getTools()[0];
  if (!entry) throw new Error("Expected tool");
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-mcp-compat-"));
  directories.push(rootDir);
  const tool = wrapMcpToolWithBinaryMaterialization(
    entry.tool,
    createMcpBinaryResultMaterializer({ requestId: "request", rootDir }),
  );
  const events: unknown[] = [];
  const tools: ToolSet = {};
  assignOpaqueTool(tools, "echo", tool);
  const outcome = await executeAtomicToolCall({
    call: { toolCallId: "call", toolName: "echo", input: { extra: "preserved" } },
    tools,
    messages: [],
    context: {},
    pendingToolCalls: new Set(),
    inputValidation: { type: "validate" },
    expansionHandling: { type: "reject" },
    onEvent: (event) => events.push(event),
  });
  return { outcome, events };
}

describe("MCP tool compatibility through registry and executor", () => {
  it("validates draft 2020-12 references and conditionals without changing valid results", async () => {
    const transport = new ToolTransport(true);
    transport.definitions[0]!.outputSchema = {
      $defs: { count: { type: "integer", minimum: 1 } },
      type: "object",
      properties: { kind: { const: "count" }, count: { $ref: "#/$defs/count" } },
      required: ["kind"],
      if: { properties: { kind: { const: "count" } } },
      then: { required: ["count"] },
      unevaluatedProperties: false,
    };
    const structuredContent = { kind: "count", count: 42 };
    transport.result = { content: [{ type: "text", text: "counted" }], structuredContent };
    const registry = await connect(transport);
    const valid = await execute(registry);
    expect(valid.outcome.isError).toBe(false);
    expect(valid.outcome.result).toMatchObject({ structuredContent });
    expect(valid.outcome.toolOutput).toEqual({
      type: "content",
      value: [
        { type: "text", text: "counted" },
        { type: "text", text: JSON.stringify(structuredContent) },
      ],
    });
    for (const invalid of [
      { kind: "count" },
      { kind: "count", count: "42" },
      { kind: "count", count: 42, extra: true },
    ]) {
      transport.result = { content: [], structuredContent: invalid };
      const { outcome } = await execute(registry);
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.toolOutput)).toContain("does not match");
      expect(registry.list()[0]?.status).toBe("available");
    }
  });

  it("validates an explicit draft-07 schema using its declared dialect", async () => {
    const transport = new ToolTransport(true);
    transport.definitions[0]!.outputSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ type: "integer" }, { type: "string" }],
      additionalItems: false,
    };
    transport.result = { content: [], structuredContent: [1, "one"] };
    const registry = await connect(transport);
    expect((await execute(registry)).outcome.isError).toBe(false);
    transport.result = { content: [], structuredContent: [1, 2] };
    expect((await execute(registry)).outcome.isError).toBe(true);
  });

  it("requires structuredContent for successful results but preserves server errors", async () => {
    const transport = new ToolTransport(true);
    transport.definitions[0]!.outputSchema = { type: "object", required: ["count"] };
    transport.result = { content: [{ type: "text", text: '{"count":42}' }] };
    const registry = await connect(transport);
    expect(JSON.stringify((await execute(registry)).outcome.toolOutput)).toContain(
      "no structuredContent",
    );
    transport.result = { isError: true, content: [{ type: "text", text: "upstream refused" }] };
    const { outcome } = await execute(registry);
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.toolOutput)).toContain("upstream refused");
    expect(JSON.stringify(outcome.toolOutput)).not.toContain("no structuredContent");
  });

  it("accepts null structured content when allowed by the schema", async () => {
    const transport = new ToolTransport(true);
    transport.definitions[0]!.outputSchema = { type: "null" };
    transport.result = { content: [], structuredContent: null };
    const { outcome } = await execute(await connect(transport));
    expect(outcome.isError).toBe(false);
    expect(outcome.toolOutput).toEqual({
      type: "content",
      value: [{ type: "text", text: "null" }],
    });
  });

  for (const outputSchema of [
    { type: "invalid-type" },
    { $async: true, type: "object" },
    { $schema: "https://example.invalid/unknown-dialect", type: "object" },
  ]) {
    it(`rejects unsupported output schemas before calling the affected tool: ${JSON.stringify(outputSchema)}`, async () => {
      const transport = new ToolTransport(true);
      transport.definitions[0]!.outputSchema = outputSchema;
      transport.definitions.push({ name: "healthy", inputSchema: { type: "object" } });
      const registry = await connect(transport);
      expect((await execute(registry)).outcome.isError).toBe(true);
      expect(transport.calls).not.toContain("tools/call");
      expect(registry.list()[0]).toMatchObject({ status: "available", toolCount: 2 });
      const healthy = registry.getTools().find((entry) => entry.rawName === "healthy")!;
      await expect(
        healthy.tool.execute!({}, { toolCallId: "healthy", messages: [], context: {} }),
      ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    });
  }

  it("does not fetch external schema references", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return Response.json({ type: "object" });
      },
    });
    try {
      const transport = new ToolTransport(true);
      transport.definitions[0]!.outputSchema = { $ref: server.url.toString() };
      const registry = await connect(transport);
      const { outcome } = await execute(registry);
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.toolOutput)).toContain(
        "Remote schema references are not fetched",
      );
      expect(requests).toBe(0);
      expect(transport.calls).not.toContain("tools/call");
    } finally {
      server.stop(true);
    }
  });

  for (const modern of [false, true]) {
    it(`connects a server without tools using ${modern ? "modern" : "legacy"} discovery`, async () => {
      const transport = new ToolTransport(modern);
      transport.hasTools = false;
      const registry = await connect(transport);
      expect(registry.list()).toMatchObject([{ status: "available", toolCount: 0 }]);
      expect(transport.calls).not.toContain("tools/list");
    });

    it(`keeps notifications and cancellation local using ${modern ? "modern" : "legacy"} discovery`, async () => {
      const transport = new ToolTransport(modern);
      const registry = await connect(transport);
      for (const method of [
        "notifications/progress",
        "notifications/tools/list_changed",
        "notifications/message",
      ]) {
        transport.onmessage?.({ jsonrpc: "2.0", method, params: {} });
      }
      expect(registry.list()[0]?.status).toBe("available");
      transport.holdCall = true;
      const controller = new AbortController();
      const execute = registry.getTools()[0]!.tool.execute!;
      const pending = execute(
        {},
        { toolCallId: "cancelled", messages: [], context: {}, abortSignal: controller.signal },
      );
      await transport.callStarted.promise;
      controller.abort();
      await expect(pending).rejects.toThrow("aborted");
      expect(() => transport.heldReply?.()).not.toThrow();
      expect(registry.list()[0]?.status).toBe("available");
      expect(transport.closeCount).toBe(0);
      transport.holdCall = false;
      await expect(
        execute({}, { toolCallId: "next", messages: [], context: {} }),
      ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    });
  }

  it("excludes invalid HTTP header tools without failing discovery", async () => {
    const transport = new ToolTransport(true);
    transport.definitions.push({
      name: "invalid",
      inputSchema: {
        type: "object",
        properties: { route: { type: "string", "x-mcp-header": "bad header" } },
      },
    });
    const registry = await connect(transport);
    expect(registry.list()[0]).toMatchObject({ status: "available", toolCount: 1 });
    expect(registry.getTools().map((entry) => entry.rawName)).toEqual(["echo"]);
  });

  it("preserves input schemas and extra arguments", async () => {
    const transport = new ToolTransport(true);
    transport.definitions[0]!.inputSchema = {
      type: "object",
      additionalProperties: { type: "string" },
    };
    const registry = await connect(transport);
    const tools: ToolSet = {};
    assignOpaqueTool(tools, "echo", registry.getTools()[0]!.tool);
    expect(await asSchema(tools.echo!.inputSchema).jsonSchema).toEqual(
      transport.definitions[0]!.inputSchema,
    );
    const { outcome } = await execute(registry);
    expect(outcome.isError).toBe(false);
    expect(transport.lastArguments).toEqual({ extra: "preserved" });
  });

  for (const content of [[], [{ type: "text" as const, text: "summary" }]]) {
    it(`preserves structured output alongside ${content.length} text blocks`, async () => {
      const transport = new ToolTransport(true);
      transport.result = {
        content,
        structuredContent: { count: 42 },
        _meta: { private: "not model context" },
      };
      const { outcome } = await execute(await connect(transport));
      expect(outcome.toolOutput).toEqual({
        type: "content",
        value: [...content, { type: "text", text: '{"count":42}' }],
      });
    });
  }

  it("preserves MCP errors in executor outcomes, events, and model output", async () => {
    const transport = new ToolTransport(true);
    transport.result = {
      isError: true,
      content: [{ type: "text", text: "quota exceeded" }],
      structuredContent: { retry: false },
    };
    const registry = await connect(transport);
    const { outcome, events } = await execute(registry);
    expect(outcome).toMatchObject({
      isError: true,
      outcome: "error",
      toolOutput: {
        type: "error-json",
        value: {
          content: [
            { type: "text", text: "quota exceeded" },
            { type: "text", text: '{"retry":false}' },
          ],
        },
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_execution_end", isError: true }),
    );
    expect(registry.list()[0]?.status).toBe("available");
  });

  it("decodes audio and exposes a readable local file without injecting base64", async () => {
    const transport = new ToolTransport(true);
    const data = Buffer.from("audio fixture").toString("base64");
    transport.result = { content: [{ type: "audio", data, mimeType: "audio/wav" }] };
    const { outcome } = await execute(await connect(transport));
    expect(outcome.isError).toBe(false);
    expect(outcome.toolOutput.type).toBe("content");
    if (outcome.toolOutput.type !== "content") throw new Error("Expected content");
    const notice = outcome.toolOutput.value.at(-1);
    if (notice?.type !== "text") throw new Error("Expected notice");
    const files = JSON.parse(notice.text.slice(notice.text.indexOf("\n") + 1)).mcpBinaryFiles;
    expect(files[0]).toMatchObject({ source: "audio", mediaType: "audio/wav", bytes: 13 });
    expect(await fs.readFile(files[0].localPath, "utf8")).toBe("audio fixture");
    expect(JSON.stringify(outcome.toolOutput)).not.toContain(data);
  });
});
