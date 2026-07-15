import { describe, expect, it } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";

import { executeBash, withLimitedBashOutput } from "../../src/tools/bash-impl";
import { executeRestrictedBash } from "../../src/tools/restricted-bash";
import { analyzeBashCommand } from "../../src/tools/bash-safety";
import { resolveRestrictedSessionTmpDir } from "../../src/shared/attachment-utils";
import {
  createToolResultArtifactStore,
  type ToolResultArtifactStore,
} from "../../src/artifacts/tool-result-artifact-store";

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
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=original\n");
    await fs.writeFile(path.join(workspace, "core-config.yaml"), "safe: true\n");
    await fs.writeFile(path.join(workspace, ".git", "config"), "[safe]\n");
    await fs.writeFile(path.join(workspace, "source.txt"), "source\n");
    await fs.mkdir(path.join(workspace, "nested", ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, "nested", ".env"), "NESTED=secret\n");
    await fs.writeFile(path.join(workspace, "nested", ".git", "config"), "[nested]\n");
    await fs.writeFile(outside, "outside\n");

    const commands = [
      "printf hacked > .env",
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
      expect(await fs.readFile(path.join(workspace, "core-config.yaml"), "utf8")).toBe(
        "safe: true\n",
      );
      expect(await fs.readFile(path.join(workspace, ".git", "config"), "utf8")).toBe("[safe]\n");
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

describe("analyzeBashCommand", () => {
  it("allows benign commands", () => {
    expect(analyzeBashCommand("echo hello")).toBeNull();
    expect(analyzeBashCommand("git status")).toBeNull();
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
