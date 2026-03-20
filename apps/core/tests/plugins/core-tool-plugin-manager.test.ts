import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { coreConfigSchema, type CoreConfig } from "@stanley2058/lilac-utils";

import { createCoreToolPluginManager } from "../../src/plugins";
import type { SurfaceAdapter } from "../../src/surface/adapter";

const EXPECTED_STABLE_LEVEL2_CALLABLE_IDS = [
  "attachment.add_files",
  "attachment.download",
  "codex.login",
  "codex.logout",
  "codex.status",
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
  "search",
  "skills.brief",
  "skills.full",
  "skills.list",
  "ssh.hosts",
  "ssh.probe",
  "ssh.run",
  "summarize",
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
  "workflow.cancel",
  "workflow.list",
  "workflow.schedule",
  "workflow.wait_for_reply.create",
  "workflow.wait_for_reply.send_and_wait",
].sort();

const OPTIONAL_DYNAMIC_LEVEL2_CALLABLE_IDS = new Set(["generate.image", "generate.video"]);

function testConfig(input: unknown): CoreConfig {
  const cfg = coreConfigSchema.parse(input);
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
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("preserves built-in Level 1 tool exposure across profiles and edit modes", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        adapter: {} as SurfaceAdapter,
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
      "apply_patch",
      "bash",
      "batch",
      "glob",
      "grep",
      "read_file",
      "subagent_delegate",
    ]);

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
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "subagent_delegate",
    ]);

    const exploreTools = await manager.buildLevel1Toolset({
      cwd: dataDir,
      runProfile: "explore",
      editingToolMode: "none",
      subagentDepth: 1,
      subagentConfig: cfg.agent.subagents!,
    });
    expect([...exploreTools.specs.keys()].sort()).toEqual(["batch", "glob", "grep", "read_file"]);
  });

  it("preserves built-in Level 2 callable ids", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        adapter: {} as SurfaceAdapter,
        config: cfg,
      },
      dataDir,
    });

    await manager.init();

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
  });

  it("skips capability-dependent plugins in dev mode", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-plugin-manager-"));
    const dataDir = path.join(tmpRoot, "data");
    const cfg = testConfig({});

    const manager = createCoreToolPluginManager({
      runtime: {
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
      entryBody: `export default {
  meta: { id: "fixture-plugin" },
  create() {
    return {
      level1: [{
        name: "fixture_level1",
        supportsBatch: true,
        createTool() { return { execute() { return { ok: true }; } }; },
        isEnabled() { return true; },
        formatArgs() { return " fixture"; },
      }],
      level2: [{
        id: "fixture",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "fixture.echo", name: "Fixture Echo", description: "Fixture", shortInput: [], input: [] }]; },
        async call(_callableId, input) { return { echo: input }; },
      }],
    };
  },
};`,
    });

    const manager = createCoreToolPluginManager({
      runtime: {
        bus: {} as LilacBus,
        adapter: {} as SurfaceAdapter,
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
    expect(level1.specs.has("fixture_level1")).toBe(true);

    const callableIds = (
      await Promise.all(
        manager
          .getLevel2Tools()
          .map(async (tool) => (await tool.list()).map((entry) => entry.callableId)),
      )
    ).flat();
    expect(callableIds).toContain("fixture.echo");
  });
});
