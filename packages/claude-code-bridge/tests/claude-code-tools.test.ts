import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AiSdkPiAgent, ToolExpansion } from "@stanley2058/lilac-agent";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Panic } from "better-result";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  createClaudeCodeToolBridge,
  createClaudeCodeToolBridgeResult,
  mapToolResultOutputToMcpResult,
  validateClaudeCodeBuiltInToolsResult,
} from "../claude-code-tools";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectBridge(
  bridge: Awaited<ReturnType<typeof createClaudeCodeToolBridge>>,
): Promise<Client> {
  const config = bridge.mcpServers.lilac;
  if (!config || config.type !== "sdk") throw new Error("Expected Lilac SDK MCP server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
  closeCallbacks.push(async () => {
    await Promise.all([client.close(), config.instance.close()]);
  });
  return client;
}

async function connectStdioFixture(fixtureName: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL(`./fixtures/${fixtureName}`, import.meta.url))],
  });
  closeCallbacks.push(() => client.close());
  await client.connect(transport);
  return client;
}

function permissionOptions(
  toolUseID: string,
): Parameters<Awaited<ReturnType<typeof createClaudeCodeToolBridge>>["canUseTool"]>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID,
    requestId: `permission-${toolUseID}`,
  };
}

describe("Claude Code tool bridge", () => {
  it("lists batch, omits portable find_tools, and preserves input transforms exactly once", async () => {
    let transforms = 0;
    const seen: unknown[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        transformed: tool({
          inputSchema: z.object({ value: z.string() }).transform((input) => {
            transforms += 1;
            return { value: Number(input.value) + 1 };
          }),
          execute: () => "unused",
        }),
        batch: tool({ inputSchema: z.object({}), execute: () => "unused" }),
        find_tools: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: () => "unused",
        }),
      },
      execute: async (request) => {
        seen.push(request);
        return {
          result: request.input,
          isError: false,
          outcome: "success",
          toolOutput: { type: "json", value: request.input as { value: number } },
        };
      },
    });
    const client = await connectBridge(bridge);

    const listed = await client.listTools();
    expect(listed.tools.map((entry) => entry.name)).toEqual(["transformed", "batch"]);

    const permission = await bridge.canUseTool(
      "mcp__lilac__transformed",
      { value: "2" },
      permissionOptions("toolu_1"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");
    const result = await client.callTool({
      name: "transformed",
      arguments: permission.updatedInput,
    });

    expect(transforms).toBe(1);
    expect(seen).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        toolName: "transformed",
        input: { value: 3 },
        inputValidation: "prevalidated",
      }),
    ]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ value: 3 });
  });

  it("aggregates executed batch children in order without failing the accepted parent", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        batch: tool({ inputSchema: z.object({}), execute: () => "unused" }),
      },
      execute: async () => ({
        result: { raw: "parent result must not be exposed" },
        isError: false,
        outcome: "success",
        toolOutput: { type: "json", value: { accepted: true } },
        executedExpansion: {
          children: [
            {
              toolCallId: "child-image",
              toolName: "render_preview",
              outcome: "success",
              isError: false,
              toolOutput: {
                type: "content",
                value: [
                  { type: "text", text: "preview ready" },
                  { type: "image-data", data: "AA==", mediaType: "image/png" },
                ],
              },
            },
            {
              toolCallId: "child-error",
              toolName: "publish_preview",
              outcome: "error",
              isError: true,
              toolOutput: { type: "error-json", value: { message: "publish failed" } },
            },
          ],
        },
      }),
    });
    const client = await connectBridge(bridge);
    const permission = await bridge.canUseTool(
      "mcp__lilac__batch",
      {},
      permissionOptions("batch-parent"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");

    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "batch", arguments: permission.updatedInput }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Batch accepted: 2 children." },
      {
        type: "text",
        text: "[1/2] tool=render_preview id=child-image outcome=success isError=false",
      },
      { type: "text", text: "preview ready" },
      { type: "image", data: "AA==", mimeType: "image/png" },
      {
        type: "text",
        text: "[2/2] tool=publish_preview id=child-error outcome=error isError=true",
      },
      { type: "text", text: '{"message":"publish failed"}' },
    ]);
    expect(result.structuredContent).toEqual({
      type: "lilac.batch-result",
      version: 1,
      accepted: true,
      total: 2,
      children: [
        {
          index: 1,
          toolCallId: "child-image",
          toolName: "render_preview",
          outcome: "success",
          isError: false,
          outputType: "content",
          contentStart: 1,
          contentCount: 3,
        },
        {
          index: 2,
          toolCallId: "child-error",
          toolName: "publish_preview",
          outcome: "error",
          isError: true,
          outputType: "error-json",
          contentStart: 4,
          contentCount: 2,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("parent result must not be exposed");
  });

  it("executes a batch expansion end to end through the agent-backed bridge", async () => {
    const tools = {
      batch: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: ({ value }) =>
          new ToolExpansion({ accepted: true }, [
            {
              toolCallId: "batch-child-1",
              toolName: "echo",
              input: { value },
            },
          ]),
      }),
      echo: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: ({ value }) => ({ echoed: value }),
      }),
    };
    const agent = new AiSdkPiAgent({
      system: "test",
      model: new MockLanguageModelV4({}),
      tools,
    });
    const bridge = await createClaudeCodeToolBridge({
      tools,
      execute: (request) => agent.executeExternalToolCall(request),
    });
    const client = await connectBridge(bridge);
    const permission = await bridge.canUseTool(
      "mcp__lilac__batch",
      { value: "hello" },
      permissionOptions("batch-parent"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");

    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "batch", arguments: permission.updatedInput }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      type: "lilac.batch-result",
      total: 1,
      children: [
        {
          toolCallId: "batch-child-1",
          toolName: "echo",
          outcome: "success",
          isError: false,
        },
      ],
    });
    expect(result.content).toContainEqual({ type: "text", text: '{"echoed":"hello"}' });
    expect(agent.state.pendingToolCalls.size).toBe(0);
  });

  it("fails closed without valid correlation and supports parallel identical calls", async () => {
    const calls: string[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        echo: tool({ inputSchema: z.object({ value: z.string() }), execute: () => "unused" }),
      },
      execute: async (request) => {
        calls.push(request.toolCallId);
        return {
          result: request.input,
          isError: false,
          outcome: "success",
          toolOutput: { type: "text", value: request.toolCallId },
        };
      },
    });
    const client = await connectBridge(bridge);

    const missing = await client.callTool({ name: "echo", arguments: { value: "same" } });
    expect(missing.isError).toBe(true);

    const permissions = await Promise.all(
      ["toolu_a", "toolu_b"].map((toolUseId) =>
        bridge.canUseTool("mcp__lilac__echo", { value: "same" }, permissionOptions(toolUseId)),
      ),
    );
    const inputs = permissions.map((permission) => {
      if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");
      return permission.updatedInput;
    });
    const results = await Promise.all(
      inputs.map((arguments_) => client.callTool({ name: "echo", arguments: arguments_ })),
    );

    expect(calls.toSorted()).toEqual(["toolu_a", "toolu_b"]);
    expect(results.map((result) => CallToolResultSchema.parse(result).content[0])).toEqual([
      { type: "text", text: "toolu_a" },
      { type: "text", text: "toolu_b" },
    ]);
  });

  it("prefers an exact legacy-named MCP tool over the compatibility alias", async () => {
    const called: string[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        read: tool({ inputSchema: z.object({}), execute: () => "unused" }),
        read_file: tool({ inputSchema: z.object({}), execute: () => "unused" }),
      },
      execute: async (request) => {
        called.push(request.toolName);
        return {
          result: "ok",
          isError: false,
          outcome: "success",
          toolOutput: { type: "text", value: "ok" },
        };
      },
    });
    const client = await connectBridge(bridge);
    const permission = await bridge.canUseTool(
      "mcp__lilac__read_file",
      {},
      permissionOptions("legacy-exact"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");

    await client.callTool({ name: "read_file", arguments: permission.updatedInput });

    expect(called).toEqual(["read_file"]);
  });

  it("normalizes legacy batch children before MCP validation", async () => {
    const inputs: unknown[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        read: tool({ inputSchema: z.object({}), execute: () => "unused" }),
        batch: tool({
          inputSchema: z.object({
            tool_calls: z.array(
              z.object({ tool: z.literal("read"), parameters: z.record(z.string(), z.unknown()) }),
            ),
          }),
          execute: () => "unused",
        }),
      },
      execute: async (request) => {
        inputs.push(request.input);
        return {
          result: "ok",
          isError: false,
          outcome: "success",
          toolOutput: { type: "text", value: "ok" },
        };
      },
    });
    const client = await connectBridge(bridge);
    const permission = await bridge.canUseTool(
      "mcp__lilac__batch",
      { tool_calls: [{ tool: "read_file", parameters: {} }] },
      permissionOptions("legacy-batch"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");

    await client.callTool({ name: "batch", arguments: permission.updatedInput });

    expect(inputs).toEqual([{ tool_calls: [{ tool: "read", parameters: {} }] }]);
  });

  it("skips provider-executed tools the model runs itself", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        local: tool({ inputSchema: z.object({}), execute: () => "ran" }),
        // A native web search: the provider runs it, so there is nothing for
        // the bridge to expose.
        websearch: {
          ...tool({ inputSchema: z.object({}) }),
          isProviderExecuted: true,
        } as unknown as ToolSet[string],
      },
      execute: async () => {
        throw new Error("unreachable");
      },
    });
    const client = await connectBridge(bridge);

    expect(bridge.exposedToolNames).toEqual(["local"]);
    expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["local"]);
    expect(
      await bridge.canUseTool("mcp__lilac__websearch", {}, permissionOptions("toolu_skip")),
    ).toMatchObject({ behavior: "deny" });
  });

  it("names the tool when a Lilac tool cannot be executed at all", async () => {
    // Not provider-executed, just broken: that is a toolset bug and must not
    // silently remove the tool from the model's reach.
    await expect(
      createClaudeCodeToolBridge({
        tools: { broken: tool({ inputSchema: z.object({}) }) },
        execute: async () => {
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow("Cannot expose Claude MCP tool 'broken': execute is missing");
  });

  it("rejects built-ins outside the vetted set even when typechecking is bypassed", async () => {
    await expect(
      createClaudeCodeToolBridge({
        tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
        execute: async () => {
          throw new Error("unreachable");
        },
        builtInTools: ["Bash"] as unknown as ["WebSearch"],
      }),
    ).rejects.toThrow("Claude built-in tool 'Bash' is not supported");
  });

  it("returns owned configuration and output-mapping failures from Result APIs", async () => {
    const builtIns = validateClaudeCodeBuiltInToolsResult(["Bash"]);
    expect(builtIns.status).toBe("error");
    if (builtIns.status === "error") {
      expect(builtIns.error._tag).toBe("ClaudeCodeBuiltInToolUnsupported");
    }

    const bridge = await createClaudeCodeToolBridgeResult({
      tools: { broken: tool({ inputSchema: z.object({}) }) },
      execute: async () => {
        throw new Error("unreachable");
      },
    });
    expect(bridge.status).toBe("error");
    if (bridge.status === "error") {
      expect(bridge.error._tag).toBe("ClaudeCodeToolBridgeConfigurationFailed");
    }

    const mapped = mapToolResultOutputToMcpResult(
      {
        type: "json",
        value: {
          get value(): null {
            throw new Error("serialization failed");
          },
        },
      },
      false,
    );
    expect(mapped.status).toBe("error");
    if (mapped.status === "error") {
      expect(mapped.error._tag).toBe("ClaudeCodeToolOutputMappingFailed");
    }
  });

  it("preserves Panic identity across JSON serialization", () => {
    const panic = new Panic({ message: "serialization invariant" });
    const hostile = {
      get value(): null {
        throw panic;
      },
    };

    expect(() => mapToolResultOutputToMcpResult({ type: "json", value: hostile }, false)).toThrow(
      panic,
    );
  });

  it("allows only exactly allowlisted built-ins and denies every other Claude tool", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
      execute: async () => {
        throw new Error("unreachable");
      },
      builtInTools: ["WebSearch", "ToolSearch"],
    });

    expect(
      await bridge.canUseTool("WebSearch", { query: "lilac" }, permissionOptions("toolu_search")),
    ).toEqual({ behavior: "allow", updatedInput: { query: "lilac" } });
    expect(await bridge.canUseTool("ToolSearch", {}, permissionOptions("toolu_tools"))).toEqual({
      behavior: "allow",
      updatedInput: {},
    });
    for (const denied of ["Bash", "WebFetch", "WebSearchExtra", "websearch"]) {
      expect(
        await bridge.canUseTool(denied, {}, permissionOptions(`toolu_${denied}`)),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  it("denies built-ins when no allowlist is supplied", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
      execute: async () => {
        throw new Error("unreachable");
      },
    });

    expect(await bridge.canUseTool("WebSearch", {}, permissionOptions("toolu_x"))).toMatchObject({
      behavior: "deny",
    });
  });

  it("marks Lilac built-ins always-load and gives deferred catalog tools search hints", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        read: tool({
          description: "Read a workspace file",
          inputSchema: z.object({ path: z.string() }),
          execute: () => "value",
        }),
        mcp_issue_tracker_lookup: tool({
          description: "Normalized description",
          inputSchema: z.object({ issue: z.string() }),
          execute: () => "value",
        }),
        find_tools: tool({ inputSchema: z.object({ query: z.string() }), execute: () => "value" }),
      },
      catalogMetadata: {
        mcp_issue_tracker_lookup: {
          sourceId: "linear-production",
          rawName: "ticket/search-by-customer-reference",
          title: "Customer escalation finder",
          description: "Finds escalations using the original account codename marmalade.",
          namespaceSummary: "mcp_linear_production.* — 1 tool: Issue tracking",
        },
        find_tools: {
          sourceId: "lilac",
          rawName: "find_tools",
          description: "Portable search must not be exposed to Claude Code.",
        },
      },
      execute: async () => {
        throw new Error("unreachable");
      },
    });
    const client = await connectBridge(bridge);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);
    expect(listed.tools.find((entry) => entry.name === "read")?._meta).toEqual({
      "anthropic/alwaysLoad": true,
    });
    expect(listed.tools.find((entry) => entry.name === "mcp_issue_tracker_lookup")?._meta).toEqual({
      "anthropic/searchHint": [
        "Namespace: mcp_linear_production.* — 1 tool: Issue tracking",
        "Source ID: linear-production",
        "Raw tool name: ticket/search-by-customer-reference",
        "Title: Customer escalation finder",
        "Description: Finds escalations using the original account codename marmalade.",
      ].join("\n"),
    });
    expect(bridge.exposedToolNames).not.toContain("find_tools");
  });

  it("serializes and parses all 5,000 deferred declarations over stdio MCP", async () => {
    const client = await connectStdioFixture("scale-tools-stdio-server.ts");

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(5_000);
    expect(listed.tools[0]?.name).toBe("mcp_scale_tool_0");
    expect(listed.tools[0]?.description).toBe("Scale tool 0");
    expect(listed.tools[0]?._meta).toEqual({
      "anthropic/searchHint": [
        "Source ID: scale-server",
        "Raw tool name: original/tool/0",
        "Description: Original scale description 0",
      ].join("\n"),
    });
    expect(listed.tools[4_999]?.name).toBe("mcp_scale_tool_4999");
    expect(listed.tools[4_999]?.description).toBe("Scale tool 4999");
    expect(listed.tools[4_999]?._meta).toEqual({
      "anthropic/searchHint": [
        "Source ID: scale-server",
        "Raw tool name: original/tool/4999",
        "Description: Original scale description 4999",
      ].join("\n"),
    });
  });
});
