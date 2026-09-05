import { describe, expect, it } from "bun:test";
import { analyzeBashCommand } from "@stanley2058/lilac-bash-safety";
import { serverToolExitCode, type ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import {
  env,
  isRecord,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2ToUniversal,
  resolveNativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Panic } from "better-result";

import { getTestBlobStore } from "../helpers/blob-store";
import {
  BASH_NO_OUTPUT_TIMEOUT_MS,
  executeBash,
  withLimitedBashOutput,
} from "../../src/tools/bash-impl";
import { getPreOverflowRawByteLimit } from "../../src/tools/bash-output-sanitizer";
import { bashToolWithCwd } from "../../src/tools/bash";
import {
  executeRestrictedBash,
  RESTRICTED_BASH_WALL_TIMEOUT_MS,
} from "../../src/tools/restricted-bash";
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

  it("executes the original callback URL while redacting only displayed command text", async () => {
    const callbackUrl =
      "http://localhost/callback?code=execution-code&state=execution-state&other=visible";
    const res = await executeBash({
      command: `value=${JSON.stringify(callbackUrl)}; test "$value" = ${JSON.stringify(callbackUrl)} && printf original-preserved`,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("original-preserved");
  });

  it("blocks direct static access to MCP credentials in DATA_DIR/secret", async () => {
    const credentialPath = path.join(env.dataDir, "secret", "mcp-oauth", "docs.json");
    const commands = [
      `cat ${JSON.stringify(credentialPath)}`,
      `printf nope > ${JSON.stringify(credentialPath)}`,
    ];

    for (const command of commands) {
      const result = await executeBash({ command });
      expect(result.executionError, command).toMatchObject({
        type: "blocked",
        reason: "access to a configured protected path",
      });
      expect(result.exitCode).toBe(-1);
    }
  });

  it("resolves static protected paths relative to trusted Bash cwd", async () => {
    const workspace = path.join(env.dataDir, "workspace");
    const relativeCredentialPath = path.relative(
      workspace,
      path.join(env.dataDir, "secret", "mcp-oauth", "docs.json"),
    );
    const result = await executeBash({
      command: `cat ${JSON.stringify(relativeCredentialPath)}`,
      cwd: workspace,
    });

    expect(result.executionError).toMatchObject({
      type: "blocked",
      reason: "access to a configured protected path",
    });
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

  it("forwards request delivery identity to trusted Bash", async () => {
    const res = await executeBash(
      { command: 'printf "%s" "$LILAC_REQUEST_DELIVERY_ID"' },
      {
        context: {
          requestId: "request-123",
          requestDeliveryId: "delivery-456",
          sessionId: "session-789",
          requestClient: "discord",
        },
      },
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("delivery-456");
  });

  it("does not set executionError for command failures", async () => {
    const res = await executeBash({ command: "exit 2" });

    expect(res.exitCode).toBe(2);
    expect(res.executionError).toBeUndefined();
  });

  it("returns a timeout executionError when exceeded", async () => {
    // test-wait-justification: verifies the explicit wall deadline while raw output remains active
    const res = await executeBash({
      command: "while true; do printf tick; sleep 0.01; done",
      timeoutMs: 50,
    });

    expect(res.executionError).toBeDefined();
    expect(res.executionError?.type).toBe("timeout");
    if (res.executionError?.type === "timeout") {
      expect(res.executionError.timeoutMs).toBe(50);
      expect(res.executionError.timeoutKind).toBe("wall_clock");
      expect(res.executionError.signal.length).toBeGreaterThan(0);
    }
    expect(res.stdout).toContain("tick");
    expect(BASH_NO_OUTPUT_TIMEOUT_MS).toBe(3 * 60 * 1000);
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
      expect(res.executionError.code).toBe("spawn_cwd_missing");
      expect(res.executionError.phase).toBe("spawn");
      expect(res.executionError.errno).toBe("ENOENT");
      expect(res.executionError.cwd).toBe("/this/path/definitely/does/not/exist");
      expect(res.executionError.message).toContain("cwd does not exist");
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
      path.join(await fs.realpath(tmpdir()), "lilac-bash-artifact-"),
    );
    const artifacts = createToolResultArtifactStore(
      path.join(artifactDir, "tool-results"),
      await getTestBlobStore(),
    );
    await artifacts.init();
    const testId = crypto.randomUUID();
    const requestId = `bash-trunc-test-request-${testId}`;
    const toolCallId = `bash-trunc-test-tool-${testId}`;
    const sessionId = `bash-trunc-test-session-${testId}`;
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
            sessionId,
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
      expect(res.truncation?.message).toContain("Use read with this URI");
      expect(persistenceTempEntries).toHaveLength(1);
      expect(persistenceTempEntries[0]).toEndWith(".stdout.part");
      expect(persistenceTempEntries.some((entry) => entry.endsWith(".sanitized"))).toBe(false);
      const uri = res.truncation?.artifactUri;
      if (!uri) throw new Error("expected truncated output artifact URI");
      const artifact = await artifacts.read(uri, sessionId);
      expect(artifact.status).toBe("ok");
      if (artifact.status === "ok") {
        expect(artifact.value.content).toContain("<bash_tool_full_output>");
        expect(artifact.value.content).toContain("--- stdout ---");
        expect(artifact.value.content).toContain("--- stderr ---");
        expect(artifact.value.content).toContain("API_TOKEN=<redacted>");
        expect(artifact.value.content).not.toContain("secret-value");
        expect(artifact.value.content).toContain("END");
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

  it("surfaces spill cleanup failure without exposing injected raw output or paths", async () => {
    const rawSecret = "RAW_TOKEN=spill-secret";
    const removed: string[] = [];
    try {
      const result = await executeBash(
        { command: "head -c 100000 /dev/zero | tr '\\0' x" },
        {
          context: {
            requestId: "bash-cleanup-only",
            sessionId: "bash-cleanup-only",
            requestClient: "test",
          },
          toolCallId: "bash-cleanup-only",
          outputConfig: {
            maxPreviewBytes: 64,
            artifactTtlMs: 60_000,
            artifactMaxBytesPerSession: 1024 * 1024,
          },
          spillFileOperations: {
            async remove(target) {
              removed.push(target);
              throw new Error(`${rawSecret} ${target}`);
            },
          },
        },
      );

      expect(removed).toHaveLength(2);
      expect(result.executionError).toEqual({
        type: "exception",
        code: "cleanup_failed",
        phase: "unknown",
        message: "Bash temporary output cleanup failed",
      });
      expect(result.exitCode).toBe(-1);
      const wire = JSON.stringify(result);
      expect(wire).not.toContain(rawSecret);
      for (const target of removed) expect(wire).not.toContain(target);
    } finally {
      await Promise.all(removed.map((target) => fs.rm(target, { force: true })));
    }
  });

  it("captures synchronous spill removal throws and attempts every cleanup", async () => {
    const attempted: string[] = [];
    const result = await executeBash(
      { command: "printf output" },
      {
        spillFileOperations: {
          remove(target) {
            attempted.push(target);
            if (attempted.length === 1) throw new Error("synchronous cleanup failure");
            return Promise.resolve();
          },
        },
      },
    );

    expect(attempted).toHaveLength(2);
    expect(result.executionError).toEqual({
      type: "exception",
      code: "cleanup_failed",
      phase: "unknown",
      message: "Bash temporary output cleanup failed",
    });
  });

  it("surfaces operation and spill cleanup failure without leaking either cause", async () => {
    const invalidCwd = "/tmp/lilac-bash-cleanup-missing-cwd";
    const result = await executeBash(
      { command: "printf unreachable", cwd: invalidCwd },
      {
        spillFileOperations: {
          async remove(target) {
            throw new Error(`RAW_TOKEN=cleanup-secret ${target}`);
          },
        },
      },
    );

    expect(result.executionError).toEqual({
      type: "exception",
      code: "spawn_cwd_missing",
      phase: "spawn",
      message: `Bash cwd does not exist or is not a directory: ${invalidCwd}`,
      errno: "ENOENT",
      cwd: invalidCwd,
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("cleanup-secret");
    expect(wire).toContain(invalidCwd);
  });

  it("attempts all spill cleanup before propagating the exact cleanup Panic", async () => {
    const panic = new Panic({ message: "spill cleanup invariant" });
    const attempted: string[] = [];
    let caught: unknown;
    try {
      await executeBash(
        { command: "printf unreachable", cwd: "/does/not/exist" },
        {
          spillFileOperations: {
            async remove(target) {
              attempted.push(target);
              if (attempted.length === 1) throw panic;
            },
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(attempted).toHaveLength(2);
    expect(caught).toBe(panic);
  });

  it("reports incomplete retention after bounded pre-cap ANSI output", async () => {
    const artifactDir = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-bash-bounded-spill-"),
    );
    const artifacts = createToolResultArtifactStore(
      path.join(artifactDir, "tool-results"),
      await getTestBlobStore(),
    );
    await artifacts.init();

    try {
      const result = await executeBash(
        {
          command: `printf '\\x1b]0;API_TOKEN=hidden-secret'; head -c ${getPreOverflowRawByteLimit(4)} /dev/zero | tr '\\0' x; printf '\\x07API_TOKEN=visible-secret done'`,
        },
        {
          context: {
            requestId: "bash-bounded-spill-request",
            sessionId: "bash-bounded-spill-session",
            requestClient: "test",
          },
          toolCallId: "bash-bounded-spill-call",
          artifacts,
          outputConfig: {
            maxPreviewBytes: 4,
            artifactTtlMs: 60_000,
            artifactMaxBytesPerSession: 2 * 1024 * 1024,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.truncation?.completeOutputRetained).toBe(false);
      expect(result.truncation?.artifactUri).toBeUndefined();
      expect(result.truncation?.message).toContain("complete output could not be retained");
      expect(result.stdout).not.toContain("hidden-secret");
      expect(result.stdout).not.toContain("visible-secret");
    } finally {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("forwards control capability, profile, and current user through ordinary Bash", async () => {
    const config = parseCoreConfigV1ToUniversal({});
    const bash = bashToolWithCwd(process.cwd(), {
      nativeProfile: resolveNativeSubagentProfile(config, "general"),
      controlCapability: "generic-control-capability",
    }).bash;
    const result = await executeTool(
      bash,
      {
        command:
          'printf "%s|%s|%s" "$LILAC_CONTROL_CAPABILITY" "$LILAC_SUBAGENT_PROFILE" "$LILAC_CURRENT_TURN_USER_ID"',
      },
      {
        requestId: "native-profile-bash",
        sessionId: "native-profile-bash",
        requestClient: "test",
        safetyMode: "trusted",
        currentTurnUserId: "user-2",
      },
    );

    expect(result).toMatchObject({
      stdout: "generic-control-capability|general|user-2",
      exitCode: 0,
    });
  });

  it("selects Bash mode from the profile without weakening restricted sessions", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-profile-bash-workspace-"),
    );
    const config = parseCoreConfigV2ToUniversal({ configVersion: 2 });
    const cases = [
      { profile: "explore" as const, safetyMode: "trusted" as const, expected: "1" },
      { profile: "general" as const, safetyMode: "trusted" as const, expected: "native" },
      { profile: "general" as const, safetyMode: "restricted" as const, expected: "1" },
    ];

    try {
      for (const [index, testCase] of cases.entries()) {
        const sessionId = `profile-bash-mode-${index}-${crypto.randomUUID()}`;
        const result = await executeTool(
          bashToolWithCwd(workspace, {
            nativeProfile: resolveNativeSubagentProfile(config, testCase.profile),
          }).bash,
          { command: 'printf "%s" "${LILAC_RESTRICTED:-native}"' },
          {
            requestId: sessionId,
            sessionId,
            requestClient: "test",
            safetyMode: testCase.safetyMode,
          },
        );

        expect(result).toMatchObject({ stdout: testCase.expected, exitCode: 0 });
        await fs.rm(resolveRestrictedSessionTmpDir(sessionId), { recursive: true, force: true });
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("executeRestrictedBash", () => {
  it("uses caller timeoutMs as a restricted wall deadline", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-timeout-workspace-"),
    );
    try {
      // test-wait-justification: verifies the restricted just-bash wall deadline
      const result = await executeRestrictedBash(
        { command: "sleep 1000", cwd: workspace, timeoutMs: 20 },
        { workspaceRoot: workspace },
      );
      expect(result.executionError).toMatchObject({
        type: "timeout",
        timeoutMs: 20,
        timeoutKind: "wall_clock",
      });
      expect(RESTRICTED_BASH_WALL_TIMEOUT_MS).toBe(3 * 60 * 1000);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("initializes Bun file handles before restricted filesystem execution in a fresh process", async () => {
    const runtime = new URL("../../src/tools/restricted-bash.ts", import.meta.url).href;
    const script = `
      import { executeRestrictedBash } from ${JSON.stringify(runtime)};
      import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import path from "node:path";
      const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "lilac-cold-fs-"));
      try {
        await writeFile(path.join(workspace, "input.txt"), "input");
        const output = await executeRestrictedBash(
          { command: "cat input.txt && printf output > output.txt && cat output.txt", cwd: workspace },
          { workspaceRoot: workspace, context: { workspaceWritable: true } },
        );
        process.stdout.write(JSON.stringify(output));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ stdout: "inputoutput", stderr: "", exitCode: 0 });
  });

  it("preserves writable primary-profile behavior through the Bash tool", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-primary-workspace-"),
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
    const temp = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "lilac-restricted-cwd-"));
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    try {
      const result = await executeRestrictedBash(
        { command: "pwd", cwd: process.cwd() },
        { workspaceRoot: workspace },
      );
      expect(result.executionError).toMatchObject({
        type: "blocked",
        code: "restricted_cwd",
        reason: expect.stringContaining("outside the approved workspace"),
        hint: expect.stringContaining("approved workspace"),
      });
      expect(result.stderr).toContain("outside the approved workspace");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("sanitizes previews and encrypted artifacts before returning them", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-sanitize-workspace-"),
    );
    const artifactRoot = path.join(workspace, ".artifacts");
    const store = createToolResultArtifactStore(artifactRoot, await getTestBlobStore());
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
      expect(result.truncation?.artifactUri).toStartWith("resource://t1_");
      const stored = await store.read(
        result.truncation?.artifactUri ?? "",
        "restricted-sanitize-session",
      );
      expect(stored.status).toBe("ok");
      if (stored.status === "ok") {
        expect(stored.value.content).not.toContain("\u001b");
        expect(stored.value.content).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
        expect(stored.value.content).toContain("<redacted>");
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses an overlay workspace and persistent per-session /tmp", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-workspace-"),
    );
    const testId = crypto.randomUUID();
    const sessionId = `restricted-bash-test-session-${testId}`;
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
            requestId: `restricted-bash-test-req-1-${testId}`,
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
            requestId: `restricted-bash-test-req-2-${testId}`,
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
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-isolation-workspace-"),
    );
    const testId = crypto.randomUUID();
    const requestId = `restricted-shared-request-${testId}`;
    const firstSession = `restricted-isolation-a-${testId}`;
    const secondSession = `restricted-isolation-b-${testId}`;

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

  it("preserves complete restricted tool help with and without a positional field", async () => {
    const workspace = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "lilac-tools-help-"));
    const help = {
      callableId: "demo.echo",
      name: "echo",
      description: "Echo the supplied value",
      shortInput: ["value"],
      input: ["value: string", "enabled?: boolean"],
      hidden: false,
    };
    let positional = false;
    const restoreFetch = installMockFetch(async () =>
      Response.json({
        ...help,
        ...(positional ? { primaryPositional: { field: "value" } } : {}),
      }),
    );
    try {
      for (const hasPositional of [false, true]) {
        positional = hasPositional;
        const result = await executeRestrictedBash(
          { command: "tools --help demo.echo", cwd: workspace },
          { workspaceRoot: workspace },
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          ...help,
          ...(hasPositional ? { primaryPositional: { field: "value" } } : {}),
        });
      }
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects incomplete restricted help instead of printing a stripped object", async () => {
    const workspace = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "lilac-tools-help-"));
    const restoreFetch = installMockFetch(async () =>
      Response.json({ primaryPositional: { field: "value" } }),
    );
    try {
      const result = await executeRestrictedBash(
        { command: "tools --help demo.echo", cwd: workspace },
        { workspaceRoot: workspace },
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(serverToolExitCode.internal);
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "error",
        error: { code: "TOOL_SERVER_INVALID_HELP" },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps restricted JSON input reads in the virtual filesystem and stdin adapters", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-tools-input-"),
    );
    const payload = { value: "hello", options: { enabled: true } };
    await fs.writeFile(path.join(workspace, "payload.json"), JSON.stringify(payload));
    const calls: unknown[] = [];
    const restoreFetch = installMockFetch(async (_input, init) => {
      calls.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return Response.json({ status: "ok", value: payload });
    });
    try {
      const commands = [
        `tools demo.echo --input='${JSON.stringify(payload)}'`,
        "tools demo.echo --input=@payload.json",
        "cat payload.json | tools demo.echo --stdin",
        "cat payload.json | tools demo.echo --input=@-",
      ];
      for (const command of commands) {
        const result = await executeRestrictedBash(
          { command, cwd: workspace },
          { workspaceRoot: workspace },
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(payload);
      }
      expect(calls).toEqual(commands.map(() => ({ callableId: "demo.echo", input: payload })));
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes variadic tool positionals through the nested tools command", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;
    const capturedRequestDeliveryIds: Array<string | null> = [];

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({
          callableId: "attachment.add_files",
          name: "add_files",
          description: "Attach files",
          shortInput: ["paths"],
          input: ["paths: string[]"],
          primaryPositional: { field: "paths", variadic: true },
        });
      }
      if (url.endsWith("/call")) {
        capturedRequestDeliveryIds.push(
          new Headers(init?.headers).get("x-lilac-request-delivery-id"),
        );
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ status: "ok", value: { ok: true } });
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
            requestDeliveryId: "delivery-1",
            sessionId: "restricted-tools-variadic-test-session",
            requestClient: "discord",
          },
        },
      );
      const nextDeliveryResult = await executeRestrictedBash(
        {
          command: "tools attachment.add_files a.png b.png",
          cwd: workspace,
        },
        {
          workspaceRoot: workspace,
          context: {
            requestId: "restricted-tools-variadic-test-req",
            requestDeliveryId: "delivery-2",
            sessionId: "restricted-tools-variadic-test-session",
            requestClient: "discord",
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(nextDeliveryResult.exitCode).toBe(0);
      expect(result.stdout).toBe('{"ok":true}\n');
      expect(result.stderr).toBe("");
      expect(capturedRequestDeliveryIds).toEqual(["delivery-1", "delivery-2"]);
      expect(capturedCallInput).toEqual({
        callableId: "attachment.add_files",
        input: { paths: ["a.png", "b.png"] },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("treats nested --output as a CLI option and honors compact and pretty JSON", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    const capturedInputs: unknown[] = [];
    const restoreFetch = installMockFetch(async (_input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      capturedInputs.push(body);
      if (body?.callableId === "demo.string") {
        return Response.json({ status: "ok", value: "plain text" });
      }
      return Response.json({ status: "ok", value: { ok: true, nested: { count: 2 } } });
    });

    try {
      const compact = await executeRestrictedBash(
        {
          command: "tools demo.echo --value=hello --output=json",
          cwd: workspace,
        },
        { workspaceRoot: workspace },
      );
      const pretty = await executeRestrictedBash(
        {
          command: "tools demo.echo --value=hello --output=json-pretty",
          cwd: workspace,
        },
        { workspaceRoot: workspace },
      );
      const stringValue = await executeRestrictedBash(
        {
          command: "tools demo.string --output=json",
          cwd: workspace,
        },
        { workspaceRoot: workspace },
      );

      expect(compact).toMatchObject({
        stdout: '{"ok":true,"nested":{"count":2}}\n',
        stderr: "",
        exitCode: 0,
      });
      expect(pretty).toMatchObject({
        stdout: '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}\n',
        stderr: "",
        exitCode: 0,
      });
      expect(stringValue).toMatchObject({ stdout: '"plain text"\n', stderr: "", exitCode: 0 });
      expect(capturedInputs).toEqual([
        { callableId: "demo.echo", input: { value: "hello" } },
        { callableId: "demo.echo", input: { value: "hello" } },
        { callableId: "demo.string", input: {} },
      ]);
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows mixed flags with variadic positionals in the nested tools command", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({
          callableId: "attachment.add_files",
          name: "add_files",
          description: "Attach files",
          shortInput: ["paths"],
          input: ["paths: string[]"],
          primaryPositional: { field: "paths", variadic: true },
        });
      }
      if (url.endsWith("/call")) {
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ status: "ok", value: { ok: true } });
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
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let capturedCallInput: unknown;

    const restoreFetch = installMockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/help/attachment.add_files")) {
        return Response.json({
          callableId: "attachment.add_files",
          name: "add_files",
          description: "Attach files",
          shortInput: ["paths"],
          input: ["paths: string[]"],
          primaryPositional: { field: "paths", variadic: true },
        });
      }
      if (url.endsWith("/call")) {
        capturedCallInput = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ status: "ok", value: { ok: true } });
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
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let calledTool = false;

    const restoreFetch = installMockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/help/surface.messages.list")) {
        return Response.json({
          callableId: "surface.messages.list",
          name: "list",
          description: "List messages",
          shortInput: ["sessionId"],
          input: ["sessionId: string"],
        });
      }
      if (url.endsWith("/call")) {
        calledTool = true;
        return Response.json({ status: "ok", value: { ok: true } });
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

      expect(result.exitCode).toBe(serverToolExitCode.usage);
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
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let calledTool = false;

    const restoreFetch = installMockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/help/fetch")) {
        return Response.json({
          callableId: "fetch",
          name: "fetch",
          description: "Fetch a URL",
          shortInput: ["url"],
          input: ["url: string"],
          primaryPositional: { field: "url" },
        });
      }
      if (url.endsWith("/call")) {
        calledTool = true;
        return Response.json({ status: "ok", value: { ok: true } });
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

      expect(result.exitCode).toBe(serverToolExitCode.usage);
      expect(result.stderr).toContain("accepts at most one positional argument");
      expect(calledTool).toBe(false);
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("writes nested tool failures as JSON to stderr with the shared exit code", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    const failure: ServerToolFailure = {
      kind: "denied",
      code: "CALLABLE_FORBIDDEN",
      message: "This callable is not allowed",
      retryable: false,
      details: { callableId: "surface.messages.send" },
    };
    const restoreFetch = installMockFetch(async () =>
      Response.json({ status: "error", error: failure }),
    );

    try {
      const result = await executeRestrictedBash(
        { command: "tools surface.messages.send --input='{}'", cwd: workspace },
        { workspaceRoot: workspace },
      );

      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(serverToolExitCode[failure.kind]);
      expect(JSON.parse(result.stderr)).toEqual({ status: "error", error: failure });

      const pretty = await executeRestrictedBash(
        {
          command: "tools surface.messages.send --input='{}' --output=json-pretty",
          cwd: workspace,
        },
        { workspaceRoot: workspace },
      );
      expect(pretty.stdout).toBe("");
      expect(pretty.stderr).toBe(
        `${JSON.stringify({ status: "error", error: failure }, null, 2)}\n`,
      );
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects legacy nested tool responses as structured protocol failures", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    const restoreFetch = installMockFetch(async () =>
      Response.json({ isError: false, output: { legacy: true } }),
    );

    try {
      const result = await executeRestrictedBash(
        { command: "tools example.call --input='{}'", cwd: workspace },
        { workspaceRoot: workspace },
      );
      const envelope = JSON.parse(result.stderr);

      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(serverToolExitCode.internal);
      expect(envelope).toMatchObject({
        status: "error",
        error: { kind: "internal", code: "TOOL_SERVER_INVALID_RESPONSE", retryable: false },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects nested tool failures with an empty code", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    const restoreFetch = installMockFetch(async () =>
      Response.json({
        status: "error",
        error: {
          kind: "denied",
          code: "",
          message: "Missing failure code",
          retryable: false,
        },
      }),
    );

    try {
      const result = await executeRestrictedBash(
        { command: "tools example.call --input='{}'", cwd: workspace },
        { workspaceRoot: workspace },
      );

      expect(result.exitCode).toBe(serverToolExitCode.internal);
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "error",
        error: { kind: "internal", code: "TOOL_SERVER_INVALID_RESPONSE" },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("maps nested tool network failures to retryable structured unavailable failures", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    const restoreFetch = installMockFetch(async () => {
      throw new Error("backend unavailable");
    });

    try {
      const result = await executeRestrictedBash(
        { command: "tools --list", cwd: workspace },
        { workspaceRoot: workspace },
      );
      const envelope = JSON.parse(result.stderr);

      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(serverToolExitCode.unavailable);
      expect(envelope).toMatchObject({
        status: "error",
        error: { kind: "unavailable", code: "TOOL_SERVER_NETWORK_ERROR", retryable: true },
      });
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("maps malformed JSON and every HTTP status class to structured local failures", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    let responseStatus: number | undefined;
    const restoreFetch = installMockFetch(async () =>
      responseStatus === undefined
        ? new Response("{invalid", { status: 200 })
        : new Response("failed", { status: responseStatus }),
    );

    try {
      const malformed = await executeRestrictedBash(
        { command: "tools --list", cwd: workspace },
        { workspaceRoot: workspace },
      );
      expect(malformed.exitCode).toBe(serverToolExitCode.internal);
      expect(JSON.parse(malformed.stderr)).toMatchObject({
        status: "error",
        error: { kind: "internal", code: "TOOL_SERVER_INVALID_JSON", retryable: false },
      });

      const cases = [
        [400, "usage", false],
        [422, "usage", false],
        [401, "denied", false],
        [403, "denied", false],
        [404, "not_found", false],
        [408, "timeout", true],
        [504, "timeout", true],
        [409, "conflict", false],
        [429, "unavailable", true],
        [503, "unavailable", true],
        [418, "internal", false],
      ] as const;
      for (const [status, kind, retryable] of cases) {
        responseStatus = status;
        const result = await executeRestrictedBash(
          { command: "tools --list", cwd: workspace },
          { workspaceRoot: workspace },
        );

        expect(result.exitCode).toBe(serverToolExitCode[kind]);
        expect(JSON.parse(result.stderr)).toMatchObject({
          status: "error",
          error: {
            kind,
            code: "TOOL_SERVER_HTTP_ERROR",
            retryable,
            details: { status },
          },
        });
      }
    } finally {
      restoreFetch();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns cancelled envelopes for aborted nested fetch and response reads", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    try {
      for (const phase of ["fetch", "read"] as const) {
        const started = Promise.withResolvers<void>();
        const restoreFetch = installMockFetch(async (_input, init) => {
          const pending = () =>
            new Promise<never>((_resolve, reject) => {
              const signal = init?.signal;
              const abort = () => reject(signal?.reason ?? new Error("aborted"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            });
          if (phase === "fetch") {
            started.resolve();
            return await pending();
          }
          const response = new Response("unused");
          response.text = async () => {
            started.resolve();
            return await pending();
          };
          return response;
        });
        const controller = new AbortController();
        try {
          const execution = executeRestrictedBash(
            { command: "tools --list", cwd: workspace },
            { workspaceRoot: workspace, abortSignal: controller.signal },
          );
          await started.promise;
          controller.abort();
          const result = await execution;

          expect(result.stdout).toBe("");
          expect(result.exitCode).toBe(serverToolExitCode.cancelled);
          expect(result.executionError).toMatchObject({ type: "aborted" });
          expect(JSON.parse(result.stderr)).toMatchObject({
            status: "error",
            error: {
              kind: "cancelled",
              code: "TOOL_SERVER_REQUEST_CANCELLED",
              retryable: false,
            },
          });
        } finally {
          restoreFetch();
        }
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns timeout envelopes for nested fetch and response reads at the wall deadline", async () => {
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(tmpdir()), "lilac-restricted-tools-workspace-"),
    );
    try {
      for (const phase of ["fetch", "read"] as const) {
        const started = Promise.withResolvers<void>();
        const restoreFetch = installMockFetch(async (_input, init) => {
          const pending = () =>
            new Promise<never>((_resolve, reject) => {
              const signal = init?.signal;
              const abort = () => reject(signal?.reason ?? new Error("aborted"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            });
          if (phase === "fetch") {
            started.resolve();
            return await pending();
          }
          const response = new Response("unused");
          response.text = async () => {
            started.resolve();
            return await pending();
          };
          return response;
        });
        try {
          // test-wait-justification: verifies nested requests preserve the restricted wall deadline
          const execution = executeRestrictedBash(
            { command: "tools --list", cwd: workspace, timeoutMs: 20 },
            { workspaceRoot: workspace },
          );
          await started.promise;
          const result = await execution;

          expect(result.stdout).toBe("");
          expect(result.exitCode).toBe(serverToolExitCode.timeout);
          expect(result.executionError).toMatchObject({
            type: "timeout",
            timeoutMs: 20,
            timeoutKind: "wall_clock",
          });
          expect(JSON.parse(result.stderr)).toMatchObject({
            status: "error",
            error: {
              kind: "timeout",
              code: "TOOL_SERVER_REQUEST_TIMEOUT",
              retryable: true,
            },
          });
        } finally {
          restoreFetch();
        }
      }
    } finally {
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

  it("integrates recursive rm and active Git metadata containment", () => {
    const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
    const blocked = [
      "rm -r /",
      "rm --recurs .",
      "rm -r ../outside",
      "rm -r .git",
      "rmdir .git",
      "mv .git metadata-backup",
      "printf corrupt > .git/config",
      "cp source .git/config",
      "truncate -s 0 .git/config",
      "printf corrupt | tee .git/config",
      "install source .git/hooks/pre-commit",
      "ln -s source .git/hooks/pre-commit",
      "dd if=source of=.git/index",
    ];
    const allowed = [
      "rm -r packages",
      "rm -r /tmp/cache",
      'rm -r "$target"',
      "cat .git/config",
      "cp .git/config backup",
      "truncate -s 0 output",
      "printf ok | tee output",
      "install source output",
      "ln -s source output",
      "dd if=source of=output",
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command, { cwd: repositoryRoot }), command).not.toBeNull();
    }
    for (const command of allowed) {
      expect(analyzeBashCommand(command, { cwd: repositoryRoot }), command).toBeNull();
    }
  });

  it("integrates device, Git grammar, and wrapper safety passes", () => {
    const blocked = [
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sda1",
      "shred important.bin",
      "git checkout -fq main",
      "git switch --disc main",
      "git push --mir origin",
      "git push -d origin old",
      "git push origin :old",
      "git push origin +main:main",
      "git push --force --force-with-lease origin main",
      "git branch -df old",
      "git branch --forc old",
      "git tag --del v1",
      "git reflog delete HEAD@{0}",
      "git worktree remove -fv ../old-tree",
      "watch -n 2 git reset --hard",
      "watch -q 3 git reset --hard",
      "watch --equexit=3 git reset --hard",
      "watch --shotsdir /tmp git reset --hard",
      "watch --inter 2 git reset --hard",
      "watch --equ=3 git reset --hard",
      "watch --shot=/tmp git reset --hard",
      "bash -c -- 'git reset --hard'",
    ];
    const allowed = [
      "dd if=/dev/zero of=disk.img",
      "mkfs.ext4 disk.img",
      'shred "$target"',
      "git checkout main",
      "git switch main",
      "git push --force-with-lease origin main",
      "git push origin main:main",
      'git push origin "+$refspec"',
      "git branch -d merged",
      "git tag --list",
      "git reflog show",
      "git worktree remove ../clean-tree",
      "watch git status",
      "watch -q3 git status",
      "watch --shotsdir=/tmp git status",
      "watch --inter=2 git status",
      "watch --equ 3 git status",
      "watch --shot /tmp git status",
      "bash -c -- 'git status'",
    ];

    for (const command of blocked) expect(analyzeBashCommand(command), command).not.toBeNull();
    for (const command of allowed) expect(analyzeBashCommand(command), command).toBeNull();
  });

  it("integrates malformed static fallback without broadening dynamic operands", () => {
    const options = { cwd: "/tmp/lilac-project" };
    const blocked = [
      "rm -r ../outside &&",
      "dd if=/dev/zero of=/dev/sda &&",
      "mkfs.xfs /dev/sda1 &&",
      "shred important.bin &&",
      "git push origin :old &&",
      "git push -d origin old &&",
      "git push origin +main:main &&",
    ];
    const allowed = [
      "rm -r build &&",
      'rm -r "$target" &&',
      'dd if=/dev/zero of="$target" &&',
      'shred "$target" &&',
      "git push --force-with-lease origin main &&",
      "git push origin main:main &&",
      'git push origin "+$refspec" &&',
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command, options), command).not.toBeNull();
    }
    for (const command of allowed) {
      expect(analyzeBashCommand(command, options), command).toBeNull();
    }
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
