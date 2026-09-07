import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Panic, type Result } from "better-result";

import {
  McpConfigFileOperationAndCleanupError,
  McpConfigFileOperationError,
  McpConfigError,
  mutateMcpConfigFile,
  parseMcpConfigYaml,
  readMcpConfigFile,
  resolveMcpConfigPath,
  serializeMcpConfigYaml,
  serializeMcpConfigYamlResult,
  writeMcpConfigFileAtomic,
  type McpConfigFileDependencies,
  type McpServerDefinition,
} from "../../src/mcp";

const temporaryDirectories: string[] = [];

function expectOk<T, E extends Error>(result: Result<T, E>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-config-"));
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

function stdioServer(id: string, command = "bun"): McpServerDefinition {
  return {
    id,
    allowSubagents: false,
    transportConfig: { transport: "stdio", command, args: [], env: {} },
  };
}

describe("MCP config parsing and serialization", () => {
  it("keeps the shipped example valid", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dir,
        "../../../../packages/utils/config-templates/mcp-config.example.yaml",
      ),
      "utf8",
    );

    expect(parseMcpConfigYaml(source)).toEqual({
      ok: true,
      config: { configVersion: 1, servers: {} },
    });
  });

  it("normalizes stdio, HTTP, static OAuth, and dynamic OAuth definitions", () => {
    const parsed = parseMcpConfigYaml(`
configVersion: 1
servers:
  local-docs:
    transport: stdio
    description: "  Search local product documentation.  "
    command: bun
    args: [run, server.ts]
    cwd: /workspace
    env:
      DOCS_TOKEN: { env: DOCS_TOKEN }
  dynamic-auth:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      scopes: [read, write]
      client: { type: dynamic }
  registered-auth:
    transport: http
    url: https://registered.example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      client:
        type: static
        clientId: lilac
        clientSecret: { file: secret/client.json, pointer: /secret }
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.servers["local-docs"]?.transportConfig).toEqual({
      transport: "stdio",
      command: "bun",
      args: ["run", "server.ts"],
      cwd: "/workspace",
      env: { DOCS_TOKEN: { env: "DOCS_TOKEN" } },
    });
    expect(parsed.config.servers["local-docs"]?.description).toBe(
      "Search local product documentation.",
    );
    expect(parsed.config.servers["dynamic-auth"]?.id).toBe("dynamic-auth");

    const reparsed = parseMcpConfigYaml(serializeMcpConfigYaml(parsed.config));
    expect(reparsed).toEqual(parsed);
  });

  it("strictly rejects unknown policy fields and malformed value sources", () => {
    const unknown = parseMcpConfigYaml(`
configVersion: 1
servers:
  local:
    transport: stdio
    command: bun
    allowProfiles: [primary]
`);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.join("\n")).toContain("allowProfiles");

    const malformedSource = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    headers:
      X-Token: { env: TOKEN, fallback: nope }
`);
    expect(malformedSource.ok).toBe(false);

    expect(parseMcpConfigYaml("# empty\n").ok).toBe(false);
    expect(parseMcpConfigYaml("configVersion: 2\nservers: {}\n").ok).toBe(false);
  });

  for (const transport of ["stdio", "http"] as const) {
    for (const allowSubagents of [undefined, false, true]) {
      it(`round-trips ${transport} subagent access ${String(allowSubagents)}`, () => {
        const source = [
          "configVersion: 1",
          "servers:",
          "  docs:",
          `    transport: ${transport}`,
          transport === "stdio" ? "    command: bun" : "    url: https://example.invalid/mcp",
          ...(allowSubagents === undefined ? [] : [`    allowSubagents: ${allowSubagents}`]),
        ].join("\n");
        const parsed = parseMcpConfigYaml(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
        expect(parsed.config.servers.docs?.allowSubagents).toBe(allowSubagents ?? false);
        expect(parseMcpConfigYaml(serializeMcpConfigYaml(parsed.config))).toEqual(parsed);
      });
    }

    for (const invalid of ['"true"', "null", "1", "[]"]) {
      it(`rejects ${transport} non-boolean subagent access ${invalid}`, () => {
        const parsed = parseMcpConfigYaml(
          [
            "configVersion: 1",
            "servers:",
            "  docs:",
            `    transport: ${transport}`,
            transport === "stdio" ? "    command: bun" : "    url: https://example.invalid/mcp",
            `    allowSubagents: ${invalid}`,
          ].join("\n"),
        );
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.issues.join("\n")).toContain("allowSubagents");
      });
    }
  }

  it("rejects unsupported HTTP forms and ambiguous authorization", () => {
    const unsupported = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: ftp://example.invalid/mcp
`);
    expect(unsupported.ok).toBe(false);

    const ambiguous = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    headers: { Authorization: Bearer-token }
    auth:
      type: oauth
      grant: authorization_code
      client: { type: dynamic }
`);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.issues.join("\n")).toContain("cannot be combined");

    const clientCredentials = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: client_credentials
      client:
        type: static
        clientId: service-client
        clientSecret: service-secret
