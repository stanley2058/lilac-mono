import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
