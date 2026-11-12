import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  decodeRemoteRunnerResponseJson,
  type BundledRemoteRunnerRequest,
} from "@stanley2058/lilac-fs";
import { Panic, Result } from "better-result";
import { z } from "zod";
import type { Tool } from "ai";

import {
  readStreamTextCapped,
  SshExecutionCancelledError,
  SshRequestSerializationError,
  SshStreamReadError,
  SshSubprocessExitError,
  serializeRemoteRunnerRequestJson,
  sshExecBash,
  sshExecScriptJson,
} from "../../src/ssh/ssh-exec";
import {
  remoteFuzzySearch,
  remoteGlob,
  remoteGrep,
  remoteReadFileBytes,
  remoteReadTextFile,
} from "../../src/tools/fs/remote-fs";
import { SSH } from "../../src/tool-server/tools/ssh";
import { createHash } from "node:crypto";
import { fsTool } from "../../src/tools/fs/fs";
import { remoteApplyPatch } from "../../src/tools/apply-patch/remote-apply-patch";

describe("ssh exec transport", () => {
  let tempDir = "";
  let binDir = "";
  let sshPath = "";
  let previousPath: string | undefined;
  let previousSshConfigPath: string | undefined;
  let previousRemoteRunnerCommand: string | undefined;
  let previousRemoteRunnerPackage: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "lilac-ssh-exec-"));

    binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    sshPath = path.join(binDir, "ssh");
    await writeFile(
      sshPath,
      `#!/usr/bin/env bash
set -euo pipefail

while [ "$#" -gt 0 ]; do
  if [ "$1" = "-T" ]; then
    shift
    continue
  fi

  if [ "$1" = "-o" ]; then
    shift 2
    continue
  fi

  shift
  break
done

exec "$@"
`,
      "utf8",
    );
    await chmod(sshPath, 0o755);

    const sshConfigPath = path.join(tempDir, "ssh-config");
    await writeFile(sshConfigPath, "Host fakehost\n  HostName 127.0.0.1\n  User tester\n", "utf8");

    previousPath = process.env.PATH;
    previousSshConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    previousRemoteRunnerCommand = process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    previousRemoteRunnerPackage = process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
    delete process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    delete process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;

    if (previousSshConfigPath === undefined) {
      delete process.env.LILAC_SSH_CONFIG_PATH;
    } else {
      process.env.LILAC_SSH_CONFIG_PATH = previousSshConfigPath;
    }
    if (previousRemoteRunnerCommand === undefined) {
      delete process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    } else {
      process.env.LILAC_REMOTE_FS_RUNNER_COMMAND = previousRemoteRunnerCommand;
    }
    if (previousRemoteRunnerPackage === undefined) {
      delete process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
    } else {
      process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE = previousRemoteRunnerPackage;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
      !!value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
    );
  }

  async function resolveToolResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
    if (isAsyncIterable(value)) {
      let last: T | undefined;
      for await (const chunk of value) last = chunk;
      if (last === undefined) throw new Error("tool execution produced no values");
      return last;
    }
    return await value;
  }

  async function executeTool(
    toolValue: Tool,
    input: unknown,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    if (!toolValue.execute) throw new Error("tool has no execute function");
    return await resolveToolResult(
      toolValue.execute(input, { toolCallId, messages: [], abortSignal, context: {} }),
    );
  }

  async function installMalformedRemoteBun(): Promise<void> {
    const bunPath = path.join(binDir, "bun");
    await writeFile(
      bunPath,
      `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '%s' '{"ok":true,"value":{"variant":"future"}}'
`,
      "utf8",
    );
    await chmod(bunPath, 0o755);
  }

  function observeFileCreation(
    directory: string,
    fileName: string,
  ): {
    readonly outcome: Promise<"created" | "closed">;
    readonly close: () => void;
  } {
    let settled = false;
    let resolveOutcome: (outcome: "created" | "closed") => void = () => undefined;
    let rejectOutcome: (cause: unknown) => void = () => undefined;
    const outcome = new Promise<"created" | "closed">((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const settle = (next: "created" | "closed") => {
      if (settled) return;
      settled = true;
      resolveOutcome(next);
    };
    const watcher = watch(directory, (_eventType, changedFileName) => {
      if (changedFileName?.toString() === fileName) settle("created");
    });
    watcher.on("error", (cause) => {
      if (settled) return;
      settled = true;
      rejectOutcome(cause);
    });
    return {
      outcome,
      close: () => {
        watcher.close();
        settle("closed");
      },
    };
  }

  async function withRejectionTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([operation, timeoutGuard]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function settlesBeforeTimeout(
    operation: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      await withRejectionTimeout(operation, timeoutMs, "SSH cleanup did not settle");
      return true;
    } catch {
      return false;
    }
  }

  function signalProcessBestEffort(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    try {
      process.kill(pid, signal);
    } catch {
      // The process has already exited.
    }
  }

  function isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function testRemoteRunnerRequest(): BundledRemoteRunnerRequest {
    return {
      op: "apply_patch",
      denyPaths: [],
      input: { patchText: "*** Begin Patch\n*** End Patch" },
    };
  }

  it("keeps probe cwd failures in the capability report", async () => {
    const ssh = new SSH();
    for (const cwd of [tempDir, path.join(tempDir, "missing")]) {
      const result = await ssh.call("ssh.probe", { host: "fakehost", cwd, timeoutMs: 30000 });
      expect(result).toMatchObject({
        status: "ok",
        value: {
          ok: true,
          probe: { cwd: { attempted: cwd, used: cwd === tempDir ? tempDir : "" } },
        },
      });
    }
  }, 60000);

  it("repairs a deleted or corrupt cached runner after a failed execution", async () => {
    const js = `console.log('${crypto.randomUUID()}');`;
    const runnerPath = path.join(
      process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME!, ".cache"),
      "lilac/remote-runners",
      `${createHash("sha256").update(js).digest("hex")}.js`,
    );
    const params = {
      host: "fakehost",
      cwd: tempDir,
      js,
      input: testRemoteRunnerRequest(),
      timeoutMs: 5000,
      maxOutputChars: 1000,
      decodeResponse: () => Result.ok(null),
    };
    expect((await sshExecScriptJson(params)).isOk()).toBe(true);
    for (const corrupt of [false, true]) {
      if (corrupt) await writeFile(runnerPath, "syntax error !!!");
      else await rm(runnerPath);
      expect((await sshExecScriptJson(params)).isErr()).toBe(true);
      expect((await sshExecScriptJson(params)).isOk()).toBe(true);
    }
    await rm(runnerPath);
  });

  it("reports missing remote cwd without retrying the bundled runner", async () => {
    const callsPath = path.join(tempDir, "cwd-calls");
    await writeFile(
      sshPath,
      (await readFile(sshPath, "utf8")).replace(
        "set -euo pipefail",
        `set -euo pipefail\nprintf 'call\\n' >> '${callsPath}'`,
      ),
    );
    for (const run of [remoteGlob, remoteGrep] as const) {
      const result = await run({
        host: "fakehost",
        cwd: path.join(tempDir, "missing", "child"),
        patterns: ["*"],
        input: { pattern: "x" },
        denyPaths: [],
        fsBackend: "fff",
      });
      expect(result).toMatchObject({
        status: "error",
        error: {
          message: expect.stringContaining("Remote cwd does not exist or is not a directory"),
        },
      });
    }
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(2);
    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: path.join(tempDir, "missing"),
      js: `// ${crypto.randomUUID()}`,
      input: testRemoteRunnerRequest(),
      timeoutMs: 5000,
      maxOutputChars: 1000,
      decodeResponse: () => Result.ok(null),
    });
    expect(result).toMatchObject({
      status: "error",
      error: {
        message: expect.stringContaining("Remote cwd does not exist or is not a directory"),
      },
    });
  });

  it("keeps oversized media codes compatible for local and remote reads", async () => {
    await writeFile(path.join(tempDir, "oversized.png"), Buffer.alloc(32));
    const tools = fsTool(tempDir, {
      maxInlineMediaBytesPerPart: 16,
      readFileDirectImageSupported: true,
    });
    for (const cwd of [tempDir, `fakehost:${tempDir}`]) {
      const result = await executeTool(tools.read, { path: "oversized.png", cwd }, "oversized");
      expect(result).toMatchObject({ success: false, error: { code: "UNKNOWN" } });
      expect(JSON.stringify(result)).toContain("16");
    }
  });

  it("returns a byte prefix and total size from the bundled runner like a local read", async () => {
    await writeFile(path.join(tempDir, "preview.txt"), "0123456789abcdef");

    const result = await remoteReadFileBytes({
      host: "fakehost",
      cwd: tempDir,
      filePath: "preview.txt",
      denyPaths: [],
      maxBytes: 8,
      prefixBytes: 4,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw new Error(result.error.message);
    expect(result.value).toMatchObject({ ok: true, bytesLength: 4, totalBytes: 16 });
    if (!result.value.ok) throw new Error(result.value.error);
    expect(Buffer.from(result.value.base64, "base64").toString()).toBe("0123");
  });

  it("cancels a deployment waiter without cancelling the owner", async () => {
    const callsPath = path.join(tempDir, "deployment-calls");
    const existing = await readFile(sshPath, "utf8");
    await writeFile(
      sshPath,
      existing.replace(
        "set -euo pipefail",
        `set -euo pipefail\nprintf 'call\\n' >> '${callsPath}'`,
      ),
    );
    const active = Promise.withResolvers<void>();
    const ownerSignal = new AbortController();
    const waiterSignal = new AbortController();
    const params = {
      host: "fakehost",
      cwd: "~",
      js: `process.stdout.write('${crypto.randomUUID()}'); setInterval(() => {}, 1000);`,
      input: testRemoteRunnerRequest(),
      timeoutMs: 5000,
      maxOutputChars: 1000,
      decodeResponse: () => Result.ok(null),
    };
    const owner = sshExecScriptJson({
      ...params,
      signal: ownerSignal.signal,
      onActivity: () => active.resolve(),
    });
    try {
      await active.promise;
      const waiter = sshExecScriptJson({ ...params, signal: waiterSignal.signal });
      waiterSignal.abort();
      expect((await waiter).match({ ok: () => "unexpected", err: (error) => error._tag })).toBe(
        "SshExecutionCancelledError",
      );
      expect(ownerSignal.signal.aborted).toBe(false);
      expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      ownerSignal.abort();
      await owner;
    }
  });

  it("multiplexes connections and uploads a runner source once per host and hash", async () => {
    const scriptsDir = path.join(tempDir, "scripts");
    const argsPath = path.join(tempDir, "args");
    await mkdir(scriptsDir);
    const existing = await readFile(sshPath, "utf8");
    await writeFile(
      sshPath,
      existing
        .replace("set -euo pipefail", `set -euo pipefail\nprintf '%s\\n' "$@" > '${argsPath}'`)
        .replace(
          'exec "$@"',
          `SCRIPT=$(mktemp '${scriptsDir}/script.XXXXXX')\ncat >"$SCRIPT"\nexec "$@" <"$SCRIPT"`,
        ),
    );
    const js = `console.log(JSON.stringify({ marker: '${crypto.randomUUID()}' }));`;
    const params = {
      host: "fakehost",
      cwd: "~",
      js,
      input: { op: "fs.glob" as const, denyPaths: [], input: { patterns: ["*"], maxEntries: 1 } },
      timeoutMs: 5000,
      maxOutputChars: 1000,
      decodeResponse: () => Result.ok(null),
    };
    const results = await Promise.all([sshExecScriptJson(params), sshExecScriptJson(params)]);
    expect(results.every((result) => result.isOk())).toBe(true);
    const scripts = await Promise.all(
      (await readdir(scriptsDir)).map((name) => readFile(path.join(scriptsDir, name), "utf8")),
    );
    const commands = scripts.map((script) => {
      const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)![1]!;
      const fields = JSON.parse(Buffer.from(encoded, "base64").toString()) as string[];
      return Buffer.from(fields[1]!, "base64").toString();
    });
    expect(
      commands.filter((command) => command.includes(Buffer.from(js).toString("base64"))),
    ).toHaveLength(1);
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPersist=60");
    expect(args).toContain("ControlPath=");
  });

  it("does not retry capped FFF output through the bundled runner", async () => {
    process.env.LILAC_REMOTE_FS_RUNNER_COMMAND = "printf '%0500001d' 0";
    const callsPath = path.join(tempDir, "ssh-calls");
    const existing = await readFile(sshPath, "utf8");
    await writeFile(
      sshPath,
      existing.replace(
        "set -euo pipefail",
        `set -euo pipefail\nprintf 'call\\n' >> '${callsPath}'`,
      ),
    );
    const result = await remoteGlob({
      host: "fakehost",
      cwd: "~",
      patterns: ["*"],
      denyPaths: [],
      fsBackend: "fff",
    });
    expect(result.match({ ok: () => "unexpected", err: (error) => error._tag })).toBe(
      "SshExecutionOutputCappedError",
    );
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("runs large remote commands without passing them as a bash argument", async () => {
    const padding = "x".repeat(200_000);

    const result = await sshExecBash({
      host: "fakehost",
      cmd: `printf ok\n# ${padding}\n`,
      cwd: "~",
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ok");
  });

  it("runs large JSON runner scripts over ssh", async () => {
    const padding = "x".repeat(200_000);
    const js = `const padding = ${JSON.stringify(padding)};\nprocess.stdout.write(JSON.stringify({ ok: true, value: padding.length }));\n`;

    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js,
      input: testRemoteRunnerRequest(),
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toBe(200_000);
  });

  it("rejects malformed subprocess response payloads", async () => {
    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: 'process.stdout.write(JSON.stringify({ ok: true, value: "not-a-number" }));',
      input: testRemoteRunnerRequest(),
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status === "error" ? result.error._tag : "ok").toBe(
      "RemoteRunnerResponsePayloadError",
    );
  });

  it("returns a typed nonzero subprocess failure before decoding stdout", async () => {
    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: "process.exit(7);",
      input: testRemoteRunnerRequest(),
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(SshSubprocessExitError.is(result.error)).toBeTrue();
      if (SshSubprocessExitError.is(result.error)) expect(result.error.exitCode).toBe(7);
    }
  });

  it("returns exact cancellation for an already-aborted owned signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: "process.stdout.write(JSON.stringify({ ok: true, value: 1 }));",
      input: testRemoteRunnerRequest(),
      timeoutMs: 5_000,
      signal: controller.signal,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(SshExecutionCancelledError.is(result.error)).toBeTrue();
    }
  });

  it("does not spawn SSH for a pre-aborted transport signal", async () => {
    const spawnMarkerPath = path.join(tempDir, "ssh-spawned");
    await writeFile(
      sshPath,
      `#!/usr/bin/env bash
printf 'spawned\\n' > ${JSON.stringify(spawnMarkerPath)}
exit 0
`,
      "utf8",
    );
    const controller = new AbortController();
    controller.abort(new DOMException("owned cancellation", "AbortError"));

    const result = await sshExecBash({
      host: "fakehost",
      cmd: "exit 0",
      signal: controller.signal,
      maxOutputChars: 10_000,
    });

    expect(result.aborted).toBeTrue();
    expect(result.exitCode).toBe(-1);
    await expect(stat(spawnMarkerPath)).rejects.toThrow();
  });

  it("cancels in-flight SSH only from its owned signal and cleans up the process group", async () => {
    const startedPath = path.join(tempDir, "ssh-started");
    const witnessSignalPath = path.join(tempDir, "ssh-group-signal");
    const groupCleanupPath = path.join(tempDir, "ssh-group-cleanup");
    const readyFifoPath = path.join(tempDir, "ssh-witness-ready");
    await writeFile(
      sshPath,
      `#!/usr/bin/env bash
set -uo pipefail

STARTED=${JSON.stringify(startedPath)}
WITNESS_SIGNAL=${JSON.stringify(witnessSignalPath)}
GROUP_CLEANUP=${JSON.stringify(groupCleanupPath)}
READY_FIFO=${JSON.stringify(readyFifoPath)}

mkfifo "$READY_FIFO"

group_witness() {
  trap 'trap "" TERM; printf "%s\\n" "$BASHPID" > "$WITNESS_SIGNAL.tmp"; mv "$WITNESS_SIGNAL.tmp" "$WITNESS_SIGNAL"; exit 0' TERM
  printf 'ready\\n' > "$READY_FIFO"
  tail -f /dev/null &
  wait "$!"
}

group_witness &
witness_pid=$!

cleanup() {
  trap '' TERM
  # A signal can end wait before the witness is reaped. An unreaped witness becomes a zombie of the
  # subreaper, which still answers kill -0, so keep waiting until it is really gone.
  while kill -0 "$witness_pid" 2>/dev/null; do
    wait "$witness_pid" >/dev/null 2>&1 || true
  done
  printf 'witness-reaped\\n' > "$GROUP_CLEANUP"
  exit 143
}
trap cleanup TERM

read -r _ < "$READY_FIFO"
rm -f "$READY_FIFO"
printf '%s %s\\n' "$$" "$witness_pid" > "$STARTED.tmp"
mv "$STARTED.tmp" "$STARTED"
printf 'ready\\n'
wait "$witness_pid"
`,
      "utf8",
    );
    await chmod(sshPath, 0o755);

    const startedEvent = observeFileCreation(tempDir, path.basename(startedPath));
    const ownedController = new AbortController();
    let leaderPid: number | undefined;
    let witnessPid: number | undefined;
    let executionCompletion: Promise<void> | undefined;
    let reportActivity: () => void = () => undefined;
    const activity = new Promise<void>((resolve) => {
      reportActivity = resolve;
    });

    try {
      const execution = sshExecScriptJson({
        host: "fakehost",
        cwd: "~",
        js: "process.stdout.write(JSON.stringify({ ok: true, value: 1 }));",
        input: testRemoteRunnerRequest(),
        timeoutMs: 10_000,
        signal: ownedController.signal,
        maxOutputChars: 10_000,
        onActivity: reportActivity,
        decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
      });
      executionCompletion = execution.then(
        () => undefined,
        () => undefined,
      );

      await withRejectionTimeout(activity, 2_000, "SSH subprocess did not start");
      const [leaderPidText, witnessPidText] = (await readFile(startedPath, "utf8"))
        .trim()
        .split(" ");
      leaderPid = Number(leaderPidText);
      witnessPid = Number(witnessPidText);
      expect(Number.isInteger(leaderPid) && leaderPid > 0).toBeTrue();
      expect(Number.isInteger(witnessPid) && witnessPid > 0).toBeTrue();
      expect(ownedController.signal.aborted).toBeFalse();

      const unrelatedController = new AbortController();
      unrelatedController.abort(new DOMException("unrelated cancellation", "AbortError"));
      expect(() => process.kill(leaderPid!, 0)).not.toThrow();
      expect(() => process.kill(witnessPid!, 0)).not.toThrow();

      ownedController.abort(new DOMException("owned cancellation", "AbortError"));
      const result = await withRejectionTimeout(execution, 3_000, "cancelled SSH did not exit");

      expect(result.status).toBe("error");
      if (result.status === "ok") throw new Error("expected in-flight SSH cancellation");
      expect(SshExecutionCancelledError.is(result.error)).toBeTrue();
      expect(await readFile(witnessSignalPath, "utf8")).toBe(`${witnessPid}\n`);
      expect(await readFile(groupCleanupPath, "utf8")).toBe("witness-reaped\n");
      expect(() => process.kill(leaderPid!, 0)).toThrow();
      expect(() => process.kill(witnessPid!, 0)).toThrow();
    } finally {
      startedEvent.close();
      await Promise.allSettled([startedEvent.outcome]);

      ownedController.abort(new DOMException("test cleanup", "AbortError"));
      if (leaderPid && isProcessRunning(leaderPid)) {
        signalProcessBestEffort(-leaderPid, "SIGTERM");
        signalProcessBestEffort(leaderPid, "SIGTERM");
      }
      if (witnessPid && isProcessRunning(witnessPid)) {
        signalProcessBestEffort(witnessPid, "SIGTERM");
      }

      if (executionCompletion && !(await settlesBeforeTimeout(executionCompletion, 2_000))) {
        if (witnessPid) signalProcessBestEffort(witnessPid, "SIGKILL");
        if (!(await settlesBeforeTimeout(executionCompletion, 1_000))) {
          if (leaderPid) {
            signalProcessBestEffort(-leaderPid, "SIGKILL");
            signalProcessBestEffort(leaderPid, "SIGKILL");
          }
          await withRejectionTimeout(
            executionCompletion,
            2_000,
            "SSH cleanup could not reap leader",
          );
        }
      }

      if (witnessPid && isProcessRunning(witnessPid)) {
        signalProcessBestEffort(witnessPid, "SIGKILL");
      }
      if (leaderPid && isProcessRunning(leaderPid)) {
        signalProcessBestEffort(-leaderPid, "SIGKILL");
        signalProcessBestEffort(leaderPid, "SIGKILL");
      }
    }
  }, 20_000);

  it("returns an owned serialization error for a cyclic runner request", async () => {
    const input = testRemoteRunnerRequest();
    Object.defineProperty(input.input, "patchText", { value: input, enumerable: true });

    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: "process.exit(0);",
      input,
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected request serialization failure");
    expect(SshRequestSerializationError.is(result.error)).toBeTrue();
  });

  it("returns an owned serialization error for bigint runner input", async () => {
    const input = testRemoteRunnerRequest();
    Object.defineProperty(input.input, "patchText", { value: 1n, enumerable: true });

    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: "process.exit(0);",
      input,
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected request serialization failure");
    expect(SshRequestSerializationError.is(result.error)).toBeTrue();
  });

  it("captures a hostile serialization getter without rejecting", async () => {
    const input = testRemoteRunnerRequest();
    const cause = new Error("hostile patchText getter");
    Object.defineProperty(input.input, "patchText", {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const result = await sshExecScriptJson({
      host: "fakehost",
      cwd: "~",
      js: "process.exit(0);",
      input,
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected request serialization failure");
    expect(SshRequestSerializationError.is(result.error)).toBeTrue();
    if (SshRequestSerializationError.is(result.error)) expect(result.error.cause).toBe(cause);
  });

  it("returns an owned serialization error when a getter throws a revoked proxy", () => {
    const input = testRemoteRunnerRequest();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    Object.defineProperty(input.input, "patchText", {
      enumerable: true,
      get() {
        throw proxy;
      },
    });

    const result = serializeRemoteRunnerRequestJson(input);

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected request serialization failure");
    expect(SshRequestSerializationError.is(result.error)).toBeTrue();
    if (SshRequestSerializationError.is(result.error)) {
      expect(result.error.cause).toBeInstanceOf(Error);
      expect(result.error.cause).toHaveProperty("message", "Opaque SSH adapter failure");
    }
  });

  it("propagates Panic from a hostile serialization getter", async () => {
    const input = testRemoteRunnerRequest();
    const panic = new Panic({ message: "remote request serialization invariant" });
    Object.defineProperty(input.input, "patchText", {
      enumerable: true,
      get() {
        throw panic;
      },
    });

    await expect(
      sshExecScriptJson({
        host: "fakehost",
        cwd: "~",
        js: "process.exit(0);",
        input,
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
        decodeResponse: (text) => decodeRemoteRunnerResponseJson("test.number", text, z.number()),
      }),
    ).rejects.toBe(panic);
  });

  it("propagates the public read abort signal to remote execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = fsTool(tempDir);

    const output = z
      .object({
        success: z.literal(false),
        error: z.object({ code: z.literal("UNKNOWN"), message: z.string() }),
      })
      .parse(
        await executeTool(
          tools.read,
          { path: "missing.ts", cwd: `fakehost:${tempDir}` },
          "remote-read-cancelled",
          controller.signal,
        ),
      );

    expect(output.error.message).toBe("aborted");
  });

  it("preserves empty positional parameters for remote commands", async () => {
    const result = await sshExecBash({
      host: "fakehost",
      cmd: 'printf "%s" "${1:-missing}"',
      cwd: "~",
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("missing");
  });

  it("does not copy raw stream chunks when overflow retention is disabled", async () => {
    const bytes = new TextEncoder().encode("ab😀Z");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    });
    const bufferFromSpy = spyOn(Buffer, "from");
    let rawCopyCalls = 0;

    try {
      const captured = await readStreamTextCapped(stream, 4);
      rawCopyCalls = bufferFromSpy.mock.calls.length;

      expect(captured.status).toBe("ok");
      if (captured.status === "error") throw new Error(captured.error.message);
      expect(captured.value).toEqual({ text: "ab😀", totalChars: 5, capped: true });
    } finally {
      bufferFromSpy.mockRestore();
    }

    expect(rawCopyCalls).toBe(0);
  });

  it("reports activity only for non-empty raw chunks", async () => {
    let activityCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode("output"));
        controller.close();
      },
    });

    const captured = await readStreamTextCapped(stream, 100, {
      onActivity: () => {
        activityCount += 1;
      },
    });

    expect(captured.status).toBe("ok");
    if (captured.status === "error") throw new Error(captured.error.message);
    expect(captured.value.text).toBe("output");
    expect(activityCount).toBe(1);
  });

  it("returns an owned stream read failure without rejecting", async () => {
    const cause = new Error("stream unavailable");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cause);
      },
    });

    const captured = await readStreamTextCapped(stream, 100);

    expect(captured.status).toBe("error");
    if (captured.status === "ok") throw new Error("expected stream read failure");
    expect(SshStreamReadError.is(captured.error)).toBeTrue();
    if (SshStreamReadError.is(captured.error)) {
      expect(captured.error.operation).toBe("read_chunk");
      expect(captured.error.cause).toBe(cause);
    }
  });

  it("creates secure byte-exact SSH overflow files only after the cap", async () => {
    const underLimitBase = path.join(tempDir, "under-limit");
    const underLimit = await sshExecBash({
      host: "fakehost",
      cmd: "printf small",
      timeoutMs: 5_000,
      maxOutputChars: 100,
      overflowOutputPath: underLimitBase,
    });

    expect(underLimit.capped).toEqual({ stdout: false, stderr: false });
    await expect(stat(`${underLimitBase}.stdout.part`)).rejects.toThrow();
    await expect(stat(`${underLimitBase}.stderr.part`)).rejects.toThrow();

    const overflowBase = path.join(tempDir, "overflow");
    const overflow = await sshExecBash({
      host: "fakehost",
      cmd: "printf stdout-content; printf stderr-content >&2",
      timeoutMs: 5_000,
      maxOutputChars: 5,
      overflowOutputPath: overflowBase,
    });
    const stdoutPath = `${overflowBase}.stdout.part`;
    const stderrPath = `${overflowBase}.stderr.part`;

    expect(overflow.stdout).toBe("stdou");
    expect(overflow.stderr).toBe("stder");
    expect(overflow.capped).toEqual({ stdout: true, stderr: true });
    expect(overflow.overflowPaths).toEqual({ stdout: stdoutPath, stderr: stderrPath });
    expect(await readFile(stdoutPath, "utf8")).toBe("stdout-content");
    expect(await readFile(stderrPath, "utf8")).toBe("stderr-content");
    expect((await stat(stdoutPath)).mode & 0o777).toBe(0o600);
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o600);
  });

  it("retains exact non-ASCII, BOM, and malformed UTF-8 bytes in streaming overflow", async () => {
    const overflowPath = path.join(tempDir, "stream-bytes.part");
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from("é", "utf8"),
      0xff,
      0xfe,
      ...Buffer.from("tail", "utf8"),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });

    const captured = await readStreamTextCapped(stream, 2, { overflowFilePath: overflowPath });

    expect(captured.status).toBe("ok");
    if (captured.status === "error") throw new Error(captured.error.message);
    expect(captured.value.capped).toBeTrue();
    expect(captured.value.text).toBe("é�");
    expect(captured.value.overflowFilePath).toBe(overflowPath);
    expect(await readFile(overflowPath)).toEqual(Buffer.from(bytes));
  });

  it("retains exact non-ASCII, BOM, and malformed UTF-8 bytes in non-stream overflow", async () => {
    const overflowPath = path.join(tempDir, "fallback-bytes.part");
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from("é", "utf8"),
      0xff,
      ...Buffer.from("tail", "utf8"),
    ]);

    const captured = await readStreamTextCapped(new Blob([bytes]), 1, {
      overflowFilePath: overflowPath,
    });

    expect(captured.status).toBe("ok");
    if (captured.status === "error") throw new Error(captured.error.message);
    expect(captured.value.capped).toBeTrue();
    expect(captured.value.text).toBe("é");
    expect(captured.value.overflowFilePath).toBe(overflowPath);
    expect(await readFile(overflowPath)).toEqual(Buffer.from(bytes));
  });

  it("does not clobber or remove pre-existing SSH overflow targets", async () => {
    const overflowBase = path.join(tempDir, "existing-overflow");
    const stdoutPath = `${overflowBase}.stdout.part`;
    const stderrPath = `${overflowBase}.stderr.part`;
    await writeFile(stdoutPath, "existing stdout", { mode: 0o640 });
    await writeFile(stderrPath, "existing stderr", { mode: 0o640 });

    const result = await sshExecBash({
      host: "fakehost",
      cmd: "printf stdout-content; printf stderr-content >&2",
      timeoutMs: 5_000,
      maxOutputChars: 5,
      overflowOutputPath: overflowBase,
    });

    expect(result.capped).toEqual({ stdout: true, stderr: true });
    expect(result.overflowPaths).toEqual({});
    expect(await readFile(stdoutPath, "utf8")).toBe("existing stdout");
    expect(await readFile(stderrPath, "utf8")).toBe("existing stderr");
    expect((await stat(stdoutPath)).mode & 0o777).toBe(0o640);
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o640);
  });

  it("prefers bunx and passes JSON stdin to the default remote FFF runner command", async () => {
    const bunxPath = path.join(binDir, "bunx");
    await writeFile(
      bunxPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "--no-install" ]; then
  printf '%s' '{"ok":false,"error":"unexpected bunx install invocation"}'
  exit 0
fi
if [ "\${2:-}" != "@stanley2058/lilac-remote-fs-runner@0.0.7" ]; then
  printf '%s' '{"ok":false,"error":"unexpected remote fs runner package spec"}'
  exit 0
fi
if [ "\${3:-}" != "--version" ] && [ "\${3:-}" != "request" ]; then
  printf '%s' '{"ok":false,"error":"unexpected bunx invocation"}'
  exit 0
fi
if [ "\${3:-}" = "--version" ]; then
  exit 0
fi
payload=$(cat)
if [[ "$payload" != *'"op":"fs.fuzzy_search"'* ]]; then
  printf '%s' '{"ok":false,"error":"missing fuzzy op"}'
  exit 0
fi
printf '%s' '{"ok":true,"value":{"results":[{"path":"package.json","fileName":"package.json","size":123,"gitStatus":"clean","score":1}],"totalMatched":1,"totalFiles":1,"truncated":false,"effectiveBackend":"fff"}}'
`,
      "utf8",
    );
    await chmod(bunxPath, 0o755);

    const npxPath = path.join(binDir, "npx");
    await writeFile(
      npxPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '{"ok":false,"error":"npx should not be used when bunx exists"}'
`,
      "utf8",
    );
    await chmod(npxPath, 0o755);

    const result = await remoteFuzzySearch({
      host: "fakehost",
      cwd: tempDir,
      input: { query: "package json", maxResults: 5 },
      denyPaths: [],
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw new Error(result.error.message);
    expect(result.value).toEqual({
      results: [
        {
          path: "package.json",
          fileName: "package.json",
          size: 123,
          gitStatus: "clean",
          score: 1,
        },
      ],
      totalMatched: 1,
      totalFiles: 1,
      truncated: false,
      effectiveBackend: "fff",
    });
  });

  it("coordinates cold bunx installation for concurrent home-scope remote searches", async () => {
    const bunxPath = path.join(binDir, "bunx");
    const installedPath = path.join(tempDir, "runner-installed");
    const installerPath = path.join(tempDir, "runner-installer");
    const installerStartedPath = path.join(tempDir, "runner-installer-started");
    const installerReleasePath = path.join(tempDir, "runner-installer-release");
    const installerLogPath = path.join(tempDir, "runner-installer-log");
    const probeTicketDir = path.join(tempDir, "runner-probe-tickets");
    const concurrentProbePath = path.join(tempDir, "runner-concurrent-probe");
    const cacheHome = path.join(tempDir, "cache");
    const bunxTempDir = path.join(cacheHome, "lilac", "remote-fs-runner", "bunx");
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    await mkdir(probeTicketDir);
    await writeFile(
      bunxPath,
      `#!/usr/bin/env bash
set -euo pipefail
PACKAGE='@stanley2058/lilac-remote-fs-runner@0.0.7'
INSTALLED=${JSON.stringify(installedPath)}
INSTALLER=${JSON.stringify(installerPath)}
INSTALLER_STARTED=${JSON.stringify(installerStartedPath)}
INSTALLER_RELEASE=${JSON.stringify(installerReleasePath)}
INSTALLER_LOG=${JSON.stringify(installerLogPath)}
PROBE_TICKETS=${JSON.stringify(probeTicketDir)}
CONCURRENT_PROBE=${JSON.stringify(concurrentProbePath)}
EXPECTED_TMPDIR=${JSON.stringify(bunxTempDir)}

if [ "\${TMPDIR:-}" != "$EXPECTED_TMPDIR" ]; then
  exit 89
fi

if [ "\${1:-}" = "--no-install" ]; then
  if [ "\${2:-}" != "$PACKAGE" ]; then
    exit 90
  fi
  if [ "\${3:-}" = "--version" ]; then
    if mkdir "$PROBE_TICKETS/1" 2>/dev/null; then :
    elif mkdir "$PROBE_TICKETS/2" 2>/dev/null; then :
    elif mkdir "$PROBE_TICKETS/3" 2>/dev/null; then printf 'probed\n' > "$CONCURRENT_PROBE"
    fi
    [ -f "$INSTALLED" ]
    exit
  fi
  if [ "\${3:-}" != "request" ] || [ ! -f "$INSTALLED" ]; then
    exit 91
  fi
elif [ "\${1:-}" = "$PACKAGE" ] && [ "\${2:-}" = "--version" ]; then
  if ! mkdir "$INSTALLER" 2>/dev/null; then
    printf '%s\n' 'Failed to link typescript: EEXIST' >&2
    printf '%s\n' 'Failed to link @stanley2058/lilac-remote-fs-runner: EEXIST' >&2
    exit 1
  fi
  trap 'rmdir "$INSTALLER" >/dev/null 2>&1 || true; rm -f "$INSTALLER_RELEASE" >/dev/null 2>&1 || true' EXIT
  mkfifo "$INSTALLER_RELEASE"
  printf 'started\n' > "$INSTALLER_STARTED"
  read -r _ < "$INSTALLER_RELEASE"
  touch "$INSTALLED"
  printf 'install\n' >> "$INSTALLER_LOG"
  exit 0
else
  exit 92
fi

payload=$(cat)
if [[ "$payload" != *'"op":"fs.fuzzy_search"'* ]]; then
  exit 93
fi
printf '%s' '{"ok":true,"value":{"results":[],"totalMatched":0,"totalFiles":0,"truncated":false,"effectiveBackend":"fff"}}'
`,
      "utf8",
    );
    await chmod(bunxPath, 0o755);

    const installerStarted = observeFileCreation(tempDir, path.basename(installerStartedPath));
    const concurrentProbe = observeFileCreation(tempDir, path.basename(concurrentProbePath));
    const firstController = new AbortController();
    const secondController = new AbortController();
    let first: ReturnType<typeof remoteFuzzySearch> | undefined;
    let second: ReturnType<typeof remoteFuzzySearch> | undefined;
    process.env.XDG_CACHE_HOME = cacheHome;

    try {
      first = remoteFuzzySearch({
        host: "fakehost",
        cwd: "~",
        input: { query: "first" },
        denyPaths: [],
        timeoutMs: 5_000,
        signal: firstController.signal,
      });
      expect(
        await withRejectionTimeout(
          installerStarted.outcome,
          2_000,
          "cold bunx installer did not start",
        ),
      ).toBe("created");

      second = remoteFuzzySearch({
        host: "fakehost",
        cwd: "~",
        input: { query: "second" },
        denyPaths: [],
        timeoutMs: 5_000,
        signal: secondController.signal,
      });
      expect(
        await withRejectionTimeout(
          concurrentProbe.outcome,
          2_000,
          "concurrent bunx probe did not start",
        ),
      ).toBe("created");

      await writeFile(installerReleasePath, "continue\n");
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.status).toBe("ok");
      expect(secondResult.status).toBe("ok");
      expect(await readFile(installerLogPath, "utf8")).toBe("install\n");
    } finally {
      installerStarted.close();
      concurrentProbe.close();
      firstController.abort();
      secondController.abort();
      await Promise.allSettled([first, second].filter((value) => value !== undefined));
      await Promise.allSettled([installerStarted.outcome, concurrentProbe.outcome]);
      if (previousCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousCacheHome;
      }
    }
  });

  it("keeps hostile remote FFF request serialization inside Result", async () => {
    const cases: readonly {
      readonly name: string;
      readonly poison: (input: { query: string }) => void;
    }[] = [
      {
        name: "cycle",
        poison: (input) =>
          Object.defineProperty(input, "query", { value: input, enumerable: true }),
      },
      {
        name: "bigint",
        poison: (input) => Object.defineProperty(input, "query", { value: 1n, enumerable: true }),
      },
      {
        name: "hostile getter",
        poison: (input) => {
          const hostileQuery = { value: "safe" };
          Object.defineProperty(hostileQuery, "value", {
            enumerable: true,
            get() {
              throw new Error("hostile nested query getter");
            },
          });
          Object.defineProperty(input, "query", { value: hostileQuery, enumerable: true });
        },
      },
    ];

    for (const testCase of cases) {
      const input = { query: "package" };
      testCase.poison(input);

      const result = await remoteFuzzySearch({
        host: "fakehost",
        cwd: tempDir,
        input,
        denyPaths: [],
        timeoutMs: 5_000,
      });

      expect(result.status, testCase.name).toBe("error");
      if (result.status === "ok")
        throw new Error(`expected ${testCase.name} serialization failure`);
      expect(SshRequestSerializationError.is(result.error), testCase.name).toBeTrue();
    }
  });

  it("falls back to the bundled glob and grep runner after malformed daemon variants", async () => {
    await writeFile(path.join(tempDir, "fallback.ts"), "export const needle = true;\n");
    process.env.LILAC_REMOTE_FS_RUNNER_COMMAND =
      'printf \'%s\' \'{"ok":true,"value":{"mode":"future","truncated":false}}\'';

    const glob = await remoteGlob({
      host: "fakehost",
      cwd: tempDir,
      patterns: ["*.ts"],
      mode: "default",
      denyPaths: [],
      fsBackend: "fff",
      timeoutMs: 5_000,
    });
    const grep = await remoteGrep({
      host: "fakehost",
      cwd: tempDir,
      input: { pattern: "needle", mode: "default" },
      denyPaths: [],
      fsBackend: "fff",
      timeoutMs: 5_000,
    });

    expect(glob.status).toBe("ok");
    expect(grep.status).toBe("ok");
    if (glob.status === "error") throw new Error(glob.error.message);
    if (grep.status === "error") throw new Error(grep.error.message);
    expect(glob.value.mode).toBe("default");
    if (glob.value.mode !== "default") throw new Error("expected default glob response");
    expect(glob.value.paths).toContain("fallback.ts");
    expect(glob.value.error).toBeUndefined();
    expect(grep.value.mode).toBe("default");
    if (grep.value.mode !== "default") throw new Error("expected default grep response");
    expect(grep.value.results.some((match) => match.file.endsWith("fallback.ts"))).toBeTrue();
    expect(grep.value.error).toBeUndefined();
  });

  it("keeps operation-specific filesystem failures inside an Ok response", async () => {
    const result = await remoteReadTextFile({
      host: "fakehost",
      cwd: tempDir,
      input: { path: "missing.ts" },
      denyPaths: [],
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw new Error(result.error.message);
    expect(result.value.success).toBeFalse();
    if (result.value.success) throw new Error("expected missing read to fail");
    expect(result.value.error.code).toBe("NOT_FOUND");
  });

  it("maps SSH transport Err values to existing Core tool failure shapes", async () => {
    await writeFile(sshPath, "#!/usr/bin/env bash\nexit 23\n", "utf8");
    await chmod(sshPath, 0o755);
    const tools = fsTool(tempDir);

    const readOutput = z
      .object({
        success: z.literal(false),
        resolvedPath: z.string(),
        error: z.object({ code: z.literal("UNKNOWN"), message: z.string() }),
      })
      .parse(
        await executeTool(
          tools.read,
          { path: "missing.ts", cwd: `fakehost:${tempDir}` },
          "remote-read-transport",
        ),
      );
    const patchOutput = await remoteApplyPatch({
      host: "fakehost",
      cwd: tempDir,
      patchText: "*** Begin Patch\n*** End Patch",
    });

    expect(readOutput.resolvedPath).toBe("ssh://fakehost/missing.ts");
    expect(readOutput.error.message).toContain("code 23");
    expect(patchOutput.ok).toBeFalse();
    if (!patchOutput.ok) expect(patchOutput.error).toContain("code 23");
  });

  it("maps malformed remote responses without changing outward filesystem shapes", async () => {
    await writeFile(path.join(tempDir, "state.ts"), "const oldValue = 1;\n");
    await writeFile(path.join(tempDir, "image.png"), "not-used");
    const tools = fsTool(tempDir, {
      includeEditFile: true,
      fsBackend: "fff",
      readFileDirectImageSupported: true,
      readFileDirectPdfSupported: true,
    });
    if (!("edit" in tools)) throw new Error("expected edit tool");
    const editFile = tools.edit;
    const fuzzySearch = tools.fuzzy_search;
    if (!fuzzySearch) throw new Error("expected fuzzy tool");
    const remoteCwd = `fakehost:${tempDir}`;

    const initialRead = await executeTool(
      tools.read,
      { path: "state.ts", cwd: remoteCwd },
      "remote-read-before-edit",
    );
    expect(z.object({ success: z.literal(true) }).safeParse(initialRead).success).toBeTrue();

    await installMalformedRemoteBun();
    process.env.LILAC_REMOTE_FS_RUNNER_COMMAND =
      'printf \'%s\' \'{"ok":true,"value":{"variant":"future"}}\'';

    const readOutput = await executeTool(
      tools.read,
      { path: "state.ts", cwd: remoteCwd },
      "remote-read-malformed",
    );
    const bytesOutput = await executeTool(
      tools.read,
      { path: "image.png", cwd: remoteCwd },
      "remote-bytes-malformed",
    );
    const editOutput = await executeTool(
      editFile,
      {
        path: "state.ts",
        cwd: remoteCwd,
        oldText: "oldValue",
        newText: "newValue",
      },
      "remote-edit-malformed",
    );
    const globOutput = await executeTool(
      tools.glob,
      { patterns: ["*.ts"], cwd: remoteCwd, mode: "detailed" },
      "remote-glob-malformed",
    );
    const grepOutput = await executeTool(
      tools.grep,
      { pattern: "oldValue", path: remoteCwd, mode: "detailed" },
      "remote-grep-malformed",
    );
    const fuzzyOutput = await executeTool(
      fuzzySearch,
      { query: "state", cwd: remoteCwd },
      "remote-fuzzy-malformed",
    );
    const patchOutput = await remoteApplyPatch({
      host: "fakehost",
      cwd: tempDir,
      patchText: "*** Begin Patch\n*** End Patch",
    });

    const fsFailureSchema = z.object({
      success: z.literal(false),
      resolvedPath: z.string(),
      error: z.object({ code: z.literal("UNKNOWN"), message: z.string() }),
    });
    for (const output of [readOutput, bytesOutput, editOutput]) {
      const failure = fsFailureSchema.parse(output);
      expect(failure.error.message).toContain("invalid");
    }
    expect(
      z
        .object({
          mode: z.literal("detailed"),
          truncated: z.literal(false),
          entries: z.tuple([]),
          error: z.string(),
        })
        .parse(globOutput).error,
    ).toContain("invalid");
    expect(
      z
        .object({
          mode: z.literal("detailed"),
          truncated: z.literal(false),
          results: z.tuple([]),
          error: z.string(),
        })
        .parse(grepOutput).error,
    ).toContain("invalid");
    const fuzzyFailure = z
      .object({
        results: z.tuple([]),
        totalMatched: z.literal(0),
        totalFiles: z.literal(0),
        truncated: z.literal(false),
        error: z.string(),
      })
      .parse(fuzzyOutput);
    expect(fuzzyFailure.error).toContain("remote fuzzy_search unavailable");
    expect(patchOutput.ok).toBeFalse();
    if (!patchOutput.ok)
      expect(patchOutput.error).toContain("invalid apply_patch response payload");
  });
});
