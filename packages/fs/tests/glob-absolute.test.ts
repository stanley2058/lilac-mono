import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem, type FsBackend, type GlobResult } from "../src/index";

const backends = ["node-rg", "fff"] satisfies readonly FsBackend[];

function makeFs(root: string, backend: FsBackend): FileSystem {
  return new FileSystem(root, {
    fsBackend: backend,
    fffCacheDir: `${root}-fff-cache-${backend}`,
  });
}

function expectDefaultPaths(result: GlobResult, expected: readonly string[]): void {
  expect(result.error).toBeUndefined();
  expect(result.mode).toBe("default");
  if (result.mode !== "default") {
    throw new Error("expected default glob result");
  }
  expect(result.paths.sort()).toEqual([...expected].sort());
}

describe("absolute glob patterns", () => {
  let parentDir: string;
  let baseDir: string;

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(tmpdir(), "lilac-fs-absolute-glob-"));
    baseDir = path.join(parentDir, "workspace");

    await mkdir(path.join(baseDir, "src"), { recursive: true });
    await writeFile(path.join(baseDir, "root.txt"), "root\n");
    await writeFile(path.join(baseDir, "src", "a.ts"), "export const alpha = 1;\n");
    await writeFile(path.join(baseDir, "src", "b.ts"), "export const beta = 1;\n");
    await writeFile(path.join(parentDir, "outside.ts"), "export const outside = true;\n");
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
    for (const backend of backends) {
      await rm(`${baseDir}-fff-cache-${backend}`, { recursive: true, force: true });
      await rm(`${parentDir}-fff-cache-${backend}`, { recursive: true, force: true });
    }
  });

  it("matches absolute patterns under the cwd", async () => {
    for (const backend of backends) {
      const result = await makeFs(baseDir, backend).glob({
        patterns: [path.join(baseDir, "*")],
        mode: "default",
      });

      expectDefaultPaths(result, ["root.txt", "src"]);
    }
  });

  it("matches absolute patterns from a parent cwd", async () => {
    for (const backend of backends) {
      const result = await makeFs(parentDir, backend).glob({
        patterns: [path.join(baseDir, "src", "*.ts")],
        mode: "default",
      });

      expectDefaultPaths(result, ["workspace/src/a.ts", "workspace/src/b.ts"]);
    }
  });

  it("supports exact absolute file patterns", async () => {
    for (const backend of backends) {
      const result = await makeFs(baseDir, backend).glob({
        patterns: [path.join(baseDir, "src", "a.ts")],
        mode: "default",
      });

      expectDefaultPaths(result, ["src/a.ts"]);
    }
  });

  it("supports absolute negated patterns", async () => {
    for (const backend of backends) {
      const result = await makeFs(baseDir, backend).glob({
        patterns: [path.join(baseDir, "src", "*.ts"), `!${path.join(baseDir, "src", "b.ts")}`],
        mode: "default",
      });

      expectDefaultPaths(result, ["src/a.ts"]);
    }
  });

  it("does not descend into an excluded pruned search root", async () => {
    for (const backend of backends) {
      const globstarResult = await makeFs(baseDir, backend).glob({
        patterns: ["src/**/*.ts", "!src"],
        mode: "default",
      });
      const exactResult = await makeFs(baseDir, backend).glob({
        patterns: ["src/a.ts", "!src"],
        mode: "default",
      });

      expectDefaultPaths(globstarResult, []);
      expectDefaultPaths(exactResult, []);
    }
  });

  it("does not escape the cwd for absolute patterns outside the cwd", async () => {
    for (const backend of backends) {
      const result = await makeFs(baseDir, backend).glob({
        patterns: [path.join(parentDir, "outside.ts")],
        mode: "default",
      });

      expectDefaultPaths(result, []);
    }
  });

  it("keeps matching directories and symlinks on the native glob path", async () => {
    await mkdir(path.join(baseDir, "src", "generated.ts"));
    await symlink(path.join(baseDir, "src", "a.ts"), path.join(baseDir, "src", "alias.ts"));

    const result = await makeFs(baseDir, "node-rg").glob({
      patterns: ["**/*.ts"],
      mode: "default",
    });

    expectDefaultPaths(result, ["src/a.ts", "src/alias.ts", "src/b.ts", "src/generated.ts"]);
    expect(result.effectiveBackend).toBe("node-rg");

    const rooted = await makeFs(baseDir, "node-rg").glob({
      patterns: ["src/**"],
      mode: "default",
    });
    expect(rooted.mode === "default" && rooted.paths).toContain("src");
  });

  it("skips a broken symlink in detailed native glob results", async () => {
    await symlink(path.join(baseDir, "missing.ts"), path.join(baseDir, "broken.ts"));

    const defaults = await makeFs(baseDir, "node-rg").glob({
      patterns: ["**/*.ts"],
      mode: "default",
    });
    expect(defaults.mode === "default" && defaults.paths).toContain("broken.ts");

    const detailed = await makeFs(baseDir, "node-rg").glob({
      patterns: ["**/*.ts"],
      mode: "detailed",
    });
    expect(detailed.error).toBeUndefined();
    expect(
      detailed.mode === "detailed" && detailed.entries.map((entry) => entry.path),
    ).not.toContain("broken.ts");
  });

  it("preserves zero-length terminal glob matches on the native path", async () => {
    await mkdir(path.join(baseDir, "src", "a"));
    await mkdir(path.join(baseDir, "src", "b"));

    const cases = [
      { pattern: "src/*/**", expected: ["src/a", "src/a.ts", "src/b", "src/b.ts"] },
      { pattern: "**/a/**", expected: ["src/a"] },
      { pattern: "src/", expected: ["src"] },
      { pattern: "*/", expected: ["root.txt", "src"] },
      {
        pattern: "**/",
        expected: ["root.txt", "src", "src/a", "src/a.ts", "src/b", "src/b.ts"],
      },
      {
        pattern: "src/**/",
        expected: ["src", "src/a", "src/a.ts", "src/b", "src/b.ts"],
      },
    ];
    for (const { pattern, expected } of cases) {
      const result = await makeFs(baseDir, "node-rg").glob({
        patterns: [pattern],
        mode: "default",
      });
      expectDefaultPaths(result, expected);
      expect(result.effectiveBackend).toBe("node-rg");
    }
  });

  it("returns native empty results without falling back to the filesystem walker", async () => {
    const result = await makeFs(baseDir, "node-rg").glob({
      patterns: ["**/*.missing"],
      mode: "default",
    });

    expectDefaultPaths(result, []);
    expect(result.effectiveBackend).toBe("node-rg");
  });

  it("filters stale FFF paths before returning default or detailed results", async () => {
    const fileSystem = makeFs(baseDir, "fff");
    const stalePath = path.join(baseDir, "stale.ts");
    await writeFile(stalePath, "export {};\n");
    expectDefaultPaths(await fileSystem.glob({ patterns: ["**/*.ts"], mode: "default" }), [
      "src/a.ts",
      "src/b.ts",
      "stale.ts",
    ]);

    await unlink(stalePath);
    const defaults = await fileSystem.glob({ patterns: ["**/*.ts"], mode: "default" });
    expectDefaultPaths(defaults, ["src/a.ts", "src/b.ts"]);

    const detailed = await fileSystem.glob({ patterns: ["**/*.ts"], mode: "detailed" });
    expect(detailed.error).toBeUndefined();
    if (detailed.mode !== "detailed") throw new Error("expected detailed glob result");
    expect(detailed.entries.map((entry) => entry.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
