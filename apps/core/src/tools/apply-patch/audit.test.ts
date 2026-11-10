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

test("patch preserves each mixed terminator", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-patch-"));
  try {
    await writeFile(join(root, "a"), "a\r\nb\nc\r\nd\n");
    const hunks = parsePatchResult(
      "*** Begin Patch\n*** Update File: a\n@@\n-d\n+D\n*** End Patch",
    ).unwrap();
    expect((await applyHunksResult(root, hunks)).isOk()).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("a\r\nb\nc\r\nD\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const body of [
  "*** Update File: a\n \n@@\n-a\n+A\n\n*** End Patch",
  "*** Update File: a\n@@\n a\n\n-b\n+B\n*** End Patch",
  "*** Update File: a\n@@\n-a\n+A\n \n@@\n-b\n+B\n*** End Patch",
  "*** Add File: a\n+a\n\n+b\n*** End Patch",
]) {
  test(`parser accepts blank lines: ${JSON.stringify(body)}`, () => {
    expect(parsePatchResult(`*** Begin Patch\n${body}`).isOk()).toBe(true);
  });
}

test("patch inserts with the dominant ending while keeping context terminators", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-patch-insert-"));
  try {
    await writeFile(join(root, "a"), "a\r\nb\nc\r\n");
    const hunks = parsePatchResult(
      "*** Begin Patch\n*** Update File: a\n@@\n a\n+x\n b\n*** End Patch",
    ).unwrap();
    expect((await applyHunksResult(root, hunks)).isOk()).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("a\r\nx\r\nb\nc\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
