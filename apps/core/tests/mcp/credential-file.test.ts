import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Panic } from "better-result";

import {
  McpOAuthCredentialError,
  McpOAuthCredentialWriteAndCleanupError,
  readMcpOAuthCredentialFile,
  readMcpOAuthCredentialFileResult,
  resolveMcpOAuthCredentialPath,
  resolveMcpOAuthCredentialPathResult,
  updateMcpOAuthCredentialFile,
  writeMcpOAuthCredentialFileAtomicResult,
  type McpOAuthCredentialFileDependencies,
} from "../../src/mcp";

const temporaryDirectories: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-oauth-credentials-"));
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

describe("MCP OAuth credential files", () => {
  it("atomically persists durable fields with private modes", async () => {
    const dataDir = await createDataDir();
    const credentialPath = resolveMcpOAuthCredentialPath({ dataDir, serverId: "docs" });

    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => ({
        ...credential,
        clientInformation: {
          client_id: "registered-client",
          client_secret: "client-secret",
          issuer: "https://auth.example.test",
        },
        authorizationServerInformation: {
          issuer: "https://auth.example.test",
          authorizationServerUrl: "https://auth.example.test",
          tokenEndpoint: "https://auth.example.test/token",
        },
      }),
    });
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => ({
        ...credential,
        tokens: {
          access_token: "access-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          issuer: "https://auth.example.test",
        },
      }),
    });

    expect(await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).toMatchObject({
      version: 1,
      serverUrl: "https://mcp.example.test/service",
      clientInformation: {
        client_id: "registered-client",
        issuer: "https://auth.example.test",
      },
      authorizationServerInformation: {
        issuer: "https://auth.example.test",
        authorizationServerUrl: "https://auth.example.test",
        tokenEndpoint: "https://auth.example.test/token",
      },
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        issuer: "https://auth.example.test",
      },
    });
    expect((await stat(path.dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(credentialPath))).toEqual(["docs.json"]);
  });

  it("restores private directory mode and rejects malformed credentials safely", async () => {
    const dataDir = await createDataDir();
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => credential,
    });
    const credentialPath = resolveMcpOAuthCredentialPath({ dataDir, serverId: "docs" });
    await chmod(path.dirname(credentialPath), 0o755);
    await Bun.write(credentialPath, '{"access_token":"must-not-appear"}\n');

    await expect(readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).rejects.toBeInstanceOf(
      McpOAuthCredentialError,
    );
    try {
      await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" });
    } catch (error) {
      expect(String(error)).not.toContain("must-not-appear");
    }

    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "other",
      serverUrl: "https://mcp.example.test/other",
      update: (credential) => credential,
    });
    expect((await stat(path.dirname(credentialPath))).mode & 0o777).toBe(0o700);
    expect(
      await readFile(resolveMcpOAuthCredentialPath({ dataDir, serverId: "other" }), "utf8"),
    ).toContain('"version": 1');
  });

  it("starts a clean durable record when a server ID is pointed at a new URL", async () => {
    const dataDir = await createDataDir();
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://old.example.test/mcp",
      update: (credential) => ({
        ...credential,
        tokens: { access_token: "old-token", token_type: "Bearer" },
      }),
    });
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://new.example.test/mcp",
      update: (credential) => ({
        ...credential,
        clientInformation: { client_id: "new-client" },
      }),
    });

    expect(await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).toEqual({
      version: 1,
      serverUrl: "https://new.example.test/mcp",
      clientInformation: { client_id: "new-client" },
    });
  });

  it("returns owned Results for malformed persisted credentials and invalid server IDs", async () => {
    const dataDir = await createDataDir();
    await updateMcpOAuthCredentialFile({
      dataDir,
      serverId: "docs",
      serverUrl: "https://mcp.example.test/service",
      update: (credential) => credential,
    });
    const credentialPath = resolveMcpOAuthCredentialPath({ dataDir, serverId: "docs" });
    await Bun.write(credentialPath, '{"version":1,"serverUrl":"secret-value"}\n');

    const malformed = await readMcpOAuthCredentialFileResult({ dataDir, serverId: "docs" });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error).toBeInstanceOf(McpOAuthCredentialError);
      expect(malformed.error.operation).toBe("read");
      expect(malformed.error.message).not.toContain("secret-value");
    }

    const invalidPath = resolveMcpOAuthCredentialPathResult({ dataDir, serverId: "../escape" });
    expect(invalidPath.status).toBe("error");
    if (invalidPath.status === "error") {
      expect(invalidPath.error.operation).toBe("resolve");
      expect(invalidPath.error.credentialPath).not.toContain("escape.json");
    }
  });

  it("preserves primary and cleanup failures from atomic writes", async () => {
    const calls: string[] = [];
    let writeFailure: Error | undefined;
    let closeFailure: Error | undefined;
    let removeFailure: Error | undefined;
    const dependencies = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => ({
        writeFile: async () => {
          calls.push("write");
          if (writeFailure) throw writeFailure;
        },
        chmod: async () => {
          calls.push("chmod-file");
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
        if (removeFailure) throw removeFailure;
      },
      randomUUID: () => "fixed",
    } satisfies McpOAuthCredentialFileDependencies;
    const input = {
      dataDir: "/data",
      serverId: "docs",
      credential: {
        version: 1 as const,
        serverUrl: "https://mcp.example.test/service",
      },
      dependencies,
    };

    closeFailure = new Error("close failed");
    const cleanupOnly = await writeMcpOAuthCredentialFileAtomicResult(input);
    expect(cleanupOnly.status).toBe("error");
    if (cleanupOnly.status === "error") {
      expect(cleanupOnly.error).toBeInstanceOf(McpOAuthCredentialError);
      expect(cleanupOnly.error).toMatchObject({ operation: "cleanup", cause: closeFailure });
    }
    expect(calls).toEqual(["write", "chmod-file", "sync", "close", "remove"]);

    calls.length = 0;
    writeFailure = new Error("write failed");
    removeFailure = new Error("remove failed");
    const combined = await writeMcpOAuthCredentialFileAtomicResult(input);
    expect(combined.status).toBe("error");
    if (combined.status === "error") {
      expect(combined.error).toBeInstanceOf(McpOAuthCredentialWriteAndCleanupError);
      expect(combined.error).toMatchObject({
        primary: {
          primary: { operation: "write", cause: writeFailure },
          cleanup: { operation: "cleanup", cause: closeFailure },
        },
        cleanup: { operation: "cleanup", cause: removeFailure },
      });
    }
    expect(calls).toEqual(["write", "close", "remove"]);
  });

  it("preserves the original write Panic through cleanup failures", async () => {
    const primaryPanic = new Panic({ message: "write invariant failed" });
    const cleanupPanic = new Panic({ message: "close invariant failed" });
    const calls: string[] = [];
    const dependencies = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => ({
        writeFile: async () => {
          calls.push("write");
          throw primaryPanic;
        },
        chmod: async () => {
          calls.push("chmod-file");
        },
        sync: async () => {
          calls.push("sync");
        },
        close: async () => {
          calls.push("close");
          throw cleanupPanic;
        },
      }),
      rename: async () => {
        calls.push("rename");
      },
      rm: async () => {
        calls.push("remove");
        throw new Error("remove failed");
      },
      randomUUID: () => "fixed",
    } satisfies McpOAuthCredentialFileDependencies;

    await expect(
      writeMcpOAuthCredentialFileAtomicResult({
        dataDir: "/data",
        serverId: "docs",
        credential: { version: 1, serverUrl: "https://mcp.example.test/service" },
        dependencies,
      }),
    ).rejects.toBe(primaryPanic);
    expect(calls).toEqual(["write", "close", "remove"]);
  });
});
