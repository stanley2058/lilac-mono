import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "../../src/tools/fs/fs-impl";

describe("fs tool", () => {
  let baseDir: string;
  let fsTool: FileSystem;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "lilac-fs-"));
    fsTool = new FileSystem(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("readFile defaults to raw and returns paging metadata", async () => {
    await writeFile(join(baseDir, "a.txt"), "line1\nline2\nline3");

    const res = await fsTool.readFile({ path: "a.txt" });

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.format).toBe("raw");
    expect(res.startLine).toBe(1);
    expect(res.endLine).toBe(3);
    expect(res.totalLines).toBe(3);
    expect(res.hasMoreLines).toBe(false);
    expect(res.truncatedByChars).toBe(false);
    expect(typeof res.fileHash).toBe("string");
    expect(res.fileHash.length).toBeGreaterThan(0);

    if (res.format === "raw") {
      expect(res.content).toBe("line1\nline2\nline3");
    } else {
      throw new Error("expected raw readFile result");
    }
  });

  it("readFile supports 1-based paging and numbered format", async () => {
    await writeFile(join(baseDir, "a.txt"), "line1\nline2\nline3");

    const paged = await fsTool.readFile({
      path: "a.txt",
      startLine: 2,
      maxLines: 1,
    });

    expect(paged.success).toBe(true);
    if (!paged.success) return;

    expect(paged.startLine).toBe(2);
    expect(paged.endLine).toBe(2);
    expect(paged.hasMoreLines).toBe(true);

    if (paged.format === "raw") {
      expect(paged.content).toBe("line2");
    } else {
      throw new Error("expected raw paged result");
    }

    const numbered = await fsTool.readFile({
      path: "a.txt",
      startLine: 2,
      maxLines: 1,
      format: "numbered",
    });

    expect(numbered.success).toBe(true);
    if (!numbered.success) return;

    expect(numbered.format).toBe("numbered");
    if (numbered.format === "numbered") {
      expect(numbered.numberedContent).toBe("2| line2");
    }
  });

  it("writeFile refuses to overwrite by default", async () => {
    await writeFile(join(baseDir, "b.txt"), "old");

    const res = await fsTool.writeFile({
      path: "b.txt",
      content: "new",
    });

    expect(res.success).toBe(false);
    if (res.success) return;

    expect(res.error.code).toBe("FILE_EXISTS");
    expect(await readFile(join(baseDir, "b.txt"), "utf-8")).toBe("old");
  });

  it("writeFile supports overwrite + expectedHash", async () => {
    await writeFile(join(baseDir, "b.txt"), "old");

    const firstRead = await fsTool.readFile({ path: "b.txt" });
    expect(firstRead.success).toBe(true);
    if (!firstRead.success) return;

    await writeFile(join(baseDir, "b.txt"), "changed");

    const res = await fsTool.writeFile({
      path: "b.txt",
      content: "new",
      overwrite: true,
      expectedHash: firstRead.fileHash,
    });

    expect(res.success).toBe(false);
    if (res.success) return;

    expect(res.error.code).toBe("HASH_MISMATCH");
    expect(res.currentHash).toBeDefined();
    expect(res.currentHash).not.toBe(firstRead.fileHash);
  });

  it("editFile requires prior read or expectedHash", async () => {
    await writeFile(join(baseDir, "c.txt"), "a\nb");

    const denied = await fsTool.editFile({
      path: "c.txt",
      edits: [{ type: "insert_at", line: 1, newText: "x" }],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;

    expect(denied.error.code).toBe("NOT_READ");

    const readRes = await fsTool.readFile({ path: "c.txt" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const ok = await fsTool.editFile({
      path: "c.txt",
      edits: [{ type: "insert_at", line: 1, newText: "x" }],
    });

    expect(ok.success).toBe(true);
    expect(await readFile(join(baseDir, "c.txt"), "utf-8")).toBe("x\na\nb");
  });

  it("editFile supports expectedOldText checks and is atomic", async () => {
    await writeFile(join(baseDir, "d.txt"), "line1\nline2\nline3");

    const readRes = await fsTool.readFile({ path: "d.txt" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: "d.txt",
      expectedHash: readRes.fileHash,
      edits: [
        {
          type: "replace_range",
          range: { startLine: 2, endLine: 2 },
          expectedOldText: "WRONG",
          newText: "line2-modified",
        },
      ],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;

    expect(denied.error.code).toBe("RANGE_MISMATCH");
    expect(await readFile(join(baseDir, "d.txt"), "utf-8")).toBe("line1\nline2\nline3");

    const ok = await fsTool.editFile({
      path: "d.txt",
      expectedHash: readRes.fileHash,
      edits: [
        {
          type: "replace_range",
          range: { startLine: 2, endLine: 2 },
          expectedOldText: "line2",
          newText: "line2-modified",
        },
      ],
    });

    expect(ok.success).toBe(true);
    expect(await readFile(join(baseDir, "d.txt"), "utf-8")).toBe("line1\nline2-modified\nline3");
  });

  it("replace_snippet defaults to expectedMatches=1", async () => {
    await writeFile(join(baseDir, "e.txt"), "foo foo");

    const readRes = await fsTool.readFile({ path: "e.txt", format: "numbered" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: "e.txt",
      edits: [
        {
          type: "replace_snippet",
          target: "foo",
          newText: "bar",
        },
      ],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;

    expect(denied.error.code).toBe("TOO_MANY_MATCHES");
    expect(await readFile(join(baseDir, "e.txt"), "utf-8")).toBe("foo foo");

    const ok = await fsTool.editFile({
      path: "e.txt",
      edits: [
        {
          type: "replace_snippet",
          target: "foo",
          newText: "bar",
          occurrence: "all",
          expectedMatches: "any",
        },
      ],
    });

    expect(ok.success).toBe(true);
    if (!ok.success) return;

    expect(ok.replacementsMade).toBe(2);
    expect(await readFile(join(baseDir, "e.txt"), "utf-8")).toBe("bar bar");
  });

  it("replace_snippet reports INVALID_REGEX for malformed regex", async () => {
    await writeFile(join(baseDir, "regex.txt"), "abc");

    const readRes = await fsTool.readFile({ path: "regex.txt" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: "regex.txt",
      edits: [
        {
          type: "replace_snippet",
          target: "(",
          matching: "regex",
          newText: "x",
        },
      ],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;
    expect(denied.error.code).toBe("INVALID_REGEX");
  });

  it("replace_snippet reports INVALID_EDIT on non-positive occurrence", async () => {
    await writeFile(join(baseDir, "occurrence.txt"), "abc");

    const readRes = await fsTool.readFile({ path: "occurrence.txt" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: "occurrence.txt",
      edits: [
        {
          type: "replace_snippet",
          target: "a",
          newText: "z",
          occurrence: 0,
        },
      ],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;
    expect(denied.error.code).toBe("INVALID_EDIT");
  });

  it("replace_snippet reports NOT_ENOUGH_MATCHES when expected count is too high", async () => {
    await writeFile(join(baseDir, "matches.txt"), "alpha");

    const readRes = await fsTool.readFile({ path: "matches.txt" });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: "matches.txt",
      edits: [
        {
          type: "replace_snippet",
          target: "alpha",
          newText: "beta",
          expectedMatches: 2,
        },
      ],
    });

    expect(denied.success).toBe(false);
    if (denied.success) return;
    expect(denied.error.code).toBe("NOT_ENOUGH_MATCHES");
  });
});
