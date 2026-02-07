import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";

import { fsTool } from "../../src/tools/fs/fs";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as any)[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(
  value: T | PromiseLike<T> | AsyncIterable<T>,
): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) last = chunk;
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }
  return await value;
}

describe("read_file auto-loads AGENTS.md instructions", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-read-file-agents-"));
    await mkdir(path.join(baseDir, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("loads AGENTS.md from file directory up to cwd when file is a child", async () => {
    await mkdir(path.join(baseDir, "sub", "nested"), { recursive: true });
    await writeFile(path.join(baseDir, "AGENTS.md"), "# Root\n\nRoot rules.");
    await writeFile(
      path.join(baseDir, "sub", "AGENTS.md"),
      "# Sub\n\nSub rules.",
    );
    await writeFile(
      path.join(baseDir, "sub", "nested", "file.txt"),
      "hello\n",
    );

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    const out = await resolveExecuteResult(
      readFile.execute!(
        { path: path.join("sub", "nested", "file.txt") },
        { toolCallId: "t1", messages: [] },
      ),
    );

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.loadedInstructions).toBeDefined();
    expect(out.loadedInstructions).toContain(path.join(baseDir, "sub", "AGENTS.md"));
    expect(out.loadedInstructions).toContain(path.join(baseDir, "AGENTS.md"));
    expect(out.instructionsText).toContain("Root rules.");
    expect(out.instructionsText).toContain("Sub rules.");
  });

  it("when file is not under cwd, stops at git root derived from cwd", async () => {
    await mkdir(path.join(baseDir, "a"), { recursive: true });
    await mkdir(path.join(baseDir, "b"), { recursive: true });
    await writeFile(path.join(baseDir, "AGENTS.md"), "# Root\n\nRoot rules.");
    await writeFile(path.join(baseDir, "b", "AGENTS.md"), "# B\n\nB rules.");
    await writeFile(path.join(baseDir, "b", "file.txt"), "hello\n");

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    const out = await resolveExecuteResult(
      readFile.execute!(
        {
          path: path.join(baseDir, "b", "file.txt"),
          cwd: path.join(baseDir, "a"),
        },
        { toolCallId: "t2", messages: [] },
      ),
    );

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.loadedInstructions).toContain(path.join(baseDir, "b", "AGENTS.md"));
    expect(out.loadedInstructions).toContain(path.join(baseDir, "AGENTS.md"));
    expect(out.instructionsText).toContain("B rules.");
    expect(out.instructionsText).toContain("Root rules.");
  });

  it("does not reload AGENTS.md that were already loaded in prior read_file tool results", async () => {
    await mkdir(path.join(baseDir, "sub", "nested"), { recursive: true });
    await writeFile(path.join(baseDir, "AGENTS.md"), "# Root\n\nRoot rules.");
    await writeFile(
      path.join(baseDir, "sub", "AGENTS.md"),
      "# Sub\n\nSub rules.",
    );
    await writeFile(
      path.join(baseDir, "sub", "nested", "file.txt"),
      "hello\n",
    );

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    const first = await resolveExecuteResult(
      readFile.execute!(
        { path: path.join("sub", "nested", "file.txt") },
        { toolCallId: "t3", messages: [] },
      ),
    );

    expect(first.success).toBe(true);
    if (!first.success) return;

    const toolOutput = await readFile.toModelOutput!({
      toolCallId: "t3",
      input: { path: path.join("sub", "nested", "file.txt") },
      output: first,
    });

    const prior: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t3",
          toolName: "read_file",
          output: toolOutput,
        },
      ],
    };

    const second = await resolveExecuteResult(
      readFile.execute!(
        { path: path.join("sub", "nested", "file.txt") },
        { toolCallId: "t4", messages: [prior] },
      ),
    );

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.loadedInstructions ?? []).toEqual([]);
    expect(second.instructionsText ?? "").toBe("");
  });

  it("does not auto-load instructions when reading AGENTS.md directly", async () => {
    await mkdir(path.join(baseDir, "sub"), { recursive: true });
    await writeFile(path.join(baseDir, "AGENTS.md"), "# Root\n\nRoot rules.");
    await writeFile(path.join(baseDir, "sub", "AGENTS.md"), "# Sub\n\nSub rules.");

    const tools = fsTool(baseDir);
    const readFile = tools.read_file;

    const out = await resolveExecuteResult(
      readFile.execute!(
        { path: path.join("sub", "AGENTS.md") },
        { toolCallId: "t5", messages: [] },
      ),
    );

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.loadedInstructions ?? []).toEqual([]);
    expect(out.instructionsText ?? "").toBe("");
  });
});
