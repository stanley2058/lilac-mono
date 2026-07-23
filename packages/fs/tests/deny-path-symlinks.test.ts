import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem, prewarmFffFinders } from "../src";

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

  it("blocks searches rooted at an alias into a denied directory", async () => {
    const aliasDir = path.join(baseDir, "search-alias");
    await symlink(protectedDir, aliasDir);
    const fileSystem = new FileSystem(baseDir, { denyPaths: [protectedDir] });

    const globResult = await fileSystem.glob({ patterns: ["**/*"], baseDir: aliasDir });
    const grepResult = await fileSystem.grep({ pattern: "secret", baseDir: aliasDir });
    const fuzzyResult = await fileSystem.fuzzySearchFiles({ query: "secret", baseDir: aliasDir });

    expect(globResult.error).toContain("Access denied");
    expect(grepResult.error).toContain("Access denied");
    expect(fuzzyResult.error).toContain("Access denied");
  });

  it("does not prewarm an FFF finder through an alias into a denied directory", async () => {
    const aliasDir = path.join(baseDir, "prewarm-alias");
    await symlink(protectedDir, aliasDir);

    const [result] = await prewarmFffFinders({
      basePaths: [aliasDir],
      denyPaths: [protectedDir],
    });

    expect(result).toEqual({ basePath: aliasDir, ok: false, skipped: "deny-path" });
  });

  it("blocks writes and edits through an alias into a denied directory", async () => {
    const aliasDir = path.join(baseDir, "mutation-alias");
    await symlink(protectedDir, aliasDir);
    const fileSystem = new FileSystem(baseDir, { denyPaths: [protectedDir] });

    const overwriteResult = await fileSystem.writeFile(
      { path: path.join(aliasDir, "secret.txt"), content: "changed\n", overwrite: true },
      baseDir,
    );
    const createResult = await fileSystem.writeFile(
      { path: path.join(aliasDir, "new.txt"), content: "new\n" },
      baseDir,
    );
    const editResult = await fileSystem.editFile(
      {
        path: path.join(aliasDir, "secret.txt"),
        edits: [{ type: "replace_snippet", target: "secret", newText: "changed" }],
      },
      baseDir,
    );
    const hashlineResult = await fileSystem.hashlineEditFile(
      {
        path: path.join(aliasDir, "secret.txt"),
        edits: [{ op: "replace", pos: "1#0000", lines: ["changed"] }],
      },
      baseDir,
    );

    expect(overwriteResult.success).toBe(false);
    expect(overwriteResult.success ? undefined : overwriteResult.error.code).toBe("PERMISSION");
    expect(createResult.success).toBe(false);
    expect(createResult.success ? undefined : createResult.error.code).toBe("PERMISSION");
    expect(editResult.success).toBe(false);
    expect(editResult.success ? undefined : editResult.error.code).toBe("PERMISSION");
    expect(hashlineResult.success).toBe(false);
    expect(hashlineResult.success ? undefined : hashlineResult.error.code).toBe("PERMISSION");
    expect(await Bun.file(protectedFile).text()).toBe("secret\n");
  });

  it("blocks deletes through denied parent aliases without following final symlinks", async () => {
    const aliasDir = path.join(baseDir, "delete-alias");
    await symlink(protectedDir, aliasDir);
    const allowedFileAlias = path.join(baseDir, "allowed-file-alias");
    await symlink(protectedFile, allowedFileAlias);
    const fileSystem = new FileSystem(baseDir, { denyPaths: [protectedDir] });

    const deniedResult = await fileSystem.deleteFile({
      path: path.join(aliasDir, "secret.txt"),
    });
    const allowedResult = await fileSystem.deleteFile({ path: allowedFileAlias });

    expect(deniedResult.success).toBe(false);
    expect(deniedResult.error).toContain("Access denied");
    expect(allowedResult.success).toBe(true);
    expect(await Bun.file(protectedFile).text()).toBe("secret\n");
  });
});
