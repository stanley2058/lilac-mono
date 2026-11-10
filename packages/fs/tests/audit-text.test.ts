import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSystem,
  createStreamingTextWindow,
  applyHashlineEdits,
  formatHashlineLine,
} from "../src";

test("streamed windows normalize CRLF across chunks and preserve Unicode paging", () => {
  const window = createStreamingTextWindow({
    resolvedPath: "resource://test",
    fileHash: "hash",
    maxOutputBytes: 100,
    maxCharacters: 3,
  });
  for (const chunk of ["a\r", "\n😀", "\r\nb"]) window.consume(Buffer.from(chunk));
  expect(window.finish()).toMatchObject({
    content: "a\n😀",
    totalLines: 3,
    nextStart: { type: "line", line: 2, column: 1 },
  });
});

test("hashline anchors and replacement preserve CRLF", () => {
  expect(
    applyHashlineEdits({
      content: "one\r\ntwo\r\n",
      edits: [{ op: "replace", pos: formatHashlineLine(2, "two"), lines: "new" }],
    }).unwrap().content,
  ).toBe("one\r\nnew\r\n");
});

test("regex edits use multiline and native replacement tokens, retaining CRLF", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-text-"));
  try {
    const file = join(root, "a.txt");
    await writeFile(file, "ab\r\nab\r\n");
    const fs = new FileSystem(root);
    const read = await fs.readFile({ path: file });
    expect(read).toMatchObject({ success: true, content: "ab\nab\n" });
    if (!read.success) throw new Error("fixture read failed");
    expect(
      await fs.editFile({
        path: file,
        expectedHash: read.fileHash,
        edits: [
          {
            type: "replace_snippet",
            target: "^(?<first>a)(b)$",
            matching: "regex",
            newText: "$2$<first>:$&:$$",
            occurrence: "all",
            expectedMatches: 2,
          },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(await readFile(file, "utf8")).toBe("ba:ab:$\r\nba:ab:$\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large line reads count skipped newlines and hash raw bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-large-"));
  try {
    const file = join(root, "large.txt");
    const content = "skip\r\n".repeat(2_000_000) + "😀tail\r\n";
    await writeFile(file, content);
    const result = await new FileSystem(root).readFile({
      path: file,
      start: { type: "line", line: 2_000_001 },
      maxLines: 1,
    });
    expect(result).toMatchObject({ success: true, content: "😀tail", totalLines: 2_000_002 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read preserves a standalone trailing carriage return", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-cr-"));
  try {
    const file = join(root, "a.txt");
    await writeFile(file, "one\r");
    expect(await new FileSystem(root).readFile({ path: file })).toMatchObject({
      success: true,
      content: "one\r",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
