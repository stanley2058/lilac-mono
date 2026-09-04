import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem } from "../src";

describe("readFile UTF-8 byte limit", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-read-file-bytes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("caps raw payload bytes at codepoint boundaries and continues without skips", async () => {
    await writeFile(path.join(root, "unicode.txt"), "A😀BéC");
    const fileSystem = new FileSystem(root);

    const first = await fileSystem.readFile({
      path: "unicode.txt",
      start: { type: "offset", offset: 0 },
      maxCharacters: 100,
      maxBytes: 5,
    });
    expect(first).toMatchObject({
      success: true,
      format: "raw",
      content: "A😀",
      nextStart: { type: "offset", offset: 2 },
      hasMoreLines: true,
      truncatedByChars: false,
    });

    if (!first.success || !first.nextStart) throw new Error("expected continuation");
    const second = await fileSystem.readFile({
      path: "unicode.txt",
      start: first.nextStart,
      maxCharacters: 100,
      maxBytes: 4,
    });
    expect(second).toMatchObject({
      success: true,
      content: "BéC",
      hasMoreLines: false,
    });
  });

  it.each(["numbered", "hashline"] as const)(
    "degrades %s output to raw when required for an exact byte-limited cursor",
    async (format) => {
      await writeFile(path.join(root, "formatted.txt"), "😀x\nnext");
      const result = await new FileSystem(root).readFile({
        path: "formatted.txt",
        format,
        maxCharacters: 100,
        maxBytes: 4,
      });

      expect(result).toMatchObject({
        success: true,
        format: "raw",
        content: "😀",
        nextStart: { type: "line", line: 1, column: 1 },
        hasMoreLines: true,
      });
      if (format === "hashline") {
        expect(result.success && result.degradedFromHashline).toBe(true);
      }
    },
  );

  it("rejects a byte limit too small for one Unicode character", async () => {
    await writeFile(path.join(root, "unicode.txt"), "😀x");

    const result = await new FileSystem(root).readFile({
      path: "unicode.txt",
      start: { type: "offset", offset: 0 },
      maxBytes: 3,
    });

    expect(result).toMatchObject({
      success: false,
      error: { message: "readFile maxBytes must be at least 4 to fit one Unicode character" },
    });
  });

  it("reads a line window without changing Unicode columns or continuation metadata", async () => {
    const content = "zero\nα😀beta\nthird\n";
    await writeFile(path.join(root, "lines.txt"), content);

    const result = await new FileSystem(root).readFile({
      path: "lines.txt",
      start: { type: "line", line: 2, column: 1 },
      maxLines: 2,
      maxCharacters: 100,
    });

    expect(result).toEqual({
      success: true,
      resolvedPath: path.join(root, "lines.txt"),
      content: "😀beta\nthird",
      fileHash: createHash("sha256").update(content).digest("hex"),
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      hasMoreLines: true,
      truncatedByChars: false,
      format: "raw",
      nextStart: { type: "line", line: 4 },
    });
  });

  it("keeps large line reads on the bounded-memory streaming path", async () => {
    const filePath = path.join(root, "large-sparse.txt");
    const handle = await open(filePath, "w");
    await handle.write("target\nafter", 0);
    await handle.truncate(17 * 1024 * 1024);
    await handle.close();

    const result = await new FileSystem(root).readFile({
      path: "large-sparse.txt",
      maxLines: 1,
      maxCharacters: 10,
    });

    expect(result).toMatchObject({
      success: true,
      content: "target",
      totalLines: 2,
      hasMoreLines: true,
      nextStart: { type: "line", line: 2 },
    });
  });

  it("bounds buffered line reads from a zero-size FIFO", async () => {
    const fifoPath = path.join(root, "stream.fifo");
    const mkfifo = Bun.spawn(["mkfifo", fifoPath], { stderr: "pipe" });
    if ((await mkfifo.exited) !== 0) {
      throw new Error(await new Response(mkfifo.stderr).text());
    }

    const read = new FileSystem(root).readFile({
      path: "stream.fifo",
      maxLines: 1,
      maxCharacters: 10,
    });
    const write = (async () => {
      const handle = await open(fifoPath, "w");
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let index = 0; index < 17; index++) await handle.write(chunk);
      await handle.close();
    })();

    const [result] = await Promise.all([read, write]);
    expect(result).toMatchObject({
      success: true,
      content: "aaaaaaaaaa",
      totalLines: 1,
      hasMoreLines: true,
      nextStart: { type: "line", line: 1, column: 10 },
    });
  });
});
