import { describe, expect, it } from "bun:test";
import { env, isRecord } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { executeBash, withLimitedBashOutput } from "../../src/tools/bash-impl";
import { bashToolWithCwd } from "../../src/tools/bash";
import {
  executeRestrictedBash,
  executeTrustedWorkflowBash,
  type TrustedWorkflowBashRuntime,
} from "../../src/tools/restricted-bash";
import { analyzeBashCommand } from "../../src/tools/bash-safety";
import { resolveRestrictedSessionTmpDir } from "../../src/shared/attachment-utils";
import {
  createToolResultArtifactStore,
  type ToolResultArtifactStore,
} from "../../src/artifacts/tool-result-artifact-store";
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";

const STDIN_PROBE_COMMAND =
  "if cat >/dev/null 2>&1; then echo stdin_read_ok; else echo stdin_read_err; exit 7; fi";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function installMockFetch(handler: MockFetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function trustedWorkflowRuntime(output = "bun 1.3.14\ngit version 2.43.0\n"): {
  runtime: TrustedWorkflowBashRuntime;
  commands: string[][];
  stoppedUnits: string[];
} {
  const commands: string[][] = [];
  const stoppedUnits: string[] = [];
  return {
    commands,
    stoppedUnits,
    runtime: {
      spawn(command) {
        commands.push([...command]);
        return {
          stdout: textStream(output),
          stderr: textStream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
      stopUnit: async (unit) => {
        stoppedUnits.push(unit);
      },
      createUnitName: () => "lilac-workflow-bash-test",
    },
  };
}

function workflowPolicy(root: string, safetyMode: "trusted" | "restricted"): WorkflowRequestPolicy {
  return {
    runId: "run-1",
    operationId: "operation-1",
    dispatchEpoch: "dispatch-epoch-0001",
    profile: "general",
    model: "inherit",
    reasoning: "provider-default",
    tools: ["bash"],
    executables: "trusted-container",
    safetyMode,
    editing: true,
    isolation: "shared",
    delegation: false,
    level2Callables: [],
    surfaceOriginOperations: [],
    canonicalWorkspaceRoot: root,
    canonicalAuthorityRoot: root,
    canonicalRequestedCwd: root,
    canonicalCwd: root,
    canonicalProjectId: "project-1",
    originSessionId: "channel-1",
    originClient: "discord",
    originUserId: "user-1",
    revisionId: "revision-1",
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    capabilitySha256: "c".repeat(64),
    argsSha256: "d".repeat(64),
    operationInputSha256: "e".repeat(64),
  };
}

async function executeTool(tool: unknown, input: unknown, context: unknown): Promise<unknown> {
  if (!isRecord(tool) || typeof tool["execute"] !== "function") {
    throw new Error("test tool is not executable");
  }
  return await Reflect.apply(tool["execute"], tool, [
    input,
    { context, toolCallId: "bash-tool-call", messages: [] },
  ]);
}

describe("executeBash", () => {
  it("allocates UTF-8 head-tail preview space to both streams", () => {
    const output = withLimitedBashOutput(
      {
        stdout: `OUT_START${"😀".repeat(100)}OUT_END`,
        stderr: `ERR_START${"界".repeat(100)}ERR_END`,
        exitCode: 0,
      },
      { maxOutputBytes: 160, truncated: true },
    );
    expect(output.stdout).toContain("OUT_START");
    expect(output.stdout).toContain("OUT_END");
    expect(output.stderr).toContain("ERR_START");
    expect(output.stderr).toContain("ERR_END");
    expect(Buffer.byteLength(output.stdout + output.stderr, "utf8")).toBeLessThanOrEqual(160);
    expect(output.executionError).toBeUndefined();
    expect(output.truncation?.completeOutputRetained).toBe(false);
  });

  it("executes a command and returns output", async () => {
    const res = await executeBash({ command: "echo hello" });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toContain("hello");
  });

  it("executes the smoke loop with Bash parameter expansion", async () => {
    const res = await executeBash({
      command: `for spec in "fetch tools one" "read tools two"; do
  label="\${spec%% tools*}"
  invocation="\${spec#* tools }"
  printf '%s: %s\\n' "$label" "\${invocation:-missing}"
done`,
    });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toBe("fetch: one\nread: two\n");
  });

  it("inherits PATH from the current process", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = `/__lilac_path_test__:${originalPath ?? ""}`;

    try {
      const res = await executeBash({ command: "echo $PATH" });

      expect(res.exitCode).toBe(0);
      expect(res.executionError).toBeUndefined();
      expect(res.stdout).toContain("/__lilac_path_test__:");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("forces color off for bash child env", async () => {
    const originalForceColor = process.env.FORCE_COLOR;
    const originalNoColor = process.env.NO_COLOR;

    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;

    try {
      const res = await executeBash({
        command:
          'if [ -n "${FORCE_COLOR+x}" ]; then echo "$FORCE_COLOR"; else echo "__unset__"; fi; echo "${NO_COLOR-}"',
      });

      expect(res.exitCode).toBe(0);
      expect(res.executionError).toBeUndefined();

      const lines = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      expect(lines[0]).toBe("__unset__");
      expect(lines[1]).toBe("1");
    } finally {
      if (originalForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = originalForceColor;
      }

      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  it("strips ansi escape sequences from output", async () => {
    const res = await executeBash({
      command:
        "printf '\\033[31mred\\033[0m\\n' && printf '\\033]0;title\\007osc\\n' && printf '\\033[33mwarn\\033[0m\\n' 1>&2",
    });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toContain("red");
    expect(res.stdout).toContain("osc");
    expect(res.stdout).not.toContain("title");
    expect(res.stderr).toContain("warn");
    expect(res.stdout).not.toContain("\u001b[");
    expect(res.stdout).not.toContain("\u001b]");
    expect(res.stderr).not.toContain("\u001b[");
  });

  it("injects git + gnupg env for persistence", async () => {
    const res = await executeBash({
      command: "echo $GIT_CONFIG_GLOBAL && echo $GNUPGHOME",
    });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();

    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toBe(path.join(env.dataDir, ".gitconfig"));
    expect(lines[1]).toBe(path.join(env.dataDir, "secret", "gnupg"));
  });

  it("does not set executionError for command failures", async () => {
    const res = await executeBash({ command: "exit 2" });

    expect(res.exitCode).toBe(2);
    expect(res.executionError).toBeUndefined();
  });

  it("returns a timeout executionError when exceeded", async () => {
    const res = await executeBash({ command: "sleep 10", timeoutMs: 50 });

    expect(res.executionError).toBeDefined();
    expect(res.executionError?.type).toBe("timeout");
    if (res.executionError?.type === "timeout") {
      expect(res.executionError.timeoutMs).toBe(50);
      expect(res.executionError.signal.length).toBeGreaterThan(0);
    }
    expect(res.exitCode).not.toBe(0);
  });

  it("returns an exception executionError when cwd is invalid", async () => {
    const res = await executeBash({
      command: "echo hi",
      cwd: "/this/path/definitely/does/not/exist",
    });

    expect(res.exitCode).toBe(-1);
    expect(res.executionError).toBeDefined();
    expect(res.executionError?.type).toBe("exception");
    if (res.executionError?.type === "exception") {
      expect(res.executionError.phase).toBe("spawn");
      expect(res.executionError.message.length).toBeGreaterThan(0);
    }
  });

  it("defaults to strict stdin mode that fails stdin reads", async () => {
    const res = await executeBash({ command: STDIN_PROBE_COMMAND });

    expect(res.exitCode).toBe(7);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toContain("stdin_read_err");
    expect(res.stdout).not.toContain("stdin_read_ok");
  });

  it("supports stdinMode=eof as a compatibility fallback", async () => {
    const res = await executeBash({ command: STDIN_PROBE_COMMAND, stdinMode: "eof" });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toContain("stdin_read_ok");
  });

  it("stores large output as an artifact without changing execution success", async () => {
    const artifactDir = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-bash-artifact-"),
    );
    const artifacts = createToolResultArtifactStore(path.join(artifactDir, "tool-results"));
    await artifacts.init();
    const requestId = "bash-trunc-test-request";
    const toolCallId = "bash-trunc-test-tool";
    let persistenceTempEntries: string[] = [];
    const observedArtifacts: ToolResultArtifactStore = {
      ...artifacts,
      async createFromStream(params) {
        persistenceTempEntries = (await fs.readdir(await fs.realpath("/tmp"))).filter((entry) =>
          entry.startsWith(`${requestId}-${toolCallId}-`),
        );
        return artifacts.createFromStream(params);
      },
    };

    try {
      const res = await executeBash(
        {
          command:
            "printf START; head -c 210000 /dev/zero | tr '\\0' 'a'; printf ' API_TOKEN=secret-value END'",
        },
        {
          context: {
            requestId,
            sessionId: "bash-trunc-test-session",
            requestClient: "test",
          },
          toolCallId,
          artifacts: observedArtifacts,
          outputConfig: {
            maxPreviewBytes: 40 * 1024,
            artifactTtlMs: 60_000,
            artifactMaxBytesPerSession: 1024 * 1024,
          },
        },
      );

      expect(res.exitCode).toBe(0);
      expect(res.executionError).toBeUndefined();
      expect(res.stdout).toContain("START");
      expect(res.stdout).toContain("END");
      expect(Buffer.byteLength(res.stdout + res.stderr, "utf8")).toBeLessThanOrEqual(40 * 1024);
      expect(res.truncation?.completeOutputRetained).toBe(true);
      expect(res.truncation?.originalStdoutBytes).toBe(210_030);
      expect(res.truncation?.originalStderrBytes).toBe(0);
      expect(res.truncation?.message).toContain("Use read_file with this URI");
      expect(persistenceTempEntries).toHaveLength(1);
      expect(persistenceTempEntries[0]).toEndWith(".stdout.part");
      expect(persistenceTempEntries.some((entry) => entry.endsWith(".sanitized"))).toBe(false);
      const uri = res.truncation?.artifactUri;
      if (!uri) throw new Error("expected truncated output artifact URI");
      const artifact = await artifacts.read(uri, "bash-trunc-test-session");
      expect(artifact.ok).toBe(true);
      if (artifact.ok) {
        expect(artifact.content).toContain("<bash_tool_full_output>");
        expect(artifact.content).toContain("--- stdout ---");
        expect(artifact.content).toContain("--- stderr ---");
        expect(artifact.content).toContain("API_TOKEN=<redacted>");
        expect(artifact.content).not.toContain("secret-value");
        expect(artifact.content).toContain("END");
      }
    } finally {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not assemble a discarded full-output spill without an artifact store", async () => {
    const requestId = `bash-no-artifact-${Date.now()}`;
    const toolCallId = "missing-store";
    const res = await executeBash(
      { command: "head -c 100000 /dev/zero | tr '\\0' 'z'" },
      {
        context: { requestId, sessionId: "session", requestClient: "test" },
        toolCallId,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(res.truncation?.completeOutputRetained).toBe(false);
    expect(res.truncation?.message).toContain("could not be retained");
    const tmpEntries = await fs.readdir(await fs.realpath("/tmp"));
    expect(tmpEntries.some((entry) => entry.startsWith(`${requestId}-${toolCallId}-`))).toBe(false);
  });
});

describe("executeRestrictedBash", () => {
  it("rejects cwd outside the workspace instead of silently substituting it", async () => {
    const temp = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "lilac-restricted-cwd-"));
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    try {
      const result = await executeRestrictedBash(
        { command: "pwd", cwd: process.cwd() },
        { workspaceRoot: workspace },
      );
      expect(result.executionError).toMatchObject({
        type: "blocked",
        reason: "restricted_bash_cwd",
      });
      expect(result.stderr).toContain("outside the approved workspace");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("sanitizes previews and encrypted artifacts before returning them", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-sanitize-workspace-"),
    );
    const artifactRoot = path.join(workspace, ".artifacts");
    const store = createToolResultArtifactStore(artifactRoot);
    await store.init();

    try {
      const result = await executeRestrictedBash(
        {
          command:
            "printf '\\033[31mAPI_TOKEN=abcdefghijklmnopqrstuvwxyz1234567890\\033[0m repeated repeated'",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-sanitize-request",
            sessionId: "restricted-sanitize-session",
            requestClient: "test",
          },
          toolCallId: "restricted-sanitize-call",
          artifacts: store,
          outputConfig: {
            maxPreviewBytes: 16,
            artifactTtlMs: 60_000,
            artifactMaxBytesPerSession: 1024 * 1024,
          },
        },
      );

      expect(result.stdout).not.toContain("\u001b");
      expect(result.stdout).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
      expect(result.truncation?.artifactUri).toStartWith("tool-result://");
      const stored = await store.read(
        result.truncation?.artifactUri ?? "",
        "restricted-sanitize-session",
      );
      expect(stored.ok).toBe(true);
      if (stored.ok) {
        expect(stored.content).not.toContain("\u001b");
        expect(stored.content).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
        expect(stored.content).toContain("<redacted>");
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses an overlay workspace and persistent per-session /tmp", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-workspace-"),
    );
    const sessionId = "restricted-bash-test-session";
    const sessionTmp = resolveRestrictedSessionTmpDir(sessionId);

    try {
      await fs.rm(sessionTmp, { recursive: true, force: true });
      await fs.writeFile(path.join(workspace, "visible.txt"), "original\n", "utf8");
      await fs.writeFile(path.join(workspace, ".env"), "SECRET=1\n", "utf8");

      const first = await executeRestrictedBash(
        {
          command:
            "cat visible.txt && echo changed > visible.txt && cat visible.txt && echo keep > /tmp/state.txt",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-bash-test-req-1",
            sessionId,
            requestClient: "discord",
          },
        },
      );

      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("original");
      expect(first.stdout).toContain("changed");
      expect(await fs.readFile(path.join(workspace, "visible.txt"), "utf8")).toBe("original\n");

      const second = await executeRestrictedBash(
        {
          command: "cat visible.txt && cat /tmp/state.txt && cat .env",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-bash-test-req-2",
            sessionId,
            requestClient: "discord",
          },
        },
      );

      expect(second.exitCode).not.toBe(0);
      expect(second.stdout).toContain("original");
      expect(second.stdout).toContain("keep");
      expect(second.stdout).not.toContain("SECRET=1");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(sessionTmp, { recursive: true, force: true });
    }
  });

  it("blocks every restricted workspace write primitive from protected and escaped paths", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-protected-writes-"),
    );
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    const sessionId = "restricted-protected-writes";
    await fs.mkdir(path.join(workspace, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".env.local"));
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=original\n");
    await fs.writeFile(path.join(workspace, ".envrc"), "export SECRET=original\n");
    await fs.writeFile(path.join(workspace, ".env.local", "token"), "DESCENDANT=secret\n");
    await fs.writeFile(path.join(workspace, "core-config.yaml"), "safe: true\n");
    await fs.writeFile(path.join(workspace, ".git", "config"), "[safe]\n");
    await fs.writeFile(path.join(workspace, "source.txt"), "source\n");
    await fs.link(path.join(workspace, ".env"), path.join(workspace, "env-alias.txt"));
    await fs.link(
      path.join(workspace, ".git", "config"),
      path.join(workspace, "git-config-alias.txt"),
    );
    await fs.mkdir(path.join(workspace, "nested", ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, "nested", ".env"), "NESTED=secret\n");
    await fs.writeFile(path.join(workspace, "nested", ".git", "config"), "[nested]\n");
    await fs.writeFile(outside, "outside\n");

    const commands = [
      "printf hacked > .env",
      "printf hacked > .envrc",
      "printf hacked > .env.local/token",
      "printf hacked > env-alias.txt",
      "printf hacked >> git-config-alias.txt",
      "rm env-alias.txt",
      "printf hacked >> core-config.yaml",
      "rm .git/config",
      "mv source.txt .git/hooks/pre-commit",
      "cp source.txt .env.production",
      "mkdir .git/hooks/new-hook",
      "ln source.txt .git/config",
      "ln -s source.txt .env.local",
      "printf escaped > ../outside.txt",
      "rm -rf nested",
      "mv nested moved-nested",
      "cp -r nested copied-nested",
    ];
    try {
      const hardLinkRead = await executeRestrictedBash(
        { command: "cat env-alias.txt; grep safe git-config-alias.txt", cwd: workspace },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-protected-hard-link-read",
            sessionId,
            requestClient: "test",
          },
        },
      );
      expect(hardLinkRead.exitCode).not.toBe(0);
      expect(hardLinkRead.stdout).not.toContain("SECRET=original");
      expect(hardLinkRead.stdout).not.toContain("[safe]");
      const envDescendantRead = await executeRestrictedBash(
        { command: "cat .env.local/token", cwd: workspace },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-env-descendant-read",
            sessionId,
            requestClient: "test",
          },
        },
      );
      expect(envDescendantRead.exitCode).not.toBe(0);
      expect(envDescendantRead.stdout).not.toContain("DESCENDANT=secret");

      for (const [index, command] of commands.entries()) {
        const result = await executeRestrictedBash(
          { command, cwd: workspace },
          {
            workspaceRoot: workspace,
            context: {
              requestId: `restricted-protected-write-${index}`,
              sessionId,
              requestClient: "test",
              workspaceWritable: true,
            },
          },
        );
        if (result.exitCode === 0 && command !== "rm -rf nested") {
          throw new Error(`Protected write unexpectedly succeeded: ${command}`);
        }
      }
      expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=original\n");
      expect(await fs.readFile(path.join(workspace, ".envrc"), "utf8")).toBe(
        "export SECRET=original\n",
      );
      expect(await fs.readFile(path.join(workspace, ".env.local", "token"), "utf8")).toBe(
        "DESCENDANT=secret\n",
      );
      expect(await fs.readFile(path.join(workspace, "core-config.yaml"), "utf8")).toBe(
        "safe: true\n",
      );
      expect(await fs.readFile(path.join(workspace, ".git", "config"), "utf8")).toBe("[safe]\n");
      expect(await fs.readFile(path.join(workspace, "env-alias.txt"), "utf8")).toBe(
        "SECRET=original\n",
      );
      expect(await fs.readFile(path.join(workspace, "git-config-alias.txt"), "utf8")).toBe(
        "[safe]\n",
      );
      expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("source\n");
      expect(await fs.readFile(path.join(workspace, "nested", ".env"), "utf8")).toBe(
        "NESTED=secret\n",
      );
      expect(await fs.readFile(path.join(workspace, "nested", ".git", "config"), "utf8")).toBe(
        "[nested]\n",
      );
      expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(resolveRestrictedSessionTmpDir(sessionId), { recursive: true, force: true });
    }
  });

  it("does not share cached shell state across sessions with the same request ID", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-isolation-workspace-"),
    );
    const requestId = "restricted-shared-request";
    const firstSession = "restricted-isolation-a";
    const secondSession = "restricted-isolation-b";

    try {
      const first = await executeRestrictedBash(
        { command: "printf private > /tmp/private.txt", cwd: workspace },
        {
          workspaceRoot: workspace,
          context: { requestId, sessionId: firstSession, requestClient: "test" },
        },
      );
      const second = await executeRestrictedBash(
        { command: "cat /tmp/private.txt", cwd: workspace },
        {
          workspaceRoot: workspace,
          context: { requestId, sessionId: secondSession, requestClient: "test" },
        },
      );

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).not.toBe(0);
      expect(second.stdout).not.toContain("private");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(resolveRestrictedSessionTmpDir(firstSession), { recursive: true, force: true });
      await fs.rm(resolveRestrictedSessionTmpDir(secondSession), { recursive: true, force: true });
    }
  });

  it("passes variadic tool positionals through the nested tools command", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({ primaryPositional: { field: "paths", variadic: true } });
      }
      if (url.endsWith("/call")) {
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ isError: false, output: { ok: true } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await executeRestrictedBash(
        {
          command: "tools attachment.add_files a.png b.png",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-variadic-test-req",
            sessionId: "restricted-tools-variadic-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(capturedCallInput).toEqual({
        callableId: "attachment.add_files",
        input: { paths: ["a.png", "b.png"] },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows mixed flags with variadic positionals in the nested tools command", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({ primaryPositional: { field: "paths", variadic: true } });
      }
      if (url.endsWith("/call")) {
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ isError: false, output: { ok: true } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await executeRestrictedBash(
        {
          command:
            'tools attachment.add_files a.png b.png --filenames:json=\'["renamed-a.png","renamed-b.png"]\'',
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-mixed-test-req",
            sessionId: "restricted-tools-mixed-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(capturedCallInput).toEqual({
        callableId: "attachment.add_files",
        input: {
          paths: ["a.png", "b.png"],
          filenames: ["renamed-a.png", "renamed-b.png"],
        },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps bare nested tool flags boolean without consuming following positionals", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({ primaryPositional: { field: "paths", variadic: true } });
      }
      if (url.endsWith("/call")) {
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ isError: false, output: { ok: true } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await executeRestrictedBash(
        {
          command: "tools attachment.add_files --dry-run a.png",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-bare-flag-test-req",
            sessionId: "restricted-tools-bare-flag-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(capturedCallInput).toEqual({
        callableId: "attachment.add_files",
        input: { dryRun: true, paths: ["a.png"] },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("explains that nested tools flags require equals syntax for values", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-tools-workspace-"),
    );
    let calledTool = false;

    const restoreFetch = installMockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/help/surface.messages.list")) {
        return Response.json({});
      }
      if (url.endsWith("/call")) {
        calledTool = true;
        return Response.json({ isError: false, output: { ok: true } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await executeRestrictedBash(
        {
          command: 'tools surface.messages.list --session-id "#meeting-room"',
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-equals-hint-test-req",
            sessionId: "restricted-tools-equals-hint-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Bare --session-id was parsed as boolean true; if you meant to pass a value, use --session-id=<value>.",
      );
      expect(calledTool).toBe(false);
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps scalar tool positionals limited to one argument in the nested tools command", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-tools-workspace-"),
    );
    let calledTool = false;

    const restoreFetch = installMockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/help/fetch")) {
        return Response.json({ primaryPositional: { field: "url" } });
      }
      if (url.endsWith("/call")) {
        calledTool = true;
        return Response.json({ isError: false, output: { ok: true } });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const result = await executeRestrictedBash(
        {
          command: "tools fetch https://example.com extra",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-scalar-test-req",
            sessionId: "restricted-tools-scalar-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("accepts at most one positional argument");
      expect(calledTool).toBe(false);
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("executeTrustedWorkflowBash", () => {
  const integrationIt = process.env.LILAC_WORKFLOW_BASH_INTEGRATION === "1" ? it : it.skip;

  integrationIt("enforces the live executable sandbox boundary", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-live-"),
    );
    const outside = path.join(process.cwd(), `.workflow-outside-${crypto.randomUUID()}.txt`);
    const inheritedSecret = process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET;
    process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET = "inherited-process-secret";
    try {
      await fs.writeFile(path.join(root, ".env"), "PROTECTED=workspace-secret\n");
      await fs.mkdir(path.join(root, ".config", "gh"), { recursive: true });
      await fs.mkdir(path.join(root, "secrets"), { recursive: true });
      await fs.writeFile(path.join(root, ".config", "gh", "hosts.yml"), "oauth=credential\n");
      await fs.writeFile(path.join(root, "secrets", "token"), "directory-secret\n");
      await fs.writeFile(path.join(root, "core-config.yaml"), "apiKey: core-secret\n");
      await fs.writeFile(path.join(root, "inaccessible.txt"), "inaccessible-secret\n", {
        mode: 0o000,
      });
      await fs.writeFile(outside, "outside-secret\n");
      await fs.writeFile(
        path.join(root, "probe.py"),
        [
          "import os",
          "from pathlib import Path",
          `protected = Path(${JSON.stringify(path.join(root, ".env"))})`,
          `outside = Path(${JSON.stringify(outside)})`,
          "protected_paths = {",
          `    "env": protected,`,
          `    "credential": Path(${JSON.stringify(path.join(root, ".config", "gh", "hosts.yml"))}),`,
          `    "vault": Path(${JSON.stringify(path.join(root, "secrets", "token"))}),`,
          `    "core_config": Path(${JSON.stringify(path.join(root, "core-config.yaml"))}),`,
          `    "inaccessible": Path(${JSON.stringify(path.join(root, "inaccessible.txt"))}),`,
          "}",
          "for name, protected_path in protected_paths.items():",
          "    try:",
          "        content = protected_path.read_text()",
          '        print(name + ("_masked=empty" if content == "" else "_leak=" + content))',
          "    except OSError:",
          '        print(name + "_read=denied")',
          'print("outside_exists=" + str(outside.exists()))',
          'print("etc_exists=" + str(Path("/etc/passwd").exists()))',
          'print("inherited=" + os.environ.get("LILAC_TRUSTED_WORKFLOW_TEST_SECRET", "missing"))',
          'Path("generated.txt").write_text("generated\\n")',
          "try:",
          '    protected.write_text("changed\\n")',
          '    print("protected_write=allowed")',
          "except OSError:",
          '    print("protected_write=denied")',
          "try:",
          '    outside.write_text("changed\\n")',
          '    print("outside_write=allowed")',
          "except OSError:",
          '    print("outside_write=denied")',
          "",
        ].join("\n"),
      );

      const result = await executeTrustedWorkflowBash(
        {
          command: [
            "git_arg=--version",
            'version="$(node --version)"',
            'git "$git_arg"',
            'printf "node=%s\\n" "$version"',
            "cat <<'EOF'",
            "heredoc=ok",
            "EOF",
            "python3 -c 'exec(open(\"probe.py\").read())'",
          ].join("\n"),
          cwd: root,
          dangerouslyAllow: true,
        },
        { workspaceRoot: root, workspaceWritable: true },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain("git version");
      expect(result.stdout).toContain("node=v");
      expect(result.stdout).toContain("heredoc=ok");
      expect(result.stdout).toContain("env_masked=empty");
      expect(result.stdout).toContain("credential_read=denied");
      expect(result.stdout).toContain("vault_read=denied");
      expect(result.stdout).toContain("core_config_masked=empty");
      expect(result.stdout).toContain("inaccessible_read=denied");
      expect(result.stdout).toContain("outside_exists=False");
      expect(result.stdout).toContain("etc_exists=False");
      expect(result.stdout).toContain("inherited=missing");
      expect(result.stdout).toContain("protected_write=denied");
      expect(result.stdout).toContain("outside_write=denied");
      expect(result.stdout).not.toContain("workspace-secret");
      expect(result.stdout).not.toContain("oauth=credential");
      expect(result.stdout).not.toContain("directory-secret");
      expect(result.stdout).not.toContain("core-secret");
      expect(result.stdout).not.toContain("inaccessible-secret");
      expect(result.stdout).not.toContain("outside-secret");
      expect(result.stdout).not.toContain("inherited-process-secret");
      expect(await fs.readFile(path.join(root, "generated.txt"), "utf8")).toBe("generated\n");
      expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(
        "PROTECTED=workspace-secret\n",
      );
      expect(await fs.readFile(outside, "utf8")).toBe("outside-secret\n");
    } finally {
      if (inheritedSecret === undefined) delete process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET;
      else process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET = inheritedSecret;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { force: true });
    }
  });

  integrationIt(
    "runs Bun tests and local Git status/diff in this real workspace",
    async () => {
      const workspaceRoot = path.resolve(import.meta.dir, "../../../..");
      const coreCwd = path.join(workspaceRoot, "apps", "core");
      const policy = {
        ...workflowPolicy(workspaceRoot, "trusted"),
        editing: false,
        canonicalRequestedCwd: coreCwd,
        canonicalCwd: coreCwd,
      };
      const bash = bashToolWithCwd(coreCwd, { workflowPolicy: policy }).bash;
      const rawResult = await executeTool(
        bash,
        {
          command: [
            "set -e",
            'bun_version="$(bun --version)"',
            'git_action="${GIT_ACTION:-status}"',
            'git "$git_action" --short --untracked-files=no >/tmp/workflow-git-status.txt',
            "git diff --stat -- src/tools/bash.ts >/tmp/workflow-git-diff.txt",
            'test -z "$(git config --local --list)"',
            'printf "git_config=masked\\n"',
            'printf "bun=%s status_lines=%s diff_lines=%s\\n" "$bun_version" "$(wc -l </tmp/workflow-git-status.txt)" "$(wc -l </tmp/workflow-git-diff.txt)"',
            "cat <<'EOF'",
            "normal-heredoc=ok",
            "EOF",
            "bun test tests/workflow/workflow-level1-boundary.test.ts",
          ].join("\n"),
        },
        {
          requestId: "trusted-real-workspace-request",
          sessionId: "trusted-real-workspace-session",
          requestClient: "unknown",
          safetyMode: "trusted",
        },
      );
      if (!isRecord(rawResult)) throw new Error("trusted real-workspace result is malformed");
      const stdout = typeof rawResult["stdout"] === "string" ? rawResult["stdout"] : "";
      const stderr = typeof rawResult["stderr"] === "string" ? rawResult["stderr"] : "";

      expect(rawResult).toMatchObject({ exitCode: 0 });
      expect(stdout).toContain("bun=");
      expect(stdout).toContain("status_lines=");
      expect(stdout).toContain("diff_lines=");
      expect(stdout).toContain("git_config=masked");
      expect(stdout).toContain("normal-heredoc=ok");
      expect(`${stdout}\n${stderr}`).toContain("3 pass");
    },
    30_000,
  );

  integrationIt("rejects an outside secret hardlinked under node_modules", async () => {
    const temp = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-live-hardlink-"),
    );
    const root = path.join(temp, "workspace");
    const cacheRoot = path.join(temp, ".bun", "install", "cache");
    const outsideSecret = path.join(temp, "outside-secret.txt");
    await fs.mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(outsideSecret, "outside-hardlink-secret\n");
    await fs.link(outsideSecret, path.join(root, "node_modules", "fixture", "index.js"));
    try {
      const result = await executeTrustedWorkflowBash(
        { command: "cat node_modules/fixture/index.js" },
        { workspaceRoot: root, workspaceWritable: false, bunCacheRoot: cacheRoot },
      );
      expect(result.executionError).toMatchObject({ type: "blocked" });
      expect(result.stderr).toContain("no authorized Bun cache source");
      expect(result.stdout).not.toContain("outside-hardlink-secret");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  integrationIt("verifies live cancellation reaches a stopped unit", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-live-cancel-"),
    );
    const controller = new AbortController();
    try {
      const resultPromise = executeTrustedWorkflowBash(
        { command: "sleep 60" },
        { workspaceRoot: root, workspaceWritable: false, abortSignal: controller.signal },
      );
      await Bun.sleep(100);
      controller.abort();
      const result = await resultPromise;
      expect(result.executionError).toMatchObject({ type: "aborted" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs installed executables in a clear-env OS sandbox with only the approved root", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-bash-"),
    );
    const outside = path.join(path.dirname(root), `outside-${crypto.randomUUID()}.txt`);
    const fake = trustedWorkflowRuntime();
    const inheritedSecret = process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET;
    process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET = "must-not-enter-sandbox";
    try {
      await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
      await fs.mkdir(path.join(root, ".config", "gh"), { recursive: true });
      await fs.mkdir(path.join(root, "nested", ".ssh"), { recursive: true });
      await fs.writeFile(path.join(root, ".env"), "TOKEN=workspace-secret\n");
      await fs.writeFile(path.join(root, ".git", "config"), "credential=secret\n");
      await fs.writeFile(path.join(root, ".config", "gh", "hosts.yml"), "oauth_token: secret\n");
      await fs.writeFile(path.join(root, "nested", ".ssh", "id_ed25519"), "private\n");
      await fs.writeFile(path.join(root, "visible.txt"), "visible\n");
      await fs.writeFile(outside, "outside-secret\n");

      const result = await executeTrustedWorkflowBash(
        { command: "bun --version && git --version", cwd: root },
        {
          workspaceRoot: root,
          workspaceWritable: true,
          context: {
            requestId: "trusted-workflow-request",
            sessionId: "trusted-workflow-session",
            requestClient: "unknown",
          },
          runtime: fake.runtime,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.executionError).toBeUndefined();
      expect(result.stdout).toContain("bun 1.3.14");
      expect(result.stdout).toContain("git version 2.43.0");
      expect(fake.commands).toHaveLength(1);
      const sandboxCommand = fake.commands[0]!;
      expect(sandboxCommand.slice(0, 2)).toEqual(["/usr/bin/systemd-run", "--user"]);
      expect(sandboxCommand).toContain("/usr/bin/bwrap");
      expect(sandboxCommand).toContain("--unshare-all");
      expect(sandboxCommand).toContain("--clearenv");
      expect(sandboxCommand).toContain("MemoryMax=2147483648");
      expect(sandboxCommand).toContain("TasksMax=256");
      expect(sandboxCommand).toContain("/usr");
      expect(sandboxCommand).not.toContain("/opt");
      expect(sandboxCommand).toContain(process.execPath);
      expect(sandboxCommand).toContain("/usr/bin/bash");
      expect(sandboxCommand).toContain(root);
      expect(sandboxCommand).toContain(path.join(root, ".env"));
      expect(sandboxCommand).toContain(path.join(root, ".git", "config"));
      expect(sandboxCommand).toContain(path.join(root, ".git", "hooks"));
      expect(sandboxCommand).toContain(path.join(root, ".config", "gh"));
      expect(sandboxCommand).toContain(path.join(root, "nested", ".ssh"));
      expect(sandboxCommand).not.toContain(outside);
      expect(sandboxCommand).not.toContain("must-not-enter-sandbox");
      expect(sandboxCommand).not.toContain("workspace-secret");
      expect(sandboxCommand).not.toContain("outside-secret");
      const writableMount = sandboxCommand.findIndex(
        (value, index) => value === "--bind" && sandboxCommand[index + 1] === root,
      );
      expect(sandboxCommand.slice(writableMount, writableMount + 3)).toEqual([
        "--bind",
        root,
        root,
      ]);

      const readOnlyFake = trustedWorkflowRuntime("read-only\n");
      await executeTrustedWorkflowBash(
        { command: "bun --version", cwd: root },
        { workspaceRoot: root, workspaceWritable: false, runtime: readOnlyFake.runtime },
      );
      const readOnlyCommand = readOnlyFake.commands[0]!;
      const readOnlyMount = readOnlyCommand.findIndex(
        (value, index) => value === "--ro-bind" && readOnlyCommand[index + 1] === root,
      );
      expect(readOnlyCommand.slice(readOnlyMount, readOnlyMount + 3)).toEqual([
        "--ro-bind",
        root,
        root,
      ]);
    } finally {
      if (inheritedSecret === undefined) delete process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET;
      else process.env.LILAC_TRUSTED_WORKFLOW_TEST_SECRET = inheritedSecret;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { force: true });
    }
  });

  it("authorizes canonical subdirectory cwd and rejects escapes and symlinks", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-cwd-"),
    );
    const fake = trustedWorkflowRuntime();
    try {
      const nested = path.join(root, "packages", "core");
      await fs.mkdir(nested, { recursive: true });
      await fs.symlink(nested, path.join(root, "linked-core"));
      const allowed = await executeTrustedWorkflowBash(
        { command: "pwd", cwd: "packages/core" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      const escaped = await executeTrustedWorkflowBash(
        { command: "pwd", cwd: path.dirname(root) },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      const ssh = await executeTrustedWorkflowBash(
        { command: "pwd", cwd: "host:/tmp" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      const symlink = await executeTrustedWorkflowBash(
        { command: "pwd", cwd: path.join(root, "linked-core") },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );

      expect(allowed.executionError).toBeUndefined();
      expect(fake.commands[0]).toContain(nested);
      expect(escaped.executionError).toMatchObject({ type: "blocked" });
      expect(escaped.stderr).toContain("outside the approved root");
      expect(ssh.executionError).toMatchObject({ type: "blocked" });
      expect(ssh.stderr).toContain("does not allow SSH");
      expect(symlink.executionError).toMatchObject({ type: "blocked" });
      expect(symlink.stderr).toContain("canonical real directory");
      expect(fake.commands).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies abort and timeout while recursive authorization is running", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-authorization-cancel-"),
    );
    const fake = trustedWorkflowRuntime();
    await Promise.all(
      Array.from({ length: 1_024 }, async (_value, index) => {
        await fs.writeFile(path.join(root, `file-${index}.txt`), "value\n");
      }),
    );
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 0);
      const aborted = await executeTrustedWorkflowBash(
        { command: "true" },
        {
          workspaceRoot: root,
          workspaceWritable: false,
          abortSignal: controller.signal,
          runtime: fake.runtime,
        },
      );
      const timedOut = await executeTrustedWorkflowBash(
        { command: "true", timeoutMs: 1 },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );

      expect(aborted.executionError).toMatchObject({ type: "aborted" });
      expect(timedOut.executionError).toMatchObject({ type: "timeout", timeoutMs: 1 });
      expect(fake.commands).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps dangerouslyAllow false and true mount-neutral", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-override-"),
    );
    const fake = trustedWorkflowRuntime();
    try {
      const disabled = await executeTrustedWorkflowBash(
        { command: "printf ok", dangerouslyAllow: false },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      const enabled = await executeTrustedWorkflowBash(
        { command: "printf ok", dangerouslyAllow: true },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );

      expect(disabled.executionError).toBeUndefined();
      expect(enabled.executionError).toBeUndefined();
      expect(fake.commands).toHaveLength(2);
      const normalizeUnit = (command: readonly string[]) =>
        command.map((value) =>
          value.startsWith("--unit=lilac-workflow-bash-") ? "--unit=<unit>" : value,
        );
      expect(normalizeUnit(fake.commands[0]!)).toEqual(normalizeUnit(fake.commands[1]!));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("proves internal hardlinks are contained and rejects external or protected aliases", async () => {
    const temp = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-hardlinks-"),
    );
    const root = path.join(temp, "workspace");
    const outside = path.join(temp, "outside.txt");
    const bunCacheRoot = path.join(temp, ".bun", "install", "cache");
    const fake = trustedWorkflowRuntime();
    await fs.mkdir(root);
    await fs.mkdir(bunCacheRoot, { recursive: true });
    try {
      const internal = path.join(root, "internal.txt");
      await fs.writeFile(internal, "internal\n");
      for (let index = 0; index < 1_000; index += 1) {
        await fs.link(internal, path.join(root, `internal-${index}.txt`));
      }
      const internalResult = await executeTrustedWorkflowBash(
        { command: "wc -l internal.txt" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(internalResult.executionError).toBeUndefined();
      expect(fake.commands).toHaveLength(1);

      await fs.writeFile(outside, "outside\n");
      await fs.link(outside, path.join(root, "outside-alias.txt"));
      const escaped = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(escaped.executionError).toMatchObject({ type: "blocked" });
      expect(escaped.stderr).toContain("hardlink escapes the approved root");
      await fs.rm(path.join(root, "outside-alias.txt"));

      const dependencyRoot = path.join(root, "node_modules", "fixture");
      await fs.mkdir(dependencyRoot, { recursive: true });
      const cachedDependency = path.join(bunCacheRoot, "fixture-index.js");
      await fs.writeFile(cachedDependency, "cached dependency\n");
      await fs.link(cachedDependency, path.join(dependencyRoot, "index.js"));
      const dependency = await executeTrustedWorkflowBash(
        { command: "cat node_modules/fixture/index.js" },
        {
          workspaceRoot: root,
          workspaceWritable: true,
          runtime: fake.runtime,
          bunCacheRoot,
        },
      );
      expect(dependency.executionError).toBeUndefined();
      const dependencyCommand = fake.commands[1]!;
      const dependencyMount = dependencyCommand.findIndex(
        (value, index) =>
          value === "--ro-bind" && dependencyCommand[index + 1] === path.join(root, "node_modules"),
      );
      expect(dependencyCommand.slice(dependencyMount, dependencyMount + 3)).toEqual([
        "--ro-bind",
        path.join(root, "node_modules"),
        path.join(root, "node_modules"),
      ]);
      await fs.rm(path.join(root, "node_modules"), { recursive: true });

      await fs.mkdir(dependencyRoot, { recursive: true });
      await fs.link(outside, path.join(dependencyRoot, "outside-secret.js"));
      const unauthorizedDependency = await executeTrustedWorkflowBash(
        { command: "cat node_modules/fixture/outside-secret.js" },
        {
          workspaceRoot: root,
          workspaceWritable: false,
          runtime: fake.runtime,
          bunCacheRoot,
        },
      );
      expect(unauthorizedDependency.executionError).toMatchObject({ type: "blocked" });
      expect(unauthorizedDependency.stderr).toContain("no authorized Bun cache source");
      expect(unauthorizedDependency.stdout).not.toContain("outside");
      await fs.rm(path.join(root, "node_modules"), { recursive: true });

      await fs.writeFile(path.join(root, ".env"), "secret\n");
      await fs.link(path.join(root, ".env"), path.join(root, "env-alias.txt"));
      const protectedAlias = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(protectedAlias.executionError).toMatchObject({ type: "blocked" });
      expect(protectedAlias.stderr).toContain("aliases protected data");
      expect(fake.commands).toHaveLength(2);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects FIFOs and sockets before spawning", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-special-"),
    );
    const fake = trustedWorkflowRuntime();
    const fifo = path.join(root, "input.fifo");
    const socket = path.join(root, "service.sock");
    const server = createServer();
    try {
      expect(await Bun.spawn(["/usr/bin/mkfifo", fifo]).exited).toBe(0);
      const fifoResult = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(fifoResult.executionError).toMatchObject({ type: "blocked" });
      expect(fifoResult.stderr).toContain("unsupported special node");
      await fs.rm(fifo);

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      const socketResult = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(socketResult.executionError).toMatchObject({ type: "blocked" });
      expect(socketResult.stderr).toContain("unsupported special node");
      expect(fake.commands).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles more than 512 protected masks when actual argv capacity permits", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-masks-"),
    );
    const fake = trustedWorkflowRuntime();
    try {
      await Promise.all(
        Array.from({ length: 513 }, async (_value, index) => {
          await fs.writeFile(path.join(root, `.env.${index}`), "secret\n");
        }),
      );
      const result = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(result.executionError).toBeUndefined();
      expect(fake.commands).toHaveLength(1);
      expect(fake.commands[0]!.filter((value) => value === "--ro-bind").length).toBeGreaterThan(
        512,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when command argv exceeds its byte bound", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-argv-"),
    );
    const fake = trustedWorkflowRuntime();
    try {
      const result = await executeTrustedWorkflowBash(
        { command: `printf %s ${"x".repeat(600_000)}` },
        { workspaceRoot: root, workspaceWritable: false, runtime: fake.runtime },
      );
      expect(result.executionError).toMatchObject({
        type: "exception",
        phase: "spawn",
        message: expect.stringContaining("argument exceeds transport limit"),
      });
      expect(fake.commands).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists complete large output and reports stream read failures", async () => {
    const temp = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-output-"),
    );
    const root = path.join(temp, "workspace");
    const artifacts = createToolResultArtifactStore(path.join(temp, "artifacts"));
    await fs.mkdir(root);
    await artifacts.init();
    const largeOutput = `START${"x".repeat(100_000)}END\n`;
    const fake = trustedWorkflowRuntime(largeOutput);
    try {
      const bash = bashToolWithCwd(root, {
        workflowPolicy: workflowPolicy(root, "trusted"),
        trustedWorkflowRuntime: fake.runtime,
        artifacts,
        outputConfig: {
          maxPreviewBytes: 1_024,
          artifactTtlMs: 60_000,
          artifactMaxBytesPerSession: 1024 * 1024,
        },
      }).bash;
      const rawResult = await executeTool(
        bash,
        { command: "bun test" },
        {
          requestId: "trusted-output-request",
          sessionId: "trusted-output-session",
          requestClient: "unknown",
          safetyMode: "trusted",
        },
      );
      if (!isRecord(rawResult)) throw new Error("trusted bash result is malformed");
      expect(rawResult["truncation"]).toMatchObject({ completeOutputRetained: true });
      const truncation = rawResult["truncation"];
      if (!isRecord(truncation) || typeof truncation["artifactUri"] !== "string") {
        throw new Error("trusted bash output artifact is missing");
      }
      const stored = await artifacts.read(truncation["artifactUri"], "trusted-output-session");
      expect(stored.ok).toBe(true);
      if (stored.ok) {
        expect(stored.content).toContain("START");
        expect(stored.content).toContain("END");
        expect(stored.content.length).toBeGreaterThan(100_000);
      }

      const streamFailureRuntime: TrustedWorkflowBashRuntime = {
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("simulated stdout failure"));
            },
          }),
          stderr: textStream("stderr survived\n"),
          exited: Promise.resolve(0),
          kill: () => {},
        }),
        stopUnit: async () => {},
        createUnitName: () => "lilac-workflow-bash-stream-failure",
      };
      const failed = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: streamFailureRuntime },
      );
      expect(failed.stderr).toContain("stderr survived");
      expect(failed.executionError).toMatchObject({
        type: "exception",
        phase: "stdout",
        message: "simulated stdout failure",
      });

      const stderrFailureRuntime: TrustedWorkflowBashRuntime = {
        spawn: () => ({
          stdout: textStream("stdout survived\n"),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("simulated stderr failure"));
            },
          }),
          exited: Promise.resolve(0),
          kill: () => {},
        }),
        stopUnit: async () => {},
        createUnitName: () => "lilac-workflow-bash-stderr-failure",
      };
      const stderrFailed = await executeTrustedWorkflowBash(
        { command: "true" },
        { workspaceRoot: root, workspaceWritable: false, runtime: stderrFailureRuntime },
      );
      expect(stderrFailed.stdout).toContain("stdout survived");
      expect(stderrFailed.executionError).toMatchObject({
        type: "exception",
        phase: "stderr",
        message: "simulated stderr failure",
      });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("routes only trusted-origin workflow policy through the executable sandbox", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-route-"),
    );
    const trustedFake = trustedWorkflowRuntime("trusted executable\n");
    const restrictedFake = trustedWorkflowRuntime("must not execute\n");
    try {
      const requestedCwd = path.join(root, "packages", "core");
      await fs.mkdir(requestedCwd, { recursive: true });
      const trustedPolicy = {
        ...workflowPolicy(root, "trusted"),
        canonicalRequestedCwd: requestedCwd,
        canonicalCwd: requestedCwd,
      };
      const trustedTool = bashToolWithCwd(requestedCwd, {
        workflowPolicy: trustedPolicy,
        trustedWorkflowRuntime: trustedFake.runtime,
      }).bash;
      const trusted = await executeTool(
        trustedTool,
        { command: "bun --version" },
        { safetyMode: "trusted" },
      );
      expect(trusted).toMatchObject({ exitCode: 0, stdout: "trusted executable\n" });
      expect(trustedFake.commands).toHaveLength(1);
      const trustedCommand = trustedFake.commands[0]!;
      expect(trustedCommand).toContain(root);
      const chdirIndex = trustedCommand.indexOf("--chdir");
      expect(trustedCommand[chdirIndex + 1]).toBe(requestedCwd);

      const restrictedTool = bashToolWithCwd(root, {
        workflowPolicy: workflowPolicy(root, "trusted"),
        trustedWorkflowRuntime: restrictedFake.runtime,
      }).bash;
      const restricted = await executeTool(
        restrictedTool,
        { command: "printf restricted-origin" },
        { safetyMode: "restricted" },
      );
      expect(restricted).toMatchObject({ exitCode: 0, stdout: "restricted-origin" });
      expect(restrictedFake.commands).toHaveLength(0);

      const restrictedPolicyTool = bashToolWithCwd(root, {
        workflowPolicy: workflowPolicy(root, "restricted"),
        trustedWorkflowRuntime: restrictedFake.runtime,
      }).bash;
      const restrictedPolicy = await executeTool(
        restrictedPolicyTool,
        { command: "printf restricted-policy" },
        { safetyMode: "trusted" },
      );
      expect(restrictedPolicy).toMatchObject({ exitCode: 0, stdout: "restricted-policy" });
      expect(restrictedFake.commands).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels the complete transient systemd unit", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-cancel-"),
    );
    let resolveSpawned = () => {};
    let resolveExit = (_exitCode: number) => {};
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stoppedUnits: string[] = [];
    const controller = new AbortController();
    const runtime: TrustedWorkflowBashRuntime = {
      spawn: () => {
        resolveSpawned();
        return {
          stdout: textStream(""),
          stderr: textStream(""),
          exited,
          kill: () => resolveExit(143),
        };
      },
      stopUnit: async (unit) => {
        stoppedUnits.push(unit);
      },
      createUnitName: () => "lilac-workflow-bash-cancel-test",
    };
    try {
      const resultPromise = executeTrustedWorkflowBash(
        { command: "sleep 60", cwd: root },
        {
          workspaceRoot: root,
          workspaceWritable: false,
          abortSignal: controller.signal,
          runtime,
        },
      );
      await spawned;
      controller.abort();
      const result = await resultPromise;

      expect(result.executionError).toMatchObject({ type: "aborted", signal: "SIGTERM" });
      expect(stoppedUnits).toEqual(["lilac-workflow-bash-cancel-test"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns a cleanup failure when cancellation cannot verify unit termination", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-cancel-failure-"),
    );
    let resolveSpawned = () => {};
    let resolveExit = (_exitCode: number) => {};
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const controller = new AbortController();
    const runtime: TrustedWorkflowBashRuntime = {
      spawn: () => {
        resolveSpawned();
        return {
          stdout: textStream(""),
          stderr: textStream(""),
          exited,
          kill: () => resolveExit(143),
        };
      },
      stopUnit: async () => {
        throw new Error("unit remained active");
      },
      createUnitName: () => "lilac-workflow-bash-cancel-failure",
    };
    try {
      const resultPromise = executeTrustedWorkflowBash(
        { command: "sleep 60" },
        {
          workspaceRoot: root,
          workspaceWritable: false,
          abortSignal: controller.signal,
          runtime,
        },
      );
      await spawned;
      controller.abort();
      const result = await resultPromise;

      expect(result.exitCode).toBe(-1);
      expect(result.executionError).toMatchObject({
        type: "exception",
        phase: "unknown",
        message: expect.stringContaining("cleanup failed: unit remained active"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("analyzeBashCommand", () => {
  it("allows benign commands", () => {
    expect(analyzeBashCommand("echo hello")).toBeNull();
    expect(analyzeBashCommand("git status")).toBeNull();
  });

  it("analyzes the smoke loop's Bash parameter expansions", () => {
    const command = `for spec in "fetch tools fetch https://example.com" "read tools read_file README.md"; do
  label="\${spec%% tools*}"
  invocation="\${spec#* tools }"
  printf '%s: %s\\n' "$label" "\${invocation:-missing}"
done`;

    expect(analyzeBashCommand(command)).toBeNull();
    expect(analyzeBashCommand('echo "it\'s ${spec%% tools*}"')).toBeNull();
    expect(analyzeBashCommand("echo ok # it's a comment")).toBeNull();
  });

  it("still blocks destructive commands adjacent to parameter expansions", () => {
    const result = analyzeBashCommand(
      'echo "${spec%% tools*}"; git reset --hard; echo "${value#prefix}"',
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toContain("git reset --hard");
  });

  it("blocks destructive commands selected through parameter expansions", () => {
    const commands = [
      "${command:-rm} -rf /",
      "git ${x:-reset} --hard",
      "rm ${x:--rf} /",
      "find . ${x:--delete}",
      "bash ${x:--c} 'git reset --hard'",
      "curl ${x:-file:///etc/passwd}",
      "cat ${x:-$HOME/.ssh/id_rsa}",
      "python ${x:-dangerous.py}",
      "echo ok > ${x:-/etc/passwd}",
    ];
    const assigned = analyzeBashCommand('command=git; "$command" reset --hard');
    const assignedArgument = analyzeBashCommand('operation=${x:-reset}; git "$operation" --hard');
    const loop = analyzeBashCommand('for command in rm; do "$command" -rf /; done');
    const wrapped = analyzeBashCommand('exec "$command" -rf /');
    const grouped = analyzeBashCommand('{ "$command" -rf /; }');

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(assigned?.reason).toContain("dynamic shell expansion");
    expect(assignedArgument?.reason).toContain("safety-relevant command argument");
    expect(loop?.reason).toContain("dynamic shell expansion");
    expect(wrapped?.reason).toContain("dynamic shell expansion");
    expect(grouped?.reason).toContain("dynamic shell expansion");
  });

  it("allows exact benign expansions in assignment and display-value positions", () => {
    expect(analyzeBashCommand('label="${spec%% tools*}"')).toBeNull();
    expect(analyzeBashCommand('invocation="${spec#* tools}"')).toBeNull();
    expect(analyzeBashCommand('value="${input:-missing}"; printf "%s\\n" "$value"')).toBeNull();
    expect(analyzeBashCommand('printf "%s\\n" "${input:-missing}"')).toBeNull();
    // tee is intentionally unchanged by this hardening.
    expect(analyzeBashCommand('printf ok | tee "${output:-result.txt}"')).toBeNull();
  });

  it("blocks dynamic executables in shell control flow and execution wrappers", () => {
    const commands = [
      '! "$command" -rf /',
      '( "$command" -rf / )',
      'if true; then "$command" -rf /; fi',
      'case "$kind" in remove) "$command" -rf /;; esac',
      'xargs "$command" -rf /',
      'find . -exec "$command" -rf / \\;',
      'timeout 2 "$command" -rf /',
      'nice -n 2 "$command" -rf /',
      'nohup "$command" -rf /',
      'eval "$command"',
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("blocks static destructive commands behind execution wrappers", () => {
    const commands = [
      "timeout 2 rm -rf /",
      "time git reset --hard",
      "timeout 2 find . -delete",
      "nice -n 2 rm -rf /",
      "nohup git reset --hard",
      "env rm -rf /",
      "command git reset --hard",
      "builtin rm -rf /",
      "env command timeout 2 find . -delete",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("recursively analyzes exec, setsid, stdbuf, ionice, and chrt commands", () => {
    const commands = [
      "exec rm -rf /",
      "exec bash -c 'git reset --hard'",
      "setsid rm -rf /",
      "setsid sh -c 'rm -rf /'",
      "stdbuf -oL rm -rf /",
      "stdbuf --output=L bash -c 'git reset --hard'",
      "ionice -c 2 rm -rf /",
      "ionice --class 2 sh -c 'rm -rf /'",
      "chrt -f 1 rm -rf /",
      "chrt --fifo 1 bash -c 'git reset --hard'",
      "setsid stdbuf -oL ionice -c2 chrt -f 1 sh -c 'rm -rf /'",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("recursively analyzes static eval payloads and rejects dynamic payloads", () => {
    expect(analyzeBashCommand("eval 'git reset --hard'")?.reason).toContain("git reset --hard");
    expect(analyzeBashCommand("eval 'rm -rf /'")).not.toBeNull();
    expect(analyzeBashCommand('eval "$command"')?.reason).toContain("dynamic shell expansion");
  });

  it("fails closed for dynamic simple redirection targets without changing tee arguments", () => {
    expect(analyzeBashCommand("printf ok > $out")).not.toBeNull();
    expect(analyzeBashCommand('printf ok > "$out"')).not.toBeNull();
    expect(analyzeBashCommand('printf ok | tee "$out"')).toBeNull();
  });

  it("fails closed for Bash prompt expansion that can execute variable contents", () => {
    const commands = [
      'printf "%s\\n" "${parameter@P}"',
      `parameter='$(git reset --hard)'; printf '%s\\n' "\${parameter@P}"`,
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toMatchObject({
        reason: expect.stringContaining("could not be safely analyzed"),
      });
    }
  });

  it("fails closed for function definitions and coprocesses with dynamic executables", () => {
    const commands = [
      'remove_all() { "$command" -rf /; }',
      'function remove_all { "$command" -rf /; }',
      'coproc "$command" -rf /',
      'coproc worker { "$command" -rf /; }',
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toMatchObject({
        reason: expect.stringContaining("could not be safely analyzed"),
      });
    }
  });

  it("fails closed for command substitutions, ANSI-C quoting, and heredocs", () => {
    const commands = [
      "$(printf rm) -rf /",
      "`printf rm` -rf /",
      "echo $(git reset --hard)",
      "bash -c $'git reset --hard'",
      "cat <<'EOF'\ngit reset --hard\nEOF",
      "cat <<EOF\n$(git reset --hard)\nEOF",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toMatchObject({
        reason: expect.stringContaining("could not be safely analyzed"),
      });
    }
  });

  it("fails closed when nested shell analysis reaches its recursion limit", () => {
    let command = "git status";
    for (let i = 0; i < 6; i++) {
      command = `bash -c ${JSON.stringify(command)}`;
    }

    expect(analyzeBashCommand(command)).toMatchObject({
      reason: expect.stringContaining("recursion exceeded"),
    });
  });

  it("returns a blocked safety result for parser failures", () => {
    const result = analyzeBashCommand('echo "unterminated');

    expect(result).toEqual({
      reason: "Command could not be safely analyzed because shell parsing failed. Verify manually.",
      segment: 'echo "unterminated',
    });
  });

  it("blocks destructive git commands", () => {
    const result = analyzeBashCommand("git reset --hard");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("git reset --hard");
  });

  it("blocks rm -rf against root", () => {
    const result = analyzeBashCommand("rm -rf /");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("root");
  });

  it("allows rm -rf against temp paths", () => {
    const result = analyzeBashCommand("rm -rf /tmp/cache");
    expect(result).toBeNull();
  });

  it("blocks commands wrapped in bash -c", () => {
    const result = analyzeBashCommand("bash -c 'git reset --hard'");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("git reset --hard");
  });

  it("blocks interpreter one-liners that contain dangerous commands", () => {
    const result = analyzeBashCommand("python -c 'import os; os.system(\"rm -rf /\")'");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("interpreter");
  });

  it("blocks find -delete", () => {
    const result = analyzeBashCommand("find . -delete");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("find -delete");
  });

  it("treats the dynamic tool environment as trusted local bash state", () => {
    expect(analyzeBashCommand("cat /data/secret/tool-env.jsonc")).toBeNull();
  });

  it("blocks xargs rm -rf even with temp targets", () => {
    const result = analyzeBashCommand("xargs rm -rf /tmp/cache");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("xargs");
  });

  it("blocks parallel shell -c", () => {
    const result = analyzeBashCommand("parallel bash -c '{}' ::: 'echo hi'");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("parallel");
  });
});
