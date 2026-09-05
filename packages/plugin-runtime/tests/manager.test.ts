import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Panic, Result } from "better-result";

import {
  ToolPluginManager,
  ToolPluginManagerHookError,
  ToolPluginSkipError,
  discoverExternalToolPlugins,
  invokeLevel2Call,
  type Level1ToolSpec,
  type LilacToolPlugin,
  type PluginLogger,
  type ServerTool,
} from "..";

type Runtime = { greeting?: string };

function createLevel1Spec(name: string): Level1ToolSpec<Runtime> {
  return {
    name,
    createTool() {
      return { execute: () => ({ ok: true }) };
    },
    isEnabled() {
      return true;
    },
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
      return Result.ok({ ok: true });
    },
  };
}

function manager(params: {
  dataDir: string;
  builtinPlugins?: readonly LilacToolPlugin<Runtime, Level1ToolSpec<Runtime>, ServerTool>[];
  getDisabledPluginIds?: () => Promise<readonly string[]> | readonly string[];
  getPluginConfig?: (pluginId: string) => Promise<unknown> | unknown;
  getLevel1RegistrationKey?: (
    spec: Level1ToolSpec<Runtime>,
    context: { pluginId: string; source: "builtin" | "external" },
  ) => string;
  logger?: PluginLogger;
}) {
  return new ToolPluginManager<Runtime, Level1ToolSpec<Runtime>, ServerTool>({
    runtime: {},
    dataDir: params.dataDir,
    builtinPlugins: params.builtinPlugins,
    getDisabledPluginIds: params.getDisabledPluginIds,
    getPluginConfig: params.getPluginConfig,
    getLevel1RegistrationKey: params.getLevel1RegistrationKey,
    logger: params.logger,
    adaptLevel1Item: (item) => item,
    adaptLevel2Item: (item) => item,
  });
}

async function initManager(value: ReturnType<typeof manager>): Promise<void> {
  const initialized = await value.init();
  expect(initialized.status).toBe("ok");
  if (initialized.status === "error") throw new Error(initialized.error.message);
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
    JSON.stringify({ name: params.pluginId, lilac: { plugin: entryRel } }),
    "utf8",
  );
  await fs.writeFile(entryPath, params.entryBody, "utf8");
}

