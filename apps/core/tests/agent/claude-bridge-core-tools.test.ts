import { expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv from "ajv";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCoreConfigV3ToUniversal } from "@stanley2058/lilac-utils";
import { createClaudeCode } from "@stanley2058/lilac-utils/claude-sdk";
import { materializeClaudeCodeRunResult } from "@stanley2058/lilac-claude-code-bridge";
import { AgentExecutor } from "../../../../packages/agent/agent-executor";
import { createCoreToolPluginManager } from "../../src/plugins";

it("runs Core Level 1 tools through Claude permission correlation, MCP and the agent executor", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-claude-core-"));
  const config = parseCoreConfigV3ToUniversal({});
  const manager = createCoreToolPluginManager({ dataDir: cwd, runtime: { config } });
  const client = new Client({ name: "core-boundary-test", version: "1.0.0" });
  let release: (() => Promise<unknown>) | undefined;
  let dispose: (() => Promise<void>) | undefined;
  try {
    await fs.writeFile(path.join(cwd, "note.txt"), "original needle\n");
    const built = await manager.buildLevel1ToolsetResult({
      cwd,
      runProfile: "primary",
      editingToolMode: "apply_patch",
      subagentDepth: 0,
      subagentConfig: config.agent.subagents,
      requestContext: {
        requestId: "bridge-request",
        requestClient: "unknown",
        subagentDepth: 0,
        subagentProfile: "primary",
        sessionId: "bridge-session",
        safetyMode: "trusted",
        metadata: { readFileDirectImageSupported: true },
      },
    });
    if (built.status === "error") throw built.error;
    const toolset = built.value;
    release = toolset.release;
    const executor = new AgentExecutor({
      system: "Core bridge integration",
      tools: toolset.tools,
      genericOutputNormalizerBypassTools: toolset.genericOutputNormalizerBypassTools,
      aggregateOutputBudgetExemptTools: toolset.aggregateOutputBudgetExemptTools,
      adapter: {
        createExecution: () => {
          throw new Error("This test must not call a model");
        },
      },
    });
    type Settings = Parameters<
      NonNullable<Parameters<typeof materializeClaudeCodeRunResult>[0]["createModel"]>
    >[1];
    const settings: Settings[] = [];
    const provider = createClaudeCode();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: toolset.tools,
        execute: (request) => executor.executeExternalToolCall(request),
        createModel: (id, options) => {
          settings.push(options);
          return provider(id, options);
        },
      })
    ).unwrap();
    dispose = run.dispose;
    const bridge = settings[0]!;
    const server = bridge.mcpServers?.lilac;
    if (!server || server.type !== "sdk") throw new Error("Expected SDK MCP server");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    const samples: Record<string, Record<string, unknown>> = {
      read: { path: "note.txt" },
      patch: {
        patchText:
          "*** Begin Patch\n*** Update File: note.txt\n@@\n-original needle\n+changed needle\n*** End Patch",
      },
      glob: { patterns: ["*.txt"] },
      grep: { pattern: "needle", path: "note.txt" },
      bash: { command: "printf 'bash content\\n' > shell.txt; cat shell.txt" },
      model_catalog: {},
      skip_reply: { reason: "Already answered." },
      fuzzy_search: { query: "note" },
    };
    const listed = (await client.listTools()).tools;
    expect(listed.map((entry) => entry.name).sort()).toEqual(
      Object.keys(toolset.tools)
        .filter((name) => name !== "find_tools")
        .sort(),
    );
    const ajv = new Ajv({ strict: false });
    for (const declaration of listed) {
      expect(samples[declaration.name], `Add a valid sample for ${declaration.name}`).toBeDefined();
      const validate = ajv.compile(declaration.inputSchema);
      expect(validate(samples[declaration.name]), JSON.stringify(validate.errors)).toBe(true);
    }
    let callId = 0;
    async function call(name: string, input = samples[name]!, expectError = false) {
      const toolUseID = `toolu_core_${++callId}`;
      const permission = await bridge.canUseTool!(`mcp__lilac__${name}`, input, {
        signal: AbortSignal.timeout(8_000),
        toolUseID,
        requestId: `permission-${toolUseID}`,
      });
      if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");
      const result = await client.callTool({ name, arguments: permission.updatedInput });
      expect(result.isError === true, JSON.stringify(result)).toBe(expectError);
      return result;
    }
    function text(result: Awaited<ReturnType<typeof call>>) {
      return (result.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    }
    const uncorrelated = await client.callTool({
      name: "bash",
      arguments: { command: "touch forbidden.txt" },
    });
    expect(uncorrelated.isError).toBe(true);
    expect(await Bun.file(path.join(cwd, "forbidden.txt")).exists()).toBe(false);
    expect(text(await call("read"))).toContain("original needle");
    const hook = bridge.hooks?.PostToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("Expected skip_reply hook");
    const afterSkip = (id: string) =>
      hook(
        {
          hook_event_name: "PostToolUse",
          tool_use_id: id,
          tool_name: "mcp__lilac__skip_reply",
          tool_input: samples.skip_reply,
          tool_response: {},
          session_id: "test",
          cwd,
          transcript_path: "",
        },
        id,
        { signal: AbortSignal.timeout(8_000) },
      );
    expect(text(await call("skip_reply"))).toBe("Reply skipped.");
    expect(await afterSkip("different-call")).toEqual({});
    expect(await afterSkip(`toolu_core_${callId}`)).toEqual({ continue: false });
    expect(await afterSkip(`toolu_core_${callId}`)).toEqual({});
    await call("skip_reply", { reason: "" }, true);
    expect(await afterSkip(`toolu_core_${callId}`)).toEqual({});
    await call("patch");
    expect(await fs.readFile(path.join(cwd, "note.txt"), "utf8")).toBe("changed needle\n");
    expect(text(await call("read"))).toContain("changed needle");
    expect(text(await call("glob"))).toContain("note.txt");
    expect(text(await call("grep"))).toContain("changed needle");
    expect(text(await call("bash"))).toContain("bash content");
    expect(await fs.readFile(path.join(cwd, "shell.txt"), "utf8")).toBe("bash content\n");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=";
    await fs.writeFile(path.join(cwd, "pixel.png"), Buffer.from(png, "base64"));
    const image = await call("read", { path: "pixel.png" });
    expect(image.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png", data: png }),
    );
  } finally {
    await client.close();
    await dispose?.();
    await release?.();
    await manager.destroy();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}, 10_000);
