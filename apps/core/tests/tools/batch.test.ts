import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asSchema, type ToolSet } from "ai";

import { applyPatchTool } from "../../src/tools/apply-patch";
import { bashToolWithCwd } from "../../src/tools/bash";
import { batchTool } from "../../src/tools/batch";
import { fsTool } from "../../src/tools/fs/fs";

type ExecTool = {
  execute: (
    input: unknown,
    options: {
      toolCallId: string;
      messages: readonly unknown[];
      abortSignal?: AbortSignal;
      experimental_context?: unknown;
    },
  ) => Promise<unknown> | unknown;
};

function makeTools(
  cwd: string,
  opts?: {
    editingMode?: "apply_patch" | "edit_file" | "none";
    includeApplyPatch?: boolean;
    includeEditFile?: boolean;
  },
): ToolSet {
  const editingMode = opts?.editingMode ?? "apply_patch";
  const includeApplyPatch = opts?.includeApplyPatch ?? editingMode === "apply_patch";
  const includeEditFile = opts?.includeEditFile ?? editingMode === "edit_file";

  const tools: ToolSet = {} as ToolSet;
  Object.assign(tools, bashToolWithCwd(cwd), fsTool(cwd, { includeEditFile }));
  if (includeApplyPatch) {
    Object.assign(tools, applyPatchTool({ cwd }));
  }
  Object.assign(
    tools,
    batchTool({
      defaultCwd: cwd,
      getTools: () => tools,
      editingMode,
    }),
  );
  return tools;
}

function makeToolsWithBatchReporter(
  cwd: string,
  reportToolStatus: Parameters<typeof batchTool>[0]["reportToolStatus"],
  opts?: {
    editingMode?: "apply_patch" | "edit_file" | "none";
    includeApplyPatch?: boolean;
    includeEditFile?: boolean;
  },
): ToolSet {
  const editingMode = opts?.editingMode ?? "apply_patch";
  const includeApplyPatch = opts?.includeApplyPatch ?? editingMode === "apply_patch";
  const includeEditFile = opts?.includeEditFile ?? editingMode === "edit_file";

  const tools: ToolSet = {} as ToolSet;
  Object.assign(tools, bashToolWithCwd(cwd), fsTool(cwd, { includeEditFile }));
  if (includeApplyPatch) {
    Object.assign(tools, applyPatchTool({ cwd }));
  }
  Object.assign(
    tools,
    batchTool({
      defaultCwd: cwd,
      getTools: () => tools,
      editingMode,
      reportToolStatus,
    }),
  );
  return tools;
}

function getTool(tools: ToolSet, name: string): ExecTool {
  const t = (tools as unknown as Record<string, unknown>)[name];
  if (!t || typeof t !== "object") throw new Error(`missing tool: ${name}`);
  const exec = (t as Record<string, unknown>)["execute"];
  if (typeof exec !== "function") throw new Error(`tool not executable: ${name}`);
  return t as unknown as ExecTool;
}

