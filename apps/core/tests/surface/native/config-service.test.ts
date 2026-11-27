import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mutateMcpConfigFile } from "../../../src/mcp/config-file";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { NativeConfigService } from "../../../src/surface/native/config-service";
import { McpOAuthControlError, type McpOAuthControl } from "../../../src/mcp/oauth-control";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { mcpOAuth?: McpOAuthControl } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-config-"));
  dirs.push(dataDir);
  await fs.writeFile(path.join(dataDir, "core-config.yaml"), "configVersion: 2\n");
  await fs.writeFile(path.join(dataDir, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
  let reloads = 0;
  const service = new NativeConfigService({
    dataDir,
    ownerId: "owner",
    registry: {
      reload: async () => {
        reloads++;
        return Result.ok([]);
      },
      list: () => [
        { serverId: "docs", transport: "http", status: "available", toolCount: 3 },
        {
          serverId: "local",
          transport: "stdio",
          status: "unavailable",
          phase: "connection",
          error: "spawn failed",
        },
      ],
    },
    ...options,
  });
  return { dataDir, service, reloads: () => reloads };
}

describe("native owner configuration", () => {
  it("denies participant reads and writes", async () => {
    const { service } = await fixture();
    expect((await service.read("participant", "core")).isErr()).toBe(true);
    expect(
      (
        await service.save("participant", {
          kind: "core",
          text: "configVersion: 2",
          expectedRevision: "x",
        })
      ).isErr(),
    ).toBe(true);
    expect((await service.reloadMcp("participant")).isErr()).toBe(true);
    expect(service.mcpStatus("participant").isErr()).toBe(true);
  });
  it("validates without mutation, saves atomically and rejects stale concurrent saves", async () => {
    const { service, dataDir } = await fixture();
    const initial = (await service.read("owner", "core")).unwrap();
    const invalid = await service.save("owner", {
      kind: "core",
      expectedRevision: initial.revision,
      text: "configVersion: 2\nsurface:\n  native:\n    port: -1\n",
    });
    expect(invalid.match({ ok: () => "", err: (error) => error.message })).toContain("port");
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toBe(initial.text);
    const [first, second] = await Promise.all([
      service.save("owner", {
        kind: "core",
        expectedRevision: initial.revision,
        text: "configVersion: 2\nagent:\n  reasoningDisplay: none\n",
      }),
      service.save("owner", {
        kind: "core",
        expectedRevision: initial.revision,
        text: "configVersion: 2\nagent:\n  reasoningDisplay: detailed\n",
      }),
    ]);
    expect(first.isOk()).toBe(true);
    expect(second.match({ ok: () => "", err: (error) => error.code })).toBe("conflict");
    expect((await fs.readdir(dataDir)).sort()).toEqual(["core-config.yaml", "mcp-config.yaml"]);
  });
  it("saves MCP without reload and only reloads on owner request", async () => {
    const { service, reloads } = await fixture();
    const current = (await service.read("owner", "mcp")).unwrap();
    const saved = await service.save("owner", {
      kind: "mcp",
      expectedRevision: current.revision,
      text: "configVersion: 1\nservers:\n  test:\n    transport: stdio\n    command: echo\n",
    });
    expect(saved.isOk()).toBe(true);
    expect(reloads()).toBe(0);
    expect((await service.reloadMcp("owner")).isOk()).toBe(true);
    expect(reloads()).toBe(1);
  });
});

it("serializes MCP tool mutation and owner saves through one path lock", async () => {
  const { service, dataDir } = await fixture();
  const current = (await service.read("owner", "mcp")).unwrap();
  const renameEntered = Promise.withResolvers<void>();
  const allowRename = Promise.withResolvers<void>();
  const changed = mutateMcpConfigFile({
    configPath: path.join(dataDir, "mcp-config.yaml"),
    mutation: {
      type: "upsert",
      server: {
        id: "tool-added",
        allowSubagents: false,
        transportConfig: { transport: "stdio", command: "echo", args: [], env: {} },
      },
    },
    fileDependencies: {
      mkdir: fs.mkdir,
      open: fs.open,
      rm: fs.rm,
      randomUUID,
      rename: async (from, to) => {
        renameEntered.resolve();
        await allowRename.promise;
        await fs.rename(from, to);
      },
    },
  });
  await renameEntered.promise;
  const saved = service.save("owner", {
    kind: "mcp",
    expectedRevision: current.revision,
    text: "configVersion: 1\nservers: {}\n# stale owner change\n",
  });
  allowRename.resolve();
  expect((await changed).isOk()).toBe(true);
  expect((await saved).match({ ok: () => "", err: (error) => error.code })).toBe("conflict");
  expect((await service.read("owner", "mcp")).unwrap().text).toContain("tool-added");
});

it("lets the owner create an absent MCP config", async () => {
  const { service, dataDir } = await fixture();
  await fs.rm(path.join(dataDir, "mcp-config.yaml"));
  const empty = (await service.read("owner", "mcp")).unwrap();
  expect(empty.text).toContain("servers: {}");
  const saved = await service.save("owner", {
    kind: "mcp",
    expectedRevision: empty.revision,
    text: "configVersion: 1\nservers: {}\n# created\n",
  });
  expect(saved.isOk()).toBe(true);
  expect(await fs.readFile(path.join(dataDir, "mcp-config.yaml"), "utf8")).toContain("created");
});

it("reconciles OAuth providers before reload and starts owner sign-in", async () => {
  const calls: string[] = [];
  const { service } = await fixture({
    mcpOAuth: {
      callbackUrl: "https://lilac.example/api/mcp/oauth/callback",
      reconcile: async () => {
        calls.push("reconcile");
      },
      authorize: async (serverId) => {
        calls.push(`authorize:${serverId}`);
        if (serverId === "missing")
          return Result.err(
            new McpOAuthControlError({ code: "not-found", message: "not saved with OAuth" }),
          );
        return Result.ok({
          status: "authorization_required",
          authorizationUrl: "https://auth.example/authorize?state=s",
          callbackUrl: "https://lilac.example/api/mcp/oauth/callback",
        });
      },
    },
  });

  expect((await service.reloadMcp("owner")).isOk()).toBe(true);
  expect(service.mcpStatus("owner").unwrap().oauthCallbackUrl).toBe(
    "https://lilac.example/api/mcp/oauth/callback",
  );
  expect((await service.authorizeMcp("participant", "docs")).isErr()).toBe(true);
  expect((await service.authorizeMcp("owner", "docs")).unwrap()).toMatchObject({
    status: "authorization_required",
    authorizationUrl: "https://auth.example/authorize?state=s",
  });
  expect(
    (await service.authorizeMcp("owner", "missing")).match({
      ok: () => undefined,
      err: (error) => ({ code: error.code, message: error.message }),
    }),
  ).toEqual({ code: "not-found", message: "not saved with OAuth" });
  expect(calls).toEqual(["reconcile", "authorize:docs", "authorize:missing"]);
});
