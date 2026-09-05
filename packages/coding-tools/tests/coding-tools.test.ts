import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { isToolExpansion } from "@stanley2058/lilac-agent";
import {
  createToolResultArtifactStore,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
  ToolResultArtifactStorageFailure,
  type ToolResultArtifactStore,
  type ToolResultOutput,
} from "@stanley2058/lilac-tool-results";
import { asSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { Panic, Result } from "better-result";
import { z } from "zod";

import {
  BASH_NO_OUTPUT_TIMEOUT_MS,
  applyPatchResult,
  createBatchToolResult,
  createCodingToolset,
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  loadReadFileInstructions,
  loadWorkspaceInstructions,
} from "../src";
import { createBashOutputSanitizer } from "../src/bash-output-sanitizer";
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

async function toModelOutput(
  tools: ToolSet,
  name: string,
  toolCallId: string,
  input: unknown,
  output: unknown,
): Promise<ToolResultOutput> {
  const candidate = tools[name];
  if (!candidate?.toModelOutput) throw new Error(`missing model output converter: ${name}`);
  return await candidate.toModelOutput({
    toolCallId,
    input: input as never,
    output: output as never,
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

async function bashSpoolDirectories(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith("lilac-coding-bash-")),
  );
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

    // test-wait-justification: verifies the explicit wall deadline while the command emits output
    const timeout = await bash.execute(
      { command: "while true; do printf tick; sleep 0.01; done", timeoutMs: 50 },
      options("bash-timeout"),
    );
    expect(timeout).toMatchObject({
      stdout: expect.stringContaining("tick"),
      executionError: { type: "timeout", timeoutMs: 50, timeoutKind: "wall_clock" },
    });

    // test-wait-justification: verifies the deadline remains armed after the shell leader exits while a descendant retains its output pipes
    const backgroundTimeout = await bash.execute(
      { command: "sleep 5 &", timeoutMs: 50 },
      options("bash-background-timeout"),
    );
    expect(backgroundTimeout).toMatchObject({
      executionError: { type: "timeout", timeoutMs: 50, timeoutKind: "wall_clock" },
    });
    expect(BASH_NO_OUTPUT_TIMEOUT_MS).toBe(3 * 60 * 1000);

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

  it("reports the fixed inactivity deadline as a no-output timeout", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const shortenedSetTimeout = Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        nativeSetTimeout(callback, delay === BASH_NO_OUTPUT_TIMEOUT_MS ? 200 : delay, ...args),
      { __promisify__: nativeSetTimeout.__promisify__ },
    );
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      shortenedSetTimeout as typeof setTimeout,
    );

    try {
      const bash = executable(createCodingToolset({ cwd }), "bash");
      // test-wait-justification: verifies the fixed no-output deadline through a scoped shortened timer
      const result = await bash.execute(
        { command: "printf partial; sleep 5" },
        options("bash-no-output-timeout"),
      );
      expect(result).toMatchObject({
        stdout: "partial",
        executionError: {
          type: "timeout",
          timeoutMs: BASH_NO_OUTPUT_TIMEOUT_MS,
          timeoutKind: "no_output",
          signal: "SIGTERM",
        },
      });
    } finally {
      timerSpy.mockRestore();
    }
  });

  it("blocks expansion-sensitive deletion unless dangerouslyAllow is explicit", async () => {
    const target = path.join(cwd, "expanded-target");
    await mkdir(target);
    await writeFile(path.join(target, "marker.txt"), "keep");
    const command = `target=${JSON.stringify(target)}; rm -rf "$target"`;
    const tools = createCodingToolset({ cwd, allowBashGuardrailBypass: true });
    const bash = executable(tools, "bash");

    const blocked = await bash.execute({ command }, options("bash-safety-block"));
    expect(blocked).toMatchObject({
      exitCode: -1,
      executionError: {
        type: "blocked",
        code: "dynamic_recursive_delete",
        reason: expect.stringContaining("dynamic target"),
        hint: expect.stringContaining("literal child paths"),
        segment: expect.stringContaining("rm -rf"),
      },
    });
    expect(await readFile(path.join(target, "marker.txt"), "utf8")).toBe("keep");

    const allowed = await bash.execute(
      { command, dangerouslyAllow: true },
      options("bash-safety-bypass"),
    );
    expect(allowed).toMatchObject({ exitCode: 0 });
    expect(await readdir(cwd)).not.toContain("expanded-target");
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "read").execute(
          { path: "marker.txt", dangerouslyAllow: true },
          options("filesystem-bypass-disabled"),
        ),
      ),
    ).rejects.toThrow("dangerouslyAllow is disabled");
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "edit").execute(
          {
            path: "marker.txt",
            oldText: "before",
            newText: "after",
            dangerouslyAllow: true,
          },
          options("edit-bypass-disabled"),
        ),
      ),
    ).rejects.toThrow("dangerouslyAllow is disabled");
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "patch").execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: bypass.txt",
              "+blocked",
              "*** End Patch",
            ].join("\n"),
            dangerouslyAllow: true,
          },
          options("patch-bypass-disabled"),
        ),
      ),
    ).rejects.toThrow("dangerouslyAllow is disabled");
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

  it("settles streaming Bash for hostile rejections and terminates on Panic", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "stream-settlement-artifacts"));
    await artifacts.init();
    const hostileTarget: object = Object.create(null);
    const hostileProxy = new Proxy(hostileTarget, {
      get() {
        throw new Error("proxy get trap must stay contained");
      },
      getPrototypeOf() {
        throw new Error("proxy prototype trap must stay contained");
      },
    });
    const hostileString = {
      [Symbol.toPrimitive]() {
        throw new Error("String coercion must stay contained");
      },
      toString() {
        throw new Error("toString must stay contained");
      },
    };
    const hostileCauses: readonly unknown[] = [Object.create(null), hostileProxy, hostileString];

    for (const [index, cause] of hostileCauses.entries()) {
      const failingArtifacts: ToolResultArtifactStore = {
        ...artifacts,
        async createFromStream() {
          throw cause;
        },
      };
      const execution = executable(
        createCodingToolset({
          cwd,
          bashStreamOutput: true,
          bashMaxOutputBytes: 32,
          artifactIntegration: {
            artifacts: failingArtifacts,
            scopeId: "scope-hostile-stream",
            requestId: `request-hostile-stream-${index}`,
            maxSpoolBytes: 1024 * 1024,
          },
        }),
        "bash",
      ).execute({ command: "printf '%0100d' 0" }, options(`bash-hostile-stream-${index}`));
      if (!isAsyncIterable(execution)) throw new Error("expected streaming Bash output");
      const consume = async () => {
        const iterator = execution[Symbol.asyncIterator]();
        while (true) {
          const next = await iterator.next();
          if (next.done) return next.value;
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("streaming Bash completion hung")), 5_000);
      });
      try {
        await expect(Promise.race([consume(), timeout])).resolves.toMatchObject({
          exitCode: 0,
          truncation: {
            completeOutputRetained: false,
            retentionStatus: "artifact-write-failed",
          },
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const panic = new Panic({ message: "streaming artifact invariant failed" });
    const panickingArtifacts: ToolResultArtifactStore = {
      ...artifacts,
      async createFromStream() {
        throw panic;
      },
    };
    const panickingExecution = executable(
      createCodingToolset({
        cwd,
        bashStreamOutput: true,
        bashMaxOutputBytes: 32,
        artifactIntegration: {
          artifacts: panickingArtifacts,
          scopeId: "scope-panic-stream",
          requestId: "request-panic-stream",
          maxSpoolBytes: 1024 * 1024,
        },
      }),
      "bash",
    ).execute({ command: "printf '%0100d' 0" }, options("bash-panic-stream"));
    if (!isAsyncIterable(panickingExecution)) throw new Error("expected streaming Bash output");
    const consumePanic = async () => {
      for await (const _update of panickingExecution) {
        // Consume until the terminal rejection.
      }
    };
    let panicTimer: ReturnType<typeof setTimeout> | undefined;
    const panicTimeout = new Promise<never>((_resolve, reject) => {
      panicTimer = setTimeout(() => reject(new Error("streaming Bash Panic hung")), 5_000);
    });
    try {
      await expect(Promise.race([consumePanic(), panicTimeout])).rejects.toBe(panic);
    } finally {
      if (panicTimer !== undefined) clearTimeout(panicTimer);
    }
  });

  it("retains sanitized complete Bash output behind a bounded head/tail preview", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "artifacts"));
    await artifacts.init();
    const artifactIntegration = {
      artifacts,
      scopeId: "scope-a",
      requestId: "request-a",
      ttlMs: 60_000,
      maxBytesPerScope: 1024 * 1024,
      maxSpoolBytes: 1024 * 1024,
    } as const;
    const tools = createCodingToolset({
      cwd,
      bashMaxOutputBytes: 160,
      artifactIntegration,
    });
    const result = z
      .object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        truncation: z.object({
          artifactUri: z.string(),
          artifactBytes: z.number(),
          originalStdoutBytes: z.number(),
          originalStderrBytes: z.number(),
          previewBytes: z.number(),
          completeOutputRetained: z.literal(true),
          retentionStatus: z.literal("retained"),
        }),
      })
      .passthrough()
      .parse(
        await executable(tools, "bash").execute(
          {
            command:
              "printf '\\x1b[31mSTART\\x1b[0m'; printf 'x%.0s' {1..300}; printf ' API_TOKEN=very-secret-value END'; { printf 'ERR_START'; printf 'y%.0s' {1..200}; printf 'ERR_END'; } >&2",
          },
          options("bash-artifact"),
        ),
      );

    expect(result.stdout).toStartWith("START");
    expect(result.stdout).toEndWith("END");
    expect(result.stderr).toStartWith("ERR_START");
    expect(result.stderr).toEndWith("ERR_END");
    expect(result.stdout).toContain("middle output omitted");
    expect(result.truncation.previewBytes).toBeLessThanOrEqual(160);
    expect(result.truncation.originalStdoutBytes).toBeGreaterThan(300);
    expect(result.truncation.originalStderrBytes).toBeGreaterThan(200);

    const read = executable(tools, "read");
    const pages: string[] = [];
    let start: { type: "offset"; offset: number } = { type: "offset", offset: 0 };
    for (let page = 0; page < 100; page += 1) {
      const window = z
        .object({
          success: z.literal(true),
          kind: z.literal("artifact"),
          content: z.string(),
          hasMore: z.boolean(),
          nextStart: z.object({ type: z.literal("offset"), offset: z.number() }).optional(),
        })
        .parse(
          await read.execute(
            { path: result.truncation.artifactUri, start, maxCharacters: 47, maxLines: 2_000 },
            options(`read-bash-artifact-${page}`),
          ),
        );
      pages.push(window.content);
      if (!window.hasMore || !window.nextStart) break;
      start = window.nextStart;
    }
    const complete = pages.join("");
    expect(complete).toBe(
      `<bash_tool_full_output>\n--- stdout ---\nSTART${"x".repeat(300)} API_TOKEN=<redacted> END\n\n--- stderr ---\nERR_START${"y".repeat(200)}ERR_END\n</bash_tool_full_output>\n`,
    );
    expect(complete).not.toContain("very-secret-value");
    expect(complete).not.toContain("\u001b");
  });

  it("does not create a Bash spool directory for under-limit artifact output", async () => {
    const isolatedTmp = path.join(cwd, "tmp");
    await mkdir(isolatedTmp);
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      const artifacts = createToolResultArtifactStore(path.join(cwd, "small-artifacts"));
      await artifacts.init();
      const result = await executable(
        createCodingToolset({
          cwd,
          bashMaxOutputBytes: 1024,
          artifactIntegration: {
            artifacts,
            scopeId: "scope-small",
            requestId: "request-small",
          },
        }),
        "bash",
      ).execute(
        {
          command:
            'shopt -s nullglob; spools=("$TMPDIR"/lilac-coding-bash-*); printf "%s" "${#spools[@]}"',
        },
        options("bash-small-artifact"),
      );

      expect(result).toMatchObject({ stdout: "0", stderr: "", exitCode: 0 });
      expect(await readdir(isolatedTmp)).toEqual([]);
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
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

  it("sanitizes terminal controls and secrets split across chunks", () => {
    const sanitizer = createBashOutputSanitizer(["literal-secret-value"]);
    const sanitized =
      sanitizer.write(Buffer.from("\u001b[")) +
      sanitizer.write(Buffer.from("31mAPI_TO")) +
      sanitizer.write(Buffer.from("KEN=split-secret-value\nAuthorization: Bear")) +
      sanitizer.write(Buffer.from("er credential-value\nliteral-")) +
      sanitizer.write(Buffer.from("secret-value END\u001b")) +
      sanitizer.write(Buffer.from("[0m")) +
      sanitizer.end();

    expect(sanitized).toContain("API_TOKEN=<redacted>");
    expect(sanitized).toContain("Authorization: <redacted>");
    expect(sanitized).toContain("<redacted> END");
    expect(sanitized).not.toContain("split-secret-value");
    expect(sanitized).not.toContain("credential-value");
    expect(sanitized).not.toContain("literal-secret-value");
    expect(sanitized).not.toContain("\u001b");
  });

  it("drains Bash after the hard spool cap and reports that complete output was not retained", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "capped-artifacts"));
    await artifacts.init();
    const before = await bashSpoolDirectories();
    const result = await executable(
      createCodingToolset({
        cwd,
        bashMaxOutputBytes: 64,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-cap",
          requestId: "request-cap",
          maxSpoolBytes: 100,
        },
      }),
      "bash",
    ).execute(
      { command: "printf START; head -c 10000 /dev/zero | tr '\\0' z; printf END" },
      options("bash-spool-cap"),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      truncation: {
        completeOutputRetained: false,
        retentionStatus: "spool-limit-exceeded",
      },
    });
    expect(JSON.stringify(result)).not.toContain("artifactUri");
    expect(await readdir(artifacts.rootDir)).toEqual([]);
    expect(await bashSpoolDirectories()).toEqual(before);
  });

  it("throws for an invalid maxSpoolBytes configuration", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "invalid-spool-artifacts"));
    await artifacts.init();
    const bash = executable(
      createCodingToolset({
        cwd,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-invalid-spool",
          requestId: "request-invalid-spool",
          maxSpoolBytes: Number.POSITIVE_INFINITY,
        },
      }),
      "bash",
    );

    await expect(
      Promise.resolve(bash.execute({ command: "true" }, options("bash-invalid-spool"))),
    ).rejects.toThrow("artifactIntegration.maxSpoolBytes must be a non-negative finite number");
  });

  it("leaves no Bash spools after timeout, abort, and rejected artifact persistence", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "cleanup-artifacts"));
    await artifacts.init();
    const before = await bashSpoolDirectories();
    const integration = {
      artifacts,
      scopeId: "scope-cleanup",
      requestId: "request-cleanup",
      maxSpoolBytes: 1024 * 1024,
    } as const;
    const bash = executable(
      createCodingToolset({ cwd, bashMaxOutputBytes: 32, artifactIntegration: integration }),
      "bash",
    );
    const timeout = await bash.execute(
      { command: "printf '%0100d' 0; sleep 5", timeoutMs: 20 },
      options("bash-artifact-timeout"),
    );
    expect(timeout).toMatchObject({
      executionError: { type: "timeout", timeoutMs: 20, timeoutKind: "wall_clock" },
    });
    expect(await bashSpoolDirectories()).toEqual(before);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await bash.execute(
      { command: "printf '%0100d' 0; sleep 5" },
      options("bash-artifact-abort", controller.signal),
    );
    expect(aborted).toMatchObject({ executionError: { type: "aborted" } });
    expect(await bashSpoolDirectories()).toEqual(before);

    const failingArtifacts: ToolResultArtifactStore = {
      ...artifacts,
      async createFromStream() {
        throw new Error("intentional artifact failure");
      },
    };
    const failedPersistence = await executable(
      createCodingToolset({
        cwd,
        bashMaxOutputBytes: 32,
        artifactIntegration: {
          ...integration,
          artifacts: failingArtifacts,
          requestId: "request-failure",
        },
      }),
      "bash",
    ).execute({ command: "printf '%0100d' 0" }, options("bash-artifact-failure"));
    expect(failedPersistence).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("0"),
      truncation: {
        completeOutputRetained: false,
        retentionStatus: "artifact-write-failed",
      },
    });
    expect(failedPersistence).not.toHaveProperty("executionError");
    expect(await bashSpoolDirectories()).toEqual(before);
  });

  it("maps an artifact Result Err to truncation retention failure", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "result-error-artifacts"));
    await artifacts.init();
    const before = await bashSpoolDirectories();
    const failingArtifacts: ToolResultArtifactStore = {
      ...artifacts,
      async createFromStream() {
        return Result.err(
          new ToolResultArtifactStorageFailure({
            operation: "write-content",
            code: "ENOSPC",
            message: "Tool result artifact write-content failed",
          }),
        );
      },
    };

    const result = await executable(
      createCodingToolset({
        cwd,
        bashMaxOutputBytes: 32,
        artifactIntegration: {
          artifacts: failingArtifacts,
          scopeId: "scope-result-error",
          requestId: "request-result-error",
          maxSpoolBytes: 1024 * 1024,
        },
      }),
      "bash",
    ).execute({ command: "printf '%0100d' 0" }, options("bash-artifact-result-error"));

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("0"),
      truncation: {
        completeOutputRetained: false,
        retentionStatus: "artifact-write-failed",
      },
    });
    expect(result).not.toHaveProperty("executionError");
    expect(await bashSpoolDirectories()).toEqual(before);
  });

  it("preserves artifact Panic identity after cleaning the Bash spool", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "panic-artifacts"));
    await artifacts.init();
    const before = await bashSpoolDirectories();
    const panic = new Panic({ message: "artifact invariant failed" });
    const failingArtifacts: ToolResultArtifactStore = {
      ...artifacts,
      async createFromStream() {
        throw panic;
      },
    };
    const execution = executable(
      createCodingToolset({
        cwd,
        bashMaxOutputBytes: 32,
        artifactIntegration: {
          artifacts: failingArtifacts,
          scopeId: "scope-panic",
          requestId: "request-panic",
          maxSpoolBytes: 1024 * 1024,
        },
      }),
      "bash",
    ).execute({ command: "printf '%0100d' 0" }, options("bash-artifact-panic"));

    await expect(Promise.resolve(execution)).rejects.toBe(panic);
    expect(await bashSpoolDirectories()).toEqual(before);
  });

  it("rejects SSH cwd targets at the local adapter boundary", async () => {
    expect(() => createCodingToolset({ cwd: "host:/repo" })).toThrow(
      "local coding-tools adapter does not support SSH cwd target",
    );
    const tools = createCodingToolset({ cwd });
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "read").execute(
          { path: "a.txt", cwd: "host:/repo" },
          options("read-ssh"),
        ),
      ),
    ).rejects.toThrow("local coding-tools adapter does not support SSH cwd target");
    await expect(
      Promise.resolve().then(() =>
        executable(tools, "patch").execute(
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
    const localEditSchema = createCodingToolset({ cwd }).edit?.inputSchema;
    const localHashlineValidation = await asSchema(localEditSchema).validate?.({
      path: "a.ts",
      edits: [{ op: "replace", pos: "1#abcd", lines: ["next"] }],
    });
    expect(localHashlineValidation?.success).toBe(false);
  });

  it("read reads text and denies protected paths by default", async () => {
    await writeFile(path.join(cwd, "hello.txt"), "hello\nworld\n");
    const read = executable(createCodingToolset({ cwd }), "read");
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
      "read",
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
      "read",
    );
    expect(
      await symlinkedRootRead.execute(
        { path: path.join(realDeniedDirectory, "secret.txt") },
        options("read-symlinked-deny-root"),
      ),
    ).toMatchObject({ success: false, error: { code: "PERMISSION" } });
  });

  it("applies the configured UTF-8 payload cap independently of maxCharacters", async () => {
    await writeFile(path.join(cwd, "unicode.txt"), "A😀BéC");
    const read = executable(createCodingToolset({ cwd, maxOutputBytes: 5 }), "read");

    const result = await read.execute(
      { path: "unicode.txt", start: { type: "offset", offset: 0 }, maxCharacters: 100 },
      options("read-unicode"),
    );

    expect(result).toMatchObject({
      success: true,
      content: "A😀",
      truncatedByChars: false,
      nextStart: { type: "offset", offset: 2 },
    });
  });

  it("read keeps image and PDF bytes out of its canonical result and attaches them for models", async () => {
    const attachments = [
      {
        filename: "pixel.png",
        mimeType: "image/png",
        data: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
          "base64",
        ),
      },
      { filename: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) },
      {
        filename: "photo.jpeg",
        mimeType: "image/jpeg",
        data: Buffer.from([0xff, 0xd8, 0xff]),
      },
      { filename: "old.gif", mimeType: "image/gif", data: Buffer.from("GIF87a") },
      { filename: "new.gif", mimeType: "image/gif", data: Buffer.from("GIF89a") },
      {
        filename: "image.webp",
        mimeType: "image/webp",
        data: Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      },
      { filename: "notes.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4") },
    ] as const;
    await Promise.all(
      attachments.map(({ filename, data }) => writeFile(path.join(cwd, filename), data)),
    );
    const tools = createCodingToolset({
      cwd,
      readFileDirectAttachmentSupported: true,
      maxInlineMediaBytesPerPart: 128,
    });
    const read = executable(tools, "read");

    for (const [index, attachment] of attachments.entries()) {
      const toolCallId = `attachment-${index}`;
      const result = await read.execute({ path: attachment.filename }, options(toolCallId));
      expect(result).toMatchObject({
        success: true,
        kind: "attachment",
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        bytes: attachment.data.byteLength,
      });
      expect(JSON.stringify(result)).not.toContain(attachment.data.toString("base64"));
      expect(
        await toModelOutput(tools, "read", toolCallId, { path: attachment.filename }, result),
      ).toEqual({
        type: "content",
        value: [
          {
            type: "text",
            text: `Attached file from read: ${attachment.filename} (${attachment.mimeType}, ${attachment.data.byteLength} bytes).`,
          },
          {
            type: "file",
            mediaType: attachment.mimeType,
            filename: attachment.filename,
            data: { type: "data", data: attachment.data.toString("base64") },
          },
        ],
      });
    }
    expect(tools.read?.description).toContain(
      "Analyze supported images and PDFs already attached to context directly",
    );
    expect(tools.read?.description).toContain(
      "Use read to attach supported images and PDFs available only through a local filesystem path",
    );
    expect(JSON.stringify(await asSchema(tools.read?.inputSchema).jsonSchema)).toContain(
      "Local filesystem path or tool-result:// URI.",
    );
  });

  it("read preserves attachment instructions and reports consumed attachment bytes", async () => {
    const nestedDirectory = path.join(cwd, "nested");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    await mkdir(nestedDirectory);
    await Promise.all([
      writeFile(path.join(nestedDirectory, "AGENTS.md"), "Inspect images carefully.\n"),
      writeFile(path.join(nestedDirectory, "pixel.png"), image),
    ]);
    const tools = createCodingToolset({ cwd, readFileDirectAttachmentSupported: true });
    const attachment = z
      .object({
        success: z.literal(true),
        kind: z.literal("attachment"),
        filename: z.string(),
        mimeType: z.string(),
        bytes: z.number(),
        loadedInstructions: z.array(z.string()),
        instructionsText: z.string(),
      })
      .passthrough()
      .parse(
        await executable(tools, "read").execute(
          { path: "nested/pixel.png" },
          options("attachment-instructions"),
        ),
      );

    expect(attachment.loadedInstructions).toEqual([path.join(nestedDirectory, "AGENTS.md")]);
    expect(
      await toModelOutput(
        tools,
        "read",
        "attachment-instructions",
        { path: "nested/pixel.png" },
        attachment,
      ),
    ).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: `Attached file from read: pixel.png (image/png, ${image.byteLength} bytes).`,
        },
        { type: "text", text: attachment.instructionsText.trim() },
        {
          type: "file",
          mediaType: "image/png",
          filename: "pixel.png",
          data: { type: "data", data: image.toString("base64") },
        },
      ],
    });
    expect(
      await toModelOutput(
        tools,
        "read",
        "attachment-instructions",
        { path: "nested/pixel.png" },
        attachment,
      ),
    ).toEqual({
      type: "error-text",
      value: "Failed to read attachment bytes for 'pixel.png'.",
    });
  });

  it("read does not access or consume attachment state for malformed callback outputs", async () => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axh8h0AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(cwd, "pixel.png"), image);
    const tools = createCodingToolset({
      cwd,
      loadInstructions: false,
      readFileDirectAttachmentSupported: true,
    });
    const read = executable(tools, "read");
    const validOutput = {
      success: true as const,
      kind: "attachment" as const,
      resolvedPath: path.join(cwd, "pixel.png"),
      fileHash: "hash",
      filename: "pixel.png",
      mimeType: "image/png" as const,
      bytes: image.byteLength,
    };
    const malformedOutputs = [
      { ...validOutput, success: "true" },
      { ...validOutput, kind: "file" },
      { ...validOutput, resolvedPath: 1 },
      { ...validOutput, fileHash: 1 },
      { ...validOutput, filename: 1 },
      { ...validOutput, mimeType: "application/octet-stream" },
      { ...validOutput, bytes: `${image.byteLength}` },
      { ...validOutput, loadedInstructions: [1] },
      { ...validOutput, instructionsText: 1 },
      { ...validOutput, unexpected: true },
    ];

    for (const [index, malformedOutput] of malformedOutputs.entries()) {
      const toolCallId = `malformed-attachment-${index}`;
      await read.execute({ path: "pixel.png" }, options(toolCallId));
      expect(
        await toModelOutput(tools, "read", toolCallId, { path: "pixel.png" }, malformedOutput),
      ).toEqual({ type: "json", value: malformedOutput });
      expect(
        await toModelOutput(tools, "read", toolCallId, { path: "pixel.png" }, validOutput),
      ).toMatchObject({
        type: "content",
        value: [
          expect.anything(),
          { type: "file", data: { type: "data", data: image.toString("base64") } },
        ],
      });
    }

    const malformedFailure = {
      success: false,
      resolvedPath: path.join(cwd, "missing.txt"),
      error: { code: "INVALID", message: "missing" },
    };
    expect(
      await toModelOutput(
        tools,
        "read",
        "malformed-failure",
        { path: "missing.txt" },
        malformedFailure,
      ),
    ).toEqual({ type: "json", value: malformedFailure });
  });

  it("read rejects mislabeled attachments and projects structured failures as errors", async () => {
    await writeFile(path.join(cwd, "fake.png"), "not an image");
    const tools = createCodingToolset({ cwd, readFileDirectAttachmentSupported: true });
    const read = executable(tools, "read");
    const mislabeled = await read.execute({ path: "fake.png" }, options("fake-image"));
    expect(mislabeled).toMatchObject({ success: false });
    expect(JSON.stringify(mislabeled)).toContain("not a supported image or PDF");

    const missing = await read.execute({ path: "missing.txt" }, options("missing-read"));
    expect(
      await toModelOutput(tools, "read", "missing-read", { path: "missing.txt" }, missing),
    ).toMatchObject({ type: "error-json", value: { success: false } });
  });

  it("projects structured search failures as errors", async () => {
    const tools = createCodingToolset({ cwd, fsBackend: "fff" });
    for (const name of ["glob", "grep", "fuzzy_search"] as const) {
      expect(
        await toModelOutput(tools, name, `${name}-failure`, {}, { error: `${name} failed` }),
      ).toEqual({ type: "error-json", value: { error: `${name} failed` } });
    }
  });

  it("read enables media explicitly and enforces the decoded per-part byte limit", async () => {
    await writeFile(path.join(cwd, "large.webp"), Buffer.alloc(17));
    const textOnly = createCodingToolset({ cwd });
    expect(textOnly.read?.description).not.toContain("supported images and PDFs");

    const read = executable(
      createCodingToolset({
        cwd,
        readFileDirectAttachmentSupported: true,
        maxInlineMediaBytesPerPart: 16,
      }),
      "read",
    );
    const result = await read.execute({ path: "large.webp" }, options("large-image"));
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain("16-byte media limit");
    expect(JSON.stringify(result)).toContain("Resize or compress the image");
  });

  it("pages scoped artifact URIs before cwd checks or instruction loading", async () => {
    await writeFile(path.join(cwd, "AGENTS.md"), "instructions that must not load\n");
    const artifacts = createToolResultArtifactStore(path.join(cwd, "read-artifacts"));
    await artifacts.init();
    const created = await artifacts.create({
      scopeId: "scope-read",
      requestId: "request-read",
      toolCallId: "producer",
      toolName: "bash",
      content: "ab😀cd\nsecond",
      ttlMs: 60_000,
      maxBytesPerScope: 1024,
    });
    if (created.status === "error") throw created.error;
    const read = executable(
      createCodingToolset({
        cwd,
        maxOutputBytes: 5,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-read",
          requestId: "request-read",
        },
      }),
      "read",
    );
    const first = await read.execute(
      {
        path: created.value.uri,
        cwd: "ignored-host:/not-a-local-path",
        start: { type: "offset", offset: 2 },
        maxCharacters: 3,
        maxLines: 10,
      },
      options("read-artifact-page"),
    );
    expect(first).toEqual({
      success: true,
      kind: "artifact",
      resolvedPath: created.value.uri,
      content: "😀c",
      startOffset: 2,
      endOffset: 4,
      totalCharacters: 12,
      nextStart: { type: "offset", offset: 4 },
      hasMore: true,
    });
    expect(JSON.stringify(first)).not.toContain("loadedInstructions");
    expect(JSON.stringify(first)).not.toContain("instructions that must not load");

    const foreign = await executable(
      createCodingToolset({
        cwd,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-foreign",
          requestId: "request-foreign",
        },
      }),
      "read",
    ).execute({ path: created.value.uri }, options("read-artifact-foreign"));
    expect(foreign).toMatchObject({
      success: false,
      resolvedPath: created.value.uri,
      error: { code: "UNKNOWN", message: TOOL_RESULT_UNAVAILABLE_MESSAGE },
    });

    const unavailable = await executable(createCodingToolset({ cwd }), "read").execute(
      { path: created.value.uri },
      options("read-artifact-no-authority"),
    );
    expect(unavailable).toMatchObject({
      success: false,
      error: { code: "UNKNOWN", message: TOOL_RESULT_UNAVAILABLE_MESSAGE },
    });
  });

  it("searches scoped artifact URIs with a bounded inline result", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "grep-artifacts"));
    await artifacts.init();
    const created = await artifacts.create({
      scopeId: "scope-grep",
      requestId: "request-grep",
      toolCallId: "producer",
      toolName: "bash",
      content: `first\n${"x".repeat(8_000)}:needle\nlast`,
      ttlMs: 60_000,
      maxBytesPerScope: 16 * 1024,
    });
    if (created.status === "error") throw created.error;
    const filesBefore = await readdir(artifacts.rootDir);
    const grep = executable(
      createCodingToolset({
        cwd,
        maxOutputBytes: 512,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-grep",
          requestId: "request-grep",
        },
      }),
      "grep",
    );

    const output = await grep.execute(
      { pattern: "needle", path: created.value.uri, fileExtensions: ["ts"] },
      options("grep-artifact"),
    );
    expect(output).toMatchObject({
      mode: "default",
      truncated: true,
      results: [{ file: created.value.uri, line: 2 }],
    });
    expect(JSON.stringify(output)).toContain("[truncated]");
    expect(JSON.stringify(output)).toContain("needle");
    expect(Buffer.byteLength(JSON.stringify(output, null, 2), "utf8")).toBeLessThanOrEqual(512);
    expect(await readdir(artifacts.rootDir)).toEqual(filesBefore);

    const foreign = await executable(
      createCodingToolset({
        cwd,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-foreign",
          requestId: "request-foreign",
        },
      }),
      "grep",
    ).execute({ pattern: "needle", path: created.value.uri }, options("grep-artifact-foreign"));
    expect(foreign).toMatchObject({ error: TOOL_RESULT_UNAVAILABLE_MESSAGE, results: [] });
    expect(await readdir(artifacts.rootDir)).toEqual(filesBefore);
  });

  it("maintains expired artifacts after an unavailable artifact read", async () => {
    const artifacts = createToolResultArtifactStore(path.join(cwd, "expired-read-artifacts"));
    expect((await artifacts.init()).status).toBe("ok");
    const created = await artifacts.create({
      scopeId: "scope-read",
      requestId: "request-read",
      toolCallId: "producer",
      toolName: "bash",
      content: "expired",
      ttlMs: -1,
      maxBytesPerScope: 1024,
    });
    if (created.status === "error") throw created.error;
    expect(await readdir(artifacts.rootDir)).toHaveLength(2);

    const result = await executable(
      createCodingToolset({
        cwd,
        artifactIntegration: {
          artifacts,
          scopeId: "scope-read",
          requestId: "request-read",
        },
      }),
      "read",
    ).execute({ path: created.value.uri }, options("read-expired-artifact"));

    expect(result).toMatchObject({
      success: false,
      error: { code: "UNKNOWN", message: TOOL_RESULT_UNAVAILABLE_MESSAGE },
    });
    expect(await readdir(artifacts.rootDir)).toEqual([]);
  });

  it("preloads workspace AGENTS.md and adds only nested instructions to read", async () => {
    const packageDirectory = path.join(cwd, "packages", "widget");
    const nestedDirectory = path.join(packageDirectory, "src");
    await mkdir(path.join(cwd, ".git"));
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "# Root\n\nRoot rules.\n");
    await writeFile(path.join(packageDirectory, "AGENTS.md"), "# Package\n\nPackage rules.\n");
    await writeFile(path.join(nestedDirectory, "AGENTS.md"), "# Nested\n\nNested rules.\n");
    await writeFile(path.join(nestedDirectory, "file.txt"), "hello\n");

    const workspace = await loadWorkspaceInstructions(packageDirectory);
    expect(workspace?.loaded).toEqual([
      path.join(packageDirectory, "AGENTS.md"),
      path.join(cwd, "AGENTS.md"),
    ]);
    expect(workspace?.text).toContain("Package rules.");
    expect(workspace?.text).toContain("Root rules.");

    const tools = createCodingToolset({
      cwd: packageDirectory,
      preloadedInstructionPaths: workspace?.loaded,
    });
    expect(tools.read?.description).toContain("AGENTS.md");
    const read = executable(tools, "read");
    const first = z
      .object({
        success: z.literal(true),
        loadedInstructions: z.array(z.string()),
        instructionsText: z.string(),
      })
      .passthrough()
      .parse(await read.execute({ path: "src/file.txt" }, options("read-instructions")));

    expect(first.loadedInstructions).toEqual([path.join(nestedDirectory, "AGENTS.md")]);
    expect(first.instructionsText).toContain("<system-reminder>");
    expect(first.instructionsText).toContain("Nested rules.");
    expect(first.instructionsText).not.toContain("Package rules.");

    const repeated = await loadReadFileInstructions({
      resolvedPath: path.join(nestedDirectory, "file.txt"),
      cwd: packageDirectory,
      preloadedInstructionPaths: workspace?.loaded,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "read",
              output: { type: "json", value: first },
            },
          ],
        },
      ],
    });
    expect(repeated).toBeNull();

    const repeatedFromContent = await loadReadFileInstructions({
      resolvedPath: path.join(nestedDirectory, "file.txt"),
      cwd: packageDirectory,
      preloadedInstructionPaths: workspace?.loaded,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "read",
              output: {
                type: "content",
                value: [{ type: "text", text: first.instructionsText }],
              },
            },
          ],
        },
      ],
    });
    expect(repeatedFromContent).toBeNull();

    const concurrentRead = executable(
      createCodingToolset({
        cwd: packageDirectory,
        preloadedInstructionPaths: workspace?.loaded,
      }),
      "read",
    );
    const concurrentOptions = options("read-concurrent-1");
    const concurrent = await Promise.all([
      concurrentRead.execute({ path: "src/file.txt" }, concurrentOptions),
      concurrentRead.execute(
        { path: "src/file.txt" },
        { ...concurrentOptions, toolCallId: "read-concurrent-2" },
      ),
    ]);
    expect(
      concurrent.filter((output) => JSON.stringify(output).includes("Nested rules.")),
    ).toHaveLength(1);
    expect(
      JSON.stringify(
        await concurrentRead.execute({ path: "src/file.txt" }, options("read-later-scope")),
      ),
    ).toContain("Nested rules.");

    const direct = await read.execute({ path: "src/AGENTS.md" }, options("read-agents"));
    expect(JSON.stringify(direct)).not.toContain("loadedInstructions");
  });

  it("does not load AGENTS.md symlinks outside the workspace or into denied paths", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "lilac-instructions-outside-"));
    try {
      const outsideInstructions = path.join(outside, "outside.md");
      await writeFile(outsideInstructions, "Outside secret rules.\n");
      await symlink(outsideInstructions, path.join(cwd, "AGENTS.md"));
      expect(await loadWorkspaceInstructions(cwd)).toBeNull();

      await rm(path.join(cwd, "AGENTS.md"));
      const protectedInstructions = path.join(cwd, "protected.txt");
      await writeFile(protectedInstructions, "Protected secret rules.\n");
      await symlink(protectedInstructions, path.join(cwd, "AGENTS.md"));
      expect(
        await loadWorkspaceInstructions(cwd, { denyPaths: [protectedInstructions] }),
      ).toBeNull();

      const nestedDirectory = path.join(cwd, "nested");
      await mkdir(nestedDirectory);
      const aliasedInstructions = path.join(nestedDirectory, "rules.md");
      await writeFile(aliasedInstructions, "Aliased rules.\n");
      await symlink(aliasedInstructions, path.join(nestedDirectory, "AGENTS.md"));
      const direct = await executable(createCodingToolset({ cwd }), "read").execute(
        { path: "nested/AGENTS.md" },
        options("read-symlinked-agents"),
      );
      expect(JSON.stringify(direct)).not.toContain("loadedInstructions");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

  it("edit requires read and uses legacy replace-snippet semantics", async () => {
    await writeFile(path.join(cwd, "edit.txt"), "before\n");
    const tools = createCodingToolset({ cwd });
    const edit = executable(tools, "edit");
    const notRead = await edit.execute(
      { path: "edit.txt", oldText: "before", newText: "after" },
      options("edit-not-read"),
    );
    expect(notRead).toMatchObject({ success: false, error: { code: "NOT_READ" } });

    await executable(tools, "read").execute({ path: "edit.txt" }, options("edit-read"));
    const edited = await edit.execute(
      { path: "edit.txt", oldText: "before", newText: "after" },
      options("edit"),
    );
    expect(edited).toMatchObject({ success: true, replacementsMade: 1 });
    expect(await readFile(path.join(cwd, "edit.txt"), "utf8")).toBe("after\n");
  });

  it("patch supports add, update, move, delete and refuses directory deletes", async () => {
    await writeFile(path.join(cwd, "old.txt"), "old\n");
    const blockedPath = path.join(cwd, "blocked.txt");
    const applyPatch = executable(
      createCodingToolset({
        cwd,
        denyPaths: [blockedPath],
        allowGuardrailBypass: true,
      }),
      "patch",
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

  it("patch rejects add, update, and delete through a symlink into a denied directory", async () => {
    const denied = path.join(cwd, "denied");
    await mkdir(denied);
    await writeFile(path.join(denied, "update.txt"), "before\n");
    await writeFile(path.join(denied, "delete.txt"), "keep\n");
    await symlink(denied, path.join(cwd, "workspace-link"), "dir");
    const applyPatch = executable(createCodingToolset({ cwd, denyPaths: [denied] }), "patch");
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
        executable(createCodingToolset({ cwd }), "patch").execute(
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

  it("a filesystem-root deny path blocks every local coding-tool path", async () => {
    await writeFile(path.join(cwd, "blocked.txt"), "blocked\n");
    const filesystemRoot = path.parse(cwd).root;
    const tools = createCodingToolset({ cwd, denyPaths: [filesystemRoot] });

    const read = await executable(tools, "read").execute(
      { path: "blocked.txt" },
      options("root-deny-read"),
    );
    expect(read).toMatchObject({ success: false, error: { code: "PERMISSION" } });

    const glob = await executable(tools, "glob").execute(
      { patterns: ["**/*"] },
      options("root-deny-glob"),
    );
    expect(glob).toMatchObject({ paths: [], error: expect.stringContaining("Access denied") });

    const grep = await executable(tools, "grep").execute(
      { pattern: "blocked" },
      options("root-deny-grep"),
    );
    expect(grep).toMatchObject({ results: [], error: expect.stringContaining("Access denied") });

    const edit = await executable(tools, "edit").execute(
      { path: "blocked.txt", oldText: "blocked", newText: "changed" },
      options("root-deny-edit"),
    );
    expect(edit).toMatchObject({ success: false, error: { code: "PERMISSION" } });

    const bash = await executable(tools, "bash").execute(
      { command: "true" },
      options("root-deny-bash"),
    );
    expect(bash).toMatchObject({ executionError: { type: "blocked" } });

    await expect(
      Promise.resolve(
        executable(tools, "patch").execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: root-denied.txt",
              "+denied",
              "*** End Patch",
            ].join("\n"),
          },
          options("root-deny-patch"),
        ),
      ),
    ).rejects.toThrow("Access denied");
    expect(await readFile(path.join(cwd, "blocked.txt"), "utf8")).toBe("blocked\n");
    expect(Bun.file(path.join(cwd, "root-denied.txt")).size).toBe(0);
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
    const tools = createCodingToolset({
      cwd,
      extraTools: {
        panicking: tool({ inputSchema: panickingSchema, execute: () => "unused" }),
      },
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
      const tools = createCodingToolset({
        cwd,
        extraTools: {
          hostile: tool({ inputSchema: hostileSchema, execute: () => "unused" }),
        },
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

  it("keeps filtered tools out of a read-only profile and its batch", async () => {
    const tools = createCodingToolset({
      cwd,
      enabledTools: ["read", "glob", "grep", "batch"],
      extraTools: {
        custom_tool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: ({ value }) => value,
        }),
      },
    });
    expect(Object.keys(tools).sort()).toEqual(["batch", "glob", "grep", "read"]);
    expect(createCodingToolset({ cwd, enabledTools: ["read"] }).batch).toBeUndefined();

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
      enabledTools: ["read", "custom_tool", "batch"],
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
        tool_calls?: {
          items?: {
            properties?: {
              tool?: { enum?: string[] };
              parameters?: unknown;
            };
          };
        };
      };
    };
    const exposedNames = schemaShape.properties?.tool_calls?.items?.properties?.tool?.enum ?? [];
    expect(exposedNames.sort()).toEqual(["glob", "grep", "read"]);
    expect(schemaShape.properties?.tool_calls?.items?.properties?.parameters).toEqual({});

    const validateBatchInput = asSchema(batchTool.inputSchema).validate;
    expect(validateBatchInput).toBeDefined();
    expect(
      await validateBatchInput?.({
        tool_calls: [{ tool: "read", parameters: "not an object" }],
      }),
    ).toMatchObject({ success: false });
    expect(await validateBatchInput?.({ tool_calls: [{ tool: "read" }] })).toEqual({
      success: true,
      value: { tool_calls: [{ tool: "read", parameters: {} }] },
    });

    const expansion = await executable(tools, "batch").execute(
      {
        tool_calls: ["bash", "edit", "patch"].map((name) => ({
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

  it("normalizes legacy child names without advertising them in batch", async () => {
    const tools = createCodingToolset({ cwd, enabledTools: ["read", "batch"] });
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
    const tools = createCodingToolset({
      cwd,
      enabledTools: ["read", "read_file", "batch"],
      extraTools: {
        read_file: tool({ inputSchema: z.object({}), execute: () => "legacy" }),
      },
    });

    const expansion = await executable(tools, "batch").execute(
      { tool_calls: [{ tool: "read_file", parameters: {} }] },
      options("exact-legacy-read-child"),
    );
    expect(isToolExpansion(expansion)).toBe(true);
    if (!isToolExpansion(expansion)) throw new Error("expected ToolExpansion");
    expect(expansion.children[0]?.toolName).toBe("read_file");
  });

  it("rejects dangerouslyAllow by default for bash, filesystem, edit, and patch", async () => {
    await writeFile(path.join(cwd, "guarded.txt"), "before\n");
    const tools = createCodingToolset({ cwd });
    const calls = [
      () =>
        executable(tools, "bash").execute(
          { command: "true", dangerouslyAllow: true },
          options("bypass-bash"),
        ),
      () =>
        executable(tools, "read").execute(
          { path: "guarded.txt", dangerouslyAllow: true },
          options("bypass-read"),
        ),
      () =>
        executable(tools, "edit").execute(
          {
            path: "guarded.txt",
            oldText: "before",
            newText: "after",
            dangerouslyAllow: true,
          },
          options("bypass-edit"),
        ),
      () =>
        executable(tools, "patch").execute(
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
