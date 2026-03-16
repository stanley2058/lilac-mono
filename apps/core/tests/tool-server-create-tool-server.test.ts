import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolPluginManager, type Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

import {
  createToolServer,
  type ToolServerHealthSnapshot,
} from "../src/tool-server/create-tool-server";
import type { ServerTool } from "../src/tool-server/types";

async function writePluginServerTool(params: {
  dataDir: string;
  pluginId: string;
  callableId: string;
  value: string;
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
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
  meta: { id: "${params.pluginId}" },
  create() {
    return {
      level2: [{
        id: "${params.pluginId}",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "${params.callableId}", name: "${params.callableId}", description: "${params.callableId}", shortInput: [], input: [] }]; },
        async call() { return { value: "${params.value}" }; },
      }],
    };
  },
};`,
    "utf8",
  );
}

describe("createToolServer", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("passes x-lilac request context and cached messages to tool.call", async () => {
    const seenCalls: Array<{
      callableId: string;
      input: Record<string, unknown>;
      requestId?: string;
      sessionId?: string;
      requestClient?: string;
      cwd?: string;
      messages?: readonly unknown[];
    }> = [];

    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "test.echo",
            name: "Test Echo",
            description: "echo",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId, input, opts) {
        seenCalls.push({
          callableId,
          input,
          requestId: opts?.context?.requestId,
          sessionId: opts?.context?.sessionId,
          requestClient: opts?.context?.requestClient,
          cwd: opts?.context?.cwd,
          messages: opts?.messages,
        });
        return { ok: true, echo: input };
      },
    };

    const cachedMessages = [{ role: "user", content: "cached" }];
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get(requestId: string) {
          return requestId === "req:1" ? cachedMessages : undefined;
        },
      },
    });

    await server.init();

    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lilac-request-id": "req:1",
          "x-lilac-session-id": "chan",
          "x-lilac-request-client": "discord",
          "x-lilac-cwd": "/tmp/work",
        },
        body: JSON.stringify({
          callableId: "test.echo",
          input: { hello: "world" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ isError: false, output: { ok: true, echo: { hello: "world" } } });

    const captured = seenCalls[0]!;
    expect(captured.callableId).toBe("test.echo");
    expect(captured.input).toEqual({ hello: "world" });
    expect(captured.requestId).toBe("req:1");
    expect(captured.sessionId).toBe("chan");
    expect(captured.requestClient).toBe("discord");
    expect(captured.cwd).toBe("/tmp/work");
    expect(captured.messages).toEqual(cachedMessages);
  });

  it("supports plugin-backed list/call/reload flows", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
    });

    const server = createToolServer({
      pluginManager,
    });

    await server.init();

    const firstList = await server.app.handle(new Request("http://localhost/list"));
    expect(firstList.status).toBe(200);
    expect(await firstList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call",
          name: "echo.call",
          description: "echo.call",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const firstCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call", input: {} }),
      }),
    );
    expect(await firstCall.json()).toEqual({ isError: false, output: { value: "one" } });

    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call.v2",
      value: "two",
    });

    const reload = await server.app.handle(
      new Request("http://localhost/reload", {
        method: "POST",
      }),
    );
    expect(await reload.json()).toEqual({ ok: true });

    const secondList = await server.app.handle(new Request("http://localhost/list"));
    expect(await secondList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call.v2",
          name: "echo.call.v2",
          description: "echo.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const secondCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call.v2", input: {} }),
      }),
    );
    expect(await secondCall.json()).toEqual({ isError: false, output: { value: "two" } });

    await server.stop();
  });

  it("refreshes plugin-backed call mapping on list/help/call without explicit reload", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: async (tool) => {
        await tool.init();
      },
      destroyLevel2Item: async (tool) => {
        await tool.destroy();
      },
    });

    const server = createToolServer({ pluginManager });
    await server.init();

    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call.v2",
      value: "two",
    });

    const listRes = await server.app.handle(new Request("http://localhost/list"));
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "fresh.call.v2",
          name: "fresh.call.v2",
          description: "fresh.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const helpRes = await server.app.handle(new Request("http://localhost/help/fresh.call.v2"));
    expect(helpRes.status).toBe(200);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fresh.call.v2", input: {} }),
      }),
    );
    expect(await callRes.json()).toEqual({ isError: false, output: { value: "two" } });

    await server.stop();
  });

  it("reports live and ready health separately", async () => {
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.ready",
            ok: false,
            impact: "ready",
            reason: "warming up",
          },
        ],
        info: {
          runtime: {
            state: "warming",
          },
        },
      }),
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
        maxHeapUsageRatio: 2,
      },
    });

    await server.init();
    await server.start(0);
    await Bun.sleep(5);
    server.recordUnhandledRejection(new Error("timer exploded"));

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    const healthBody = (await healthRes.json()) as {
      live: boolean;
      ready: boolean;
      info: {
        external?: Record<string, unknown>;
        unhandledRejection?: {
          count: number;
          lastReason: string;
        };
      };
    };
    expect(healthBody.live).toBe(true);
    expect(healthBody.ready).toBe(false);
    expect(healthBody.info.external).toEqual({
      runtime: {
        state: "warming",
      },
    });
    expect(healthBody.info.unhandledRejection).toMatchObject({
      count: 1,
      lastReason: "timer exploded",
    });

    const readyRes = await server.app.handle(new Request("http://localhost/readyz"));
    const readyBody = (await readyRes.json()) as {
      ready: boolean;
    };
    expect(readyBody.ready).toBe(false);

    await server.stop();
  });

  it("times out tool calls and marks wedged calls unhealthy", async () => {
    const tool: ServerTool = {
      id: "hang",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "hang.forever",
            name: "Hang Forever",
            description: "never resolves",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        return await new Promise(() => {});
      },
    };

    const server = createToolServer({
      tools: [tool],
      toolCallTimeouts: {
        defaultTimeoutMs: 20,
      },
      healthConfig: {
        toolCallOverdueGraceMs: 10,
      },
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "hang.forever",
          input: {},
        }),
      }),
    );
    expect(callRes.status).toBe(200);
    expect(await callRes.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 20ms",
    });

    await Bun.sleep(20);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(503);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(false);

    await server.stop();
  });

  it("invokes the unhealthy watchdog after repeated live failures", async () => {
    const unhealthySnapshots: ToolServerHealthSnapshot[] = [];
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.redis",
            ok: false,
            impact: "live",
            reason: "redis ping failed",
          },
        ],
      }),
      onUnhealthy: async (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
      healthConfig: {
        watchdogIntervalMs: 10,
        watchdogFailureThreshold: 2,
      },
    });

    await server.init();
    await server.start(0);

    await Bun.sleep(40);

    expect(unhealthySnapshots).toHaveLength(1);
    expect(
      unhealthySnapshots[0]?.checks.find(
        (check: ToolServerHealthSnapshot["checks"][number]) => check.name === "runtime.redis",
      )?.ok,
    ).toBe(false);

    await server.stop();
  });
});