describe("plugin runtime manager", () => {
  it("retires shared Level 1 and Level 2 resources after the last generation holder releases", async () => {
    const destroyed: number[] = [];
    let nextGeneration = 0;
    const value = manager({
      dataDir: "/tmp/plugin-runtime-generation-unused",
      builtinPlugins: [
        {
          meta: { id: "shared" },
          create() {
            const generation = ++nextGeneration;
            const state = { closed: false };
            return {
              level1: [
                {
                  ...createLevel1Spec("read"),
                  createTool: () => ({ execute: () => ({ generation, closed: state.closed }) }),
                },
              ],
              level2: [
                {
                  ...createServerTool("read"),
                  call: async () => Result.ok({ generation, closed: state.closed }),
                },
              ],
              destroy: async () => {
                state.closed = true;
                destroyed.push(generation);
              },
            };
          },
        },
      ],
    });
    await initManager(value);
    const run = value.acquireGeneration();
    const httpCall = value.acquireGeneration();
    expect((await value.reload()).status).toBe("ok");
    expect(destroyed).toEqual([]);
    expect(run.level1[0]).not.toBe(value.getLevel1Items()[0]);
    expect((await httpCall.level2[0]!.call("read", {})).unwrap()).toEqual({
      generation: 1,
      closed: false,
    });
    expect((await run.release()).status).toBe("ok");
    expect(destroyed).toEqual([]);
    expect((await httpCall.release()).status).toBe("ok");
    expect(destroyed).toEqual([1]);
    await httpCall.release();
    await run.release();
    expect(destroyed).toEqual([1]);
    expect((await value.destroy()).status).toBe("ok");
    expect(destroyed).toEqual([1, 2]);
  });

  it("defers shutdown cleanup and propagates its Panic through the final holder", async () => {
    const panic = new Panic({ message: "retired generation cleanup defect" });
    const value = manager({
      dataDir: "/tmp/plugin-runtime-generation-panic-unused",
      builtinPlugins: [
        {
          meta: { id: "cleanup" },
          create: () => ({
            level1: [createLevel1Spec("read")],
            destroy: async () => {
              throw panic;
            },
          }),
        },
      ],
    });
    await initManager(value);
    const run = value.acquireGeneration();
    expect((await value.destroy()).status).toBe("ok");
    expect(value.getLevel1Items()).toEqual([]);
    await expect(run.release()).rejects.toBe(panic);
    expect((await run.release()).status).toBe("ok");
  });

  it("returns deferred cleanup failures to the final generation holder", async () => {
    const value = manager({
      dataDir: "/tmp/plugin-runtime-generation-failure-unused",
      builtinPlugins: [
        {
          meta: { id: "cleanup" },
          create: () => ({
            level1: [createLevel1Spec("read")],
            destroy: async () => {
              throw new Error("connection close failed");
            },
          }),
        },
      ],
    });
    await initManager(value);
    const run = value.acquireGeneration();
    expect((await value.destroy()).status).toBe("ok");
    const released = await run.release();
    expect(released.status).toBe("error");
    if (released.status === "ok") throw new Error("expected retirement cleanup failure");
    expect(released.error.failures).toHaveLength(1);
  });

  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("returns discovery Results and rejects malformed package JSON without assertions", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const badDir = path.join(dataDir, "plugins", "broken-plugin");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "package.json"), "{not-json", "utf8");

    const discovered = await discoverExternalToolPlugins({ dataDir });
    expect(discovered.status).toBe("ok");
    if (discovered.status === "error") throw new Error(discovered.error.message);
    expect(discovered.value).toEqual([
      expect.objectContaining({
        type: "invalid",
        pluginId: "broken-plugin",
        reason: expect.stringContaining("Failed to parse package.json"),
      }),
    ]);
  });

  it("loads identity-preserved contributions and reloads changed transitive modules", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const pluginDir = path.join(dataDir, "plugins", "demo-plugin");
    await writePlugin({
      dataDir,
      pluginId: "demo-plugin",
      entryBody: `import { callableId, toolName } from "./dep.js";
const level1 = {
  name: toolName,
  createTool() { if (this !== level1) throw new Error("level1 receiver"); return {}; },
  isEnabled() { return true; },
};
const level2 = {
  id: "demo",
  async init() { if (this !== level2) throw new Error("level2 receiver"); },
  async destroy() {},
  async list() { if (this !== level2) throw new Error("list receiver"); return [{ callableId, name: "Demo", description: "Demo", shortInput: [] }]; },
  async call() {},
};
export default { meta: { id: "demo-plugin" }, create() { return { level1: [level1], level2: [level2] }; } };`,
    });
    await fs.writeFile(
      path.join(pluginDir, "dist", "dep.js"),
      'export const toolName = "demo_tool"; export const callableId = "demo.call";',
      "utf8",
    );

    const value = manager({ dataDir });
    await initManager(value);
    const firstLevel1 = value.getLevel1Items()[0]!;
    expect(firstLevel1.name).toBe("demo_tool");
    expect(value.getLevel1ContributionInfo().get(firstLevel1)).toEqual({
      pluginId: "demo-plugin",
      source: "external",
    });

    await fs.writeFile(
      path.join(pluginDir, "dist", "dep.js"),
      'export const toolName = "demo_tool_v2"; export const callableId = "demo.call.v2";',
      "utf8",
    );
    const refreshed = await value.ensureFresh();
    expect(refreshed.status).toBe("ok");
    expect(value.getLevel1Items().map((item) => item.name)).toEqual(["demo_tool_v2"]);
    expect(value.getStatuses()[0]).toEqual(
      expect.objectContaining({ state: "loaded", level2Ids: ["demo.call.v2"] }),
    );
  });

  it("marks malformed module, instance, Level 1, Level 2, and list results failed", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    const fixtures: Readonly<Record<string, string>> = {
      "bad-module": "export default {};",
      "bad-instance": 'export default { meta: { id: "bad-instance" }, create() { return null; } };',
      "bad-level1": `export default { meta: { id: "bad-level1" }, create() { return { level1: [{ name: "x", createTool() {} }] }; } };`,
      "bad-level2": `export default { meta: { id: "bad-level2" }, create() { return { level2: [{ id: "x", init() {}, destroy() {}, list() {} }] }; } };`,
      "bad-list": `export default { meta: { id: "bad-list" }, create() { return { level2: [{ id: "x", async init() {}, async destroy() {}, async list() { return [{ callableId: "x" }]; }, async call() {} }] }; } };`,
    };
    for (const [pluginId, entryBody] of Object.entries(fixtures)) {
      await writePlugin({ dataDir, pluginId, entryBody });
    }

    const value = manager({ dataDir });
    await initManager(value);
    expect(value.getStatuses().map((status) => [status.pluginId, status.state])).toEqual([
      ["bad-instance", "failed"],
      ["bad-level1", "failed"],
      ["bad-level2", "failed"],
      ["bad-list", "failed"],
      ["bad-module", "failed"],
    ]);
    expect(value.getLevel1Items()).toHaveLength(0);
    expect(value.getLevel2Items()).toHaveLength(0);
  });

  it("captures synchronous and asynchronous plugin failures into Results/status", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-plugin-runtime-"));
    const dataDir = path.join(tmpRoot, "data");
    await writePlugin({
      dataDir,
      pluginId: "sync-failure",
      entryBody:
        'export default { meta: { id: "sync-failure" }, create() { throw new Error("sync boom"); } };',
    });
    await writePlugin({
      dataDir,
      pluginId: "async-failure",
      entryBody:
        'export default { meta: { id: "async-failure" }, async create() { throw new Error("async boom"); } };',
    });

    const external = manager({ dataDir });
    await initManager(external);
    expect(external.getStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "sync-failure",
          reason: expect.stringContaining("sync boom"),
        }),
        expect.objectContaining({
          pluginId: "async-failure",
          reason: expect.stringContaining("async boom"),
        }),
      ]),
    );

    const builtin = manager({
      dataDir: path.join(tmpRoot, "empty"),
      builtinPlugins: [
        {
          meta: { id: "builtin-failure" },
          create() {
            throw new Error("builtin boom");
          },
        },
      ],
    });
    const failed = await builtin.init();
    expect(failed.status).toBe("error");
    if (failed.status === "ok") throw new Error("expected builtin failure");
    expect(failed.error._tag).toBe("ToolPluginHookError");
  });

  it("does not misclassify a tagged Level 1 contribution as a manager failure", async () => {
    const taggedSpec = Object.assign(
      new ToolPluginManagerHookError({
        hook: "adaptLevel1Item",
        pluginId: "tagged-success",
        cause: new Error("payload only"),
        message: "valid tagged contribution",
      }),
      {
        name: "tagged_success",
        createTool() {
          return {};
        },
        isEnabled() {
          return true;
        },
      },
    ) as ToolPluginManagerHookError & Level1ToolSpec<Runtime>;
    const value = manager({
      dataDir: "/tmp/plugin-runtime-tagged-success-unused",
      builtinPlugins: [
        {
          meta: { id: "tagged-success" },
          create: () => ({ level1: [taggedSpec] }),
        },
      ],
    });

    const initialized = await value.init();
    expect(initialized.status).toBe("ok");
    expect(value.getLevel1Items()).toEqual([taggedSpec]);
  });

  it("maps getPluginConfig failure and preserves Panic from its create continuation", async () => {
    const ordinary = manager({
      dataDir: "/tmp/plugin-runtime-config-failure-unused",
      builtinPlugins: [{ meta: { id: "config-failure" }, create: () => ({}) }],
      getPluginConfig() {
        throw new Error("config unavailable");
      },
    });
    const ordinaryResult = await ordinary.init();
    expect(ordinaryResult.status).toBe("error");
    if (ordinaryResult.status === "ok") throw new Error("expected config failure");
    expect(ordinaryResult.error._tag).toBe("ToolPluginManagerHookError");
    if (ordinaryResult.error._tag !== "ToolPluginManagerHookError") {
      throw new Error("expected manager hook error");
    }
    expect(ordinaryResult.error.hook).toBe("getPluginConfig");
    expect(ordinaryResult.error.message).toContain("config unavailable");

    const panic = new Panic({ message: "create continuation invariant" });
    const panicking = manager({
      dataDir: "/tmp/plugin-runtime-config-panic-unused",
      builtinPlugins: [
        {
          meta: { id: "config-panic" },
          create() {
            throw panic;
          },
        },
      ],
      getPluginConfig: () => ({ enabled: true }),
    });
    let caught: unknown;
    try {
      await panicking.init();
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(panic);
    expect(Panic.is(caught)).toBe(true);
  });

  it("aggregates every Level 2 and instance cleanup failure", async () => {
    const events: string[] = [];
    const failingTool = (id: string): ServerTool => ({
      id,
      async init() {},
      async destroy() {
        events.push(`destroy:${id}`);
        throw new Error(`destroy ${id}`);
      },
      async list() {
        return [{ callableId: id, name: id, description: id, shortInput: [] }];
      },
      async call() {
        return Result.ok();
      },
    });
    const value = manager({
      dataDir: "/tmp/plugin-runtime-cleanup-unused",
      builtinPlugins: [
        {
          meta: { id: "cleanup" },
          create() {
            return {
              level2: [failingTool("one"), failingTool("two")],
              async destroy() {
                events.push("destroy:instance");
                throw new Error("destroy instance");
              },
            };
          },
        },
      ],
    });
    await initManager(value);
    const destroyed = await value.destroy();
    expect(destroyed.status).toBe("error");
    if (destroyed.status === "ok") throw new Error("expected cleanup failure");
    expect(destroyed.error.failures).toHaveLength(3);
    expect(events).toEqual(["destroy:two", "destroy:one", "destroy:instance"]);
    expect(value.getStatuses()).toEqual([]);
  });

  it("continues all cleanup hooks and preserves the first Panic", async () => {
    const firstPanic = new Panic({ message: "first cleanup invariant" });
    const laterPanic = new Panic({ message: "later cleanup invariant" });
    const events: string[] = [];
    const tool = (id: string, failure?: Error): ServerTool => ({
      id,
      async init() {},
      async destroy() {
        events.push(`destroy:${id}`);
        if (failure) throw failure;
      },
      async list() {
        return [{ callableId: id, name: id, description: id, shortInput: [] }];
      },
      async call() {
        return Result.ok();
      },
    });
    const value = manager({
      dataDir: "/tmp/plugin-runtime-cleanup-panic-unused",
      builtinPlugins: [
        {
          meta: { id: "cleanup-panic" },
          create() {
            return {
              level2: [
                tool("one", laterPanic),
                tool("two", new Error("ordinary cleanup failure")),
                tool("three", firstPanic),
              ],
              async destroy() {
                events.push("destroy:instance");
                throw laterPanic;
              },
            };
          },
        },
      ],
    });
    await initManager(value);

    let caught: unknown;
    try {
      await value.destroy();
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(firstPanic);
    expect(events).toEqual(["destroy:three", "destroy:two", "destroy:one", "destroy:instance"]);
    expect(value.getStatuses()).toEqual([]);
  });

  it("keeps skip compatibility and propagates Panic", async () => {
    const skipped = manager({
      dataDir: "/tmp/plugin-runtime-skip-unused",
      builtinPlugins: [
        {
          meta: { id: "optional" },
          create() {
            throw new ToolPluginSkipError("capability unavailable");
          },
        },
      ],
    });
    await initManager(skipped);
    expect(skipped.getStatuses()).toEqual([
      expect.objectContaining({
        pluginId: "optional",
        state: "skipped",
        reason: "capability unavailable",
      }),
    ]);

    const panic = new Panic({ message: "invariant" });
    const panicking = manager({
      dataDir: "/tmp/plugin-runtime-panic-unused",
      builtinPlugins: [
        {
          meta: { id: "panic" },
          create() {
            throw panic;
          },
        },
      ],
    });
    try {
      await panicking.init();
      throw new Error("expected Panic");
    } catch (cause) {
      expect(cause).toBe(panic);
      expect(Panic.is(cause)).toBe(true);
    }
  });

  it("validates disabled-id hook results and reports disabled status", async () => {
    const disabled = manager({
      dataDir: "/tmp/plugin-runtime-disabled-unused",
      builtinPlugins: [
        { meta: { id: "disabled" }, create: () => ({ level1: [createLevel1Spec("unused")] }) },
      ],
      getDisabledPluginIds: () => ["disabled"],
    });
    await initManager(disabled);
    expect(disabled.getStatuses()).toEqual([
      expect.objectContaining({ pluginId: "disabled", state: "disabled" }),
    ]);

    const malformedDisabledIds = new Proxy(() => ["valid"], {
      apply: () => [1],
    });
    const malformed = manager({
      dataDir: "/tmp/plugin-runtime-disabled-invalid-unused",
      getDisabledPluginIds: malformedDisabledIds,
    });
    const invalidResult = await malformed.init();
    expect(invalidResult.status).toBe("error");
    if (invalidResult.status === "ok") throw new Error("expected malformed disabled ids");
    expect(invalidResult.error._tag).toBe("ToolPluginCapabilityError");
  });

  it("preserves plugin, instance, item identities and method receivers", async () => {
    const level1 = createLevel1Spec("identity");
    const level2 = createServerTool("identity.call");
    const instance = {
      level1: [level1],
      level2: [level2],
      initialized: false,
      async init() {
        if (this !== instance) throw new Error("instance init receiver");
        this.initialized = true;
      },
      async destroy() {
        if (this !== instance) throw new Error("instance destroy receiver");
      },
    };
    const plugin = {
      meta: { id: "identity" },
      create() {
        if (this !== plugin) throw new Error("plugin receiver");
        return instance;
      },
    } satisfies LilacToolPlugin<Runtime, Level1ToolSpec<Runtime>, ServerTool>;
    const value = manager({
      dataDir: "/tmp/plugin-runtime-identity-unused",
      builtinPlugins: [plugin],
    });
    await initManager(value);
    expect(instance.initialized).toBe(true);
    expect(Object.is(value.getLevel1Items()[0], level1)).toBe(true);
    expect(Object.is(value.getLevel2Items()[0], level2)).toBe(true);
    const destroyed = await value.destroy();
    expect(destroyed.status).toBe("ok");
  });

  it("captures stateful capability getters once and preserves plugin attribution", async () => {
    const reads = new Map<string, number>();
    const read = (name: string) => reads.set(name, (reads.get(name) ?? 0) + 1);
    let livePluginId = "stable-id";
    let listCalls = 0;
    let callReceiverMatches = false;
    const meta = {
      get id() {
        read("meta.id");
        return livePluginId;
      },
    };
    const tool: ServerTool = {
      get id() {
        read("tool.id");
        return "stateful-tool";
      },
      get init() {
        read("tool.init");
        return async function (this: unknown) {
          expect(this).toBe(tool);
        };
      },
      get destroy() {
        read("tool.destroy");
        return async function (this: unknown) {
          expect(this).toBe(tool);
        };
      },
      get list() {
        read("tool.list");
        return async function (this: unknown) {
          expect(this).toBe(tool);
          listCalls += 1;
          const callableId = listCalls === 1 ? "stable.call" : "unstable.call";
          return [{ callableId, name: callableId, description: callableId, shortInput: [] }];
        };
      },
      get call() {
        read("tool.call");
        return async function (this: unknown) {
          callReceiverMatches = this === tool;
          return Result.ok({ ok: true });
        };
      },
    };
    const instance = {
      get level1() {
        read("instance.level1");
        return [];
      },
      get level2() {
        read("instance.level2");
        return [tool];
      },
    };
    const plugin = {
      get meta() {
        read("plugin.meta");
        return meta;
      },
      get create() {
        read("plugin.create");
        return function (this: unknown) {
          expect(this).toBe(plugin);
          livePluginId = "mutated-id";
          return instance;
        };
      },
    } satisfies LilacToolPlugin<Runtime, Level1ToolSpec<Runtime>, ServerTool>;
    const value = manager({
      dataDir: "/tmp/plugin-runtime-captured-capabilities-unused",
      builtinPlugins: [plugin],
    });

    await initManager(value);
    expect(value.getStatuses()).toEqual([
      expect.objectContaining({ pluginId: "stable-id", level2Ids: ["stable.call"] }),
    ]);
    expect(value.getLevel2ContributionInfo().get(tool)).toEqual({
      pluginId: "stable-id",
      source: "builtin",
    });
    const called = await invokeLevel2Call({
      pluginId: "stable-id",
      source: "builtin",
      tool,
      capability: value.getLevel2Capabilities().get(tool),
      callableId: "stable.call",
      input: {},
    });
    expect(called.status).toBe("ok");
    expect(callReceiverMatches).toBe(true);
    expect(listCalls).toBe(1);
    for (const name of [
      "plugin.meta",
      "plugin.create",
      "meta.id",
      "instance.level1",
      "instance.level2",
      "tool.id",
      "tool.init",
      "tool.destroy",
      "tool.list",
      "tool.call",
    ]) {
      expect(reads.get(name)).toBe(1);
    }
    expect((await value.destroy()).status).toBe("ok");
  });

  it("initializes Level 2 tools before reading their callable catalogs", async () => {
    let initialized = false;
    const tool: ServerTool = {
      id: "init-dependent",
      async init() {
        initialized = true;
      },
      async destroy() {},
      async list() {
        if (!initialized) throw new Error("list called before init");
        return [
          {
            callableId: "init-dependent.call",
            name: "Init dependent",
            description: "Init dependent",
            shortInput: [],
          },
        ];
      },
      async call() {
        return Result.ok();
      },
    };
    const value = manager({
      dataDir: "/tmp/plugin-runtime-init-dependent-list-unused",
      builtinPlugins: [{ meta: { id: "init-dependent" }, create: () => ({ level2: [tool] }) }],
    });

    await initManager(value);
    expect(initialized).toBe(true);
    expect(value.getStatuses()[0]).toEqual(
      expect.objectContaining({ level2Ids: ["init-dependent.call"] }),
    );
    expect((await value.destroy()).status).toBe("ok");
  });

  it("keeps an operation Panic when every initialized cleanup path also fails", async () => {
    const operationPanic = new Panic({ message: "list invariant" });
    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    const events: string[] = [];
    const reports: unknown[][] = [];
    const tool: ServerTool = {
      id: "operation-panic",
      async init() {
        events.push("init:tool");
      },
      async destroy() {
        events.push("destroy:tool");
        throw cleanupPanic;
      },
      async list() {
        throw operationPanic;
      },
      async call() {
        return Result.ok();
      },
    };
    const value = manager({
      dataDir: "/tmp/plugin-runtime-operation-panic-unused",
      logger: { error: (...args) => reports.push([...args]) },
      builtinPlugins: [
        {
          meta: { id: "operation-panic" },
          create() {
            return {
              level2: [tool],
              async destroy() {
                events.push("destroy:instance");
                throw cleanupPanic;
              },
            };
          },
        },
      ],
    });

    let caught: unknown;
    try {
      await value.init();
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(operationPanic);
    expect(events).toEqual(["init:tool", "destroy:tool", "destroy:instance"]);
    expect(reports).toEqual([
      [
        "Plugin cleanup failed after operation Panic",
        { pluginId: "operation-panic", detail: "cleanup rejected with Panic" },
      ],
    ]);
    expect(value.getStatuses()).toEqual([]);
  });

  it("reports cleanup failure after committing reload without reverting new state", async () => {
    let generation = 0;
    const plugin: LilacToolPlugin<Runtime, Level1ToolSpec<Runtime>, ServerTool> = {
      meta: { id: "committed-reload" },
      create() {
        generation += 1;
        const current = generation;
        return {
          level1: [createLevel1Spec(`generation-${current}`)],
          async destroy() {
            if (current === 1) throw new Error("old cleanup failed");
          },
        };
      },
    };
    const value = manager({
      dataDir: "/tmp/plugin-runtime-committed-reload-unused",
      builtinPlugins: [plugin],
    });
    await initManager(value);

    const reloaded = await value.reload();
    expect(reloaded.status).toBe("error");
    if (reloaded.status === "ok") throw new Error("expected committed cleanup failure");
    expect(reloaded.error._tag).toBe("ToolPluginReloadCommittedCleanupError");
    expect(value.getLevel1Items()[0]?.name).toBe("generation-2");
    expect(value.getStatuses()[0]).toEqual(
      expect.objectContaining({ pluginId: "committed-reload", state: "loaded" }),
    );
  });

  it("keeps old state on failed reload", async () => {
    let failReload = false;
    const plugin: LilacToolPlugin<Runtime, Level1ToolSpec<Runtime>, ServerTool> = {
      meta: { id: "reload" },
      create() {
        if (failReload) throw new Error("reload failed");
        return { level1: [createLevel1Spec("stable")] };
      },
    };
    const value = manager({
      dataDir: "/tmp/plugin-runtime-reload-unused",
      builtinPlugins: [plugin],
    });
    await initManager(value);
    const original = value.getLevel1Items()[0];
    failReload = true;
    const reloaded = await value.reload();
    expect(reloaded.status).toBe("error");
    expect(Object.is(value.getLevel1Items()[0], original)).toBe(true);
    expect(value.getStatuses()[0]).toEqual(
      expect.objectContaining({ pluginId: "reload", state: "loaded" }),
    );
  });

  it("returns duplicate registration as a Result and leaves status/state empty", async () => {
    const value = manager({
      dataDir: "/tmp/plugin-runtime-duplicate-unused",
      builtinPlugins: [
        { meta: { id: "one" }, create: () => ({ level1: [createLevel1Spec("shared")] }) },
        { meta: { id: "two" }, create: () => ({ level1: [createLevel1Spec("shared")] }) },
      ],
    });
    const initialized = await value.init();
    expect(initialized.status).toBe("error");
    expect(value.getStatuses()).toEqual([]);
    expect(value.getLevel1Items()).toEqual([]);
  });
});
