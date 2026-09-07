import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Panic, Result } from "better-result";

import {
  McpOAuthCallbackService,
  McpOAuthProviderService,
  readMcpConfigFile,
  readMcpOAuthCredentialFile,
  resolveMcpConfigPath,
  writeMcpOAuthCredentialFileAtomic,
  type McpCatalogTool,
  type McpRegistryApi,
  type McpRegistryConfigStatus,
  type McpReloadOutcome,
  type McpServerStatus,
  type UniversalMcpConfig,
} from "../../src/mcp";
import { createBuiltinMcpPlugin } from "../../src/plugins/builtin/server-tools";
import { McpManagement } from "../../src/tool-server/tools/mcp";

const temporaryDirectories: string[] = [];

async function callValue(
  tool: McpManagement,
  callableId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const result = await tool.call(callableId, input);
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

async function readConfigValue(configPath: string) {
  const result = await readMcpConfigFile(configPath);
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-management-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class RecordingRegistry implements McpRegistryApi {
  readonly reloadCalls: (string | undefined)[] = [];
  statuses: readonly McpServerStatus[] = [];
  configStatus: McpRegistryConfigStatus = { status: "valid" };
  reloadOutcomes: readonly McpReloadOutcome[] = [];
  waitUntilInitializedImpl: () => Promise<void> = async () => undefined;

  async init(): Promise<void> {}

  async waitUntilInitialized() {
    await this.waitUntilInitializedImpl();
    return Result.ok(undefined);
  }

  async reload(serverId?: string) {
    this.reloadCalls.push(serverId);
    const outcomes =
      this.reloadOutcomes.length > 0
        ? this.reloadOutcomes
        : [
            {
              serverId: serverId ?? "all",
              reconciliation: "unchanged" as const,
              result: "retained" as const,
            },
          ];
    return Result.ok(outcomes);
  }

  list(): readonly McpServerStatus[] {
    return this.statuses;
  }

  getConfigStatus(): McpRegistryConfigStatus {
    return this.configStatus;
  }

  getCatalogServers() {
    return [];
  }

  getTools(): readonly McpCatalogTool[] {
    return [];
  }

  async shutdown(): Promise<void> {}
}

function createProviders() {
  const reconciledConfigs: UniversalMcpConfig[] = [];
  const authorizationCalls: string[] = [];
  return {
    reconciledConfigs,
    authorizationCalls,
    reconcile(config: UniversalMcpConfig) {
      reconciledConfigs.push(config);
    },
    async startAuthorization(serverId: string) {
      authorizationCalls.push(serverId);
      return {
        status: "authorization_required" as const,
        authorizationUrl: "https://auth.example.test/authorize?state=one-time-state",
        callbackUrl: "http://localhost:1456/mcp/oauth/callback",
      };
    },
  };
}

function createListeningCallback() {
  const status = { status: "listening", hostname: "localhost", port: 1456 } as const;
  return {
    start: () => status,
    getStatus: () => status,
  };
}

async function createTool() {
  const dataDir = await createDataDir();
  const registry = new RecordingRegistry();
  const providers = createProviders();
  const configPath = resolveMcpConfigPath({ dataDir });
  const callback = createListeningCallback();
  const tool = new McpManagement({ registry, providers, callback, configPath });
  return { dataDir, configPath, registry, providers, tool };
}

describe("MCP management metadata", () => {
  it("exposes six ordinary callables with serverId positional help and flattened add fields", async () => {
    const setup = await createTool();
    const entries = await setup.tool.list();

    expect(entries.map((entry) => entry.callableId)).toEqual([
      "mcp.list",
      "mcp.add",
      "mcp.remove",
      "mcp.status",
      "mcp.auth",
      "mcp.reload",
    ]);
    for (const entry of entries.filter((entry) => entry.callableId !== "mcp.list")) {
      expect(entry.primaryPositional).toEqual({ field: "serverId" });
    }

    const add = entries.find((entry) => entry.callableId === "mcp.add");
    expect(add?.shortInput).toContain('--transport=<"stdio" | "http">');
    expect(add?.input).toContain("--server-id=<string> | Configured MCP server ID.");
    expect(add?.input).toContain('--url=<string> (Required when transport="http")');
    expect(add?.input).toContain('--command=<string> (Required when transport="stdio")');
  });

  it("registers one builtin Level-2 tool only when all MCP runtime services exist", async () => {
    const setup = await createTool();
    const plugin = createBuiltinMcpPlugin();
    const providers = new McpOAuthProviderService({ dataDir: setup.dataDir });

    expect(plugin.meta.id).toBe("mcp");
    const instance = await plugin.create({
      runtime: {
        mcpRegistry: setup.registry,
        mcpOAuthProviders: providers,
        mcpConfigPath: setup.configPath,
      },
      dataDir: setup.dataDir,
      pluginConfig: undefined,
      source: "builtin",
    });
    expect(instance.level2).toHaveLength(1);
    expect(instance.level2?.[0]?.id).toBe("mcp");

    expect(() =>
      plugin.create({
        runtime: { mcpRegistry: setup.registry },
        dataDir: setup.dataDir,
        pluginConfig: undefined,
        source: "builtin",
      }),
    ).toThrow("mcp requires registry, OAuth provider service, and config path");
  });
});

describe("MCP management calls", () => {
  it("adds, lists, inspects, authenticates, reloads, and removes servers", async () => {
    const setup = await createTool();
    setup.registry.statuses = [
      { serverId: "docs", transport: "http", status: "available", toolCount: 3 },
      {
        serverId: "local",
        transport: "stdio",
        status: "unavailable",
        phase: "connection",
        error: "connection refused",
      },
    ];

    const added = await callValue(setup.tool, "mcp.add", {
      serverId: "docs",
      description: "Documentation search and retrieval.",
      transport: "http",
      url: "https://mcp.example.test/service",
    });
    expect(added).toEqual({
      mutation: { type: "upsert", serverId: "docs", changed: true, result: "added" },
      reload: [
        {
          serverId: "docs",
          reconciliation: "unchanged",
          result: "retained",
        },
      ],
    });
    expect((await readConfigValue(setup.configPath)).config.servers.docs?.transportConfig).toEqual({
      transport: "http",
      url: "https://mcp.example.test/service",
      headers: {},
    });
    expect((await readConfigValue(setup.configPath)).config.servers.docs?.allowSubagents).toBe(
      false,
    );
    expect((await readConfigValue(setup.configPath)).config.servers.docs?.description).toBe(
      "Documentation search and retrieval.",
    );

    expect(await callValue(setup.tool, "mcp.list", {})).toEqual({
      servers: [{ serverId: "docs", transport: "http", authentication: "none" }],
    });
    expect(await callValue(setup.tool, "mcp.status", { serverId: "docs" })).toEqual({
      config: { status: "valid" },
      statuses: [{ serverId: "docs", transport: "http", status: "available", toolCount: 3 }],
      callback: { status: "listening", hostname: "localhost", port: 1456 },
    });
    expect(await callValue(setup.tool, "mcp.status", {})).toEqual({
      config: { status: "valid" },
      statuses: setup.registry.statuses,
      callback: { status: "listening", hostname: "localhost", port: 1456 },
    });

    expect(await callValue(setup.tool, "mcp.auth", { serverId: "docs" })).toEqual({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize?state=one-time-state",
      callbackUrl: "http://localhost:1456/mcp/oauth/callback",
    });
    expect(setup.providers.authorizationCalls).toEqual(["docs"]);

    expect(await callValue(setup.tool, "mcp.reload", {})).toEqual({
      reload: [{ serverId: "all", reconciliation: "unchanged", result: "retained" }],
    });
    const removed = await callValue(setup.tool, "mcp.remove", { serverId: "docs" });
    expect(removed).toEqual({
      mutation: { type: "remove", serverId: "docs", changed: true, result: "removed" },
      reload: [
        {
          serverId: "docs",
          reconciliation: "unchanged",
          result: "retained",
        },
      ],
    });
    expect((await readConfigValue(setup.configPath)).config.servers).toEqual({});

    expect(setup.providers.reconciledConfigs).toHaveLength(3);
    expect(setup.registry.reloadCalls).toEqual(["docs", undefined, "docs"]);
  });

  for (const transport of ["http", "stdio"] as const) {
    it(`persists and replaces ${transport} subagent access through mcp.add`, async () => {
      const setup = await createTool();
      const input =
        transport === "http"
          ? { serverId: "docs", transport, url: "https://example.invalid/mcp" }
          : { serverId: "docs", transport, command: "bun" };
      for (const allowSubagents of [true, false]) {
        const result = await callValue(setup.tool, "mcp.add", { ...input, allowSubagents });
        expect(result).toMatchObject({ mutation: { changed: true } });
        expect((await readConfigValue(setup.configPath)).config.servers.docs?.allowSubagents).toBe(
          allowSubagents,
        );
        expect(setup.providers.reconciledConfigs.at(-1)?.servers.docs?.allowSubagents).toBe(
          allowSubagents,
        );
      }
    });
  }

  it("normalizes flattened stdio input and reconciles exactly once even for no-op mutations", async () => {
    const setup = await createTool();
    const input = {
      serverId: "local",
      transport: "stdio" as const,
      command: "bun",
      args: ["run", "server.ts"],
      cwd: "/workspace",
      env: { TOKEN: { env: "MCP_TOKEN" } },
    };

    await setup.tool.call("mcp.add", input);
    const unchanged = await callValue(setup.tool, "mcp.add", input);
    expect(unchanged).toMatchObject({
      mutation: { changed: false, result: "unchanged" },
    });
    expect((await readConfigValue(setup.configPath)).config.servers.local?.transportConfig).toEqual(
      {
        transport: "stdio",
        command: "bun",
        args: ["run", "server.ts"],
        cwd: "/workspace",
        env: { TOKEN: { env: "MCP_TOKEN" } },
      },
    );

    await setup.tool.call("mcp.remove", { serverId: "missing" });
    expect(setup.providers.reconciledConfigs).toHaveLength(3);
    expect(setup.registry.reloadCalls).toEqual(["local", "local", "missing"]);
  });

  it("serializes concurrent mutations through provider reconciliation and registry reload", async () => {
    const setup = await createTool();

    await Promise.all([
      setup.tool.call("mcp.add", {
        serverId: "alpha",
        transport: "stdio",
        command: "alpha-command",
      }),
      setup.tool.call("mcp.add", {
        serverId: "beta",
        transport: "stdio",
        command: "beta-command",
      }),
      setup.tool.call("mcp.remove", { serverId: "alpha" }),
    ]);

    expect(
      setup.providers.reconciledConfigs.map((config) => Object.keys(config.servers).sort()),
    ).toEqual([["alpha"], ["alpha", "beta"], ["beta"]]);
    expect(setup.registry.reloadCalls).toEqual(["alpha", "beta", "alpha"]);
  });

  it("preserves Panic from MCP management capture", async () => {
    const setup = await createTool();
    const panic = new Panic({ message: "MCP reconciliation invariant failed" });
    setup.providers.reconcile = () => {
      throw panic;
    };

    await expect(
      setup.tool.call("mcp.add", {
        serverId: "private",
        transport: "http",
        url: "https://mcp.example.test/service?token=must-not-leak",
        headers: { Authorization: "Bearer must-not-leak" },
      }),
    ).rejects.toBeInstanceOf(Panic);
  });

  it("waits for deferred registry initialization before reconciling providers and reloading", async () => {
    const setup = await createTool();
    const initGate = deferred<void>();
    const waitStarted = deferred<void>();
    setup.registry.waitUntilInitializedImpl = async () => {
      waitStarted.resolve();
      await initGate.promise;
    };

    const adding = setup.tool.call("mcp.add", {
      serverId: "deferred",
      transport: "stdio",
      command: "deferred-command",
    });
    await waitStarted.promise;

    expect(Object.keys((await readConfigValue(setup.configPath)).config.servers)).toEqual([
      "deferred",
    ]);
    expect(setup.providers.reconciledConfigs).toHaveLength(0);
    expect(setup.registry.reloadCalls).toHaveLength(0);

    initGate.resolve();
    await adding;

    expect(setup.providers.reconciledConfigs).toHaveLength(1);
    expect(setup.registry.reloadCalls).toEqual(["deferred"]);
  });

  it("serializes explicit reload with config mutations", async () => {
    const setup = await createTool();

    await Promise.all([
      setup.tool.call("mcp.add", {
        serverId: "alpha",
        transport: "stdio",
        command: "alpha-command",
      }),
      setup.tool.call("mcp.reload", {}),
      setup.tool.call("mcp.add", {
        serverId: "beta",
        transport: "stdio",
        command: "beta-command",
      }),
    ]);

    expect(
      setup.providers.reconciledConfigs.map((config) => Object.keys(config.servers).sort()),
    ).toEqual([["alpha"], ["alpha"], ["alpha", "beta"]]);
    expect(setup.registry.reloadCalls).toEqual(["alpha", undefined, "beta"]);
  });

  it("retries callback binding through mcp.auth before starting authorization", async () => {
    const setup = await createTool();
    const callbackProviders = new McpOAuthProviderService({ dataDir: setup.dataDir });
    let portAvailable = false;
    let bindAttempts = 0;
    const callback = new McpOAuthCallbackService({
      providers: callbackProviders,
      serverFactory: (options) => {
        bindAttempts += 1;
        if (!portAvailable) throw new Error("listen EADDRINUSE");
        return { port: options.port, stop() {} };
      },
    });
    const tool = new McpManagement({
      registry: setup.registry,
      providers: setup.providers,
      callback,
      configPath: setup.configPath,
    });

    expect(callback.start()).toMatchObject({ status: "unavailable" });
    expect(setup.providers.authorizationCalls).toEqual([]);

    portAvailable = true;
    expect(await callValue(tool, "mcp.auth", { serverId: "docs" })).toMatchObject({
      status: "authorization_required",
    });
    expect(bindAttempts).toBe(2);
    expect(setup.providers.authorizationCalls).toEqual(["docs"]);
    expect(await callValue(tool, "mcp.status", {})).toMatchObject({
      callback: { status: "listening", hostname: "localhost", port: 1456 },
    });

    await callback.stop();
  });

  it("does not start authorization while callback binding remains unavailable", async () => {
    const setup = await createTool();
    const callback = new McpOAuthCallbackService({
      providers: new McpOAuthProviderService({ dataDir: setup.dataDir }),
      serverFactory: () => {
        throw new Error("listen EADDRINUSE");
      },
    });
    const tool = new McpManagement({
      registry: setup.registry,
      providers: setup.providers,
      callback,
      configPath: setup.configPath,
    });

    expect(await tool.call("mcp.auth", { serverId: "docs" })).toMatchObject({
      status: "error",
      error: {
        kind: "unavailable",
        message:
          "MCP OAuth callback listener is unavailable on localhost:1456. Ensure the port is free, then retry mcp.auth.",
      },
    });
    expect(setup.providers.authorizationCalls).toEqual([]);
    expect(callback.getStatus()).toEqual({
      status: "unavailable",
      hostname: "localhost",
      port: 1456,
      error: "listen EADDRINUSE",
    });
  });

  it("strictly rejects malformed and nested add inputs", async () => {
    const setup = await createTool();

    expect(
      await setup.tool.call("mcp.add", {
        serverId: "docs",
        transport: "http",
        url: "not-a-url",
      }),
    ).toMatchObject({ status: "error", error: { kind: "usage", code: "invalid_input" } });
    expect(
      await setup.tool.call("mcp.add", {
        serverId: "docs",
        transport: "stdio",
        command: "bun",
        url: "https://unexpected.example.test",
      }),
    ).toMatchObject({ status: "error", error: { kind: "usage", code: "invalid_input" } });
    expect(
      await setup.tool.call("mcp.add", {
        serverId: "docs",
        server: {
          transport: "http",
          url: "https://mcp.example.test",
        },
      }),
    ).toMatchObject({ status: "error", error: { kind: "usage", code: "invalid_input" } });
    expect(await setup.tool.call("mcp.auth", {})).toMatchObject({
      status: "error",
      error: { kind: "usage", code: "invalid_input" },
    });
    expect(await setup.tool.call("mcp.list", { verbose: true })).toMatchObject({
      status: "error",
      error: { kind: "usage", code: "invalid_input" },
    });
    expect(setup.providers.reconciledConfigs).toHaveLength(0);
    expect(setup.registry.reloadCalls).toHaveLength(0);
  });

  it("maps config Results to an ordinary tool failure without leaking internals", async () => {
    const setup = await createTool();
    await writeFile(
      setup.configPath,
      "configVersion: 1\nservers:\n  bad:\n    transport: websocket\n",
      "utf8",
    );

    const failure = await setup.tool.call("mcp.list", {});
    expect(failure).toMatchObject({
      status: "error",
      error: {
        kind: "unavailable",
        code: "mcp_unavailable",
        message: expect.stringContaining("Invalid MCP configuration"),
      },
    });
    expect(JSON.stringify(failure)).not.toContain("cause");
  });

  it("retains the OAuth credential file when removing its server", async () => {
    const setup = await createTool();
    await setup.tool.call("mcp.add", {
      serverId: "docs",
      transport: "http",
      url: "https://mcp.example.test/service",
      auth: {
        type: "oauth",
        grant: "authorization_code",
        client: { type: "dynamic" },
      },
    });
    await writeMcpOAuthCredentialFileAtomic({
      dataDir: setup.dataDir,
      serverId: "docs",
      credential: {
        version: 1,
        serverUrl: "https://mcp.example.test/service",
        tokens: { access_token: "persisted-access-token", token_type: "Bearer" },
      },
    });

    await setup.tool.call("mcp.remove", { serverId: "docs" });
    expect(
      await readMcpOAuthCredentialFile({ dataDir: setup.dataDir, serverId: "docs" }),
    ).toMatchObject({
      tokens: { access_token: "persisted-access-token" },
    });
  });

  it("never returns configured credential material or prior OAuth callback data", async () => {
    const setup = await createTool();
    const secrets = ["header-secret", "url-query-secret", "callback-secret", "one-time-state"];

    const added = await callValue(setup.tool, "mcp.add", {
      serverId: "private",
      transport: "http",
      url: "https://mcp.example.test/service?token=url-query-secret",
      headers: { Authorization: "Bearer header-secret" },
    });
    await setup.tool.call("mcp.auth", { serverId: "private" });
    const list = await callValue(setup.tool, "mcp.list", {});
    const status = await callValue(setup.tool, "mcp.status", {});
    const serializedSafeOutputs = JSON.stringify({ added, list, status });

    for (const secret of secrets) expect(serializedSafeOutputs).not.toContain(secret);
    expect(list).toEqual({
      servers: [{ serverId: "private", transport: "http", authentication: "none" }],
    });
  });

  it("reports a retained config diagnostic without rereading an invalid file", async () => {
    const setup = await createTool();
    setup.registry.configStatus = {
      status: "invalid",
      error:
        "Invalid MCP configuration: servers.docs.transport is invalid. Fix the file, then run mcp.reload.",
    };

    expect(await callValue(setup.tool, "mcp.status", {})).toEqual({
      config: setup.registry.configStatus,
      statuses: [],
      callback: { status: "listening", hostname: "localhost", port: 1456 },
    });
  });
});
