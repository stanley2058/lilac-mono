import { describe, expect, it } from "bun:test";
import {
  env,
  isRecord,
  parseCoreConfigV1ToUniversal,
  resolveNativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";

import { executeBash, withLimitedBashOutput } from "../../src/tools/bash-impl";
import { bashToolWithCwd } from "../../src/tools/bash";
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

  it("executes benign ANSI-C quoting and command substitutions through the safety harness", async () => {
    const res = await executeBash({
      command: `printf 'key\thttps://example.com\n' | while IFS=$'\\t' read -r key url; do
  printf '%s:%s\\n' "$key" "$url"
done
media_dir=$(mktemp -d /tmp/aws-media.XXXXXX)
printf '%s\\n' "$(printf hi)" $'\\x6f\\x6b'
rmdir "$media_dir"`,
    });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toBe("key:https://example.com\nhi\nok\n");
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

  it("forwards generic control capability and profile context through ordinary Bash", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    const bash = bashToolWithCwd(process.cwd(), {
      nativeProfile: resolveNativeSubagentProfile(config, "general"),
      controlCapability: "generic-control-capability",
    }).bash;
    const result = await executeTool(
      bash,
      { command: 'printf "%s|%s" "$LILAC_CONTROL_CAPABILITY" "$LILAC_SUBAGENT_PROFILE"' },
      {
        requestId: "native-profile-bash",
        sessionId: "native-profile-bash",
        requestClient: "test",
        safetyMode: "trusted",
      },
    );

    expect(result).toMatchObject({
      stdout: "generic-control-capability|general",
      exitCode: 0,
    });
  });
});

