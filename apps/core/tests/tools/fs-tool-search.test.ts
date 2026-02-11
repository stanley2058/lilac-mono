import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fsTool } from "../../src/tools/fs/fs";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

async function resolveExecuteResult<T>(
  value: T | PromiseLike<T> | AsyncIterable<T>,
): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) {
      last = chunk;
    }
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }

  return await value;
}

describe("fs tool search wrappers", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-fs-tool-search-"));
    await mkdir(path.join(baseDir, "src"), { recursive: true });
    await writeFile(path.join(baseDir, "src", "a.ts"), "export const alpha = 1;\n");
    await writeFile(path.join(baseDir, "src", "b.ts"), "export const beta = alpha;\n");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("glob lists matching paths", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.glob.execute!({ patterns: ["src/**/*.ts"] }, { toolCallId: "g1", messages: [] }),
    );

    expect(out.mode).toBe("lean");
    expect(out.error).toBeUndefined();
    if (out.mode !== "lean") {
      throw new Error("expected lean glob output");
    }
    expect(out.paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("glob returns metadata in verbose mode", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.glob.execute!(
        {
          patterns: ["src/**/*.ts"],
          mode: "verbose",
        },
        { toolCallId: "g2", messages: [] },
      ),
    );

    expect(out.mode).toBe("verbose");
    expect(out.error).toBeUndefined();
    if (out.mode !== "verbose") {
      throw new Error("expected verbose glob output");
    }
    const paths = out.entries.map((e) => e.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out.entries.every((e) => typeof e.size === "number")).toBe(true);
  });

  it("grep defaults to lean text output", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          maxResults: 2,
        },
        { toolCallId: "g3", messages: [] },
      ),
    );

    expect(out.mode).toBe("lean");
    expect(out.error).toBeUndefined();
    if (out.mode !== "lean") {
      throw new Error("expected lean grep output");
    }
    const lines = out.text
      .split("\n")
      .map((line) => line.replace(/^\.\//, ""))
      .filter((line) => line.length > 0)
      .sort();
    expect(lines.length).toBe(2);
    expect(lines[0]?.startsWith("src/a.ts:1:")).toBe(true);
    expect(lines[1]?.startsWith("src/b.ts:1:")).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("grep returns metadata in verbose mode", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          mode: "verbose",
        },
        { toolCallId: "g4", messages: [] },
      ),
    );

    expect(out.mode).toBe("verbose");
    expect(out.error).toBeUndefined();
    if (out.mode !== "verbose") {
      throw new Error("expected verbose grep output");
    }
    const files = out.results.map((r) => r.file.replace(/^\.\//, "")).sort();
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out.results.every((r) => typeof r.column === "number")).toBe(true);
  });

  it("grep enforces global maxResults", async () => {
    const tools = fsTool(baseDir);
    await writeFile(
      path.join(baseDir, "src", "many.ts"),
      [
        "const alpha1 = alpha;",
        "const alpha2 = alpha;",
        "const alpha3 = alpha;",
        "const alpha4 = alpha;",
        "const alpha5 = alpha;",
      ].join("\n") + "\n",
    );

    const verbose = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          mode: "verbose",
          maxResults: 3,
        },
        { toolCallId: "g5", messages: [] },
      ),
    );

    expect(verbose.mode).toBe("verbose");
    if (verbose.mode !== "verbose") {
      throw new Error("expected verbose grep output");
    }
    expect(verbose.results.length).toBe(3);
    expect(verbose.truncated).toBe(true);

    const lean = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          maxResults: 2,
        },
        { toolCallId: "g6", messages: [] },
      ),
    );

    expect(lean.mode).toBe("lean");
    if (lean.mode !== "lean") {
      throw new Error("expected lean grep output");
    }
    expect(lean.text.split("\n").filter((line) => line.length > 0).length).toBe(2);
    expect(lean.truncated).toBe(true);
  });
});
