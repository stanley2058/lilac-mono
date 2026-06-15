import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem, type FsBackend } from "../src/index";

const backends = ["node-rg", "fff"] satisfies readonly FsBackend[];

describe("search permission handling", () => {
  let baseDir: string;
  let blockedDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-fs-perms-"));
    blockedDir = path.join(baseDir, "blocked");

    await mkdir(path.join(baseDir, "ok"), { recursive: true });
    await mkdir(blockedDir, { recursive: true });
    await writeFile(path.join(baseDir, "ok", "package.json"), "{}\n");
    await writeFile(path.join(blockedDir, "package.json"), "{}\n");
    await chmod(blockedDir, 0);
  });

  afterEach(async () => {
    await chmod(blockedDir, 0o700).catch(() => undefined);
    await rm(baseDir, { recursive: true, force: true });
  });

  it("glob skips inaccessible subdirectories", async () => {
    if (process.getuid?.() === 0) return;

    for (const backend of backends) {
      const fsTool = new FileSystem(baseDir, {
        fsBackend: backend,
        fffCacheDir: path.join(baseDir, `.fff-cache-${backend}`),
      });

      const result = await fsTool.glob({ patterns: ["**/package.json"], mode: "default" });

      expect(result.error).toBeUndefined();
      expect(result.mode).toBe("default");
      if (result.mode !== "default") {
        throw new Error("expected default glob result");
      }
      expect(result.paths.map((p) => p.replace(/^\.\//, "")).sort()).toEqual(["ok/package.json"]);
      expect(result.truncated).toBe(false);
    }
  });
});
