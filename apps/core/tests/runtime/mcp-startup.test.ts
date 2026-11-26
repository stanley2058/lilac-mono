import { describe, expect, it } from "bun:test";

import { Result } from "better-result";

import { McpConfigError, createEmptyMcpConfig, type UniversalMcpConfig } from "../../src/mcp";
import { startCoreMcpServices } from "../../src/runtime/create-core-runtime";

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

type LogEntry = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

function recordingLogger(entries: LogEntry[]) {
  return {
    info(message: string, details: Readonly<Record<string, unknown>>) {
      entries.push({ level: "info", message, details });
    },
    warn(message: string, details: Readonly<Record<string, unknown>>) {
      entries.push({ level: "warn", message, details });
    },
    error(message: string, details: Readonly<Record<string, unknown>>) {
      entries.push({ level: "error", message, details });
    },
  };
}

describe("Core MCP startup", () => {
  it("returns while registry initialization is still pending", async () => {
    const initGate = deferred<void>();
    const logs: LogEntry[] = [];
    const reconciled: UniversalMcpConfig[] = [];
    let initStarted = false;

    const startup = await startCoreMcpServices({
      configPath: "/data/mcp-config.yaml",
      providers: {
        reconcile(config) {
          reconciled.push(config);
        },
      },
      registry: {
        init() {
          initStarted = true;
          return initGate.promise;
        },
      },
      callback: {
        start: () => ({ status: "listening", hostname: "localhost", port: 1456 }),
      },
      logger: recordingLogger(logs),
      readConfig: async (configPath) =>
        Result.ok({
          configPath,
          exists: false,
          config: createEmptyMcpConfig(),
        }),
    });

    expect(initStarted).toBe(true);
    expect(reconciled).toEqual([createEmptyMcpConfig()]);
    expect(logs).toContainEqual({
      level: "info",
      message: "MCP OAuth callback listener started",
      details: { status: "listening", hostname: "localhost", port: 1456 },
    });

    initGate.resolve();
    await startup.registryInit;
  });

  it("uses empty providers for malformed config and catches background init failure", async () => {
    const logs: LogEntry[] = [];
    const reconciled: UniversalMcpConfig[] = [];

    const startup = await startCoreMcpServices({
      configPath: "/data/mcp-config.yaml",
      providers: {
        reconcile(config) {
          reconciled.push(config);
        },
      },
      registry: {
        async init() {
          throw new Error("registry config invalid");
        },
      },
      callback: {
        start: () => ({
          status: "unavailable",
          hostname: "localhost",
          port: 1456,
          error: "listen EADDRINUSE",
        }),
      },
      logger: recordingLogger(logs),
      readConfig: async () =>
        Result.err(
          new McpConfigError({
            configPath: "/data/mcp-config.yaml",
            issues: ["invalid MCP YAML"],
          }),
        ),
    });
    await startup.registryInit;

    expect(reconciled).toEqual([createEmptyMcpConfig()]);
    expect(logs).toContainEqual({
      level: "warn",
      message: "MCP OAuth providers reconciled to empty configuration",
      details: {
        path: "/data/mcp-config.yaml",
        error: "Invalid MCP configuration at /data/mcp-config.yaml:\n  - invalid MCP YAML",
      },
    });
    expect(logs).toContainEqual({
      level: "warn",
      message: "MCP OAuth callback listener unavailable",
      details: {
        status: "unavailable",
        hostname: "localhost",
        port: 1456,
        error: "listen EADDRINUSE",
      },
    });
    expect(logs).toContainEqual({
      level: "error",
      message: "MCP registry background initialization failed",
      details: { path: "/data/mcp-config.yaml", error: "registry config invalid" },
    });
  });
});
