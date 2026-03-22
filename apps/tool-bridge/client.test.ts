import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildToolInput, isMainModule, parseArgs, resolveBuildId } from "./client";

describe("tool-bridge entrypoint detection", () => {
  it("treats the generated dist index wrapper as the main CLI entrypoint", () => {
    expect(
      isMainModule(
        [
          "/usr/bin/bun",
          "/workspace/apps/tool-bridge/dist/index.js",
          "fetch",
          "https://example.com",
        ],
        "/workspace",
        "/workspace/apps/tool-bridge/dist/client.js",
      ),
    ).toBe(true);
  });

  it("treats a symlinked `tools` entrypoint as the main CLI entrypoint", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-"));

    try {
      const distDir = path.join(root, "dist");
      const binDir = path.join(root, "bin");
      const clientPath = path.join(distDir, "client.js");
      const indexPath = path.join(distDir, "index.js");
      const toolsPath = path.join(binDir, "tools");

      await fs.mkdir(distDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(clientPath, 'console.log("client");\n');
      await fs.writeFile(indexPath, 'import "./client.js";\n');
      await fs.symlink(indexPath, toolsPath);

      expect(isMainModule(["/usr/bin/bun", toolsPath, "--list"], root, clientPath)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("tool-bridge build id", () => {
  it("hashes the built client artifact and trims to 8 characters", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-"));

    try {
      const distDir = path.join(root, "dist");
      const clientPath = path.join(distDir, "client.js");
      const indexPath = path.join(distDir, "index.js");
      const clientSource = 'console.log("built client");\n';
      const expected = createHash("sha256").update(clientSource).digest("hex").slice(0, 8);

      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(clientPath, clientSource);
      await fs.writeFile(indexPath, 'import "./client.js";\n');

      await expect(resolveBuildId(clientPath)).resolves.toBe(expected);
      await expect(resolveBuildId(indexPath)).resolves.toBe(expected);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to dev when running from source", async () => {
    await expect(resolveBuildId("/workspace/apps/tool-bridge/client.ts")).resolves.toBe("dev");
  });
});

describe("tool-bridge positional input", () => {
  it("parses a bare positional argument for tool calls", () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--mode=browser"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.callableId).toBe("fetch");
    expect(parsed.positionalArgs).toEqual(["https://example.com"]);
    expect(parsed.fieldInputs).toEqual([{ field: "mode", value: "browser" }]);
  });

  it("supports `--` for positional values that begin with dashes", () => {
    const parsed = parseArgs(["fetch", "--", "--literal-value"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["--literal-value"]);
  });

  it("maps the primary positional argument into tool input", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--format=text"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).resolves.toEqual({
      url: "https://example.com",
      format: "text",
    });
  });

  it("rejects positional input for tools without primary positional metadata", async () => {
    const parsed = parseArgs(["search", "llms"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed)).rejects.toThrow(
      "Tool 'search' does not support positional input.",
    );
  });

  it("rejects duplicate positional and named input for the same field", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--url=https://other.example.com"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).rejects.toThrow(
      "Primary positional <url> conflicts with an existing 'url' value",
    );
  });
});
