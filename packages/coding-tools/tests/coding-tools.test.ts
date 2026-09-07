import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isToolExpansion } from "@stanley2058/lilac-agent";
import { asSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { Panic } from "better-result";
import { z } from "zod";

import {
  applyPatchResult,
  createBatchToolResult,
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  loadReadFileInstructions,
  createReadFileInstructionClaims,
  bashInputSchema,
  globInputSchema,
  editFileInputSchema,
} from "../src";
import { BufferedFileSink } from "../src/buffered-file-sink";

type ToolOptions = ToolExecutionOptions<unknown>;

type ExecutableTool = {
  execute(input: unknown, options: ToolOptions): Promise<unknown> | unknown;
};

function executable(tools: ToolSet, name: string): ExecutableTool {
  const candidate = tools[name];
  if (!candidate || typeof candidate.execute !== "function")
    throw new Error(`missing tool: ${name}`);
  return {
    execute: (input, executionOptions) => candidate.execute!(input as never, executionOptions),
  };
}

function options(toolCallId: string, abortSignal?: AbortSignal): ToolOptions {
  return { toolCallId, messages: [], context: {}, abortSignal };
}

function batchTools(cwd: string, children: ToolSet): ToolSet {
  return { ...children, ...createBatchToolResult({ cwd, getTools: () => children }).unwrap() };
}

function patchTool(
  params: Omit<Parameters<typeof applyPatchResult>[0], "patchText">,
): ExecutableTool {
  return {
    execute: async (input, { abortSignal }) => {
      const patch = z
        .object({ patchText: z.string(), dangerouslyAllow: z.boolean().optional() })
        .parse(input);
      const result = await applyPatchResult({ ...params, ...patch, abortSignal });
      if (result.status === "error") throw result.error;
      return result.value;
    },
  };
}

describe("coding tools", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "lilac-coding-tools-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("buffers persistent spool writes into configured blocks", async () => {
    const filePath = path.join(cwd, "buffered-sink.log");
    const sink = await BufferedFileSink.open(filePath, { flags: "wx", blockBytes: 8 });

    await sink.write("abc");
    expect((await stat(filePath)).size).toBe(0);
    await sink.write("defghijk");
    expect((await stat(filePath)).size).toBe(8);
    await sink.close();

    expect(await readFile(filePath, "utf8")).toBe("abcdefghijk");
  });

  it("exports hashline schema factories for stateful runtime adapters", async () => {
    const readSchema = createReadFileInputSchema({ hashlineEnabled: true });
    const grepSchema = createGrepInputSchema(true);
    const editSchema = createEditFileInputSchema(true);
    expect(readSchema.safeParse({ path: "a.ts", format: "hashline" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", mode: "hashline" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", path: "src" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", cwd: "src" }).success).toBe(false);
    expect(grepSchema.safeParse({ pattern: "needle", includeContextLines: 1 }).success).toBe(false);
    expect(
      editSchema.safeParse({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#abcd", lines: ["next"] }],
      }).success,
    ).toBe(true);
    expect(editSchema.safeParse({ path: "a.ts", oldText: "a", newText: "b" }).success).toBe(false);

    const readJsonSchema = await asSchema(readSchema).jsonSchema;
    const serialized = JSON.stringify(readJsonSchema);
    expect(serialized).toContain('"hashline"');
    expect(serialized).toContain("runtime adapter has SSH configured");
  });

  it("patch supports add, update, move, delete and refuses directory deletes", async () => {
    await writeFile(path.join(cwd, "old.txt"), "old\n");
    const blockedPath = path.join(cwd, "blocked.txt");
    const applyPatch = patchTool({ cwd, denyPaths: [blockedPath], allowGuardrailBypass: true });
    const patchText = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+added",
      "*** Update File: old.txt",
      "*** Move to: moved.txt",
      "@@",
      "-old",
      "+new",
      "*** Delete File: added.txt",
      "*** End Patch",
    ].join("\n");
    await applyPatch.execute({ patchText }, options("patch"));
    expect(await readFile(path.join(cwd, "moved.txt"), "utf8")).toBe("new\n");
    expect(Bun.file(path.join(cwd, "old.txt")).size).toBe(0);
    expect(Bun.file(path.join(cwd, "added.txt")).size).toBe(0);

    const blockedPatch = [
      "*** Begin Patch",
      "*** Add File: blocked.txt",
      "+allowed only explicitly",
      "*** End Patch",
    ].join("\n");
    await expect(
      Promise.resolve(applyPatch.execute({ patchText: blockedPatch }, options("patch-deny"))),
    ).rejects.toThrow("Access denied");
    await applyPatch.execute(
      { patchText: blockedPatch, dangerouslyAllow: true },
      options("patch-allow"),
    );
    expect(await readFile(blockedPath, "utf8")).toBe("allowed only explicitly");

    await mkdir(path.join(cwd, "directory"));
    await expect(
      Promise.resolve(
        applyPatch.execute(
          {
            patchText: ["*** Begin Patch", "*** Delete File: directory", "*** End Patch"].join(
              "\n",
            ),
          },
          options("patch-directory"),
        ),
      ),
    ).rejects.toThrow("Refusing to delete directory");

    await writeFile(path.join(cwd, "trailing-empty.txt"), "target\n");
    const trailingEmptyPatch = [
      "*** Begin Patch",
      "*** Update File: trailing-empty.txt",
      "@@",
      "-target",
      "-",
      "+changed",
      "*** End Patch",
    ].join("\n");
    await applyPatch.execute({ patchText: trailingEmptyPatch }, options("patch-trailing-empty"));
    expect(await readFile(path.join(cwd, "trailing-empty.txt"), "utf8")).toBe("changed\n");
  });

  it("patch rejects add, update, and delete through a symlink into a denied directory", async () => {
    const denied = path.join(cwd, "denied");
    await mkdir(denied);
    await writeFile(path.join(denied, "update.txt"), "before\n");
    await writeFile(path.join(denied, "delete.txt"), "keep\n");
    await symlink(denied, path.join(cwd, "workspace-link"), "dir");
    const applyPatch = patchTool({ cwd, denyPaths: [denied] });
    const patches = [
      ["*** Begin Patch", "*** Add File: workspace-link/added.txt", "+blocked", "*** End Patch"],
      [
        "*** Begin Patch",
        "*** Update File: workspace-link/update.txt",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ],
      ["*** Begin Patch", "*** Delete File: workspace-link/delete.txt", "*** End Patch"],
    ];

    for (const [index, patchLines] of patches.entries()) {
      await expect(
        Promise.resolve().then(() =>
          applyPatch.execute(
            { patchText: patchLines.join("\n") },
            options(`patch-symlink-${index}`),
          ),
        ),
      ).rejects.toThrow("resolves into protected path");
    }
    expect(Bun.file(path.join(denied, "added.txt")).size).toBe(0);
    expect(await readFile(path.join(denied, "update.txt"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(denied, "delete.txt"), "utf8")).toBe("keep\n");
  });

  it("patch honors AbortSignal before starting later hunks", async () => {
    const controller = new AbortController();
    let abortedReads = 0;
    const abortSignal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "aborted") {
          abortedReads++;
          if (abortedReads === 6) controller.abort();
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const patchText = [
      "*** Begin Patch",
      "*** Add File: first.txt",
      "+first",
      "*** Add File: later.txt",
      "+later",
      "*** End Patch",
    ].join("\n");

    await expect(
      Promise.resolve().then(() =>
        patchTool({ cwd, denyPaths: [] }).execute(
          { patchText },
          options("patch-abort", abortSignal),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "PatchAbortedAfterCommit",
      retrySafe: false,
      message: expect.stringContaining("patch aborted"),
      committedMutations: expect.arrayContaining([
        { type: "file-written", path: path.join(cwd, "first.txt") },
      ]),
    });
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("first");
    expect(Bun.file(path.join(cwd, "later.txt")).size).toBe(0);
  });

  it("applyPatchResult distinguishes cancellation before mutation from cancellation after commit", async () => {
    const preCommitController = new AbortController();
    preCommitController.abort();
    const beforeCommit = await applyPatchResult({
      cwd,
      denyPaths: [],
      patchText: ["*** Begin Patch", "*** Add File: never.txt", "+never", "*** End Patch"].join(
        "\n",
      ),
      abortSignal: preCommitController.signal,
    });
    expect(beforeCommit).toMatchObject({ status: "error", error: { _tag: "PatchAborted" } });
    expect(Bun.file(path.join(cwd, "never.txt")).size).toBe(0);

    const postCommitController = new AbortController();
    let abortedReads = 0;
    const abortSignal = new Proxy(postCommitController.signal, {
      get(target, property) {
        if (property === "aborted") {
          abortedReads++;
          if (abortedReads === 6) postCommitController.abort();
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const afterCommit = await applyPatchResult({
      cwd,
      denyPaths: [],
      patchText: [
        "*** Begin Patch",
        "*** Add File: committed.txt",
        "+committed",
        "*** Add File: not-started.txt",
        "+not started",
        "*** End Patch",
      ].join("\n"),
      abortSignal,
    });
    expect(afterCommit).toMatchObject({
      status: "error",
      error: {
        _tag: "PatchAbortedAfterCommit",
        retrySafe: false,
        committedMutations: expect.arrayContaining([
          { type: "file-written", path: path.join(cwd, "committed.txt") },
        ]),
      },
    });
    expect(await readFile(path.join(cwd, "committed.txt"), "utf8")).toBe("committed");
    expect(Bun.file(path.join(cwd, "not-started.txt")).size).toBe(0);
  });

  it("batch expands every enabled tool including delegation and rejects edit overlap", async () => {
    const subagent = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: ({ prompt }) => prompt,
    });
    const custom = tool({
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });
    const tools = batchTools(cwd, {
      bash: tool({ inputSchema: bashInputSchema }),
      glob: tool({ inputSchema: globInputSchema }),
      edit: tool({ inputSchema: editFileInputSchema }),
      custom_tool: custom,
      subagent_delegate: subagent,
    });
    const batch = executable(tools, "batch");
    const expansion = await batch.execute(
      {
        tool_calls: [
          { tool: "bash", parameters: {} },
          { tool: "glob", parameters: { patterns: ["*.ts"] } },
          { tool: "custom_tool", parameters: { value: "included" } },
        ],
      },
      options("batch"),
    );
    expect(isToolExpansion(expansion)).toBe(true);
    if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
    expect(expansion.children[0]).toMatchObject({ toolName: "bash", invalid: true });
    expect(expansion.children[1]).toMatchObject({ toolName: "glob" });
    expect(expansion.children[1]?.invalid).toBeUndefined();
    expect(expansion.children[2]).toMatchObject({
      toolName: "custom_tool",
      input: { value: "included" },
    });
    expect(expansion.children[0]?.toolCallId).toStartWith("batch_child_");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: [
              {
                tool: "edit",
                parameters: { path: "same.txt", oldText: "a", newText: "b" },
              },
              {
                tool: "edit",
                parameters: { path: "same.txt", oldText: "b", newText: "c" },
              },
            ],
          },
          options("batch-overlap"),
        ),
      ),
    ).rejects.toThrow("overlapping paths");

    const delegated = await batch.execute(
      { tool_calls: [{ tool: "subagent_delegate", parameters: { prompt: "no" } }] },
      options("batch-delegate"),
    );
    expect(isToolExpansion(delegated)).toBe(true);
    if (!isToolExpansion(delegated)) throw new Error("expected ToolExpansion");
    expect(delegated.children[0]).toMatchObject({
      toolName: "subagent_delegate",
      input: { prompt: "no" },
    });
    expect(delegated.children[0]?.invalid).toBeUndefined();
    const delegatedChild = delegated.children[0];
    if (!delegatedChild) throw new Error("missing delegated child");
    const delegatedResult = await executable(tools, delegatedChild.toolName).execute(
      delegatedChild.input,
      options(delegatedChild.toolCallId),
    );
    expect(delegatedResult).toBe("no");

    await expect(
      Promise.resolve(
        batch.execute(
          {
            tool_calls: Array.from({ length: 9 }, () => ({
              tool: "glob",
              parameters: { patterns: ["*.ts"] },
            })),
          },
          options("batch-limit"),
        ),
      ),
    ).rejects.toThrow("at most 8");
  });

  it("preserves Panic identity from batch child validation", async () => {
    const panic = new Panic({ message: "batch schema invariant failed" });
    const panickingSchema = z.unknown().transform((): Record<string, never> => {
      throw panic;
    });
    const tools = batchTools(cwd, {
      panicking: tool({ inputSchema: panickingSchema, execute: () => "unused" }),
    });

    await expect(
      executable(tools, "batch").execute(
        { tool_calls: [{ tool: "panicking", parameters: {} }] },
        options("batch-validation-panic"),
      ),
    ).rejects.toBe(panic);
  });

  it("projects hostile batch validation causes without invoking object coercion", async () => {
    const nullPrototypeCause: unknown = Object.create(null);
    const hostileTarget: object = Object.create(null);
    const hostileCause: unknown = new Proxy(hostileTarget, {
      get() {
        throw new Error("proxy get trap must stay contained");
      },
      getPrototypeOf() {
        throw new Error("proxy prototype trap must stay contained");
      },
    });

    for (const [index, cause] of [nullPrototypeCause, hostileCause].entries()) {
      const hostileSchema = z.unknown().transform((): Record<string, never> => {
        throw cause;
      });
      const tools = batchTools(cwd, {
        hostile: tool({ inputSchema: hostileSchema, execute: () => "unused" }),
      });

      const expansion = await executable(tools, "batch").execute(
        { tool_calls: [{ tool: "hostile", parameters: {} }] },
        options(`batch-hostile-validation-${index}`),
      );

      expect(isToolExpansion(expansion)).toBe(true);
      if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
      expect(expansion.children[0]).toMatchObject({
        invalid: true,
        error: expect.stringContaining("Batch child input validation failed"),
      });
    }
  });

  it("projects hostile synchronous edit-target failures before rejecting the batch", async () => {
    const hostileTarget: object = Object.create(null);
    const hostileCause: unknown = new Proxy(hostileTarget, {
      get() {
        throw new Error("proxy get trap must stay contained");
      },
      getPrototypeOf() {
        throw new Error("proxy prototype trap must stay contained");
      },
    });
    const childTool = tool({
      inputSchema: z.object({ path: z.string() }),
      execute: () => "unused",
    });
    const batch = createBatchToolResult({
      cwd,
      getTools: () => ({ hostile_edit: childTool }),
      getToolSpecs: () =>
        new Map([
          [
            "hostile_edit",
            {
              name: "hostile_edit",
              editTargets: () => {
                throw hostileCause;
              },
            },
          ],
        ]),
    });
    if (batch.status === "error") throw batch.error;

    await expect(
      executable(batch.value, "batch").execute(
        { tool_calls: [{ tool: "hostile_edit", parameters: { path: "file.txt" } }] },
        options("batch-hostile-edit-targets"),
      ),
    ).rejects.toThrow("Batch edit-target resolution failed");
  });

  it("normalizes legacy child names without advertising them in batch", async () => {
    const tools = batchTools(cwd, { read: tool({ inputSchema: createReadFileInputSchema() }) });
    const schema = JSON.stringify(await asSchema(tools.batch?.inputSchema).jsonSchema);
    expect(schema).toContain('"read"');
    expect(schema).not.toContain("read_file");

    const expansion = await executable(tools, "batch").execute(
      { tool_calls: [{ tool: "read_file", parameters: { path: "missing.txt" } }] },
      options("legacy-read-child"),
    );
    expect(isToolExpansion(expansion)).toBe(true);
    if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
    expect(expansion.children[0]?.toolName).toBe("read");
  });

  it("prefers an exact legacy-named batch child over the compatibility alias", async () => {
    const tools = batchTools(cwd, {
      read: tool({ inputSchema: createReadFileInputSchema() }),
      read_file: tool({ inputSchema: z.object({}), execute: () => "legacy" }),
    });

    const expansion = await executable(tools, "batch").execute(
      { tool_calls: [{ tool: "read_file", parameters: {} }] },
      options("exact-legacy-read-child"),
    );
    expect(isToolExpansion(expansion)).toBe(true);
    if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
    expect(expansion.children[0]?.toolName).toBe("read_file");
  });

  it("loads nested instructions once per read context and recognizes prior tool output", async () => {
    const nestedDirectory = path.join(cwd, "src");
    await mkdir(nestedDirectory);
    const rootInstructions = path.join(cwd, "AGENTS.md");
    const nestedInstructions = path.join(nestedDirectory, "AGENTS.md");
    await writeFile(rootInstructions, "Root rules.");
    await writeFile(nestedInstructions, "Nested rules.");
    const params = {
      resolvedPath: path.join(nestedDirectory, "file.txt"),
      cwd,
      preloadedInstructionPaths: [rootInstructions],
      messages: [],
    };
    const first = await loadReadFileInstructions(params);
    expect(first?.loaded).toEqual([nestedInstructions]);
    expect(first?.text).toContain("<system-reminder>");
    expect(first?.text).toContain("Nested rules.");
    expect(first?.text).not.toContain("Root rules.");

    for (const output of [
      { type: "json", value: { loadedInstructions: first?.loaded, instructionsText: first?.text } },
      { type: "content", value: [{ type: "text", text: first?.text }] },
    ]) {
      expect(
        await loadReadFileInstructions({
          ...params,
          messages: [
            { role: "tool", content: [{ type: "tool-result", toolName: "read", output }] },
          ],
        }),
      ).toBeNull();
    }

    const claims = createReadFileInstructionClaims();
    const claimedInstructionPaths = claims.forMessages(params.messages);
    const concurrent = await Promise.all([
      loadReadFileInstructions({ ...params, claimedInstructionPaths }),
      loadReadFileInstructions({ ...params, claimedInstructionPaths }),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(
      await loadReadFileInstructions({
        ...params,
        claimedInstructionPaths: claims.forMessages([]),
      }),
    ).not.toBeNull();
    expect(
      await loadReadFileInstructions({ ...params, resolvedPath: nestedInstructions }),
    ).toBeNull();
  });

  it("does not load instruction symlinks outside the workspace or into denied paths", async () => {
    const nestedDirectory = path.join(cwd, "src");
    const protectedInstructions = path.join(cwd, "protected.md");
    await mkdir(nestedDirectory);
    await writeFile(protectedInstructions, "Protected rules.");
    await symlink(protectedInstructions, path.join(nestedDirectory, "AGENTS.md"));
    expect(
      await loadReadFileInstructions({
        resolvedPath: path.join(nestedDirectory, "file.txt"),
        cwd,
        denyPaths: [protectedInstructions],
        messages: [],
      }),
    ).toBeNull();
    expect(
      await loadReadFileInstructions({
        resolvedPath: path.join(nestedDirectory, "file.txt"),
        cwd: nestedDirectory,
        messages: [],
      }),
    ).toBeNull();
  });
});
