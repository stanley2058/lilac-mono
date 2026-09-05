import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asSchema } from "ai";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import {
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2ToUniversal,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import { createCoreToolPluginManager as createCoreToolPluginManagerResult } from "../../src/plugins";
import { decodeCoreToolRequestMetadata } from "../../src/plugins/builtin/local-tools";
import { McpRegistry } from "../../src/mcp";
import { catalogToolStableId } from "../../src/mcp/catalog-identity";
import type { ConversationThreadToolService } from "../../src/conversation/thread-service";
import type { DiscoveryService } from "../../src/discovery/discovery-service";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import type { SurfaceAdapter } from "../../src/surface/adapter";
import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";
import { SurfaceRuntimeRegistry } from "../../src/surface/runtime-descriptor";
import {
  configSnapshot,
  FakeClientFactory,
  FakeMcpClient,
  mcpConfig,
  mcpToolDefinition,
  stdioDefinition,
} from "../mcp/fixtures/registry-fixture";
import { getTestBlobStore } from "../helpers/blob-store";
import type { ResourceAccess } from "../../src/resource";

function createCoreToolPluginManager(
  params: Parameters<typeof createCoreToolPluginManagerResult>[0],
) {
  const manager = createCoreToolPluginManagerResult(params);
  return {
    ...manager,
    async buildLevel1Toolset(buildParams: Parameters<typeof manager.buildLevel1ToolsetResult>[0]) {
      const built = await manager.buildLevel1ToolsetResult(buildParams);
      if (built.status === "error") throw new Error(built.error.message, { cause: built.error });
      return built.value;
    },
  };
}

function convertedMcpTool(name: string) {
  const client = new FakeMcpClient();
  const converted = client.toolsFromDefinitions({ tools: [mcpToolDefinition(name)] })[name];
  if (!converted) throw new Error(`missing converted MCP tool: ${name}`);
  return converted;
}

const TEST_SURFACE_REGISTRY = SurfaceRuntimeRegistry.create([
  { protocol: BUILTIN_SURFACE_PROTOCOLS.discord, adapter: {} as SurfaceAdapter },
  { protocol: BUILTIN_SURFACE_PROTOCOLS.github, adapter: {} as SurfaceAdapter },
]);
if (TEST_SURFACE_REGISTRY.status === "error") throw TEST_SURFACE_REGISTRY.error;
const TEST_SURFACE_ADAPTER_RESOLVER = TEST_SURFACE_REGISTRY.value.adapterResolver();
const TEST_RESOURCE_ACCESS = {} as ResourceAccess;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) last = chunk;
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }
  return await value;
}

function getExecutableTool(
  tools: Record<string, { execute?: (...args: readonly unknown[]) => unknown }>,
  name: string,
): { execute: (...args: readonly unknown[]) => unknown } {
  const tool = tools[name];
  if (!tool || typeof tool.execute !== "function") {
    throw new Error(`missing executable tool: ${name}`);
  }
  return { execute: tool.execute };
}

function getToolDescription(tools: Record<string, unknown>, name: string): string {
  const tool = tools[name];
  if (!tool || typeof tool !== "object") {
    throw new Error(`missing tool: ${name}`);
  }

  const description = (tool as { description?: unknown }).description;
  if (typeof description !== "string") {
    throw new Error(`missing tool description: ${name}`);
  }

  return description;
}

function getBatchToolNames(tools: Record<string, unknown>): string[] {
  const batch = tools["batch"];
  if (!batch || typeof batch !== "object") throw new Error("missing batch tool");
  const inputSchema = (batch as { inputSchema?: unknown }).inputSchema;
  const schema = asSchema(inputSchema as never).jsonSchema as {
    properties?: {
      tool_calls?: { items?: { properties?: { tool?: { enum?: string[] } } } };
    };
  };
  return schema.properties?.tool_calls?.items?.properties?.tool?.enum ?? [];
}

const EXPECTED_STABLE_LEVEL2_CALLABLE_IDS = [
  "attachment.add_files",
  "attachment.download",
  "codex.login",
  "codex.logout",
  "codex.status",
  "conversation.thread.metadata",
  "conversation.thread.read",
  "conversation.thread.runSummarization",
  "conversation.thread.search",
  "content.inspect",
  "discovery.search",
  "fetch",
  "onboarding.all",
  "onboarding.bootstrap",
  "onboarding.defaults",
  "onboarding.git_identity",
  "onboarding.github_app",
  "onboarding.github_user_token",
  "onboarding.gnupg",
  "onboarding.playwright",
  "onboarding.reload_config",
  "onboarding.reload_tools",
  "onboarding.restart",
  "onboarding.vcs_env",
  "resource.materialize",
  "search",
  "skills.brief",
  "skills.full",
  "skills.list",
  "ssh.hosts",
  "ssh.probe",
  "ssh.run",
  "surface.help",
  "surface.activities.recentAgentWrites",
  "surface.messages.delete",
  "surface.messages.edit",
  "surface.messages.list",
  "surface.messages.read",
  "surface.messages.search",
  "surface.messages.send",
  "surface.reactions.add",
  "surface.reactions.list",
  "surface.reactions.listDetailed",
  "surface.reactions.remove",
  "surface.sessions.list",
  "surface.sessions.listParticipants",
  "workflow.definition.get",
  "workflow.definition.list",
  "workflow.definition.save",
  "workflow.definition.validate",
  "workflow.run.cancel",
  "workflow.run.get",
  "workflow.run.list",
  "workflow.run.pause",
  "workflow.run.resume",
  "workflow.run.trigger",
  "workflow.trigger.cancel",
  "workflow.trigger.create",
  "workflow.trigger.get",
  "workflow.trigger.list",
].sort();