`);
    expect(clientCredentials.ok).toBe(false);

    const configurableRedirect = parseMcpConfigYaml(`
configVersion: 1
servers:
  remote:
    transport: http
    url: https://example.invalid/mcp
    auth:
      type: oauth
      grant: authorization_code
      redirectUri: https://example.invalid/oauth/callback
      client: { type: dynamic }
`);
    expect(configurableRedirect.ok).toBe(false);
  });

  it("rejects invalid emitted shapes while preserving earlier serialization errors", () => {
    const unsupported = serializeMcpConfigYamlResult({
      configVersion: 2,
      servers: { expected: stdioServer("different") },
    });
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error).toMatchObject({ reason: "unsupported-version" });
    }

    const invalid = serializeMcpConfigYamlResult({
      configVersion: 1,
      servers: { "../invalid": stdioServer("../invalid") },
    });
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") {
      expect(invalid.error).toMatchObject({ reason: "invalid-output" });
    }

    const mismatched = serializeMcpConfigYamlResult({
      configVersion: 1,
      servers: { expected: stdioServer("different") },
    });
    expect(mismatched.status).toBe("error");
    if (mismatched.status === "error") {
      expect(mismatched.error).toMatchObject({ reason: "id-mismatch" });
    }
  });
});

describe("MCP config file mutations", () => {
  it("atomically upserts and removes servers from a missing config", async () => {
    const dataDir = await createDataDir();
    const configPath = resolveMcpConfigPath({ dataDir });

    const [firstResult, secondResult] = await Promise.all([
      mutateMcpConfigFile({
        configPath,
        mutation: { type: "upsert", server: stdioServer("alpha") },
      }),
      mutateMcpConfigFile({
        configPath,
        mutation: { type: "upsert", server: stdioServer("beta", "node") },
      }),
    ]);
    const first = expectOk(firstResult);
    const second = expectOk(secondResult);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);

    const loaded = expectOk(await readMcpConfigFile(configPath));
    expect(Object.keys(loaded.config.servers)).toEqual(["alpha", "beta"]);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    const removed = expectOk(
      await mutateMcpConfigFile({
        configPath,
        mutation: { type: "remove", serverId: "alpha" },
      }),
    );
    expect(removed.changed).toBe(true);
    expect(Object.keys(removed.config.servers)).toEqual(["beta"]);

    const noOp = expectOk(
      await mutateMcpConfigFile({
        configPath,
        mutation: { type: "remove", serverId: "alpha" },
      }),
    );
    expect(noOp.changed).toBe(false);
  });

  it("refuses to mutate an invalid existing file", async () => {
    const dataDir = await createDataDir();
    const configPath = resolveMcpConfigPath({ dataDir });
    const invalid = "configVersion: 1\nservers:\n  bad:\n    transport: websocket\n";
    await writeFile(configPath, invalid, "utf8");

    const mutation = await mutateMcpConfigFile({
      configPath,
      mutation: { type: "upsert", server: stdioServer("good") },
    });
    expect(mutation.status).toBe("error");
    if (mutation.status === "error") expect(mutation.error).toBeInstanceOf(McpConfigError);
    expect(await readFile(configPath, "utf8")).toBe(invalid);
  });

  it("uses deterministic cleanup precedence for atomic writes", async () => {
    const configPath = "/data/mcp-config.yaml";
    const calls: string[] = [];
    let writeFailure: Error | undefined;
    let closeFailure: Error | undefined;
    const dependencies = {
      mkdir: async () => undefined,
      open: async () => ({
        writeFile: async () => {
          calls.push("write");
          if (writeFailure) throw writeFailure;
        },
        sync: async () => {
          calls.push("sync");
        },
        close: async () => {
          calls.push("close");
          if (closeFailure) throw closeFailure;
        },
      }),
      rename: async () => {
        calls.push("rename");
      },
      rm: async () => {
        calls.push("remove");
      },
      randomUUID: () => "fixed",
    } satisfies McpConfigFileDependencies;

    closeFailure = new Error("close failed");
    const cleanupOnly = await writeMcpConfigFileAtomic(
      configPath,
      { configVersion: 1, servers: {} },
      dependencies,
    );
    expect(cleanupOnly.status).toBe("error");
    if (cleanupOnly.status === "error") {
      expect(cleanupOnly.error).toBeInstanceOf(McpConfigFileOperationError);
      expect(cleanupOnly.error).toMatchObject({ operation: "close_temporary" });
    }
    expect(calls).toEqual(["write", "sync", "close", "remove"]);

    calls.length = 0;
    writeFailure = new Error("write failed");
    const primaryAndCleanup = await writeMcpConfigFileAtomic(
      configPath,
      { configVersion: 1, servers: {} },
      dependencies,
    );
    expect(primaryAndCleanup.status).toBe("error");
    if (primaryAndCleanup.status === "error") {
      expect(primaryAndCleanup.error).toBeInstanceOf(McpConfigFileOperationAndCleanupError);
      expect(primaryAndCleanup.error).toMatchObject({
        primary: { operation: "write_temporary" },
        cleanup: { operation: "close_temporary" },
      });
    }
    expect(calls).toEqual(["write", "close", "remove"]);

    for (const panicOperation of ["write", "sync"] as const) {
      calls.length = 0;
      writeFailure = undefined;
      closeFailure = new Error("cleanup failed after Panic");
      const panic = new Panic({ message: `${panicOperation} invariant failed` });
      const panicDependencies = {
        ...dependencies,
        open: async () => ({
          writeFile: async () => {
            calls.push("write");
            if (panicOperation === "write") throw panic;
          },
          sync: async () => {
            calls.push("sync");
            if (panicOperation === "sync") throw panic;
          },
          close: async () => {
            calls.push("close");
            if (closeFailure) throw closeFailure;
          },
        }),
      } satisfies McpConfigFileDependencies;
      await expect(
        writeMcpConfigFileAtomic(configPath, { configVersion: 1, servers: {} }, panicDependencies),
      ).rejects.toBe(panic);
      expect(calls).toEqual(
        panicOperation === "write"
          ? ["write", "close", "remove"]
          : ["write", "sync", "close", "remove"],
      );
      if (panicOperation === "write") {
        calls.length = 0;
        await expect(
          mutateMcpConfigFile({
            configPath,
            mutation: { type: "upsert", server: stdioServer("panic") },
            fileDependencies: panicDependencies,
          }),
        ).rejects.toBe(panic);
        expect(calls).toEqual(["write", "close", "remove"]);
      }
    }

    for (const panicOperation of ["close", "rename"] as const) {
      calls.length = 0;
      const panic = new Panic({ message: `${panicOperation} invariant failed` });
      const panicDependencies = {
        ...dependencies,
        open: async () => ({
          writeFile: async () => {
            calls.push("write");
          },
          sync: async () => {
            calls.push("sync");
          },
          close: async () => {
            calls.push("close");
            if (panicOperation === "close") throw panic;
          },
        }),
        rename: async () => {
          calls.push("rename");
          if (panicOperation === "rename") throw panic;
        },
      } satisfies McpConfigFileDependencies;
      await expect(
        writeMcpConfigFileAtomic(configPath, { configVersion: 1, servers: {} }, panicDependencies),
      ).rejects.toBe(panic);
      expect(calls).toEqual(
        panicOperation === "close"
          ? ["write", "sync", "close", "remove"]
          : ["write", "sync", "close", "rename", "remove"],
      );
    }

    calls.length = 0;
    const hostileCause = {
      toString: () => {
        throw new Error("must not coerce rejection");
      },
      [Symbol.toPrimitive]: () => {
        throw new Error("must not coerce rejection");
      },
    };
    const hostileResult = await writeMcpConfigFileAtomic(
      configPath,
      { configVersion: 1, servers: {} },
      {
        ...dependencies,
        open: async () => ({
          writeFile: () => Promise.reject(hostileCause),
          sync: async () => undefined,
          close: async () => {
            calls.push("close");
          },
        }),
      },
    );
    expect(hostileResult.status).toBe("error");
    if (hostileResult.status === "error") {
      expect(hostileResult.error).toMatchObject({
        operation: "write_temporary",
        cause: hostileCause,
      });
      expect(hostileResult.error.message).toEndWith("Unknown error");
    }
    expect(calls).toEqual(["close", "remove"]);
  });

  it("preserves operation Panic identity across atomic-write cleanup Panics", async () => {
    const configPath = "/data/mcp-config.yaml";
    const expectedCalls = {
      open: ["open", "remove"],
      write: ["open", "write", "close", "remove"],
      sync: ["open", "write", "sync", "close", "remove"],
      close: ["open", "write", "sync", "close", "remove"],
      rename: ["open", "write", "sync", "close", "rename", "remove"],
    } satisfies Record<string, readonly string[]>;

    for (const operation of ["open", "write", "sync", "close", "rename"] as const) {
      const calls: string[] = [];
      const primaryPanic = new Panic({ message: `${operation} invariant failed` });
      const cleanupPanic = new Panic({ message: `${operation} cleanup invariant failed` });
      const removePanic = new Panic({ message: `${operation} remove invariant failed` });
      const dependencies = {
        mkdir: async () => undefined,
        open: async () => {
          calls.push("open");
          if (operation === "open") throw primaryPanic;
          return {
            writeFile: async () => {
              calls.push("write");
              if (operation === "write") throw primaryPanic;
            },
            sync: async () => {
              calls.push("sync");
              if (operation === "sync") throw primaryPanic;
            },
            close: async () => {
              calls.push("close");
              if (operation === "close") throw primaryPanic;
              if (operation === "write" || operation === "sync") throw cleanupPanic;
            },
          };
        },
        rename: async () => {
          calls.push("rename");
          if (operation === "rename") throw primaryPanic;
        },
        rm: async () => {
          calls.push("remove");
          throw removePanic;
        },
        randomUUID: () => "fixed",
      } satisfies McpConfigFileDependencies;

      await expect(
        writeMcpConfigFileAtomic(configPath, { configVersion: 1, servers: {} }, dependencies),
      ).rejects.toBe(primaryPanic);
      expect(calls).toEqual(expectedCalls[operation]);
    }
  });

  it("preserves cleanup Panic identity when no operation Panic exists", async () => {
    const configPath = "/data/mcp-config.yaml";
    const calls: string[] = [];
    const removePanic = new Panic({ message: "remove invariant failed" });
    const openFailure = new Error("open failed");
    const openDependencies = {
      mkdir: async () => undefined,
      open: async () => {
        calls.push("open");
        throw openFailure;
      },
      rename: async () => undefined,
      rm: async () => {
        calls.push("remove");
        throw removePanic;
      },
      randomUUID: () => "fixed",
    } satisfies McpConfigFileDependencies;

    await expect(
      writeMcpConfigFileAtomic(configPath, { configVersion: 1, servers: {} }, openDependencies),
    ).rejects.toBe(removePanic);
    expect(calls).toEqual(["open", "remove"]);

    calls.length = 0;
    const closePanic = new Panic({ message: "close invariant failed" });
    const laterRemovePanic = new Panic({ message: "later remove invariant failed" });
    const writeFailure = new Error("write failed");
    const closeDependencies = {
      ...openDependencies,
      open: async () => ({
        writeFile: async () => {
          calls.push("write");
          throw writeFailure;
        },
        sync: async () => {
          calls.push("sync");
        },
        close: async () => {
          calls.push("close");
          throw closePanic;
        },
      }),
      rm: async () => {
        calls.push("remove");
        throw laterRemovePanic;
      },
    } satisfies McpConfigFileDependencies;

    await expect(
      writeMcpConfigFileAtomic(configPath, { configVersion: 1, servers: {} }, closeDependencies),
    ).rejects.toBe(closePanic);
    expect(calls).toEqual(["write", "close", "remove"]);
  });
});
