import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem, type ReadFileStart } from "@stanley2058/lilac-fs";

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
      start: { type: "line", line: 2 },
      maxLines: 1,
    });

    expect(paged.success).toBe(true);
    if (!paged.success) return;

    expect(paged.startLine).toBe(2);
    expect(paged.endLine).toBe(2);
    expect(paged.hasMoreLines).toBe(true);
    expect(paged.nextStart).toEqual({ type: "line", line: 3 });

    if (paged.format === "raw") {
      expect(paged.content).toBe("line2");
    } else {
      throw new Error("expected raw paged result");
    }

    const numbered = await fsTool.readFile({
      path: "a.txt",
      start: { type: "line", line: 2 },
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

  it("readFile supports absolute Unicode offsets including newlines", async () => {
    await writeFile(join(baseDir, "offset.txt"), "A😀\nBC");

    const atNewline = await fsTool.readFile({
      path: "offset.txt",
      start: { type: "offset", offset: 2 },
    });
    expect(atNewline.success).toBe(true);
    if (!atNewline.success || atNewline.format !== "raw") return;
    expect(atNewline.content).toBe("\nBC");
    expect(atNewline.startLine).toBe(1);

    const afterNewline = await fsTool.readFile({
      path: "offset.txt",
      start: { type: "offset", offset: 3 },
    });
    expect(afterNewline.success).toBe(true);
    if (!afterNewline.success || afterNewline.format !== "raw") return;
    expect(afterNewline.content).toBe("BC");
    expect(afterNewline.startLine).toBe(2);
  });

  it("readFile formats numbered partial lines and degrades partial hashline reads", async () => {
    await writeFile(join(baseDir, "partial.txt"), "alpha\nbeta");

    const numbered = await fsTool.readFile({
      path: "partial.txt",
      start: { type: "offset", offset: 2 },
      format: "numbered",
    });
    expect(numbered.success).toBe(true);
    if (!numbered.success || numbered.format !== "numbered") return;
    expect(numbered.numberedContent).toBe("1| pha\n2| beta");

    const hashline = await fsTool.readFile({
      path: "partial.txt",
      start: { type: "offset", offset: 2 },
      format: "hashline",
    });
    expect(hashline.success).toBe(true);
    if (!hashline.success || hashline.format !== "raw") return;
    expect(hashline.content).toBe("pha\nbeta");
    expect(hashline.degradedFromHashline).toBe(true);

    const lineColumnHashline = await fsTool.readFile({
      path: "partial.txt",
      start: { type: "line", line: 1, column: 2 },
      format: "hashline",
    });
    expect(lineColumnHashline.success).toBe(true);
    if (!lineColumnHashline.success || lineColumnHashline.format !== "raw") return;
    expect(lineColumnHashline.content).toBe("pha\nbeta");
    expect(lineColumnHashline.degradedFromHashline).toBe(true);

    for (const format of ["numbered", "hashline"] as const) {
      const truncated = await fsTool.readFile({
        path: "partial.txt",
        start: { type: "offset", offset: 2 },
        format,
        maxCharacters: 2,
      });
      expect(truncated.success).toBe(true);
      if (!truncated.success || truncated.format !== "raw") {
        throw new Error("expected degraded raw read");
      }
      expect(truncated.content).toBe("ph");
      expect(truncated.nextStart).toEqual({ type: "offset", offset: 4 });

      const lineLimited = await fsTool.readFile({
        path: "partial.txt",
        start: { type: "offset", offset: 0 },
        format,
        maxLines: 1,
        maxCharacters: 6,
      });
      expect(lineLimited.success).toBe(true);
      if (!lineLimited.success || lineLimited.format !== "raw") {
        throw new Error("expected line-limited degraded raw read");
      }
      expect(lineLimited.content).toBe("alpha\n");
      expect(lineLimited.nextStart).toEqual({ type: "offset", offset: 6 });
    }
  });

  it("readFile character truncation reports a continuation that cannot skip a long line", async () => {
    await writeFile(join(baseDir, "long-line.txt"), `${"x".repeat(100)}\nsecond`);
    const res = await fsTool.readFile({ path: "long-line.txt", maxCharacters: 10 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.truncatedByChars).toBe(true);
    expect(res.endLine).toBe(0);
    expect(res.nextStart).toEqual({ type: "line", line: 1, column: 10 });
    expect(res.hasMoreLines).toBe(true);
    if (!res.nextStart) throw new Error("expected continuation");

    const continued = await fsTool.readFile({
      path: "long-line.txt",
      start: res.nextStart,
      maxCharacters: 10,
    });
    expect(continued.success).toBe(true);
    if (continued.success && continued.format === "raw") {
      expect(continued.content).toBe("x".repeat(10));
      expect(continued.nextStart).toEqual({ type: "line", line: 1, column: 20 });
    }
  });

  it("readFile preserves offset mode in Unicode-safe character continuations", async () => {
    await writeFile(join(baseDir, "offset-continuation.txt"), "😀abc");
    const first = await fsTool.readFile({
      path: "offset-continuation.txt",
      start: { type: "offset", offset: 0 },
      maxCharacters: 1,
    });
    expect(first.success).toBe(true);
    if (!first.success || first.format !== "raw") return;
    expect(first.content).toBe("😀");
    expect(first.nextStart).toEqual({ type: "offset", offset: 1 });
    if (!first.nextStart) throw new Error("expected continuation");

    const second = await fsTool.readFile({
      path: "offset-continuation.txt",
      start: first.nextStart,
      maxCharacters: 1,
    });
    expect(second.success).toBe(true);
    if (second.success && second.format === "raw") expect(second.content).toBe("a");
  });

  it("readFile returns mode-preserving continuations for line windows", async () => {
    await writeFile(join(baseDir, "windows.txt"), "line1\nline2\nline3");

    const defaultStart = await fsTool.readFile({ path: "windows.txt", maxLines: 1 });
    expect(defaultStart.success).toBe(true);
    if (!defaultStart.success) return;
    expect(defaultStart.nextStart).toEqual({ type: "line", line: 2 });

    const offsetStart = await fsTool.readFile({
      path: "windows.txt",
      start: { type: "offset", offset: 1 },
      maxLines: 1,
    });
    expect(offsetStart.success).toBe(true);
    if (!offsetStart.success || offsetStart.format !== "raw") return;
    expect(offsetStart.content).toBe("ine1\n");
    expect(offsetStart.nextStart).toEqual({ type: "offset", offset: 6 });
  });

  it("reconstructs source exactly from offset pages limited by lines", async () => {
    const source = "one\n😀two\nthree";
    await writeFile(join(baseDir, "offset-pages.txt"), source);
    const chunks: string[] = [];
    let start: ReadFileStart = { type: "offset", offset: 0 };

    for (let page = 0; page < 10; page += 1) {
      const result = await fsTool.readFile({ path: "offset-pages.txt", start, maxLines: 1 });
      expect(result.success).toBe(true);
      if (!result.success || result.format !== "raw") throw new Error("expected raw page");
      chunks.push(result.content);
      if (!result.nextStart) break;
      expect(result.nextStart.type).toBe("offset");
      if (result.nextStart.type !== "offset" || start.type !== "offset") {
        throw new Error("expected offset continuation");
      }
      expect(result.nextStart.offset).toBeGreaterThan(start.offset);
      start = result.nextStart;
    }

    expect(chunks.join("")).toBe(source);
  });

  it("readFile clamps maxLines to one and returns an advancing continuation", async () => {
    await writeFile(join(baseDir, "zero-lines.txt"), "first\nsecond");

    const lineStart = await fsTool.readFile({ path: "zero-lines.txt", maxLines: 0 });
    expect(lineStart.success).toBe(true);
    if (!lineStart.success || lineStart.format !== "raw") return;
    expect(lineStart.content).toBe("first");
    expect(lineStart.nextStart).toEqual({ type: "line", line: 2 });

    const offsetStart = await fsTool.readFile({
      path: "zero-lines.txt",
      start: { type: "offset", offset: 0 },
      maxLines: 0,
    });
    expect(offsetStart.success).toBe(true);
    if (!offsetStart.success || offsetStart.format !== "raw") return;
    expect(offsetStart.content).toBe("first\n");
    expect(offsetStart.nextStart).toEqual({ type: "offset", offset: 6 });
  });

  it("readFile degrades numbered and hashline truncation to Unicode-safe raw continuation", async () => {
    await writeFile(join(baseDir, "formatted-long-line.txt"), "😀abc");
    for (const format of ["numbered", "hashline"] as const) {
      const first = await fsTool.readFile({
        path: "formatted-long-line.txt",
        format,
        maxCharacters: 1,
      });
      expect(first.success).toBe(true);
      if (!first.success || first.format !== "raw") throw new Error("expected degraded raw read");
      expect(first.content).toBe("😀");
      expect(first.nextStart).toEqual({ type: "line", line: 1, column: 1 });
      if (!first.nextStart) throw new Error("expected continuation");

      const second = await fsTool.readFile({
        path: "formatted-long-line.txt",
        start: first.nextStart,
        maxCharacters: 1,
      });
      expect(second.success).toBe(true);
      if (second.success && second.format === "raw") expect(second.content).toBe("a");
    }
  });

  it("readFile streams a small late window while hashing the complete file", async () => {
    const largePrefix = `${"0123456789abcdef".repeat(256 * 1024)}\n`;
    await writeFile(join(baseDir, "large.txt"), `${largePrefix}target\nafter`);

    const res = await fsTool.readFile({
      path: "large.txt",
      start: { type: "line", line: 2 },
      maxLines: 1,
      maxCharacters: 10,
    });

    expect(res.success).toBe(true);
    if (!res.success || res.format !== "raw") return;
    expect(res.content).toBe("target");
    expect(res.totalLines).toBe(3);
    expect(res.hasMoreLines).toBe(true);

    const edit = await fsTool.editFile({
      path: "large.txt",
      expectedHash: res.fileHash,
      edits: [{ type: "replace_snippet", target: "target", newText: "updated" }],
    });
    expect(edit.success).toBe(true);
  });

  it("readFile supports hashline format", async () => {
    await writeFile(join(baseDir, "hashline.txt"), "alpha\nbeta\n");

    const res = await fsTool.readFile({ path: "hashline.txt", format: "hashline" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.format).toBe("hashline");
    if (res.format !== "hashline") {
      throw new Error("expected hashline output");
    }

    const lines = res.hashlineContent.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1#[0-9a-f]{4}:alpha$/);
    expect(lines[1]).toMatch(/^2#[0-9a-f]{4}:beta$/);
    expect(lines[2]).toMatch(/^3#[0-9a-f]{4}:$/);
  });

  it("readFile downgrades oversized hashline reads back to raw with a warning", async () => {
    await writeFile(join(baseDir, "long.txt"), `${"x".repeat(2_049)}\nshort\n`);

    const res = await fsTool.readFile({ path: "long.txt", format: "hashline" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.format).toBe("raw");
    if (res.format !== "raw") {
      throw new Error("expected downgraded raw output");
    }
    expect(res.degradedFromHashline).toBe(true);
    expect(res.warnings?.[0]?.code).toBe("LINE_TOO_LONG_FOR_HASHLINE");
    expect(res.warnings?.[0]?.message).toContain("Use bash");
    expect(res.content.startsWith("x")).toBe(true);
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

  it("hashlineEditFile replaces, prepends, and appends using read anchors", async () => {
    await writeFile(join(baseDir, "anchors.txt"), "before\nmatch\nafter\n");

    const readRes = await fsTool.readFile({ path: "anchors.txt", format: "hashline" });
    expect(readRes.success).toBe(true);
    if (!readRes.success || readRes.format !== "hashline") {
      throw new Error("expected hashline read");
    }

    const [beforeAnchor, matchAnchor] = readRes.hashlineContent.split("\n");
    expect(beforeAnchor).toBeDefined();
    expect(matchAnchor).toBeDefined();

    const editRes = await fsTool.hashlineEditFile({
      path: "anchors.txt",
      edits: [
        {
          op: "prepend",
          pos: matchAnchor!,
          lines: ["intro"],
        },
        {
          op: "replace",
          pos: matchAnchor!,
          lines: ["matched"],
        },
        {
          op: "append",
          pos: beforeAnchor!,
          lines: ["between"],
        },
      ],
    });

    expect(editRes.success).toBe(true);
    await expect(readFile(join(baseDir, "anchors.txt"), "utf-8")).resolves.toBe(
      "before\nbetween\nintro\nmatched\nafter\n",
    );
  });

  it("hashlineEditFile rejects stale anchors", async () => {
    await writeFile(join(baseDir, "stale.txt"), "alpha\nbeta\n");

    const readRes = await fsTool.readFile({ path: "stale.txt", format: "hashline" });
    expect(readRes.success).toBe(true);
    if (!readRes.success || readRes.format !== "hashline") {
      throw new Error("expected hashline read");
    }

    const betaAnchor = readRes.hashlineContent.split("\n")[1]!;
    await writeFile(join(baseDir, "stale.txt"), "alpha\ngamma\n");
    const currentReadRes = await fsTool.readFile({ path: "stale.txt", format: "hashline" });
    expect(currentReadRes.success).toBe(true);
    if (!currentReadRes.success) {
      throw new Error("expected current read");
    }

    const editRes = await fsTool.hashlineEditFile({
      path: "stale.txt",
      expectedHash: currentReadRes.fileHash,
      edits: [{ op: "replace", pos: betaAnchor, lines: ["delta"] }],
    });

    expect(editRes.success).toBe(false);
    if (editRes.success) return;
    expect(editRes.error.code).toBe("STALE_ANCHOR");
    expect(editRes.error.message).toContain("Re-read the file");
  });

  it("hashlineEditFile rejects files changed since the last read", async () => {
    await writeFile(join(baseDir, "stale-file.txt"), "alpha\nbeta\n");

    const readRes = await fsTool.readFile({ path: "stale-file.txt", format: "hashline" });
    expect(readRes.success).toBe(true);
    if (!readRes.success || readRes.format !== "hashline") {
      throw new Error("expected hashline read");
    }

    const betaAnchor = readRes.hashlineContent.split("\n")[1]!;
    await writeFile(join(baseDir, "stale-file.txt"), "alpha changed\nbeta\n");

    const editRes = await fsTool.hashlineEditFile({
      path: "stale-file.txt",
      edits: [{ op: "replace", pos: betaAnchor, lines: ["gamma"] }],
    });

    expect(editRes.success).toBe(false);
    if (editRes.success) return;
    expect(editRes.error.code).toBe("HASH_MISMATCH");
    expect(editRes.currentHash).toBeDefined();
  });
});
