import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isToolExpansion } from "@stanley2058/lilac-agent";
import { asSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";

import {
  createCodingToolset,
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
} from "../src";

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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

describe("coding tools", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "lilac-coding-tools-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("bash uses caller cwd, caps output, enforces timeout, and guards protected paths", async () => {
    const tools = createCodingToolset({
      cwd,
      bashMaxOutputBytes: 8,
      allowGuardrailBypass: true,
    });
    const bash = executable(tools, "bash");
    const normal = await executable(
      createCodingToolset({ cwd, bashMaxOutputBytes: 40 * 1024 }),
      "bash",
    ).execute({ command: "pwd" }, options("bash-cwd"));
    expect(normal).toMatchObject({ stdout: `${cwd}\n`, exitCode: 0 });

    const capped = await bash.execute(
      { command: "printf 1234567890; printf abcdefghij >&2" },
      options("bash-cap"),
    );
    expect(capped).toMatchObject({ stdoutTruncated: true, stderrTruncated: true, exitCode: 0 });
    const cappedOutput = capped as { stdout: string; stderr: string };
    expect(
      Buffer.byteLength(cappedOutput.stdout + cappedOutput.stderr, "utf8"),
    ).toBeLessThanOrEqual(8);

    const timeout = await bash.execute(
      { command: "sleep 5", timeoutMs: 20 },
      options("bash-timeout"),
    );
    expect(timeout).toMatchObject({ executionError: { type: "timeout" } });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await bash.execute(
      { command: "sleep 5" },
      options("bash-abort", controller.signal),
    );
    expect(aborted).toMatchObject({ executionError: { type: "aborted" } });

    const blocked = await bash.execute(
      { command: `test -e ${path.join(homedir(), ".ssh")}` },
      options("bash-deny"),
    );
    expect(blocked).toMatchObject({ executionError: { type: "blocked" } });
    const deniedCwd = path.join(cwd, "bash-denied");
    const linkedCwd = path.join(cwd, "bash-linked-cwd");
    await mkdir(deniedCwd);
    await symlink(deniedCwd, linkedCwd, "dir");
    const linkedCwdResult = await executable(
      createCodingToolset({ cwd: linkedCwd, denyPaths: [deniedCwd] }),
      "bash",
    ).execute({ command: "true" }, options("bash-canonical-cwd"));
    expect(linkedCwdResult).toMatchObject({ executionError: { type: "blocked" } });
    const allowed = await bash.execute(
      { command: `printf '%s' ${path.join(homedir(), ".ssh")}`, dangerouslyAllow: true },
      options("bash-allow"),
    );
    expect(allowed).toMatchObject({ exitCode: 0 });
    expect((allowed as { executionError?: unknown }).executionError).toBeUndefined();

    const operationCwd = path.join(cwd, "operation-cwd");
    await mkdir(operationCwd);
    const cwdOverride = await executable(createCodingToolset({ cwd }), "bash").execute(
      { command: "pwd", cwd: operationCwd, stdinMode: "error" },
      options("bash-operation-cwd"),
    );
    expect(cwdOverride).toMatchObject({ stdout: `${operationCwd}\n`, exitCode: 0 });

    const strictStdin = await executable(createCodingToolset({ cwd }), "bash").execute(
      {
        command:
          "if cat >/dev/null 2>&1; then echo stdin_read_ok; else echo stdin_read_err; exit 7; fi",
      },
      options("bash-strict-stdin"),
    );
    expect(strictStdin).toMatchObject({ stdout: "stdin_read_err\n", exitCode: 7 });
    const eofStdin = await executable(createCodingToolset({ cwd }), "bash").execute(
      {
        command: "if cat >/dev/null 2>&1; then echo stdin_read_ok; else exit 7; fi",
        stdinMode: "eof",
      },
      options("bash-eof-stdin"),
    );
    expect(eofStdin).toMatchObject({ stdout: "stdin_read_ok\n", exitCode: 0 });
  });

  it("optionally streams bounded Bash stdout and stderr before the final result", async () => {
    const bash = executable(
      createCodingToolset({
        cwd,
        bashStreamOutput: true,
        bashMergeOutput: true,
        bashMaxOutputBytes: 32,
      }),
      "bash",
    );
    const result = bash.execute(
      { command: "printf 'first'; printf 'err' >&2; printf 'second'" },
      options("bash-stream"),
    );
    if (!isAsyncIterable(result)) throw new Error("expected streaming Bash output");

    const updates: unknown[] = [];
    let finalOutput: unknown;
    const iterator = result[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalOutput = next.value;
        break;
      }
      updates.push(next.value);
    }

    const deltaSchema = z.object({
      type: z.literal("output-delta"),
      delta: z.string(),
    });
    const deltas = updates
      .map((update) => deltaSchema.safeParse(update))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);
    expect(deltas.map((update) => update.delta).join("")).toBe("firsterrsecond");
    expect(deltas).toHaveLength(1);
    expect(finalOutput).toMatchObject({
      stdout: "firsterrsecond",
      stderr: "",
      exitCode: 0,
    });
  });

  it("rejects SSH cwd targets at the local adapter boundary", async () => {
    expect(() => createCodingToolset({ cwd: "host:/repo" })).toThrow(
      "local coding-tools adapter does not support SSH cwd target",
    );
    const tools = createCodingToolset({ cwd });
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "read_file").execute(
          { path: "a.txt", cwd: "host:/repo" },
          options("read-ssh"),
        ),
      ),
    ).rejects.toThrow("local coding-tools adapter does not support SSH cwd target");
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "apply_patch").execute(
          {
            cwd: "host:/repo",
            patchText: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch",
          },
          options("patch-ssh"),
        ),
      ),
    ).rejects.toThrow("local coding-tools adapter does not support SSH cwd target");
  });

  it("exports hashline schema factories for stateful runtime adapters", async () => {
    const readSchema = createReadFileInputSchema({ hashlineEnabled: true });
    const grepSchema = createGrepInputSchema(true);
    const editSchema = createEditFileInputSchema(true);
    expect(readSchema.safeParse({ path: "a.ts", format: "hashline" }).success).toBe(true);
    expect(grepSchema.safeParse({ pattern: "needle", mode: "hashline" }).success).toBe(true);
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
    const localEditSchema = createCodingToolset({ cwd }).edit_file?.inputSchema;
    const localHashlineValidation = await asSchema(localEditSchema).validate?.({
      path: "a.ts",
      edits: [{ op: "replace", pos: "1#abcd", lines: ["next"] }],
    });
    expect(localHashlineValidation?.success).toBe(false);
  });

  it("read_file reads text and denies protected paths by default", async () => {
    await writeFile(path.join(cwd, "hello.txt"), "hello\nworld\n");
    const read = executable(createCodingToolset({ cwd }), "read_file");
    const result = await read.execute(
      { path: "hello.txt", format: "numbered", maxLines: 1 },
      options("read"),
    );
    expect(result).toMatchObject({ success: true, numberedContent: "1| hello" });

    const denied = await read.execute({ path: "~/.ssh/config" }, options("read-deny"));
    expect(denied).toMatchObject({ success: false, error: { code: "PERMISSION" } });

    const protectedPath = path.join(cwd, "protected.txt");
    await writeFile(protectedPath, "protected\n");
    const protectedRead = executable(
      createCodingToolset({
        cwd,
        denyPaths: [protectedPath],
        allowGuardrailBypass: true,
      }),
      "read_file",
    );
    const allowed = await protectedRead.execute(
      { path: protectedPath, dangerouslyAllow: true },
      options("read-allow"),
    );
    expect(allowed).toMatchObject({ success: true, content: "protected\n" });

    const protectedAlias = path.join(cwd, "protected-alias.txt");
    await symlink(protectedPath, protectedAlias);
    const deniedAlias = await protectedRead.execute(
      { path: protectedAlias },
      options("read-denied-alias"),
    );
    expect(deniedAlias).toMatchObject({ success: false, error: { code: "PERMISSION" } });

    const realDeniedDirectory = path.join(cwd, "real-denied");
    const deniedDirectoryAlias = path.join(cwd, "denied-directory-alias");
    await mkdir(realDeniedDirectory);
    await writeFile(path.join(realDeniedDirectory, "secret.txt"), "secret\n");
    await symlink(realDeniedDirectory, deniedDirectoryAlias);
    const symlinkedRootRead = executable(
      createCodingToolset({ cwd, denyPaths: [deniedDirectoryAlias] }),
      "read_file",
    );
    expect(
      await symlinkedRootRead.execute(
        { path: path.join(realDeniedDirectory, "secret.txt") },
        options("read-symlinked-deny-root"),
      ),
    ).toMatchObject({ success: false, error: { code: "PERMISSION" } });
  });

  it("glob returns matching local paths", async () => {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
    await writeFile(path.join(cwd, "src", "b.js"), "module.exports = {};\n");
    const glob = executable(createCodingToolset({ cwd }), "glob");
    const result = await glob.execute({ patterns: ["**/*.ts"] }, options("glob"));
    expect(result).toMatchObject({ mode: "default", paths: ["src/a.ts"] });
  });

  it("grep searches local file contents", async () => {
    await writeFile(path.join(cwd, "one.ts"), "const needle = 1;\n");
    await writeFile(path.join(cwd, "two.ts"), "const other = 2;\n");
    const grep = executable(createCodingToolset({ cwd }), "grep");
    const result = await grep.execute(
      { pattern: "needle", fileExtensions: ["ts"] },
      options("grep"),
    );
    expect(result).toMatchObject({
      mode: "default",
      results: [{ file: "./one.ts", line: 1, text: "const needle = 1;\n" }],
    });
  });

  it("fuzzy_search is exposed only for fff and searches through FileSystem", async () => {
    await writeFile(path.join(cwd, "distinctive-widget.ts"), "export {};\n");
    expect(createCodingToolset({ cwd }).fuzzy_search).toBeUndefined();
    const tools = createCodingToolset({ cwd, fsBackend: "fff" });
    const result = await executable(tools, "fuzzy_search").execute(
      { query: "distinctwidget" },
      options("fuzzy"),
    );
    expect(result).toMatchObject({ results: expect.any(Array) });
  });

  it("edit_file requires read_file and uses legacy replace-snippet semantics", async () => {
    await writeFile(path.join(cwd, "edit.txt"), "before\n");
    const tools = createCodingToolset({ cwd });
    const edit = executable(tools, "edit_file");
    const notRead = await edit.execute(
      { path: "edit.txt", oldText: "before", newText: "after" },
      options("edit-not-read"),
    );
    expect(notRead).toMatchObject({ success: false, error: { code: "NOT_READ" } });

    await executable(tools, "read_file").execute({ path: "edit.txt" }, options("edit-read"));
    const edited = await edit.execute(
      { path: "edit.txt", oldText: "before", newText: "after" },
      options("edit"),
    );
    expect(edited).toMatchObject({ success: true, replacementsMade: 1 });
    expect(await readFile(path.join(cwd, "edit.txt"), "utf8")).toBe("after\n");
  });

  it("apply_patch supports add, update, move, delete and refuses directory deletes", async () => {
    await writeFile(path.join(cwd, "old.txt"), "old\n");
    const blockedPath = path.join(cwd, "blocked.txt");
    const applyPatch = executable(
      createCodingToolset({
        cwd,
        denyPaths: [blockedPath],
        allowGuardrailBypass: true,
      }),
      "apply_patch",
    );
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

  it("apply_patch rejects add, update, and delete through a symlink into a denied directory", async () => {
    const denied = path.join(cwd, "denied");
    await mkdir(denied);
    await writeFile(path.join(denied, "update.txt"), "before\n");
    await writeFile(path.join(denied, "delete.txt"), "keep\n");
    await symlink(denied, path.join(cwd, "workspace-link"), "dir");
    const applyPatch = executable(createCodingToolset({ cwd, denyPaths: [denied] }), "apply_patch");
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

  it("apply_patch honors AbortSignal before starting later hunks", async () => {
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
        executable(createCodingToolset({ cwd }), "apply_patch").execute(
          { patchText },
          options("patch-abort", abortSignal),
        ),
      ),
    ).rejects.toThrow("apply_patch aborted");
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("first");
    expect(Bun.file(path.join(cwd, "later.txt")).size).toBe(0);
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
    const tools = createCodingToolset({
      cwd,
      extraTools: { custom_tool: custom, subagent_delegate: subagent },
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
                tool: "edit_file",
                parameters: { path: "same.txt", oldText: "a", newText: "b" },
              },
              {
                tool: "edit_file",
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

  it("keeps filtered tools out of a read-only profile and its batch", async () => {
    const tools = createCodingToolset({
      cwd,
      enabledTools: ["read_file", "glob", "grep", "batch"],
      extraTools: {
        custom_tool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: ({ value }) => value,
        }),
      },
    });
    expect(Object.keys(tools).sort()).toEqual(["batch", "glob", "grep", "read_file"]);
    expect(createCodingToolset({ cwd, enabledTools: ["read_file"] }).batch).toBeUndefined();

    const wildcardTools = createCodingToolset({
      cwd,
      enabledTools: ["*"],
      extraTools: {
        wildcard_extra: tool({
          inputSchema: z.object({}),
          execute: () => true,
        }),
      },
    });
    expect(wildcardTools.wildcard_extra).toBeDefined();
    expect(wildcardTools.bash).toBeDefined();
    expect(wildcardTools.batch).toBeDefined();

    const excludedFromBatch = createCodingToolset({
      cwd,
      enabledTools: ["read_file", "custom_tool", "batch"],
      batchExcludedTools: ["custom_tool"],
      extraTools: {
        custom_tool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: ({ value }) => value,
        }),
      },
    });
    expect(
      JSON.stringify(await asSchema(excludedFromBatch.batch?.inputSchema).jsonSchema),
    ).not.toContain("custom_tool");

    const onlyExcludedFromBatch = createCodingToolset({
      cwd,
      enabledTools: ["custom_tool", "batch"],
      batchExcludedTools: ["custom_tool"],
      extraTools: {
        custom_tool: tool({ inputSchema: z.object({}), execute: () => true }),
      },
    });
    expect(Object.keys(onlyExcludedFromBatch)).toEqual(["custom_tool"]);

    const batchTool = tools.batch;
    if (!batchTool) throw new Error("missing batch tool");
    const jsonSchema = await asSchema(batchTool.inputSchema).jsonSchema;
    const schemaShape = jsonSchema as {
      properties?: {
        tool_calls?: { items?: { properties?: { tool?: { enum?: string[] } } } };
      };
    };
    const exposedNames = schemaShape.properties?.tool_calls?.items?.properties?.tool?.enum ?? [];
    expect(exposedNames.sort()).toEqual(["glob", "grep", "read_file"]);

    const expansion = await executable(tools, "batch").execute(
      {
        tool_calls: ["bash", "edit_file", "apply_patch"].map((name) => ({
          tool: name,
          parameters: {},
        })),
      },
      options("read-only-batch"),
    );
    expect(isToolExpansion(expansion)).toBe(true);
    if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
    expect(expansion.children).toHaveLength(3);
    expect(expansion.children.every((child) => child.invalid === true)).toBe(true);
  });

  it("rejects dangerouslyAllow by default for bash, filesystem, edit, and apply_patch", async () => {
    await writeFile(path.join(cwd, "guarded.txt"), "before\n");
    const tools = createCodingToolset({ cwd });
    const calls = [
      () =>
        executable(tools, "bash").execute(
          { command: "true", dangerouslyAllow: true },
          options("bypass-bash"),
        ),
      () =>
        executable(tools, "read_file").execute(
          { path: "guarded.txt", dangerouslyAllow: true },
          options("bypass-read"),
        ),
      () =>
        executable(tools, "edit_file").execute(
          {
            path: "guarded.txt",
            oldText: "before",
            newText: "after",
            dangerouslyAllow: true,
          },
          options("bypass-edit"),
        ),
      () =>
        executable(tools, "apply_patch").execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: bypass.txt",
              "+blocked",
              "*** End Patch",
            ].join("\n"),
            dangerouslyAllow: true,
          },
          options("bypass-patch"),
        ),
    ];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toThrow("dangerouslyAllow is disabled");
    }
  });
});
