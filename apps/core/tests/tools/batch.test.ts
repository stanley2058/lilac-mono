import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asSchema, tool, type ToolSet } from "ai";
import { isToolExpansion, type ToolExpansion } from "@stanley2058/lilac-agent";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import { z } from "zod";

import { applyPatchTool } from "../../src/tools/apply-patch";
import { bashToolWithCwd } from "../../src/tools/bash";
import { batchTool, collectApplyPatchTouchedPaths } from "../../src/tools/batch";
import { fsTool } from "../../src/tools/fs/fs";

type ExecTool = {
  execute: (
    input: unknown,
    options: {
      toolCallId: string;
      messages: readonly unknown[];
      abortSignal?: AbortSignal;
      context?: unknown;
    },
  ) => Promise<unknown> | unknown;
};

function getTool(tools: ToolSet, name: string): ExecTool {
  const candidate = (tools as unknown as Record<string, unknown>)[name];
  if (!candidate || typeof candidate !== "object") throw new Error(`missing tool: ${name}`);
  const execute = (candidate as Record<string, unknown>)["execute"];
  if (typeof execute !== "function") throw new Error(`tool not executable: ${name}`);
  return candidate as ExecTool;
}

function requireExpansion(value: unknown): ToolExpansion {
  if (!isToolExpansion(value)) throw new Error("expected ToolExpansion");
  return value;
}

function makeTools(
  cwd: string,
  options?: {
    editingMode?: "apply_patch" | "edit_file" | "none";
    maxCalls?: number;
    specs?: ReadonlyMap<string, Level1ToolSpec<unknown>>;
  },
): ToolSet {
  const editingMode = options?.editingMode ?? "apply_patch";
  const tools: ToolSet = {} as ToolSet;
  Object.assign(
    tools,
    bashToolWithCwd(cwd),
    fsTool(cwd, { includeEditFile: editingMode === "edit_file" }),
  );
  if (editingMode === "apply_patch") Object.assign(tools, applyPatchTool({ cwd }));
  Object.assign(
    tools,
    batchTool({
      defaultCwd: cwd,
      getTools: () => tools,
      getToolSpecs: options?.specs ? () => options.specs! : undefined,
      editingMode,
      maxCalls: options?.maxCalls,
    }),
  );
  return tools;
}

function batchOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} };
}

