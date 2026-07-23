import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem } from "../src";

describe("filesystem deny paths through symlinks", () => {
  let baseDir: string;
  let protectedDir: string;
  let protectedFile: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-fs-deny-symlink-"));
    protectedDir = path.join(baseDir, "protected");
    protectedFile = path.join(protectedDir, "secret.txt");
    await mkdir(protectedDir);
    await writeFile(protectedFile, "secret\n");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("blocks text and byte reads through an alias into a denied directory", async () => {
    const aliasDir = path.join(baseDir, "alias");
    await symlink(protectedDir, aliasDir);
    const fileSystem = new FileSystem(baseDir, { denyPaths: [protectedDir] });

    const textResult = await fileSystem.readFile({ path: path.join(aliasDir, "secret.txt") });
    const bytesResult = await fileSystem.readFileBytes({
      path: path.join(aliasDir, "secret.txt"),
    });

    expect(textResult.success).toBe(false);
    expect(textResult.success ? undefined : textResult.error.code).toBe("PERMISSION");
    expect(bytesResult.success).toBe(false);
    expect(bytesResult.success ? undefined : bytesResult.error.code).toBe("PERMISSION");
  });

  it("blocks the canonical target when the configured deny path is a symlink", async () => {
    const deniedAlias = path.join(baseDir, "denied-alias");
    await symlink(protectedDir, deniedAlias);
    const fileSystem = new FileSystem(baseDir, { denyPaths: [deniedAlias] });

    const result = await fileSystem.readFile({ path: protectedFile });

    expect(result.success).toBe(false);
    expect(result.success ? undefined : result.error.code).toBe("PERMISSION");
  });
});
