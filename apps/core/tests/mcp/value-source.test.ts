import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import {
  resolveJsonPointer,
  resolveMcpValueSource,
  resolveMcpValueSourceMap,
  validateHttpHeaders,
} from "../../src/mcp";

function expectOk<T, E extends Error>(result: import("better-result").Result<T, E>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-mcp-values-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP value sources", () => {
  it("resolves inline, environment, whole-file, and JSON Pointer values", async () => {
    const baseDir = await createTemporaryDirectory();
    await writeFile(path.join(baseDir, "token.txt"), "file-token\n", "utf8");
    await writeFile(
      path.join(baseDir, "values.json"),
      JSON.stringify({ "a/b": { "c~d": ["zero", "selected"] } }),
      "utf8",
    );
    const context = { baseDir, env: { TOKEN: "environment-token" } };

    expect(expectOk(await resolveMcpValueSource("inline", context))).toBe("inline");
    expect(expectOk(await resolveMcpValueSource({ env: "TOKEN" }, context))).toBe(
      "environment-token",
    );
    expect(expectOk(await resolveMcpValueSource({ file: "token.txt" }, context))).toBe(
      "file-token",
    );
    expect(
      expectOk(
        await resolveMcpValueSource({ file: "values.json", pointer: "/a~1b/c~0d/1" }, context),
      ),
    ).toBe("selected");
  });

  it("prepends prefixes after resolving values and preserves failures", async () => {
    const context = {
      baseDir: "/data",
      env: { TOKEN: "env-token" },
      readTextFile: async (file: string) =>
        file.endsWith(".json") ? JSON.stringify({ token: " json-token " }) : " file-token\n",
    };
    const values = expectOk(
      await resolveMcpValueSourceMap(
        {
          Authorization: { env: "TOKEN", prefix: "Bearer " },
          "X-File": { file: "token.txt", prefix: "Token " },
          "X-Json": { file: "auth.json", pointer: "/token", prefix: "Basic " },
          "X-Empty": { env: "TOKEN", prefix: "" },
        },
        context,
      ),
    );
    expect(values).toEqual({
      Authorization: "Bearer env-token",
      "X-File": "Token file-token",
      "X-Json": "Basic  json-token ",
      "X-Empty": "env-token",
    });
    expect(validateHttpHeaders(values).status).toBe("ok");
    expect(
      (await resolveMcpValueSource({ env: "MISSING", prefix: "Bearer " }, context)).status,
    ).toBe("error");
    expect(
      (
        await resolveMcpValueSource(
          { file: "auth.json", pointer: "/missing", prefix: "Bearer " },
          context,
        )
      ).status,
    ).toBe("error");
    const unsafe = expectOk(
      await resolveMcpValueSourceMap(
        {
          Authorization: { env: "TOKEN", prefix: "Bearer\r\n" },
        },
        context,
      ),
    );
    expect(validateHttpHeaders(unsafe).status).toBe("error");
  });

  it("returns contextual failures without exposing other resolved values", async () => {
    const baseDir = await createTemporaryDirectory();
    const result = await resolveMcpValueSourceMap(
      { GOOD: "secret-good", BAD: { env: "MISSING" } },
      { baseDir, env: {} },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("McpValueMapResolutionError");
      expect(result.error.message).toBe("BAD: environment variable MISSING is not set");
    }
    expect(JSON.stringify(result)).not.toContain("secret-good");
  });

  it("rejects invalid pointers, non-string targets, and unsafe headers", async () => {
    const missing = resolveJsonPointer({ value: "x" }, "/missing");
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.error.message).toContain("does not exist");
    const invalidEscape = resolveJsonPointer({ value: "x" }, "/bad~2escape");
    expect(invalidEscape.status).toBe("error");
    if (invalidEscape.status === "error") {
      expect(invalidEscape.error.message).toContain("invalid escaping");
    }

    const baseDir = await createTemporaryDirectory();
    await writeFile(path.join(baseDir, "values.json"), JSON.stringify({ count: 1 }), "utf8");
    expect(
      (
        await resolveMcpValueSource(
          { file: "values.json", pointer: "/count" },
          { baseDir, env: {} },
        )
      ).status,
    ).toBe("error");

    expect(validateHttpHeaders({ "X-Valid": "value" }).status).toBe("ok");
    expect(validateHttpHeaders({ "Bad Header": "value" }).status).toBe("error");
    expect(validateHttpHeaders({ "X-Unsafe": "first\r\nsecond" }).status).toBe("error");
  });

  it("redacts tagged errors from the file adapter", async () => {
    const result = await resolveMcpValueSource(
      { file: "token.txt" },
      {
        baseDir: "/data",
        env: {},
        readTextFile: async () => {
          throw new Error("token=top-secret");
        },
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(formatTaggedErrorForLog(result.error)).toEqual({
        errorTag: "McpValueFileReadError",
        errorMessage: "failed to read token.txt: token=<redacted>",
      });
    }
  });
});