describe("batch expansion tool", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "lilac-batch-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("accepts eight child calls and rejects a ninth", async () => {
    const tools = makeTools(baseDir, { editingMode: "none" });
    const batch = getTool(tools, "batch");
    const call = { tool: "glob", parameters: { patterns: ["*.missing"] } };

    const expansion = requireExpansion(
      await batch.execute(
        { tool_calls: Array.from({ length: 8 }, () => call) },
        batchOptions("batch-limit"),
      ),
    );
    expect(expansion.result).toMatchObject({ ok: true, total: 8 });
    expect(expansion.children).toHaveLength(8);

    await expect(
      Promise.resolve(
        batch.execute(
          { tool_calls: Array.from({ length: 9 }, () => call) },
          batchOptions("batch-over-limit"),
        ),
      ),
    ).rejects.toThrow("at most 8");
  });

  it("defensively caps configured maxCalls above eight", async () => {
    const tools = makeTools(baseDir, { editingMode: "none", maxCalls: 100 });
    const batch = getTool(tools, "batch");
    const call = { tool: "glob", parameters: { patterns: ["*.missing"] } };

    await expect(
      Promise.resolve(
        batch.execute(
          { tool_calls: Array.from({ length: 9 }, () => call) },
          batchOptions("batch-hard-limit"),
        ),
      ),
    ).rejects.toThrow("at most 8");
  });

  it("rejects overlapping apply_patch calls before expansion", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");
    await writeFile(join(baseDir, "a.txt"), "hello\n");
    const patch = (replacement: string) =>
      [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-hello",
        `+${replacement}`,
        "*** End Patch",
      ].join("\n");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: [
              { tool: "apply_patch", parameters: { patchText: patch("one") } },
              { tool: "apply_patch", parameters: { patchText: patch("two") } },
            ],
          },
          batchOptions("batch-overlap"),
        ),
      ),
    ).rejects.toThrow(/overlapping paths/i);
    expect(await readFile(join(baseDir, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("expands disjoint edits without executing them in the parent", async () => {
    const tools = makeTools(baseDir);
    const batch = getTool(tools, "batch");
    await writeFile(join(baseDir, "a.txt"), "one\n");
    await writeFile(join(baseDir, "b.txt"), "two\n");
    const patch = (file: string, oldText: string, newText: string) =>
      [
        "*** Begin Patch",
        `*** Update File: ${file}`,
        "@@",
        `-${oldText}`,
        `+${newText}`,
        "*** End Patch",
      ].join("\n");

    const expansion = requireExpansion(
      await batch.execute(
        {
          tool_calls: [
            { tool: "apply_patch", parameters: { patchText: patch("a.txt", "one", "ONE") } },
            { tool: "apply_patch", parameters: { patchText: patch("b.txt", "two", "TWO") } },
          ],
        },
        batchOptions("batch-disjoint"),
      ),
    );

    expect(expansion.children.map((child) => child.toolName)).toEqual([
      "apply_patch",
      "apply_patch",
    ]);
    expect(await readFile(join(baseDir, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(baseDir, "b.txt"), "utf8")).toBe("two\n");
  });

  it("validates child inputs and preserves invalid calls as child errors", async () => {
    const tools = makeTools(baseDir, { editingMode: "none" });
    const batch = getTool(tools, "batch");
    const expansion = requireExpansion(
      await batch.execute(
        {
          tool_calls: [
            { tool: "bash", parameters: {} },
            { tool: "glob", parameters: { patterns: ["*.ts"] } },
          ],
        },
        batchOptions("batch-validation"),
      ),
    );

    expect(expansion.result).toMatchObject({ ok: true, total: 2 });
    expect(expansion.children[0]).toMatchObject({ toolName: "bash", invalid: true });
    expect(String(expansion.children[0]?.error)).toContain("batch child #1 (bash)");
    expect(expansion.children[1]).toMatchObject({
      toolName: "glob",
      input: { patterns: ["*.ts"] },
    });
  });

  it("generates deterministic unique child tool-call IDs", async () => {
    const tools = makeTools(baseDir, { editingMode: "none" });
    const batch = getTool(tools, "batch");
    const input = {
      tool_calls: [
        { tool: "glob", parameters: { patterns: ["*.ts"] } },
        { tool: "glob", parameters: { patterns: ["*.js"] } },
      ],
    };

    const first = requireExpansion(await batch.execute(input, batchOptions("batch-ids")));
    const second = requireExpansion(await batch.execute(input, batchOptions("batch-ids")));
    const firstIds = first.children.map((child) => child.toolCallId);
    expect(firstIds).toEqual(second.children.map((child) => child.toolCallId));
    expect(new Set(firstIds).size).toBe(2);
    expect(firstIds.every((id) => id.length <= 64)).toBe(true);
  });

  it("includes enabled Level-1 tools by default while honoring explicit opt-out", () => {
    const noop = tool({
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => ({ value }),
    });
    const tools = {
      custom_default: noop,
      custom_opt_out: noop,
      subagent_delegate: noop,
      batch: noop,
    } as unknown as ToolSet;
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      ["custom_default", { name: "custom_default", createTool: () => noop, isEnabled: () => true }],
      [
        "custom_opt_out",
        {
          name: "custom_opt_out",
          supportsBatch: false,
          createTool: () => noop,
          isEnabled: () => true,
        },
      ],
      [
        "subagent_delegate",
        { name: "subagent_delegate", createTool: () => noop, isEnabled: () => true },
      ],
      ["batch", { name: "batch", createTool: () => noop, isEnabled: () => true }],
    ]);
    Object.assign(
      tools,
      batchTool({ defaultCwd: baseDir, getTools: () => tools, getToolSpecs: () => specs }),
    );

    const batch = tools.batch as unknown as { inputSchema: unknown };
    const schema = asSchema(batch.inputSchema as never).jsonSchema as {
      properties?: {
        tool_calls?: { items?: { properties?: { tool?: { enum?: string[] } } } };
      };
    };
    const names = schema.properties?.tool_calls?.items?.properties?.tool?.enum ?? [];
    expect(names).toContain("custom_default");
    expect(names).toContain("subagent_delegate");
    expect(names).not.toContain("custom_opt_out");
    expect(names).not.toContain("batch");
  });

  it("does not fall back to legacy names when every enabled tool opts out", () => {
    const noop = tool({
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => ({ value }),
    });
    const tools = { opted_out: noop } as unknown as ToolSet;
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "opted_out",
        {
          name: "opted_out",
          supportsBatch: false,
          createTool: () => noop,
          isEnabled: () => true,
        },
      ],
    ]);

    expect(() =>
      batchTool({ defaultCwd: baseDir, getTools: () => tools, getToolSpecs: () => specs }),
    ).toThrow("requires at least one enabled Level-1 tool");
  });

  it("preflights edit targets from schema-transformed child input", async () => {
    let preflightPath: string | undefined;
    const customEdit = tool({
      inputSchema: z
        .object({ path: z.string() })
        .transform(async (input) => ({ ...input, path: `normalized/${input.path}` })),
      execute: () => ({ ok: true }),
    });
    const tools = { custom_edit: customEdit } as unknown as ToolSet;
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "custom_edit",
        {
          name: "custom_edit",
          createTool: () => customEdit,
          isEnabled: () => true,
          editTargets: (args) => {
            const path = (args as Record<string, unknown>)["path"];
            if (typeof path !== "string") throw new Error("missing transformed path");
            preflightPath = path;
            return [`file:///${path}`];
          },
        },
      ],
    ]);
    Object.assign(
      tools,
      batchTool({ defaultCwd: baseDir, getTools: () => tools, getToolSpecs: () => specs }),
    );

    const expansion = requireExpansion(
      await getTool(tools, "batch").execute(
        { tool_calls: [{ tool: "custom_edit", parameters: { path: "a.txt" } }] },
        batchOptions("batch-transformed-target"),
      ),
    );

    expect(preflightPath).toBe("normalized/a.txt");
    expect(expansion.children[0]?.input).toEqual({ path: "normalized/a.txt" });
  });

  it("fails closed when plugin edit targets cannot be resolved", async () => {
    const customEdit = tool({
      inputSchema: z.object({ path: z.string() }),
      execute: () => ({ ok: true }),
    });
    const tools = { custom_edit: customEdit } as unknown as ToolSet;
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "custom_edit",
        {
          name: "custom_edit",
          createTool: () => customEdit,
          isEnabled: () => true,
          editTargets: () => {
            throw new Error("target unavailable");
          },
        },
      ],
    ]);
    Object.assign(
      tools,
      batchTool({ defaultCwd: baseDir, getTools: () => tools, getToolSpecs: () => specs }),
    );

    await expect(
      Promise.resolve(
        getTool(tools, "batch").execute(
          { tool_calls: [{ tool: "custom_edit", parameters: { path: "a.txt" } }] },
          batchOptions("batch-target-error"),
        ),
      ),
    ).rejects.toThrow("target unavailable");
  });

  it("normalizes local and remote patch target keys", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");

    expect([...collectApplyPatchTouchedPaths({ patchText, cwd: baseDir })]).toEqual([
      `file://${join(baseDir, "src/a.ts")}`,
      `file://${join(baseDir, "src/b.ts")}`,
    ]);
    expect([...collectApplyPatchTouchedPaths({ patchText, cwd: "host:/repo" })]).toEqual([
      "ssh://host/repo/src/a.ts",
      "ssh://host/repo/src/b.ts",
    ]);
  });
});
