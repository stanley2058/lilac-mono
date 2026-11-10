import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHunksResult, parsePatchResult } from "./apply-patch-core";

test("patch edits preserve CRLF on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-patch-"));
  try {
    await writeFile(join(root, "a:b"), "one\r\ntwo\r\n");
    const hunks = parsePatchResult(
      "*** Begin Patch\n*** Update File: a:b\n@@\n-two\n+new\n*** End of File\n*** End Patch",
    ).unwrap();
    expect((await applyHunksResult(root, hunks)).isOk()).toBe(true);
    expect(await readFile(join(root, "a:b"), "utf8")).toBe("one\r\nnew\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
