import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";

import { ConfigFiles } from "../../src/runtime/config-files";
import { createToolServer } from "../../src/tool-server/create-tool-server";
import { ConfigManagement } from "../../src/tool-server/tools/config";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const CORE = "configVersion: 3\nagent:\n  subagents:\n    maxDepth: 1\n";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-tool-"));
  dirs.push(dataDir);
  await fs.writeFile(path.join(dataDir, "core-config.yaml"), CORE);
  let reloads = 0;
  const tool = new ConfigManagement({
    files: new ConfigFiles({ dataDir }),
    registry: {
      reload: async () => {
        reloads += 1;
        return Result.ok([{ serverId: "docs", reconciliation: "new", result: "available" }]);
      },
    },
  });
  return { dataDir, tool, reloads: () => reloads };
}

function valueOf(result: Awaited<ReturnType<ConfigManagement["call"]>>) {
  return result.match({ ok: (value) => value, err: (error) => ({ error }) });
}

describe("config callables", () => {
  it("describes a field with its default, current value, and explicit state", async () => {
    const { tool } = await fixture();
    expect(
      valueOf(
        await tool.call("config.describe", { file: "core", path: "agent.subagents.maxDepth" }),
      ),
    ).toMatchObject({
      file: "core-config.yaml",
      configVersion: 3,
      path: "agent.subagents.maxDepth",
      type: { types: ["integer"] },
      restart: false,
      explicitlySet: true,
      current: 1,
      default: 2,
    });
    expect(
      valueOf(await tool.call("config.describe", { file: "core", path: "surface.native.port" })),
    ).toMatchObject({ restart: true, explicitlySet: false });
    const subagents = valueOf(
      await tool.call("config.describe", { file: "core", path: "agent.subagents" }),
    );
    expect(JSON.stringify(subagents)).toContain('"key":"maxDepth"');
  });

  it("searches fields and lists top-level sections", async () => {
    const { tool } = await fixture();
    const query = valueOf(await tool.call("config.describe", { file: "core", query: "MAXDEPTH" }));
    expect(query).toMatchObject({
      fields: expect.arrayContaining([
        { path: "agent.subagents.maxDepth", description: expect.stringContaining("depth") },
      ]),
    });
    const sections = valueOf(await tool.call("config.describe", { file: "core" }));
    expect(JSON.stringify(sections)).toContain('"key":"agent"');
  });

  it("patches, reports the diff, and rejects unknown paths with the nearest parent", async () => {
    const { tool, dataDir } = await fixture();
    const patched = valueOf(
      await tool.call("config.patch", {
        file: "core",
        operations: [{ op: "set", path: "agent.subagents.maxDepth", value: 2 }],
      }),
    );
    expect(patched).toMatchObject({ changed: true, written: true, dryRun: false });
    expect(JSON.stringify(patched)).toContain("+    maxDepth: 2");
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toContain(
      "maxDepth: 2",
    );

    const unknown = valueOf(
      await tool.call("config.patch", {
        file: "core",
        operations: [{ op: "unset", path: "agent.subagent.maxDepth" }],
      }),
    );
    expect(unknown).toMatchObject({ error: { kind: "usage" } });
    expect(JSON.stringify(unknown)).toContain("Nearest valid parent: agent.");
  });

  it("reloads MCP after an MCP write", async () => {
    const { tool, reloads } = await fixture();
    const patched = valueOf(
      await tool.call("config.patch", {
        file: "mcp",
        operations: [
          {
            op: "set",
            path: "servers.docs",
            value: { transport: "http", url: "https://example.com/mcp" },
          },
        ],
      }),
    );
    expect(patched).toMatchObject({
      written: true,
      reload: { status: "reloaded", servers: [{ serverId: "docs", result: "available" }] },
    });
    expect(reloads()).toBe(1);
  });

  it("is unavailable in restricted sessions", async () => {
    const { tool, dataDir } = await fixture();
    const server = createToolServer({ tools: [tool] });
    await server.init();
    const headers = {
      "x-lilac-safety-mode": "restricted",
      "x-lilac-session-id": "chan",
      "x-lilac-request-id": "req:1",
      "x-lilac-request-client": "discord",
    };
    const list = await server.app.handle(new Request("http://localhost/list", { headers }));
    expect(await list.json()).toEqual({ tools: [] });
    const call = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          callableId: "config.patch",
          input: {
            file: "core",
            operations: [{ op: "set", path: "agent.subagents.maxDepth", value: 2 }],
          },
        }),
      }),
    );
    expect(await call.json()).toMatchObject({
      status: "error",
      error: { kind: "denied", code: "restricted_mode_denied" },
    });
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toBe(CORE);
    await server.stop();
  });
});
