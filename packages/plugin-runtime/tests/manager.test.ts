import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ToolPluginManager,
  ToolPluginSkipError,
  discoverExternalToolPlugins,
  type Level1ToolSpec,
  type ServerTool,
} from "..";

type Runtime = {
  greeting?: string;
};

function createLevel1Spec(name: string): Level1ToolSpec<Runtime> {
  return {
    name,
    createTool: () => ({ execute: () => ({ ok: true }) }),
    isEnabled: () => true,
  };
}

function createServerTool(callableId: string): ServerTool {
  return {
    id: callableId,
    async init() {},
    async destroy() {},
    async list() {
      return [
        {
          callableId,
          name: callableId,
          description: callableId,
          shortInput: [],
          input: [],
        },
      ];
    },
    async call() {
      return { ok: true };
    },
  };
}

async function writePlugin(params: {
  dataDir: string;
  pluginId: string;
  entryBody: string;
  pluginPath?: string;
}): Promise<void> {
  const pluginDir = path.join(params.dataDir, "plugins", params.pluginId);
  const entryRel = params.pluginPath ?? "./dist/index.js";
  const entryPath = path.join(pluginDir, entryRel.replace(/^\.\//u, ""));

  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: params.pluginId,
        version: "0.0.1",
        lilac: {
          plugin: entryRel,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(entryPath, params.entryBody, "utf8");
}

describe("plugin runtime manager", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("discovers external plugin packages and flags invalid lilac.plugin config", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const badDir = path.join(dataDir, "plugins", "broken-plugin");

    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "package.json"),
      JSON.stringify({ name: "broken-plugin" }, null, 2),
      "utf8",
    );

    const discovered = await discoverExternalToolPlugins({ dataDir });
    expect(discovered).toEqual([
      expect.objectContaining({
        type: "invalid",
        pluginId: "broken-plugin",
      }),
    ]);
  });

  it("loads external plugin contributions and reloads when entrypoint changes", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePlugin({
      dataDir,
      pluginId: "demo-plugin",
      entryBody: `export default {
  meta: { id: "demo-plugin" },
  create() {
    return {
      level1: [{ name: "demo_tool", createTool() { return { execute() { return { ok: true }; } }; }, isEnabled() { return true; } }],
      level2: [{
        id: "demo",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "demo.call", name: "Demo", description: "Demo", shortInput: [], input: [] }]; },
        async call() { return { value: 1 }; },
      }],
    };
  },
};`,
    });

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
    });

    await manager.init();
    expect(manager.getLevel1Items().map((spec) => spec.name)).toEqual(["demo_tool"]);
    expect((await manager.getLevel2Items()[0]!.list()).map((entry) => entry.callableId)).toEqual([
      "demo.call",
    ]);

    await Bun.sleep(5);
    await writePlugin({
      dataDir,
      pluginId: "demo-plugin",
      entryBody: `export default {
  meta: { id: "demo-plugin" },
  create() {
    return {
      level1: [{ name: "demo_tool_v2", createTool() { return { execute() { return { ok: true }; } }; }, isEnabled() { return true; } }],
      level2: [{
        id: "demo",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "demo.call.v2", name: "Demo", description: "Demo", shortInput: [], input: [] }]; },
        async call() { return { value: 2 }; },
      }],
    };
  },
};`,
    });

    await manager.ensureFresh();
    expect(manager.getLevel1Items().map((spec) => spec.name)).toEqual(["demo_tool_v2"]);
    expect((await manager.getLevel2Items()[0]!.list()).map((entry) => entry.callableId)).toEqual([
      "demo.call.v2",
    ]);
  });

  it("reloads when a transitive plugin file changes", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const pluginDir = path.join(dataDir, "plugins", "demo-plugin");

    await writePlugin({
      dataDir,
      pluginId: "demo-plugin",
      entryBody: `import { callableId, toolName, value } from "./dep.js";

export default {
  meta: { id: "demo-plugin" },
  create() {
    return {
      level1: [{ name: toolName, createTool() { return { execute() { return { ok: true }; } }; }, isEnabled() { return true; } }],
      level2: [{
        id: "demo",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId, name: "Demo", description: "Demo", shortInput: [], input: [] }]; },
        async call() { return { value }; },
      }],
    };
  },
};`,
    });
    await fs.writeFile(
      path.join(pluginDir, "dist", "dep.js"),
      `export const toolName = "demo_tool";
export const callableId = "demo.call";
export const value = 1;
`,
      "utf8",
    );

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
    });

    await manager.init();
    expect(manager.getLevel1Items().map((spec) => spec.name)).toEqual(["demo_tool"]);

    await Bun.sleep(5);
    await fs.writeFile(
      path.join(pluginDir, "dist", "dep.js"),
      `export const toolName = "demo_tool_v2";
export const callableId = "demo.call.v2";
export const value = 2;
`,
      "utf8",
    );

    await manager.ensureFresh();
    expect(manager.getLevel1Items().map((spec) => spec.name)).toEqual(["demo_tool_v2"]);
    expect((await manager.getLevel2Items()[0]!.list()).map((entry) => entry.callableId)).toEqual([
      "demo.call.v2",
    ]);
  });

  it("marks disabled, skipped, and failed plugins in status output", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePlugin({
      dataDir,
      pluginId: "disabled-plugin",
      entryBody: `export default { meta: { id: "disabled-plugin" }, create() { return {}; } };`,
    });
    await writePlugin({
      dataDir,
      pluginId: "failed-plugin",
      entryBody: `throw new Error("boom");`,
    });

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      builtinPlugins: [
        {
          meta: { id: "skipped-builtin" },
          create() {
            throw new ToolPluginSkipError("optional capability missing");
          },
        },
      ],
      getDisabledPluginIds: () => ["disabled-plugin"],
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
    });

    await manager.init();

    expect(manager.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "skipped-builtin", state: "skipped" }),
        expect.objectContaining({ pluginId: "disabled-plugin", state: "disabled" }),
        expect.objectContaining({ pluginId: "failed-plugin", state: "failed" }),
      ]),
    );
  });

  it("runs Level 2 lifecycle hooks during init, reload, and destroy", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const events: string[] = [];

    await writePlugin({
      dataDir,
      pluginId: "lifecycle-plugin",
      entryBody: `export default {
  meta: { id: "lifecycle-plugin" },
  create() {
    return {
      level2: [{
        id: "lifecycle",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "lifecycle.call", name: "Lifecycle", description: "Lifecycle", shortInput: [], input: [] }]; },
        async call() { return { ok: true }; },
      }],
    };
  },
};`,
    });

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: (tool) => {
        events.push(`init:${tool.id}`);
      },
      destroyLevel2Item: (tool) => {
        events.push(`destroy:${tool.id}`);
      },
    });

    await manager.init();
    await manager.reload();
    await manager.destroy();

    expect(events).toEqual([
      "init:lifecycle",
      "init:lifecycle",
      "destroy:lifecycle",
      "destroy:lifecycle",
    ]);
  });

  it("fails startup when a builtin Level 2 init hook fails", async () => {
    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir: "/tmp/unused",
      builtinPlugins: [
        {
          meta: { id: "builtin-base" },
          create() {
            return {
              level2: [createServerTool("builtin.call")],
            };
          },
        },
      ],
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: (tool) => {
        throw new Error(`boom:${tool.id}`);
      },
    });

    await expect(manager.init()).rejects.toThrow("boom:builtin.call");
  });

  it("marks external plugins failed when Level 2 init fails", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePlugin({
      dataDir,
      pluginId: "broken-level2",
      entryBody: `export default {
  meta: { id: "broken-level2" },
  create() {
    return {
      level2: [{
        id: "broken",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "broken.call", name: "Broken", description: "Broken", shortInput: [], input: [] }]; },
        async call() { return { ok: true }; },
      }],
    };
  },
};`,
    });

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: (tool) => {
        if (tool.id === "broken") {
          throw new Error("level2 init boom");
        }
      },
    });

    await manager.init();

    expect(manager.getLevel2Items()).toHaveLength(0);
    expect(manager.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "broken-level2",
          state: "failed",
          reason: "level2 init boom",
        }),
      ]),
    );
  });

  it("rejects duplicate Level 1 and Level 2 contributions from external plugins", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePlugin({
      dataDir,
      pluginId: "dupe-level1",
      entryBody: `export default {
  meta: { id: "dupe-level1" },
  create() {
    return {
      level1: [{ name: "builtin_tool", createTool() { return {}; }, isEnabled() { return true; } }],
    };
  },
};`,
    });
    await writePlugin({
      dataDir,
      pluginId: "dupe-level2",
      entryBody: `export default {
  meta: { id: "dupe-level2" },
  create() {
    return {
      level2: [{
        id: "dupe-level2",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "builtin.call", name: "dup", description: "dup", shortInput: [], input: [] }]; },
        async call() { return {}; },
      }],
    };
  },
};`,
    });

    const manager = new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
      runtime: {},
      dataDir,
      builtinPlugins: [
        {
          meta: { id: "builtin-base" },
          create() {
            return {
              level1: [createLevel1Spec("builtin_tool")],
              level2: [createServerTool("builtin.call")],
            };
          },
        },
      ],
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
    });

    await manager.init();

    expect(manager.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "builtin-base", state: "loaded" }),
        expect.objectContaining({ pluginId: "dupe-level1", state: "failed" }),
        expect.objectContaining({ pluginId: "dupe-level2", state: "failed" }),
      ]),
    );
  });
});
