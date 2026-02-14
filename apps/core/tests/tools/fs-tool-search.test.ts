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
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
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

  it("exposes edit_file only when enabled", async () => {
    const defaultTools = fsTool(baseDir);
    const editEnabledTools = fsTool(baseDir, { includeEditFile: true });

    expect("edit_file" in defaultTools).toBe(false);
    expect("edit_file" in editEnabledTools).toBe(true);
  });

  it("glob lists matching paths", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.glob.execute!({ patterns: ["src/**/*.ts"] }, { toolCallId: "g1", messages: [] }),
    );

    expect(out.mode).toBe("default");
    expect(out.error).toBeUndefined();
    if (out.mode !== "default") {
      throw new Error("expected default glob output");
    }
    expect(out.paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("glob returns metadata in detailed mode", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.glob.execute!(
        {
          patterns: ["src/**/*.ts"],
          mode: "detailed",
        },
        { toolCallId: "g2", messages: [] },
      ),
    );

    expect(out.mode).toBe("detailed");
    expect(out.error).toBeUndefined();
    if (out.mode !== "detailed") {
      throw new Error("expected detailed glob output");
    }
    const paths = out.entries.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out.entries.every((e: { size: number }) => typeof e.size === "number")).toBe(true);
  });

  it("glob applies negate patterns and dedupes overlapping includes", async () => {
    const tools = fsTool(baseDir);
    await mkdir(path.join(baseDir, "node_modules", "dep"), { recursive: true });
    await writeFile(
      path.join(baseDir, "node_modules", "dep", "ignored.ts"),
      "export const ignored = true;\n",
    );

    const out = await resolveExecuteResult(
      tools.glob.execute!(
        {
          patterns: ["**/*.ts", "src/**/*.ts", "!**/node_modules/**"],
        },
        { toolCallId: "g2b", messages: [] },
      ),
    );

    expect(out.mode).toBe("default");
    if (out.mode !== "default") {
      throw new Error("expected default glob output");
    }

    const sorted = out.paths.sort();
    expect(sorted).toEqual(["src/a.ts", "src/b.ts"]);

    const outShallowNegate = await resolveExecuteResult(
      tools.glob.execute!(
        {
          patterns: ["**/*.ts", "!node_modules/**"],
        },
        { toolCallId: "g2c", messages: [] },
      ),
    );

    expect(outShallowNegate.mode).toBe("default");
    if (outShallowNegate.mode !== "default") {
      throw new Error("expected default glob output");
    }
    expect(outShallowNegate.paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("grep defaults to structured default output", async () => {
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

    expect(out.mode).toBe("default");
    expect(out.error).toBeUndefined();
    if (out.mode !== "default") {
      throw new Error("expected default grep output");
    }
    const lines = out.results
      .map(
        (r: { file: string; line: number; text: string }) =>
          `${r.file.replace(/^\.\//, "")}:${r.line}: ${r.text}`,
      )
      .sort();
    expect(lines.length).toBe(2);
    expect(lines[0]?.startsWith("src/a.ts:1:")).toBe(true);
    expect(lines[1]?.startsWith("src/b.ts:1:")).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("grep returns metadata in detailed mode", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          mode: "detailed",
        },
        { toolCallId: "g4", messages: [] },
      ),
    );

    expect(out.mode).toBe("detailed");
    expect(out.error).toBeUndefined();
    if (out.mode !== "detailed") {
      throw new Error("expected detailed grep output");
    }
    const files = out.results.map((r: { file: string }) => r.file.replace(/^\.\//, "")).sort();
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out.results.every((r: { column: number }) => typeof r.column === "number")).toBe(true);
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

    const detailed = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          mode: "detailed",
          maxResults: 3,
        },
        { toolCallId: "g5", messages: [] },
      ),
    );

    expect(detailed.mode).toBe("detailed");
    if (detailed.mode !== "detailed") {
      throw new Error("expected detailed grep output");
    }
    expect(detailed.results.length).toBe(3);
    expect(detailed.truncated).toBe(true);

    const defaults = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
          maxResults: 2,
        },
        { toolCallId: "g6", messages: [] },
      ),
    );

    expect(defaults.mode).toBe("default");
    if (defaults.mode !== "default") {
      throw new Error("expected default grep output");
    }
    expect(defaults.results.length).toBe(2);
    expect(defaults.truncated).toBe(true);
  });
});
