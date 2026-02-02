import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "../../src/tools/fs/fs-impl";

describe("fs denylist", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "lilac-fs-deny-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("blocks reads under denied directories", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const secretFile = join(secretDir, "key.txt");
    await writeFile(secretFile, "super-secret", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });
    const res = await fsTool.readFile({ path: secretFile });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PERMISSION");
  });
});