describe("batch tool", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "lilac-batch-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("rejects a batch when apply_patch calls touch the same file", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");

    await writeFile(join(baseDir, "a.txt"), "hello\n");

    const patch1 = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-hello",
      "+hello1",
      "*** End Patch",
    ].join("\n");

    const patch2 = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-hello",
      "+hello2",
      "*** End Patch",
    ].join("\n");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: [
              {
                tool: "apply_patch",
                parameters: { patchText: patch1, cwd: baseDir },
              },
              {
                tool: "apply_patch",
                parameters: { patchText: patch2, cwd: baseDir },
              },
            ],
          },
          {
            toolCallId: "batch-1",
            messages: [],
            abortSignal: undefined,
            experimental_context: undefined,
          },
        ),
      ),
    ).rejects.toThrow(/overlapping paths/i);

    expect(await readFile(join(baseDir, "a.txt"), "utf-8")).toBe("hello\n");
  });

  it("rejects overlapping remote apply_patch calls in a batch", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");

    const patch1 = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-hello",
      "+hello1",
      "*** End Patch",
    ].join("\n");

    const patch2 = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-hello",
      "+hello2",
      "*** End Patch",
    ].join("\n");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: [
              {
                tool: "apply_patch",
                parameters: { patchText: patch1, cwd: "myhost:/repo" },
              },
              {
                tool: "apply_patch",
                parameters: { patchText: patch2, cwd: "myhost:/repo" },
              },
            ],
          },
          {
            toolCallId: "batch-remote-1",
            messages: [],
            abortSignal: undefined,
            experimental_context: undefined,
          },
        ),
      ),
    ).rejects.toThrow(/overlapping paths/i);
  });

  it("executes disjoint apply_patch calls in one batch", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");

    await writeFile(join(baseDir, "a.txt"), "one\n");
    await writeFile(join(baseDir, "b.txt"), "two\n");

    const patchA = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-one",
      "+ONE",
      "*** End Patch",
    ].join("\n");

    const patchB = [
      "*** Begin Patch",
      "*** Update File: b.txt",
      "@@",
      "-two",
      "+TWO",
      "*** End Patch",
    ].join("\n");

    const res = await batch.execute(
      {
        tool_calls: [
          {
            tool: "apply_patch",
            parameters: { patchText: patchA, cwd: baseDir },
          },
          {
            tool: "apply_patch",
            parameters: { patchText: patchB, cwd: baseDir },
          },
        ],
      },
      {
        toolCallId: "batch-2",
        messages: [],
        abortSignal: undefined,
        experimental_context: undefined,
      },
    );

    const out = res as { total: number };
    expect(out.total).toBe(2);
    expect(await readFile(join(baseDir, "a.txt"), "utf-8")).toBe("ONE\n");
    expect(await readFile(join(baseDir, "b.txt"), "utf-8")).toBe("TWO\n");
  });

  it("runs bash + read_file in parallel and returns both results", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");

    await writeFile(join(baseDir, "c.txt"), "x\ny\n");

    const res = await batch.execute(
      {
        tool_calls: [
          { tool: "bash", parameters: { command: "echo hi", cwd: baseDir } },
          { tool: "read_file", parameters: { path: "c.txt" } },
        ],
      },
      {
        toolCallId: "batch-3",
        messages: [],
        abortSignal: undefined,
        experimental_context: undefined,
      },
    );

    const out = res as { results: Array<{ tool: string; ok: boolean; output?: any }> };
    expect(out.results.length).toBe(2);
    expect(out.results.some((r) => r.tool === "bash" && r.ok)).toBe(true);
    expect(out.results.some((r) => r.tool === "read_file" && r.ok)).toBe(true);
  });

  it("runs glob + grep in parallel and returns both results", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");

    await writeFile(join(baseDir, "src.ts"), "const marker = 1;\n");

    const res = await batch.execute(
      {
        tool_calls: [
          { tool: "glob", parameters: { patterns: ["**/*.ts"] } },
          {
            tool: "grep",
            parameters: {
              pattern: "marker",
              fileExtensions: ["ts"],
            },
          },
        ],
      },
      {
        toolCallId: "batch-3b",
        messages: [],
        abortSignal: undefined,
        experimental_context: undefined,
      },
    );

    const out = res as { results: Array<{ tool: string; ok: boolean }> };
    expect(out.results.length).toBe(2);
    expect(out.results.some((r) => r.tool === "glob" && r.ok)).toBe(true);
    expect(out.results.some((r) => r.tool === "grep" && r.ok)).toBe(true);
  });

  it("reports batch progress and shows newest 3 child updates", async () => {
    const updates: Array<{ status: string; display: string }> = [];
    const tools = makeToolsWithBatchReporter(baseDir, (u) => {
      updates.push({ status: u.status, display: u.display });
    });
    const batch = getTool(tools, "batch");

    await batch.execute(
      {
        tool_calls: [
          { tool: "bash", parameters: { command: "echo tool-1", cwd: baseDir } },
          { tool: "bash", parameters: { command: "echo tool-2", cwd: baseDir } },
          { tool: "bash", parameters: { command: "echo tool-3", cwd: baseDir } },
          { tool: "bash", parameters: { command: "echo tool-4", cwd: baseDir } },
          { tool: "bash", parameters: { command: "echo tool-5", cwd: baseDir } },
        ],
      },
      {
        toolCallId: "batch-4",
        messages: [],
        abortSignal: undefined,
        experimental_context: undefined,
      },
    );

    // Last "start" update while done=0 should show the newest 3 started.
    const lastStart = [...updates]
      .reverse()
      .find((u) => u.status === "start" && u.display.includes("0/5 done"));
    expect(lastStart).toBeTruthy();
    expect(lastStart!.display).toContain("batch (5 tools;");

    const lines = lastStart!.display.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[1]!).toContain("bash echo tool-3");
    expect(lines[2]!).toContain("bash echo tool-4");
    expect(lines[3]!).toContain("bash echo tool-5");

    const lastEnd = [...updates].reverse().find((u) => u.status === "end");
    expect(lastEnd).toBeTruthy();
    expect(lastEnd!.display).toBe("batch (5 tools)");
  });

  it("exposes only edit_file in batch schema for non-openai mode", async () => {
    const tools = makeTools(baseDir, {
      editingMode: "edit_file",
      includeEditFile: true,
      includeApplyPatch: false,
    });
    const batch = tools.batch as unknown as { inputSchema: unknown };
    const schema = asSchema(batch.inputSchema as never).jsonSchema as unknown as {
      properties?: {
        tool_calls?: {
          items?: {
            properties?: { tool?: { enum?: string[] } };
          };
        };
      };
    };

    const enumValues = schema.properties?.tool_calls?.items?.properties?.tool?.enum ?? [];
    expect(enumValues).toContain("edit_file");
    expect(enumValues).not.toContain("apply_patch");
  });

  it("rejects a batch when edit_file calls touch the same path", async () => {
    const tools = makeTools(baseDir, {
      editingMode: "edit_file",
      includeEditFile: true,
      includeApplyPatch: false,
    });
    const batch = getTool(tools, "batch");

    await writeFile(join(baseDir, "same.txt"), "alpha\n");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: [
              {
                tool: "edit_file",
                parameters: {
                  path: "same.txt",
                  oldText: "alpha",
                  newText: "bravo",
                  cwd: baseDir,
                },
              },
              {
                tool: "edit_file",
                parameters: {
                  path: "same.txt",
                  oldText: "alpha",
                  newText: "charlie",
                  cwd: baseDir,
                },
              },
            ],
          },
          {
            toolCallId: "batch-edit-overlap",
            messages: [],
            abortSignal: undefined,
            experimental_context: undefined,
          },
        ),
      ),
    ).rejects.toThrow(/overlapping paths/i);
  });
});
