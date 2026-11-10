import { describe, expect, it, spyOn } from "bun:test";
import type { MCPClientConfig } from "@ai-sdk/mcp";
import { McpRegistry } from "../../src/mcp/registry";
import type { McpRecoveryEvent } from "../../src/mcp/registry-types";
import {
  configSnapshot,
  FakeMcpClient,
  httpDefinition,
  mcpConfig,
  mcpToolDefinition,
  stdioDefinition,
} from "./fixtures/registry-fixture";

const options = { toolCallId: "test", messages: [], context: {} };
const immediateRetry = (callback: () => void) => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) callback();
  });
  return () => {
    cancelled = true;
  };
};
function modernClient() {
  return Object.assign(new FakeMcpClient({ first: { tools: [mcpToolDefinition("read")] } }), {
    initializeResult: {
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} },
      serverInfo: { name: "modern", version: "1" },
    },
  });
}

describe("MCP recovery and run ownership", () => {
  it("isolates modern runs, reuses discovery, recovers stable handles without replay, and releases clients", async () => {
    const clients = Array.from({ length: 4 }, modernClient);
    const configs: MCPClientConfig[] = [];
    const recovered = Promise.withResolvers<void>();
    const registry = new McpRegistry({
      configPath: "/tmp/mcp-test.yaml",
      reportFatalError: (error) => {
        throw error;
      },
      onRecoveryEvent: (event) => {
        if (event.event === "recovered") recovered.resolve();
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
        scheduleRetry: immediateRetry,
        createClient: async (config) => {
          configs.push(config);
          return clients[configs.length - 1]!;
        },
      },
    });
    await registry.init();
    const a = registry.acquireRun("a");
    const aAgain = registry.acquireRun("a");
    const b = registry.acquireRun("b");
    const entry = registry.getTools()[0]!;
    const aTool = a.bindTool(entry);
    const sameRunTool = aAgain.bindTool(entry);
    const bTool = b.bindTool(entry);
    await Promise.all([
      aTool.execute!({}, options),
      sameRunTool.execute!({}, options),
      bTool.execute!({}, options),
    ]);
    expect(configs).toHaveLength(3);
    expect(configs[1]?.initialInitializeResult).toEqual(clients[0]!.initializeResult);
    expect(clients.map((client) => client.cursors.length)).toEqual([1, 0, 0, 0]);
    let executions = 0;
    clients[1]!.executeTool = async () => {
      executions += 1;
      throw new Error("transport interrupted");
    };
    await expect(aTool.execute!({}, options)).rejects.toThrow("transport interrupted");
    await recovered.promise;
    expect(executions).toBe(1);
    expect(registry.list()[0]?.status).toBe("available");
    expect(clients[2]!.closeCount).toBe(0);
    await aTool.execute!({}, options);
    await bTool.execute!({}, options);
    expect(configs).toHaveLength(4);
    await a.release();
    expect(clients[3]!.closeCount).toBe(0);
    await aAgain.release();
    expect(clients[3]!.closeCount).toBe(1);
    await expect(aTool.execute!({}, options)).rejects.toThrow("ended");
    await b.release();
    await registry.shutdown();
    expect(clients.map((client) => client.closeCount)).toEqual([1, 1, 1, 1]);
  });

  it("keeps legacy and stdio clients shared between runs", async () => {
    for (const definition of [httpDefinition("remote"), stdioDefinition("remote")]) {
      let creates = 0;
      const client = new FakeMcpClient({ first: { tools: [mcpToolDefinition("read")] } });
      const registry = new McpRegistry({
        configPath: "/tmp/mcp-test.yaml",
        reportFatalError: () => {},
        dependencies: {
          readConfig: async () => configSnapshot(mcpConfig([definition])),
          createClient: async () => {
            creates += 1;
            return client;
          },
        },
      });
      await registry.init();
      const scopes = [registry.acquireRun("a"), registry.acquireRun("b")];
      await Promise.all(
        scopes.map((scope) => scope.bindTool(registry.getTools()[0]!).execute!({}, options)),
      );
      expect(creates).toBe(1);
      await Promise.all(scopes.map((scope) => scope.release()));
      expect(client.closeCount).toBe(0);
      await registry.shutdown();
      expect(client.closeCount).toBe(1);
    }
  });

  it("recovers startup failures and logs attempts", async () => {
    let creates = 0;
    const events: McpRecoveryEvent[] = [];
    const recovered = Promise.withResolvers<void>();
    const registry = new McpRegistry({
      configPath: "/tmp/mcp-test.yaml",
      reportFatalError: () => {},
      onRecoveryEvent: (event) => {
        events.push(event);
        if (event.event === "recovered") recovered.resolve();
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
        scheduleRetry: immediateRetry,
        createClient: async () => {
          if (++creates < 3) throw new Error("offline");
          return modernClient();
        },
      },
    });
    await registry.init();
    await recovered.promise;
    expect(creates).toBe(3);
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "attempt",
      "attempt",
      "recovered",
    ]);
    expect(registry.getTools()).toHaveLength(1);
    await registry.shutdown();
  });

  it("retains tools and reports exhaustion after three recovery attempts", async () => {
    let creates = 0;
    let online = false;
    const exhausted = Promise.withResolvers<McpRecoveryEvent>();
    const first = new FakeMcpClient({ first: { tools: [mcpToolDefinition("read")] } });
    const registry = new McpRegistry({
      configPath: "/tmp/mcp-test.yaml",
      reportFatalError: () => {},
      onRecoveryEvent: (event) => {
        if (event.event === "exhausted") exhausted.resolve(event);
      },
      dependencies: {
        readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
        scheduleRetry: immediateRetry,
        createClient: async () => {
          if (++creates > 1 && !online) throw new Error("offline");
          return online
            ? new FakeMcpClient({ first: { tools: [mcpToolDefinition("read")] } })
            : first;
        },
      },
    });
    await registry.init();
    const handle = registry.getTools()[0]!.tool;
    first.executeTool = async () => {
      throw new Error("network reset");
    };
    await expect(handle.execute!({}, options)).rejects.toThrow("network reset");
    expect((await exhausted.promise).attempt).toBe(3);
    expect(creates).toBe(4);
    expect(registry.getTools()).toHaveLength(1);
    expect(registry.getCatalogServers()).toHaveLength(1);
    await expect(handle.execute!({}, options)).rejects.toThrow(
      "recovery exhausted after 3 attempts",
    );
    expect(creates).toBe(4);
    online = true;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 120_000);
    try {
      await handle.execute!({}, options);
      expect(creates).toBe(5);
      expect(registry.list()[0]?.status).toBe("available");
    } finally {
      clock.mockRestore();
    }
    await registry.shutdown();
  });
});