const OPTIONAL_DYNAMIC_LEVEL2_CALLABLE_IDS = new Set(["generate.image", "generate.video"]);

function testConfig(input: unknown): CoreConfig {
  const cfg = parseCoreConfigV1ToUniversal(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function testConfigV2(input: unknown): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

async function writeExternalPlugin(params: {
  dataDir: string;
  pluginId: string;
  entryBody: string;
}): Promise<void> {
  const pluginDir = path.join(params.dataDir, "plugins", params.pluginId, "dist");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "..", "package.json"),
    JSON.stringify(
      {
        name: params.pluginId,
        version: "0.0.1",
        lilac: {
          plugin: "./dist/index.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(pluginDir, "index.js"), params.entryBody, "utf8");
}

describe("core tool plugin manager", () => {
  it("keeps active toolsets alive across reload and releases a failed concurrent build", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-generation-"));
    const dataDir = path.join(tmpRoot, "data");
    await writeExternalPlugin({
      dataDir,
      pluginId: "connection",
      entryBody: `export default {
        meta: { id: "connection" },
        create() {
          let closed = false;
          return {
            level1: [{
              name: "read", isEnabled: () => true,
              createTool: () => ({
                description: "Read a shared connection",
                inputSchema: { type: "object", properties: {} },
                execute: () => ({ closed }),
              }),
            }],
            destroy: async () => { closed = true; },
          };
        },
      };`,
    });
    const cfg = testConfig({});
    const configRead = Promise.withResolvers<CoreConfig>();
    const configReadStarted = Promise.withResolvers<void>();
    let blockNextConfigRead = false;
    const manager = createCoreToolPluginManager({
      runtime: {
        getConfig: async () => {
          if (!blockNextConfigRead) return cfg;
          blockNextConfigRead = false;
          configReadStarted.resolve();
          return configRead.promise;
        },
      },
      dataDir,
    });
    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents,
    });
    const name = toolset.catalog.find((entry) => entry.sourceId === "connection")!.modelName;
    const executable = getExecutableTool(
      toolset.tools as Record<
        string,
        {
          execute?: (...args: readonly unknown[]) => unknown;
        }
      >,
      name,
    );
    expect(await executable.execute({})).toEqual({ closed: false });
    blockNextConfigRead = true;
    const failedBuild = manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents,
    });
    await configReadStarted.promise;
    expect((await manager.reload()).status).toBe("ok");
    expect(await executable.execute({})).toEqual({ closed: false });
    expect((await toolset.release()).status).toBe("ok");
    expect(await executable.execute({})).toEqual({ closed: false });
    configRead.reject(new Error("configuration unavailable"));
    await expect(failedBuild).rejects.toThrow("configuration unavailable");
    expect(await executable.execute({})).toEqual({ closed: true });
    expect((await manager.destroy()).status).toBe("ok");
  });

  let tmpRoot: string | null = null;
  let workflowStore: DurableWorkflowStore | null = null;

  afterEach(async () => {
    workflowStore?.close();
    workflowStore = null;
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("preserves request metadata when direct attachment support is false", () => {
    const onSubagentDelegate = async () => ({
      runId: "run:metadata-decode",
      completion: Promise.resolve({ status: "resolved" as const, finalText: "" }),
      cancel: async () => {},
    });
    const onActivity = () => {};

    const decoded = decodeCoreToolRequestMetadata({
      readFileDirectAttachmentSupported: false,
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: false,
      controlCapability: "level-2-control-capability",
      onSubagentDelegate,
      onActivity,
    });

    expect(decoded.readFileDirectAttachmentSupported).toBe(false);
    expect(decoded.readFileDirectImageSupported).toBe(true);
    expect(decoded.readFileDirectPdfSupported).toBe(false);
    expect(decoded.controlCapability).toBe("level-2-control-capability");
    expect(decoded.onSubagentDelegate).toBe(onSubagentDelegate);
    expect(decoded.onActivity).toBe(onActivity);
  });

  it("preserves built-in Level 1 tool exposure across profiles and edit modes", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const baseCfg = testConfig({});
    const cfg: CoreConfig = {
      ...baseCfg,
      agent: {
        ...baseCfg.agent,
        subagents: {
          ...baseCfg.agent.subagents,
          profiles: {
            ...baseCfg.agent.subagents.profiles,
            explore: {
              ...baseCfg.agent.subagents.profiles.explore,
              level1: {
                ...baseCfg.agent.subagents.profiles.explore.level1,
                tools: ["bash", ...baseCfg.agent.subagents.profiles.explore.level1.tools],
              },
              execution: "restricted",
            },
          },
        },
      },
    };

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadToolService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

    const applyPatchTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "apply_patch",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });
    expect([...applyPatchTools.specs.keys()].sort()).toEqual([
      "bash",
      "batch",
      "glob",
      "grep",
      "patch",
      "read",
      "subagent_delegate",
    ]);
    expect([...applyPatchTools.genericOutputNormalizerBypassTools].sort()).toEqual([
      "bash",
      "batch",
      "grep",
      "patch",
      "read",
      "subagent_delegate",
    ]);
    expect([...applyPatchTools.aggregateOutputBudgetExemptTools]).toEqual(["read", "grep"]);
    expect([...applyPatchTools.directToolNames].sort()).toEqual([
      "bash",
      "batch",
      "glob",
      "grep",
      "patch",
      "read",
      "subagent_delegate",
    ]);
    expect(applyPatchTools.tools).not.toHaveProperty("find_tools");

    const editFileTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "edit_file",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });
    expect([...editFileTools.specs.keys()].sort()).toEqual([
      "bash",
      "batch",
      "edit",
      "glob",
      "grep",
      "read",
      "subagent_delegate",
    ]);

    const exploreTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "explore",
      editingToolMode: "none",
      subagentDepth: 1,
      subagentConfig: cfg.agent.subagents!,
    });
    expect([...exploreTools.specs.keys()].sort()).toEqual([
      "bash",
      "batch",
      "glob",
      "grep",
      "read",
    ]);

    const generalTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "general",
      editingToolMode: "apply_patch",
      subagentDepth: 1,
      subagentConfig: cfg.agent.subagents!,
    });
    expect(Object.keys(generalTools.tools).sort()).toEqual([
      "bash",
      "batch",
      "glob",
      "grep",
      "patch",
      "read",
    ]);

    const selfTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "self",
      editingToolMode: "apply_patch",
      subagentDepth: 1,
      subagentConfig: cfg.agent.subagents!,
    });
    expect(Object.keys(selfTools.tools).sort()).toEqual([
      "bash",
      "batch",
      "glob",
      "grep",
      "patch",
      "read",
      "subagent_delegate",
    ]);
  });

  it("omits Bash when a profile disables execution", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfigV2({
      configVersion: 2,
      agent: { subagents: { profiles: { explore: { execution: false } } } },
    });
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadToolService,
        config: cfg,
      },
      dataDir,
    });
    await manager.init();

    const exploreTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "explore",
      editingToolMode: "none",
      subagentDepth: 1,
      subagentConfig: cfg.agent.subagents,
    });

    expect(exploreTools.specs.has("bash")).toBe(false);
    expect([...exploreTools.specs.keys()].sort()).toEqual([
      "batch",
      "fuzzy_search",
      "glob",
      "grep",
      "read",
    ]);
  });

  it("hides unsandboxed local tools in restricted mode", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadToolService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

    const restrictedTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "apply_patch",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
      requestContext: {
        requestId: "req:restricted-tools",
        sessionId: "public-channel",
        requestClient: "discord",
        subagentDepth: 0,
        subagentProfile: "primary",
        safetyMode: "restricted",
      },
    });

    expect([...restrictedTools.specs.keys()].sort()).toEqual(["bash", "batch", "read"]);
  });

  it("threads direct attachment support metadata into read description", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "apply_patch",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
      requestContext: {
        requestId: "req:read-file-attachments",
        sessionId: "test-session",
        requestClient: "test",
        subagentDepth: 0,
        subagentProfile: "primary",
        metadata: {
          readFileDirectImageSupported: true,
          readFileDirectPdfSupported: true,
        },
      },
    });

    expect(getToolDescription(toolset.tools, "read")).toContain(
      "Analyze supported images and PDFs already attached to context directly",
    );
    expect(getToolDescription(toolset.tools, "read")).toContain("direct HTTP(S) URL");
  });

  it("gates URL reads with the web.fetch native-profile authority", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfigV2({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            explore: {
              network: true,
              level2: { plugins: ["web"], callables: ["search"] },
            },
            general: { network: false },
          },
        },
      },
    });
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });
    await manager.init();

    const build = (runProfile: "primary" | "explore" | "general") =>
      manager.buildLevel1Toolset({
        cwd: dataDir,
        runProfile,
        editingToolMode: "none",
        subagentDepth: runProfile === "primary" ? 0 : 1,
        subagentConfig: cfg.agent.subagents,
        requestContext: {
          requestId: `req:url-read-${runProfile}`,
          sessionId: "test-session",
          requestClient: "test",
          subagentDepth: runProfile === "primary" ? 0 : 1,
          subagentProfile: runProfile,
          metadata: { readFileDirectImageSupported: true },
        },
      });

    const primary = await build("primary");
    const missingFetch = await build("explore");
    const networkDisabled = await build("general");

    expect(getToolDescription(primary.tools, "read")).toContain("direct HTTP(S) URL");
    expect(getToolDescription(missingFetch.tools, "read")).not.toContain("HTTP(S)");
    expect(getToolDescription(networkDisabled.tools, "read")).not.toContain("HTTP(S)");

    const webDisabledCfg: CoreConfig = {
      ...cfg,
      plugins: { ...cfg.plugins, disabled: [...cfg.plugins.disabled, "web"] },
    };
    const webDisabledManager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: webDisabledCfg,
      },
      dataDir: path.join(dataDir, "web-disabled"),
    });
    await webDisabledManager.init();
    const webDisabled = await webDisabledManager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: webDisabledCfg.agent.subagents,
      requestContext: {
        requestId: "req:url-read-web-disabled",
        sessionId: "test-session",
        requestClient: "test",
        subagentDepth: 0,
        subagentProfile: "primary",
        metadata: { readFileDirectImageSupported: true },
      },
    });
    expect(getToolDescription(webDisabled.tools, "read")).not.toContain("HTTP(S)");
  });

  it("retains delegation and Level 2 metadata when direct attachment support is false", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    let delegationCount = 0;
    const activitySources: string[] = [];
    const requestContext = {
      requestId: "req:false-attachment-metadata",
      sessionId: "test-session",
      requestClient: "test",
      subagentDepth: 0,
      subagentProfile: "primary" as const,
      metadata: {
        readFileDirectAttachmentSupported: false,
        controlCapability: "level-2-control-capability",
        onSubagentDelegate: async () => {
          delegationCount += 1;
          return {
            runId: "run:false-attachment-metadata",
            completion: Promise.resolve({ status: "resolved" as const, finalText: "" }),
            cancel: async () => {},
          };
        },
        onActivity: (source: "tool" | "subagent") => {
          activitySources.push(source);
        },
      },
    };
    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();
    await fs.mkdir(dataDir, { recursive: true });
    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
      requestContext,
    });
    const executableTools = toolset.tools as Record<
      string,
      { execute?: (...args: readonly unknown[]) => unknown }
    >;

    const bashResult = await resolveExecuteResult(
      getExecutableTool(executableTools, "bash").execute(
        { command: 'printf "%s" "$LILAC_CONTROL_CAPABILITY"' },
        { context: requestContext, toolCallId: "bash-metadata", messages: [] },
      ),
    );
    expect(bashResult).toMatchObject({
      stdout: "level-2-control-capability",
      exitCode: 0,
    });
    expect(activitySources).toContain("tool");

    const delegationResult = await resolveExecuteResult(
      getExecutableTool(executableTools, "subagent_delegate").execute(
        { profile: "explore", task: "Check metadata", mode: "deferred" },
        { context: requestContext, toolCallId: "delegate-metadata", messages: [] },
      ),
    );
    expect(delegationResult).toMatchObject({
      ok: true,
      status: "accepted",
      workflowRunId: "run:false-attachment-metadata",
    });
    expect(delegationCount).toBe(1);
    expect(getToolDescription(toolset.tools, "read")).not.toContain(
      "Analyze supported images and PDFs already attached to context directly",
    );
  });

  it("shares local read state between read and edit within one toolset", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "note.txt"), "before\n", "utf8");

    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "edit_file",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });

    const tools = toolset.tools as Record<
      string,
      { execute?: (...args: readonly unknown[]) => unknown }
    >;
    const readFile = getExecutableTool(tools, "read");
    const editFile = getExecutableTool(tools, "edit");

    const readRes = await resolveExecuteResult(
      readFile.execute!({ path: "note.txt" }, { toolCallId: "read-1", messages: [] }),
    );
    expect((readRes as { success: boolean }).success).toBe(true);

    const editRes = await resolveExecuteResult(
      editFile.execute!(
        {
          path: "note.txt",
          oldText: "before",
          newText: "after",
        },
        { toolCallId: "edit-1", messages: [] },
      ),
    );

    expect((editRes as { success: boolean }).success).toBe(true);
    await expect(fs.readFile(path.join(dataDir, "note.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("switches non-openai edit toolsets to hashline mode when enabled in config", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    cfg.tools.editFile.hashline = true;

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "note.txt"), "before\n", "utf8");

    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "edit_file",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });

    const tools = toolset.tools as Record<
      string,
      { execute?: (...args: readonly unknown[]) => unknown }
    >;
    const readFile = getExecutableTool(tools, "read");
    const editFile = getExecutableTool(tools, "edit");

    const readRes = await resolveExecuteResult(
      readFile.execute!(
        { path: "note.txt", format: "hashline" },
        { toolCallId: "read-hashline", messages: [] },
      ),
    );
    expect((readRes as { success: boolean }).success).toBe(true);
    const hashlineContent = (readRes as { format: string; hashlineContent?: string })
      .hashlineContent;
    expect((readRes as { format: string }).format).toBe("hashline");
    expect(typeof hashlineContent).toBe("string");

    const anchor = hashlineContent!.split("\n")[0]!;
    const editRes = await resolveExecuteResult(
      editFile.execute!(
        {
          path: "note.txt",
          edits: [{ op: "replace", pos: anchor, lines: ["after"] }],
        },
        { toolCallId: "edit-hashline", messages: [] },
      ),
    );

    expect((editRes as { success: boolean }).success).toBe(true);
    await expect(fs.readFile(path.join(dataDir, "note.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("rejects hashline edits when the file changed after the read", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    cfg.tools.editFile.hashline = true;

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "note.txt"), "before\nafter\n", "utf8");

    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "edit_file",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });

    const tools = toolset.tools as Record<
      string,
      { execute?: (...args: readonly unknown[]) => unknown }
    >;
    const readFile = getExecutableTool(tools, "read");
    const editFile = getExecutableTool(tools, "edit");

    const readRes = await resolveExecuteResult(
      readFile.execute!(
        { path: "note.txt", format: "hashline" },
        { toolCallId: "read-hashline-stale", messages: [] },
      ),
    );
    expect((readRes as { success: boolean }).success).toBe(true);

    const hashlineContent = (readRes as { format: string; hashlineContent?: string })
      .hashlineContent;
    expect((readRes as { format: string }).format).toBe("hashline");
    await fs.writeFile(path.join(dataDir, "note.txt"), "before changed\nafter\n", "utf8");

    const editRes = await resolveExecuteResult(
      editFile.execute!(
        {
          path: "note.txt",
          edits: [{ op: "replace", pos: hashlineContent!.split("\n")[1]!, lines: ["done"] }],
        },
        { toolCallId: "edit-hashline-stale", messages: [] },
      ),
    );

    expect((editRes as { success: boolean }).success).toBe(false);
    expect((editRes as { error?: { code?: string } }).error?.code).toBe("HASH_MISMATCH");
  });

  it("preserves built-in Level 2, discovery, and conversation-thread callables", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    const blobStore = await getTestBlobStore();
    await fs.mkdir(dataDir, { recursive: true });
    workflowStore = new DurableWorkflowStore(path.join(dataDir, "workflow.sqlite"));

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        blobStore,
        durableWorkflowStore: workflowStore,
        attachmentOutputLifecycle: {
          registerOutputHandle: () => Result.ok(undefined),
        },
        resourceAccess: TEST_RESOURCE_ACCESS,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        conversationThreads: {} as ConversationThreadToolService,
        config: cfg,
      },
      dataDir,
    });

    const initialized = await manager.init();
    if (initialized.status === "error") {
      throw new Error(initialized.error.message, { cause: initialized.error });
    }

    const callableIds = (
      await Promise.all(
        manager
          .getLevel2Tools()
          .map(async (tool) => (await tool.list()).map((entry) => entry.callableId)),
      )
    )
      .flat()
      .sort();

    expect(callableIds.filter((id) => !OPTIONAL_DYNAMIC_LEVEL2_CALLABLE_IDS.has(id))).toEqual(
      EXPECTED_STABLE_LEVEL2_CALLABLE_IDS,
    );
    expect(
      callableIds
        .filter((id) => OPTIONAL_DYNAMIC_LEVEL2_CALLABLE_IDS.has(id))
        .every((id) => OPTIONAL_DYNAMIC_LEVEL2_CALLABLE_IDS.has(id)),
    ).toBe(true);
    expect(callableIds.filter((id) => id.startsWith("discovery."))).toEqual(["discovery.search"]);
    expect(callableIds.filter((id) => id.startsWith("conversation.thread."))).toEqual([
      "conversation.thread.metadata",
      "conversation.thread.read",
      "conversation.thread.runSummarization",
      "conversation.thread.search",
    ]);

    const contributionByTool = manager.getLevel2ContributionInfo();
    const webTool = manager.getLevel2Tools().find((tool) => tool.id === "web");
    if (!webTool) throw new Error("missing web tool");
    expect(contributionByTool.get(webTool)?.pluginId).toBe("web");
  });

  it("skips capability-dependent plugins in dev mode", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

    expect(manager.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "workflow", state: "skipped" }),
        expect.objectContaining({ pluginId: "attachment", state: "skipped" }),
        expect.objectContaining({ pluginId: "surface", state: "skipped" }),
      ]),
    );
  });

  it("loads an external plugin that contributes both Level 1 and Level 2 tools", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    await writeExternalPlugin({
      dataDir,
      pluginId: "fixture-plugin",
      entryBody: `import { Result } from ${JSON.stringify(import.meta.resolve("better-result"))};
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
import { defineServerTool } from ${JSON.stringify(new URL("../../../../packages/plugin-runtime/index.ts", import.meta.url).href)};
import { markAggregateOutputBudgetExempt, markBoundedBuiltinOutput } from ${JSON.stringify(new URL("../../src/plugins/types.ts", import.meta.url).href)};
export default {
  meta: { id: "fixture-plugin" },
  create() {
    return {
      level1: [markAggregateOutputBudgetExempt(markBoundedBuiltinOutput({
        name: "fixture_level1",
        createTool() { return { title: "Fixture Level 1", description: "Complete external fixture description", execute() { return { ok: true }; } }; },
        isEnabled() { return true; },
        formatArgs() { return " fixture"; },
      }))],
      level2: [defineServerTool({
        id: "fixture",
        callables: ({ callable }) => ({
          "fixture.echo": callable({
            name: "Fixture Echo",
            description: "Fixture",
            inputSchema: z.object({ text: z.string() }),
            run: ({ text }) => Result.ok({ echo: text }),
          }),
        }),
      })],
    };
  },
};`,
    });

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        surfaceAdapterResolver: TEST_SURFACE_ADAPTER_RESOLVER,
        discovery: {} as DiscoveryService,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

    const level1 = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });
    expect(level1.specs.has("plugin_fixture_plugin_fixture_level1")).toBe(true);
    expect(level1.specs.has("fixture_level1")).toBe(false);
    expect(level1.tools).toHaveProperty("plugin_fixture_plugin_fixture_level1");
    expect(level1.tools).not.toHaveProperty("fixture_level1");
    expect(level1.catalog).toEqual([
      expect.objectContaining({
        source: "plugin",
        sourceId: "fixture-plugin",
        rawName: "fixture_level1",
        modelName: "plugin_fixture_plugin_fixture_level1",
        title: "Fixture Level 1",
        description: "Complete external fixture description",
      }),
    ]);
    expect(level1.catalogMetadata.plugin_fixture_plugin_fixture_level1).toEqual({
      sourceId: "fixture-plugin",
      rawName: "fixture_level1",
      title: "Fixture Level 1",
      description: "Complete external fixture description",
    });
    expect(level1.genericOutputNormalizerBypassTools).not.toContain(
      "plugin_fixture_plugin_fixture_level1",
    );
    expect(level1.genericOutputNormalizerBypassTools.has("fixture_level1")).toBe(false);
    expect(level1.aggregateOutputBudgetExemptTools).not.toContain(
      "plugin_fixture_plugin_fixture_level1",
    );
    expect(getBatchToolNames(level1.tools)).not.toContain("plugin_fixture_plugin_fixture_level1");
    expect(getBatchToolNames(level1.tools)).not.toContain("batch");

    const callableIds = (
      await Promise.all(
        manager
          .getLevel2Tools()
          .map(async (tool) => (await tool.list()).map((entry) => entry.callableId)),
      )
    ).flat();
    expect(callableIds).toContain("fixture.echo");
    const fixtureTool = manager.getLevel2Tools().find((tool) => tool.id === "fixture");
    if (!fixtureTool) throw new Error("missing fixture Level 2 tool");
    expect(await fixtureTool.call("fixture.echo", { text: "hello" })).toMatchObject({
      status: "ok",
      value: { echo: "hello" },
    });
    expect(await fixtureTool.call("fixture.echo", { text: 42 })).toMatchObject({
      status: "error",
      error: {
        kind: "usage",
        message: expect.stringContaining("fixture.echo has invalid input."),
      },
    });
  });

  it("captures hostile executable metadata getters at the plugin boundary", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    await writeExternalPlugin({
      dataDir,
      pluginId: "hostile-metadata",
      entryBody: `const hostile = new Proxy({}, {
  getPrototypeOf() { throw new Error("hostile prototype trap"); },
  get() { throw new Error("hostile property trap"); },
});
export default {
  meta: { id: "hostile-metadata" },
  create() {
    return { level1: [{
      name: "hostile_metadata",
      createTool() {
        const executable = { execute() {} };
        Object.defineProperty(executable, "title", { get() { throw hostile; } });
        return executable;
      },
      isEnabled() { return true; },
    }] };
  },
};`,
    });
    const manager = createCoreToolPluginManager({ runtime: { config: cfg }, dataDir });
    const initialized = await manager.init();
    expect(initialized.status).toBe("ok");

    const built = await manager.buildLevel1ToolsetResult({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents!,
    });
    expect(built.status).toBe("error");
    if (built.status === "error") {
      expect(built.error._tag).toBe("Level1ToolsetBuildFailed");
      if (built.error._tag === "Level1ToolsetBuildFailed") {
        expect(built.error.operation).toBe("level1.executableMetadata");
        expect(built.error.message).toContain("level1.executableMetadata");
      }
    }
  });

  it("qualifies external registration keys by plugin while preserving raw status names", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const pluginBody = (pluginId: string, names: readonly string[]) => `export default {
  meta: { id: ${JSON.stringify(pluginId)} },
  create() { return { level1: [${names
    .map(
      (name) =>
        `{ name: ${JSON.stringify(name)}, createTool() { return { execute() { return ${JSON.stringify(pluginId)}; } }; }, isEnabled() { return true; } }`,
    )
    .join(",")} ] }; },
};`;
    await writeExternalPlugin({
      dataDir,
      pluginId: "same-a",
      entryBody: pluginBody("same-a", ["shared_raw"]),
    });
    await writeExternalPlugin({
      dataDir,
      pluginId: "same-b",
      entryBody: pluginBody("same-b", ["shared_raw"]),
    });
    await writeExternalPlugin({
      dataDir,
      pluginId: "builtin-name",
      entryBody: pluginBody("builtin-name", ["read"]),
    });
    await writeExternalPlugin({
      dataDir,
      pluginId: "duplicate-own",
      entryBody: pluginBody("duplicate-own", ["own_raw", "own_raw"]),
    });
    const cfg = testConfig({});
    const manager = createCoreToolPluginManager({ runtime: { config: cfg }, dataDir });

    await manager.init();

    expect(manager.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "same-a",
          state: "loaded",
          level1Names: ["shared_raw"],
        }),
        expect.objectContaining({
          pluginId: "same-b",
          state: "loaded",
          level1Names: ["shared_raw"],
        }),
        expect.objectContaining({
          pluginId: "builtin-name",
          state: "loaded",
          level1Names: ["read"],
        }),
        expect.objectContaining({ pluginId: "duplicate-own", state: "failed" }),
      ]),
    );
    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents,
    });
    expect(
      toolset.catalog
        .filter((entry) => entry.rawName === "shared_raw")
        .map((entry) => entry.sourceId)
        .sort(),
    ).toEqual(["same-a", "same-b"]);
    expect(
      toolset.catalog.some(
        (entry) => entry.sourceId === "builtin-name" && entry.rawName === "read",
      ),
    ).toBe(true);
  });

  it("applies native profile plugin and tool gates to the MCP catalog", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const base = testConfig({});
    const cfg: CoreConfig = {
      ...base,
      agent: {
        ...base.agent,
        subagents: {
          ...base.agent.subagents,
          profiles: {
            ...base.agent.subagents.profiles,
            general: {
              ...base.agent.subagents.profiles.general,
              level1: {
                plugins: ["mcp:allowed"],
                tools: ["raw_allowed", "mcp_allowed_model_raw"],
              },
            },
          },
        },
      },
    };
    const mcpEntry = (serverId: string, rawName: string) => {
      const identity = { source: "mcp", sourceId: serverId, rawToolName: rawName } as const;
      return {
        serverId,
        rawName,
        identity,
        stableId: catalogToolStableId(identity),
        tool: convertedMcpTool(rawName),
      };
    };
    const entries = [
      mcpEntry("allowed", "raw_allowed"),
      mcpEntry("allowed", "model_raw"),
      mcpEntry("allowed", "denied_raw"),
      mcpEntry("blocked", "raw_allowed"),
    ];
    const manager = createCoreToolPluginManager({
      runtime: {
        config: cfg,
        mcpRegistry: {
          async init() {},
          async reload() {
            return Result.ok([]);
          },
          getConfigStatus: () => ({ status: "valid" }),
          list: () => [],
          getCatalogServers: () => [
            {
              serverId: "allowed",
              serverInfo: { name: "allowed", version: "1.0.0" },
              description: "Allowed server tools.",
            },
            {
              serverId: "blocked",
              serverInfo: { name: "blocked", version: "1.0.0" },
              description: "Blocked server tools.",
            },
          ],
          getTools: () => entries,
          async shutdown() {},
        },
      },
      dataDir,
    });
    await manager.init();
    const build = (runProfile: "primary" | "general") =>
      manager.buildLevel1Toolset({
        cwd: dataDir,
        runProfile,
        editingToolMode: "none",
        subagentDepth: runProfile === "primary" ? 0 : 1,
        subagentConfig: cfg.agent.subagents,
      });

    const primary = await build("primary");
    expect(primary.catalog.filter((entry) => entry.source === "mcp")).toHaveLength(4);

    const general = await build("general");
    expect(
      general.catalog
        .filter((entry) => entry.source === "mcp")
        .map((entry) => `${entry.sourceId}:${entry.rawName}`),
    ).toEqual(["allowed:model_raw", "allowed:raw_allowed"]);
    expect(Object.keys(general.catalogMetadata).sort()).toEqual([
      "mcp_allowed_model_raw",
      "mcp_allowed_raw_allowed",
    ]);
    expect(general.catalogMetadata.mcp_allowed_model_raw?.namespaceSummary).toBe(
      "mcp_allowed.* — 2 tools: Allowed server tools.",
    );
    expect(getToolDescription(general.tools, "find_tools")).toContain(
      "mcp_allowed.* — 2 tools: Allowed server tools.",
    );
    expect(getToolDescription(general.tools, "find_tools")).not.toContain("mcp_blocked.*");
    expect(general.directToolNames.has("find_tools")).toBe(true);
  });

  it("reuses one registry client while creating run-scoped MCP model projections", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});
    const client = new FakeMcpClient({
      first: { tools: [mcpToolDefinition("shared-wrapper")] },
    });
    const factory = new FakeClientFactory();
    factory.enqueue("shared", client);
    const registry = new McpRegistry({
      configPath: path.join(dataDir, "mcp-config.yaml"),
      reportFatalError: (error) => {
        throw error;
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([stdioDefinition("shared")])),
        createClient: factory.create,
      },
    });
    await registry.init();
    const registryTool = registry.getTools()[0];
    if (!registryTool) throw new Error("missing shared MCP tool");
    registryTool.tool.toModelOutput = () => ({
      type: "content",
      value: [{ type: "text", text: "projected" }],
    });
    const manager = createCoreToolPluginManager({
      runtime: { config: cfg, mcpRegistry: registry },
      dataDir,
    });
    await manager.init();
    const buildSession = (sessionId: string) =>
      manager.buildLevel1Toolset({
        cwd: dataDir,
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: cfg.agent.subagents,
        requestContext: {
          requestId: `request:${sessionId}`,
          sessionId,
          requestClient: "discord",
          subagentDepth: 0,
          subagentProfile: "primary",
        },
      });

    const [first, second] = await Promise.all([buildSession("first"), buildSession("second")]);
    const firstEntry = first.catalog.find((entry) => entry.stableId === registryTool.stableId);
    const secondEntry = second.catalog.find((entry) => entry.stableId === registryTool.stableId);
    if (!firstEntry || !secondEntry) throw new Error("missing run-scoped MCP tool");

    expect(factory.configs).toHaveLength(1);
    expect(factory.created).toEqual([client]);
    expect(Object.is(firstEntry.tool, registryTool.tool)).toBe(false);
    expect(Object.is(secondEntry.tool, registryTool.tool)).toBe(false);
    expect(Object.is(firstEntry.tool, secondEntry.tool)).toBe(false);
    expect(Object.is(first.tools[firstEntry.modelName], firstEntry.tool)).toBe(true);
    expect(Object.is(second.tools[secondEntry.modelName], secondEntry.tool)).toBe(true);

    await manager.destroy();
    await registry.shutdown();
    expect(client.closeCount).toBe(1);
  });

  it("updates batch membership for selected external tools while excluding opt-outs and MCP", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    await writeExternalPlugin({
      dataDir,
      pluginId: "batch-fixture",
      entryBody: `export default {
  meta: { id: "batch-fixture" },
  create() { return { level1: [
    { name: "allowed", createTool() { return { inputSchema: { type: "object" }, execute() { return "allowed"; } }; }, isEnabled() { return true; } },
    { name: "blocked", supportsBatch: false, createTool() { return { inputSchema: { type: "object" }, execute() { return "blocked"; } }; }, isEnabled() { return true; } },
  ] }; },
};`,
    });
    const cfg = testConfig({});
    const identity = { source: "mcp", sourceId: "server", rawToolName: "remote" } as const;
    const manager = createCoreToolPluginManager({
      runtime: {
        config: cfg,
        mcpRegistry: {
          async init() {},
          async reload() {
            return Result.ok([]);
          },
          getConfigStatus: () => ({ status: "valid" }),
          list: () => [],
          getCatalogServers: () => [],
          getTools: () => [
            {
              serverId: "server",
              rawName: "remote",
              identity,
              stableId: catalogToolStableId(identity),
              tool: convertedMcpTool("remote"),
            },
          ],
          async shutdown() {},
        },
      },
      dataDir,
    });
    await manager.init();
    const toolset = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "primary",
      editingToolMode: "none",
      subagentDepth: 0,
      subagentConfig: cfg.agent.subagents,
    });
    const allowed = toolset.catalog.find((entry) => entry.rawName === "allowed")?.modelName;
    const blocked = toolset.catalog.find((entry) => entry.rawName === "blocked")?.modelName;
    const remote = toolset.catalog.find((entry) => entry.source === "mcp")?.modelName;
    if (!allowed || !blocked || !remote) throw new Error("missing deferred test tools");

    toolset.updateActiveBatchTools(new Set([...toolset.directToolNames, allowed, blocked, remote]));

    expect(getBatchToolNames(toolset.tools)).toContain(allowed);
    expect(getBatchToolNames(toolset.tools)).not.toContain(blocked);
    expect(getBatchToolNames(toolset.tools)).not.toContain(remote);
  });

  it("uses the same native profile plugin gates with and without a request context", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    await writeExternalPlugin({
      dataDir,
      pluginId: "profile-fixture",
      entryBody: `import { Result } from ${JSON.stringify(import.meta.resolve("better-result"))};
export default {
  meta: { id: "profile-fixture" },
  create() { return {
    level1: [{
      name: "fixture_write",
      createTool() { return { execute() { return { ok: true }; } }; },
      isEnabled() { return true; },
    }],
    level2: [{
      id: "fixture",
      async init() {}, async destroy() {},
      async list() { return [{ callableId: "fixture.echo", name: "Fixture", description: "Fixture", shortInput: [] }]; },
      async call() { return Result.ok({ ok: true }); },
    }],
  }; },
};`,
    });
    const base = testConfig({});
    const makeManager = (enabled: boolean) =>
      createCoreToolPluginManager({
        runtime: {
          config: {
            ...base,
            agent: {
              ...base.agent,
              subagents: {
                ...base.agent.subagents,
                profiles: {
                  ...base.agent.subagents.profiles,
                  general: {
                    ...base.agent.subagents.profiles.general,
                    level1: {
                      ...base.agent.subagents.profiles.general.level1,
                      plugins: enabled ? ["profile-fixture"] : [],
                    },
                  },
                },
              },
            },
          },
        },
        dataDir,
      });
    const requestContext = {
      requestId: "profile-plugin",
      sessionId: "profile-plugin",
      requestClient: "unknown",
      subagentDepth: 1,
      subagentProfile: "general" as const,
    };

    const denied = makeManager(false);
    await denied.init();
    expect(
      (
        await denied.buildLevel1Toolset({
          cwd: dataDir,
          runProfile: "general",
          editingToolMode: "none",
          subagentDepth: 1,
          subagentConfig: base.agent.subagents!,
          requestContext,
        })
      ).specs.has("plugin_profile_fixture_fixture_write"),
    ).toBe(false);
    await denied.destroy();

    const enabled = makeManager(true);
    await enabled.init();
    expect(
      (
        await enabled.buildLevel1Toolset({
          cwd: dataDir,
          runProfile: "general",
          editingToolMode: "none",
          subagentDepth: 1,
          subagentConfig: base.agent.subagents!,
          requestContext,
        })
      ).specs.has("plugin_profile_fixture_fixture_write"),
    ).toBe(true);
    const direct = await enabled.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "general",
      editingToolMode: "none",
      subagentDepth: 1,
      subagentConfig: base.agent.subagents,
    });
    expect(direct.specs.has("plugin_profile_fixture_fixture_write")).toBe(true);
    await enabled.destroy();
  });

  it("turns malformed Level 1 hook results into a plain Core boundary failure", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    await writeExternalPlugin({
      dataDir,
      pluginId: "malformed-level1",
      entryBody: `export default {
  meta: { id: "malformed-level1" },
  create() { return { level1: [{
    name: "malformed",
    createTool() { return {}; },
    isEnabled() { return "yes"; },
  }] }; },
};`,
    });
    const cfg = testConfig({});
    const manager = createCoreToolPluginManager({ runtime: { config: cfg }, dataDir });
    const initialized = await manager.init();
    expect(initialized.status).toBe("ok");

    await expect(
      manager.buildLevel1Toolset({
        cwd: dataDir,
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: cfg.agent.subagents,
      }),
    ).rejects.toThrow("Invalid hook result for plugin 'malformed-level1'");
  });

  it("propagates Panic from a Level 1 hook", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    await writeExternalPlugin({
      dataDir,
      pluginId: "panic-level1",
      entryBody: `import { Panic } from ${JSON.stringify(import.meta.resolve("better-result"))};
export default {
  meta: { id: "panic-level1" },
  create() { return { level1: [{
    name: "panic",
    createTool() { return {}; },
    isEnabled() { throw new Panic({ message: "level1 invariant" }); },
  }] }; },
};`,
    });
    const cfg = testConfig({});
    const manager = createCoreToolPluginManager({ runtime: { config: cfg }, dataDir });
    const initialized = await manager.init();
    expect(initialized.status).toBe("ok");

    try {
      await manager.buildLevel1Toolset({
        cwd: dataDir,
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: cfg.agent.subagents,
      });
      throw new Error("expected Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
    }
  });
});
