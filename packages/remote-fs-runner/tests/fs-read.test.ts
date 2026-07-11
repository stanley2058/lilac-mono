import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReadFileStart } from "@stanley2058/lilac-fs";

import { handleRequest } from "../src/cli";

type ReadOutput = {
  success: boolean;
  format?: string;
  content?: string;
  nextStart?: ReadFileStart;
};

async function runRead(cwd: string, input: Record<string, unknown>): Promise<ReadOutput> {
  return (await handleRequest({ op: "fs.read_text", input, denyPaths: [], cwd })) as ReadOutput;
}

describe("remote fs runner reads", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-read-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("forwards a line start for long-line continuation", async () => {
    await writeFile(path.join(baseDir, "long.txt"), `${"x".repeat(30)}\n`);
    const first = await runRead(baseDir, { path: "long.txt", maxCharacters: 10 });
    expect(first).toMatchObject({
      success: true,
      format: "raw",
      content: "x".repeat(10),
      nextStart: { type: "line", line: 1, column: 10 },
    });

    const second = await runRead(baseDir, {
      path: "long.txt",
      start: first.nextStart,
      maxCharacters: 10,
    });
    expect(second).toMatchObject({
      success: true,
      format: "raw",
      content: "x".repeat(10),
      nextStart: { type: "line", line: 1, column: 20 },
    });
  });

  it("forwards an offset start across Unicode characters and newlines", async () => {
    await writeFile(path.join(baseDir, "unicode.txt"), "a😀\nbé\n終z");

    const first = await runRead(baseDir, {
      path: "unicode.txt",
      start: { type: "offset", offset: 1 },
      maxCharacters: 3,
    });
    expect(first).toMatchObject({
      success: true,
      format: "raw",
      content: "😀\nb",
      nextStart: { type: "offset", offset: 4 },
    });

    const second = await runRead(baseDir, {
      path: "unicode.txt",
      start: first.nextStart,
      maxCharacters: 3,
    });
    expect(second).toMatchObject({
      success: true,
      format: "raw",
      content: "é\n終",
      nextStart: { type: "offset", offset: 7 },
    });
  });

  it("rejects byte reads over the limit before returning base64", async () => {
    await writeFile(path.join(baseDir, "large.pdf"), Buffer.alloc(32));

    const output = (await handleRequest({
      op: "fs.read_bytes",
      input: { path: "large.pdf", maxBytes: 16 },
      denyPaths: [],
      cwd: baseDir,
    })) as { ok: boolean; error?: string; base64?: string };

    expect(output.ok).toBe(false);
    expect(output.error).toContain("too large to inline");
    expect(output.error).not.toContain("Remote file too large");
    expect(output.base64).toBeUndefined();
  });
});