it("restores cached modern metadata without another handshake and keeps cancellation local", async () => {
  const calls: Array<{ method: string; modern: boolean }> = [];
  const started = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json();
      calls.push({
        method: message.method,
        modern: message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28",
      });
      const result = (value: Record<string, unknown>) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...value,
            resultType: "complete",
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1" } },
          },
        });
      if (message.method === "server/discover")
        return result({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        });
      if (message.method === "tools/list")
        return result({ tools: [mcpToolDefinition("read")], ttlMs: 0, cacheScope: "private" });
      if (message.params?.arguments?.wait) {
        started.resolve();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": open\n\n"));
              request.signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return result({ content: [{ type: "text", text: "ok" }] });
    },
  });
  const registry = new McpRegistry({
    configPath: "/tmp/mcp-test.yaml",
    reportFatalError: () => {},
    dependencies: {
      readConfig: async () =>
        configSnapshot(mcpConfig([httpDefinition("remote", server.url.toString())])),
    },
  });
  try {
    await registry.init();
    const scopes = [registry.acquireRun("a"), registry.acquireRun("b")];
    const entry = registry.getTools()[0]!;
    const a = scopes[0]!.bindTool(entry);
    const b = scopes[1]!.bindTool(entry);
    const controller = new AbortController();
    const pending = Promise.resolve(
      a.execute!({ wait: true }, { ...options, abortSignal: controller.signal }),
    );
    const rejected = pending.then(
      () => null,
      (error: Error) => error,
    );
    await started.promise;
    controller.abort();
    expect(await rejected).toBeInstanceOf(Error);
    await b.execute!({}, options);
    await a.execute!({}, options);
    expect(calls.filter((call) => call.method === "server/discover")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "tools/list")).toHaveLength(1);
    expect(calls.every((call) => call.modern)).toBe(true);
    await Promise.all(scopes.map((scope) => scope.release()));
  } finally {
    await registry.shutdown();
    await server.stop(true);
  }
});

