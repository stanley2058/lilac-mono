import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs, { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { canonicalizePathAsFarAsExists } from "@stanley2058/lilac-fs";
import { canonicalizeAsFarAsExistsResult } from "../src/guardrails";

describe("coding tool path canonicalization", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-canonical-path-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves missing descendants through relative and dangling symlinks", async () => {
    await mkdir(path.join(root, "actual"));
    await symlink("actual/not-created", path.join(root, "dangling"));
    await symlink("dangling", path.join(root, "alias"));
    const target = path.join(root, "alias", "nested", "file.txt");
    const expected = path.join(await realpath(root), "actual/not-created/nested/file.txt");

    for (const resolvePath of [canonicalizePathAsFarAsExists, canonicalizeAsFarAsExistsResult]) {
      expect(await resolvePath(target)).toMatchObject({ status: "ok", value: expected });
    }
  });

  it("preserves coding tool operation labels for filesystem failures", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const lstat = spyOn(fs, "lstat").mockRejectedValue(failure);
    try {
      expect(await canonicalizeAsFarAsExistsResult(path.join(root, "missing"))).toMatchObject({
        status: "error",
        error: {
          operation: "inspect unresolved path",
          code: "EACCES",
          message: "permission denied",
        },
      });
    } finally {
      lstat.mockRestore();
    }
  });

  it("keeps home expansion in the coding tool interface", async () => {
    expect(await canonicalizeAsFarAsExistsResult("~")).toMatchObject({
      status: "ok",
      value: await realpath(homedir()),
    });
  });
});