describe("executeRestrictedBash", () => {
  it("preserves writable primary-profile behavior through the Bash tool", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath("/tmp"), "lilac-restricted-primary-workspace-"),
    );
    const sessionId = "restricted-primary-profile";
    try {
      const result = await executeTool(
        bashToolWithCwd(workspace).bash,
        { command: "printf written > primary.txt" },
        {
          requestId: "restricted-primary-profile",
          sessionId,
          requestClient: "test",
          safetyMode: "restricted",
        },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(await fs.readFile(path.join(workspace, "primary.txt"), "utf8")).toBe("written");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(resolveRestrictedSessionTmpDir(sessionId), { recursive: true, force: true });
    }
  });

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

      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("original");
      expect(second.stdout).toContain("keep");
      expect(second.stdout).toContain("SECRET=<redacted>");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(sessionTmp, { recursive: true, force: true });
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

  it("allows commands whose destructive behavior depends on runtime expansion", () => {
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
    commands.push(
      'command=git; "$command" reset --hard',
      'operation=${x:-reset}; git "$operation" --hard',
      'for command in rm; do "$command" -rf /; done',
      'exec "$command" -rf /',
      '{ "$command" -rf /; }',
    );

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
  });

  it("allows exact benign expansions in assignment and display-value positions", () => {
    expect(analyzeBashCommand('label="${spec%% tools*}"')).toBeNull();
    expect(analyzeBashCommand('invocation="${spec#* tools}"')).toBeNull();
    expect(analyzeBashCommand('value="${input:-missing}"; printf "%s\\n" "$value"')).toBeNull();
    expect(analyzeBashCommand('printf "%s\\n" "${input:-missing}"')).toBeNull();
    // tee is intentionally unchanged by this hardening.
    expect(analyzeBashCommand('printf ok | tee "${output:-result.txt}"')).toBeNull();
  });

  it("allows dynamic executables in shell control flow and execution wrappers", () => {
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
      expect(analyzeBashCommand(command), command).toBeNull();
    }
  });

  it("treats command lookup operands as data", () => {
    const diagnostic = `for x in bwrap fuse-overlayfs fusermount3 unshare mount nsenter git gh; do
  printf '%-16s' "$x"
  command -v "$x" || true
done`;
    const allowed = [
      diagnostic,
      'command -V "$tool"',
      'command -pv -- "$tool"',
      'env MODE=probe command -V "$tool"',
      'builtin command -v "$tool"',
      "command -v git reset --hard",
    ];

    for (const command of allowed) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }

    expect(analyzeBashCommand('command "$tool" -rf /')).toBeNull();
    expect(analyzeBashCommand('command -p "$tool" -rf /')).toBeNull();
    expect(analyzeBashCommand("command rm -rf /")).not.toBeNull();
    expect(analyzeBashCommand("command -p rm -rf /")).not.toBeNull();
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

  it("allows dynamic data arguments behind static execution wrappers", () => {
    const commands = [
      `builtin printf '%s\n' "$value"`,
      `exec printf '%s\n' "$value"`,
      `timeout 2 printf '%s\n' "$value"`,
      `nice -n 2 printf '%s\n' "$value"`,
      `nohup printf '%s\n' "$value"`,
      `setsid --wait printf '%s\n' "$value"`,
      `stdbuf -oL printf '%s\n' "$value"`,
      `ionice -c2 printf '%s\n' "$value"`,
      `chrt -f 1 printf '%s\n' "$value"`,
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
  });

  it("supports chrt's optional priority without hiding its child", () => {
    expect(analyzeBashCommand("chrt -o rm -rf /")).not.toBeNull();
    expect(analyzeBashCommand("chrt --other git reset --hard")).not.toBeNull();
    expect(analyzeBashCommand("chrt -oR rm -rf /")).not.toBeNull();
    expect(analyzeBashCommand("chrt -RoT10 rm -rf /")).not.toBeNull();
    expect(analyzeBashCommand("chrt --ext printf ok")).toBeNull();
  });

  it("recursively analyzes static eval payloads and allows dynamic payloads", () => {
    expect(analyzeBashCommand("eval 'git reset --hard'")?.reason).toContain("git reset --hard");
    expect(analyzeBashCommand("eval 'rm -rf /'")).not.toBeNull();
    expect(analyzeBashCommand('eval "$command"')).toBeNull();
  });

  it("recursively analyzes shell scripts supplied through stdin redirections", () => {
    const blocked = [
      "bash <<'EOF'\ngit reset --hard\nEOF",
      "bash -s <<< 'rm -rf /'",
      "sh -eu <<'EOF'\ngit clean -f\nEOF",
      "bash 3<<'EOF' <&3\ngit reset --hard\nEOF",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(analyzeBashCommand("bash -eu <<'EOF'\nprintf '%s\\n' hi\nEOF")).toBeNull();
    expect(analyzeBashCommand('bash <<< "$payload"')).toBeNull();
    expect(analyzeBashCommand('bash -s <<< "$(printf dangerous)"')).toBeNull();
  });

  it("allows uninspectable shell pipeline stdin", () => {
    const commands = [
      `echo "$(printf 'git reset --hard')" | bash`,
      "printf $'git reset --hard\\n' | bash",
      "printf 'rm -rf /\\n' | sh -eu",
      "printf 'git reset --hard\\n' | { bash; }",
      "printf 'git reset --hard\\n' | (bash)",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
    expect(analyzeBashCommand("printf 'git reset --hard\\n' | bash </dev/null")).toBeNull();
  });

  it("inspects shell stdin through static command execution wrappers", () => {
    const commands = [
      "timeout 2 bash <<< $'git reset --hard'",
      "exec bash <<< $'git reset --hard'",
      "nice -n 2 bash <<< $'git reset --hard'",
      "nohup bash <<< $'git reset --hard'",
      "setsid bash <<< $'git reset --hard'",
      "stdbuf -oL bash <<< $'git reset --hard'",
      "ionice -c 2 bash <<< $'git reset --hard'",
      "chrt -f 1 bash <<< $'git reset --hard'",
      "time bash <<< $'git reset --hard'",
      "setsid stdbuf -oL timeout 2 bash <<< $'git reset --hard'",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("resolves ordered stdin redirections and descriptor duplication", () => {
    const blocked = [
      "bash -c 'bash' <<'EOF'\ngit reset --hard\nEOF",
      "bash </dev/null <<'EOF'\ngit reset --hard\nEOF",
      "bash 3<<'EOF' <&3\ngit reset --hard\nEOF",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }

    expect(analyzeBashCommand("bash <<'EOF' </dev/null\ngit reset --hard\nEOF")).toBeNull();
    expect(analyzeBashCommand("bash 3<<'EOF'\ngit reset --hard\nEOF")).toBeNull();
    expect(analyzeBashCommand("bash </dev/null")).toBeNull();
    expect(analyzeBashCommand("bash <&-")).toBeNull();
    expect(analyzeBashCommand("bash < script.sh")).toBeNull();
    expect(analyzeBashCommand("printf safe | bash < script.sh")).toBeNull();
  });

  it("resolves compound-command stdin before walking nested statements", () => {
    const blocked = [
      "{ bash; } <<'EOF'\ngit reset --hard\nEOF",
      "(bash) <<'EOF'\ngit reset --hard\nEOF",
      "if true; then bash; fi <<'EOF'\ngit reset --hard\nEOF",
      "{ bash; } 3<<'EOF' <&3\ngit reset --hard\nEOF",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }

    expect(analyzeBashCommand("{ bash; } <<'EOF' </dev/null\ngit reset --hard\nEOF")).toBeNull();
    expect(analyzeBashCommand("{ bash; } 3<<'EOF'\ngit reset --hard\nEOF")).toBeNull();
  });

  it("allows uninspectable stdin in command substitution bodies", () => {
    expect(analyzeBashCommand(`printf 'git reset --hard\\n' | echo "$(bash)"`)).toBeNull();
    expect(analyzeBashCommand(`printf $'git reset --hard\\n' | printf '%s' "$(bash)"`)).toBeNull();
    expect(analyzeBashCommand("output=$(bash)")).toBeNull();
    expect(analyzeBashCommand(`printf 'safe\\n' | echo "$(bash </dev/null)"`)).toBeNull();
  });

  it("allows dynamic redirection targets and tee arguments", () => {
    expect(analyzeBashCommand("printf ok > $out")).toBeNull();
    expect(analyzeBashCommand('printf ok > "$out"')).toBeNull();
    expect(analyzeBashCommand('printf ok > "$(printf output.txt)"')).toBeNull();
    expect(analyzeBashCommand('printf ok | tee "$out"')).toBeNull();
  });

  it("allows Bash prompt expansion with runtime-dependent contents", () => {
    const commands = [
      'printf "%s\\n" "${parameter@P}"',
      `parameter='$(git reset --hard)'; printf '%s\\n' "\${parameter@P}"`,
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
  });

  it("allows runtime-dependent function and coprocess bodies", () => {
    const commands = [
      'remove_all() { "$command" -rf /; }',
      'function remove_all { "$command" -rf /; }',
      'coproc "$command" -rf /',
      'coproc worker { "$command" -rf /; }',
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
    expect(analyzeBashCommand("status() { git status; }")).toBeNull();
  });

  it("allows function bodies with arbitrary future stdin", () => {
    expect(analyzeBashCommand("f() { bash; }; printf 'git reset --hard\\n' | f")).toBeNull();
    expect(analyzeBashCommand('f() { echo "$(bash)"; }')).toBeNull();
    expect(analyzeBashCommand("f() { bash </dev/null; }")).toBeNull();
    expect(analyzeBashCommand("status() { git status; }")).toBeNull();
  });

  it("walks destructive commands in compound constructs", () => {
    const commands = [
      "if true; then git reset --hard; fi",
      "for item in one; do git reset --hard; done",
      "while false; do git reset --hard; done",
      "until true; do git reset --hard; done",
      "case one in one) git reset --hard;; esac",
      "(git reset --hard)",
      "{ git reset --hard; }",
      "reset_all() { git reset --hard; }",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("allows benign substitutions, ANSI-C quoting, and heredocs", () => {
    const commands = [
      "media_dir=$(mktemp -d /tmp/aws-media.XXXXXX)",
      'echo "$(printf hi)"',
      "echo `printf hi`",
      "printf '%s\\n' $'\\x68\\x69'",
      "cat <<'EOF'\ngit reset --hard\nEOF",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
  });

  it("blocks proven danger inside command substitutions", () => {
    const blocked = [
      'echo "$(git reset --hard)"',
      "cat <<EOF\n$(git reset --hard)\nEOF",
      "(( value = $(git reset --hard) ))",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(analyzeBashCommand("$(printf rm) -rf /")).toBeNull();
    expect(analyzeBashCommand("`printf rm` -rf /")).toBeNull();
    expect(analyzeBashCommand("g$(printf it) reset --hard")).toBeNull();
    expect(analyzeBashCommand(`bash -c "$(printf 'git status')"`)).toBeNull();
  });

  it("uses destructive-text fallback for unsupported shell syntax", () => {
    expect(analyzeBashCommand("cat <(git reset --hard)")?.reason).toContain("git reset --hard");
    expect(analyzeBashCommand("cat <(git -C repo reset --hard)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git restore .)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git push --force origin main)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git push -fu origin main)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git restore --staged --worktree .)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git worktree remove --force ../tree)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git branch -aD old)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(git checkout --pathspec-from-file=list)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(rm -r --no-preserve-root -f /)")).not.toBeNull();
    expect(analyzeBashCommand("cat <(printf safe)")).toBeNull();
  });

  it("matches policy against decoded ANSI-C quoted content", () => {
    const commands = [
      "$'\\x72\\x6d' -rf /",
      "g$'\\x69't reset --hard",
      "bash -c $'git reset --hard'",
      "eval $'rm -rf /'",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("inspects nested arithmetic commands but allows runtime-dependent values", () => {
    const blocked = [
      "echo $(( $(git reset --hard) ))",
      "echo $(( ${x:-$(git reset --hard)} ))",
      "(( result = ${x:-$(git reset --hard)} ))",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(analyzeBashCommand("echo $(( $(printf 1) ))")).toBeNull();
    expect(analyzeBashCommand("echo $(( value ))")).toBeNull();
    expect(analyzeBashCommand("echo $(( ${value:-1} ))")).toBeNull();
    expect(analyzeBashCommand("echo $(( 1 + 2 ))")).toBeNull();
  });

  it("allows glob-dependent behavior but retains exact destructive and sensitive matches", () => {
    const cwd = "/tmp/lilac-project";
    const allowed = [
      "g* reset --hard",
      "git r* --hard",
      "rm -r? /",
      "bash -c g*",
      "eval g*",
      "cat ~/.s*/id_rsa",
      "printf ok > output*",
    ];

    for (const command of allowed) {
      expect(analyzeBashCommand(command, { cwd }), command).toBeNull();
    }
    expect(analyzeBashCommand("rm -rf /*", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm -rf ../*", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm -rf *", { cwd })).toBeNull();
    expect(analyzeBashCommand("cat ~/.ssh/*", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("cat ~/.aws/*", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("cat /data/secret/gnupg/*", { cwd })).not.toBeNull();
  });

  it("allows runtime-dependent glob operands", () => {
    const options = { cwd: "/tmp/lilac-project" };
    expect(analyzeBashCommand("cat *.txt", options)).toBeNull();
    expect(analyzeBashCommand("git add src/*.ts", options)).toBeNull();
    expect(analyzeBashCommand("rm -f *.tmp", options)).toBeNull();

    expect(analyzeBashCommand("cat ../*.txt", options)).toBeNull();
    expect(analyzeBashCommand("git add ~/.s*", options)).toBeNull();
    expect(analyzeBashCommand("rm -f ../*.tmp", options)).toBeNull();
    expect(analyzeBashCommand("git r* --hard", options)).toBeNull();
  });

  it("recognizes abbreviated GNU rm recursive and force options", () => {
    const cwd = "/tmp/lilac-project";
    expect(analyzeBashCommand("env -C / rm --recurs --force *", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm --recurs --force /", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm --recursive --for /", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm --rec --for *", { cwd, paranoidRm: true })).not.toBeNull();
    expect(analyzeBashCommand("rm --recurs --force *", { cwd })).toBeNull();
  });

  it("propagates effective cwd into nested evaluators without leaking subshell cwd", () => {
    const options = { cwd: "/tmp/lilac-project" };
    const commands = [
      "cd ..; bash -c 'rm -rf build'",
      "cd ..; sh -c 'rm -rf build'",
      "cd ..; eval 'rm -rf build'",
      "{ cd ..; bash -c 'rm -rf build'; }",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command, options), command).not.toBeNull();
    }
    expect(analyzeBashCommand("(cd ..); rm -rf build", options)).toBeNull();
    expect(analyzeBashCommand("location=$(cd ..); rm -rf build", options)).toBeNull();
  });

  it("distinguishes static and ambiguous cwd changes", () => {
    const options = { cwd: "/tmp/lilac-project" };
    const allowed = [
      "cd -P ..; bash -c 'rm -rf build'",
      "cd ~; bash -c 'rm -rf build'",
      "CDPATH=/tmp cd project; bash -c 'rm -rf build'",
      "cd /tmp/lilac-project/symlink; bash -c 'rm -rf build'",
      "pushd /tmp/lilac-project/other; sh -c 'rm -rf build'",
      "popd; eval 'rm -rf build'",
      'env -C "$target" rm -rf build',
      'sudo -D "$target" rm -rf build',
    ];
    const blocked = [
      "cd -- ..; bash -c 'rm -rf build'",
      "env -C .. bash -c 'rm -rf build'",
      "env --chdir=.. sh -c 'rm -rf build'",
      "env -C .. rm -rf build",
      "sudo -D .. bash -c 'rm -rf build'",
      "sudo --chdir .. sh -c 'rm -rf build'",
      "sudo -D .. rm -rf build",
    ];

    for (const command of allowed) {
      expect(analyzeBashCommand(command, options), command).toBeNull();
    }
    for (const command of blocked) {
      expect(analyzeBashCommand(command, options), command).not.toBeNull();
    }
  });

  it("recursively analyzes every find execution action", () => {
    const commands = [
      "find . -exec git reset --hard \\;",
      "find . -execdir git clean -f \\;",
      "find . -ok bash -c 'git reset --hard' \\;",
      "find . -okdir sh -c 'rm -rf /' \\;",
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(analyzeBashCommand("find . -exec printf '%s\\n' {} \\;")).toBeNull();
    expect(analyzeBashCommand("find . -execdir rm -rf build \\;")).toBeNull();
    expect(analyzeBashCommand("find . -exec rm -rf {} \\;")).not.toBeNull();
    expect(analyzeBashCommand("find . -exec sh -c 'rm -rf \"{}\"' \\;")).not.toBeNull();
    expect(analyzeBashCommand("find . -exec sh -c 'eval \"rm -rf {}\"' \\;")).not.toBeNull();
  });

  it("treats find execution payload tokens as flat until the first terminator", () => {
    expect(analyzeBashCommand("find . -exec echo -exec \\; -delete")).not.toBeNull();
    expect(analyzeBashCommand("find . -exec echo -exec \\;")).toBeNull();
    expect(
      analyzeBashCommand("find . -exec printf ok \\; -exec git reset --hard \\;"),
    ).not.toBeNull();
  });

  it("recursively analyzes static callbacks and allows dynamic callbacks", () => {
    const blocked = [
      "trap 'git reset --hard' EXIT",
      "mapfile -C 'git clean -f' -c 1 lines",
      "readarray --callback='rm -rf /' lines",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
    expect(analyzeBashCommand('trap "$action" EXIT')).toBeNull();
    expect(analyzeBashCommand('readarray -C "$callback" lines')).toBeNull();
    expect(analyzeBashCommand("trap 'printf done' EXIT")).toBeNull();
    expect(analyzeBashCommand("mapfile -C 'printf row' -c 1 lines")).toBeNull();
  });

  it("recursively analyzes static compgen command generators", () => {
    expect(analyzeBashCommand("compgen -C 'git reset --hard' word")).not.toBeNull();
    expect(analyzeBashCommand("compgen -aC 'git reset --hard' word")).not.toBeNull();
    expect(
      analyzeBashCommand("compgen -C 'printf safe' -C 'git reset --hard' word"),
    ).not.toBeNull();
    expect(analyzeBashCommand("compgen -C 'printf completion' word")).toBeNull();
    expect(analyzeBashCommand('compgen -C "$generator" word')).toBeNull();
    expect(analyzeBashCommand("compgen word -C 'git reset --hard'")).toBeNull();
    expect(analyzeBashCommand("compgen -- -C 'git reset --hard'")).toBeNull();
  });

  it("allows command-substitution values after inspecting their bodies", () => {
    const commands = [
      'cp "$(printf "$path")" /tmp/copied',
      'head "$(printf "$path")"',
      'file "$(printf "$path")"',
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command), command).toBeNull();
    }
    expect(analyzeBashCommand('echo "$(printf hi)"')).toBeNull();
    expect(analyzeBashCommand('basename "$(printf "$path")"')).toBeNull();
    expect(analyzeBashCommand('tesseract "$(basename "$image")" stdout')).toBeNull();
    expect(analyzeBashCommand("output=$(printf value)")).toBeNull();
  });

  it("allows commands when nested analysis reaches its recursion limit", () => {
    let command = "git status";
    for (let i = 0; i < 6; i++) {
      command = `bash -c ${JSON.stringify(command)}`;
    }

    expect(analyzeBashCommand(command)).toBeNull();
  });

  it("allows parser failures without proven destructive text", () => {
    expect(analyzeBashCommand('echo "unterminated')).toBeNull();
  });

  it("allows deferred parser errors", () => {
    expect(analyzeBashCommand("echo ok\n}")).toBeNull();
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

  it("keeps dynamic rm -rf targets as an explicit fail-closed exception", () => {
    expect(analyzeBashCommand('rm -rf "$target"')?.reason).toContain("dynamic target");
    expect(analyzeBashCommand('timeout 2 rm -rf "$target"')?.reason).toContain("dynamic target");
    expect(analyzeBashCommand('rm -f "$target"')).toBeNull();
    expect(analyzeBashCommand('rm -rf --preserve-root="$mode" build', { cwd: "/tmp" })).toBeNull();
    expect(analyzeBashCommand('rm -rf "${prefix}--cache"')).not.toBeNull();
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

  it("allows opaque interpreter code by default", () => {
    const result = analyzeBashCommand("python -c 'import os; os.system(\"rm -rf /\")'");
    expect(result).toBeNull();
  });

  it("blocks find -delete", () => {
    const result = analyzeBashCommand("find . -delete");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("find -delete");
  });

  it("treats the dynamic tool environment as trusted local bash state", () => {
    expect(analyzeBashCommand("cat /data/secret/tool-env.jsonc")).toBeNull();
  });

  it("matches sensitive paths only in access contexts", () => {
    expect(analyzeBashCommand("echo ~/.ssh/id_rsa")).toBeNull();
    expect(analyzeBashCommand("cat ~/.ssh/id_rsa")).not.toBeNull();
    expect(analyzeBashCommand("ls ~/.ssh")).not.toBeNull();
    expect(analyzeBashCommand("find ~/.ssh -type f -print")).not.toBeNull();
    expect(analyzeBashCommand("ssh -i ~/.ssh/id_rsa host")).not.toBeNull();
    expect(analyzeBashCommand("ssh-add ~/.ssh/id_rsa")).not.toBeNull();
    expect(analyzeBashCommand("ssh-keygen -y -f ~/.ssh/id_rsa")).not.toBeNull();
    expect(analyzeBashCommand("sftp -i ~/.ssh/id_rsa host")).not.toBeNull();
    expect(analyzeBashCommand("gpg --import ~/.ssh/id_rsa")).not.toBeNull();
    expect(analyzeBashCommand("openssl pkey -in ~/.ssh/id_rsa")).not.toBeNull();
    expect(analyzeBashCommand("printf ok > ~/.ssh/config")).not.toBeNull();
  });

  it("does not let uncertainty mask a later proven destructive command", () => {
    const commands = [
      'echo "$value"; git reset --hard',
      "echo $(( value )); find . -delete",
      '"$command"; rm -rf /',
    ];
    for (const command of commands) {
      expect(analyzeBashCommand(command), command).not.toBeNull();
    }
  });

  it("recursively analyzes static xargs children", () => {
    expect(analyzeBashCommand("xargs rm -rf /tmp/cache")).not.toBeNull();
    expect(analyzeBashCommand("xargs -I{} rm -rf {}")).not.toBeNull();
    expect(analyzeBashCommand("xargs -I{} sh -c 'rm -rf \"{}\"'")).not.toBeNull();
    expect(analyzeBashCommand("xargs -I{} bash -c 'eval \"rm -rf {}\"'")).not.toBeNull();
    expect(analyzeBashCommand("xargs timeout 1 rm -rf /")).not.toBeNull();
    expect(analyzeBashCommand("xargs nice -n 1 git reset --hard")).not.toBeNull();
  });

  it("analyzes finite static GNU Parallel expansions", () => {
    expect(analyzeBashCommand("parallel bash -c '{}' ::: 'echo hi'")).toBeNull();
    expect(analyzeBashCommand("parallel bash -c '{}' ::: 'git reset --hard'")).not.toBeNull();
    expect(analyzeBashCommand("parallel timeout 1 rm -rf {} ::: /")).not.toBeNull();
    expect(analyzeBashCommand("parallel {} -rf / ::: rm")).not.toBeNull();
    expect(analyzeBashCommand("parallel rm -rf {}")).not.toBeNull();
    expect(analyzeBashCommand("parallel sh -c 'rm -rf \"{}\"'")).not.toBeNull();
    expect(analyzeBashCommand("parallel sh -c 'eval \"rm -rf {}\"'")).not.toBeNull();
    expect(analyzeBashCommand("parallel 'git reset --hard' ::: HEAD")).not.toBeNull();
    expect(
      analyzeBashCommand(`parallel 'bash -c "rm -rf {2}"' ::: safe ::: /var/lib/lilac.txt`),
    ).not.toBeNull();
    expect(
      analyzeBashCommand(`parallel 'bash -c "rm -rf {.}"' ::: /var/lib/lilac.txt`),
    ).not.toBeNull();
  });

  it("uses the original cwd for the failure branch of cd", () => {
    const options = { cwd: "/tmp/lilac-project" };
    expect(analyzeBashCommand("cd .. || rm -rf build", options)).toBeNull();
    expect(analyzeBashCommand("cd .. && rm -rf build", options)).not.toBeNull();
    expect(analyzeBashCommand("cd .. && false || rm -rf build", options)).not.toBeNull();
    expect(analyzeBashCommand("cd .. || false && rm -rf build", options)).not.toBeNull();
    expect(analyzeBashCommand("false || cd .. && rm -rf build", options)).not.toBeNull();
  });
});