it("validates replacement run clients remotely and exhausts persistent outages", async () => {
  const clients = Array.from({ length: 5 }, modernClient);
  let creates = 0;
  let probes = 0;
  const events: McpRecoveryEvent[] = [];
  const registry = new McpRegistry({
    configPath: "/tmp/mcp-test.yaml",
    reportFatalError: (error) => {
      throw error;
    },
    onRecoveryEvent: (event) => events.push(event),
    dependencies: {
      readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
      scheduleRetry: immediateRetry,
      createClient: async () => clients[creates++]!,
    },
  });
  await registry.init();
  const scope = registry.acquireRun("run");
  const handle = scope.bindTool(registry.getTools()[0]!);
  await handle.execute!({}, options);
  clients[1]!.executeTool = async () => {
    throw new Error("network reset");
  };
  for (const client of clients.slice(2)) {
    client.listTools = async () => {
      probes += 1;
      throw new Error("still offline");
    };
  }
  await expect(handle.execute!({}, options)).rejects.toThrow("recovery exhausted after 3 attempts");
  expect(probes).toBe(3);
  expect(events.filter((event) => event.event === "recovered")).toHaveLength(0);
  await expect(handle.execute!({}, options)).rejects.toThrow("recovery exhausted");
  expect(creates).toBe(5);
  await registry.shutdown();
  expect(clients.every((client) => client.closeCount === 1)).toBe(true);
});

it("does not create a run client after release while waiting for shared recovery", async () => {
  const clients = [modernClient(), modernClient()];
  let creates = 0;
  const retryScheduled = Promise.withResolvers<() => void>();
  const registry = new McpRegistry({
    configPath: "/tmp/mcp-test.yaml",
    reportFatalError: (error) => {
      throw error;
    },
    dependencies: {
      readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
      scheduleRetry: (callback) => {
        retryScheduled.resolve(callback);
        return () => {};
      },
      createClient: async () => clients[creates++]!,
    },
  });
  await registry.init();
  const entry = registry.getTools()[0]!;
  const scope = registry.acquireRun("run");
  clients[0]!.executeTool = async () => {
    throw new Error("offline");
  };
  const failed = Promise.resolve(entry.tool.execute!({}, options)).then(
    () => null,
    (error: Error) => error,
  );
  const retry = await retryScheduled.promise;
  const pending = Promise.resolve(scope.bindTool(entry).execute!({}, options)).then(
    () => null,
    (error: Error) => error,
  );
  await scope.release();
  retry();
  expect(await pending).toBeInstanceOf(Error);
  await failed;
  expect(creates).toBe(2);
  await registry.shutdown();
  expect(clients.every((client) => client.closeCount === 1)).toBe(true);
});

it("closes discovery clients even when a run client fails to close", async () => {
  const clients = [modernClient(), modernClient()];
  let creates = 0;
  const registry = new McpRegistry({
    configPath: "/tmp/mcp-test.yaml",
    reportFatalError: (error) => {
      throw error;
    },
    dependencies: {
      readConfig: async () => configSnapshot(mcpConfig([httpDefinition("remote")])),
      createClient: async () => clients[creates++]!,
    },
  });
  await registry.init();
  const scope = registry.acquireRun("run");
  await scope.bindTool(registry.getTools()[0]!).execute!({}, options);
  clients[1]!.close = async () => {
    throw new Error("close failed");
  };
  await expect(registry.shutdown()).rejects.toThrow("close failed");
  expect(clients[0]!.closeCount).toBe(1);
  expect(registry.getTools()).toHaveLength(0);
});

it("bounds credential resolution and prevents late resolution from opening a client", async () => {
  const reading = Promise.withResolvers<void>();
  const credential = Promise.withResolvers<string>();
  let deadline: (() => void) | undefined;
  let creates = 0;
  const definition = stdioDefinition("local");
  const registry = new McpRegistry({
    configPath: "/tmp/mcp-test.yaml",
    reportFatalError: (error) => {
      throw error;
    },
    readTextFile: async () => {
      reading.resolve();
      return credential.promise;
    },
    dependencies: {
      readConfig: async () =>
        configSnapshot(
          mcpConfig([
            {
              ...definition,
              transportConfig: {
                transport: "stdio",
                command: "bun",
                args: [],
                env: { TOKEN: { file: "token" } },
              },
            },
          ]),
        ),
      createClient: async () => {
        creates += 1;
        return modernClient();
      },
      scheduleDeadline: (callback) => {
        deadline = callback;
        return () => {};
      },
      scheduleRetry: () => () => {},
    },
  });
  const initializing = registry.init();
  await reading.promise;
  deadline!();
  await initializing;
  expect(registry.list()[0]).toMatchObject({ status: "unavailable", phase: "connection" });
  await registry.shutdown();
  credential.resolve("test-value");
  await credential.promise;
  expect(creates).toBe(0);
});
