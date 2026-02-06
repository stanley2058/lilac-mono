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

    expect(out.error).toBeUndefined();
    const paths = out.entries.map((e) => e.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("grep returns matching content locations", async () => {
    const tools = fsTool(baseDir);

    const out = await resolveExecuteResult(
      tools.grep.execute!(
        {
          pattern: "alpha",
          fileExtensions: ["ts"],
        },
        { toolCallId: "g2", messages: [] },
      ),
    );

    expect(out.error).toBeUndefined();
    expect(Array.isArray(out.results)).toBe(true);
    const files = (out.results ?? [])
      .map((r) => r.file.replace(/^\.\//, ""))
      .sort();
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
