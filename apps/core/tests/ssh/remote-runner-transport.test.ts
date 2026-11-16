import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { invalidateRemoteRunner } from "../../src/ssh/remote-runner-deploy";
import { runSshCommand } from "../../src/ssh/ssh-command";
import { sshExecBash } from "../../src/ssh/ssh-exec";

// The shim stands in for a remote host: it drops the OpenSSH options and hands the remote command
// words to `sh -c`, joined by spaces, the way sshd hands them to the login shell.
const HOST_COUNT = 16;
const TEST_TIMEOUT_MS = 30_000;

let tempDir = "";
let remoteHome = "";
let callsPath = "";
let fakeUnameDir = "";
let previousPath: string | undefined;
let previousSshConfigPath: string | undefined;
let nextHost = 0;

function freshHost(): string {
  nextHost += 1;
  if (nextHost > HOST_COUNT) throw new Error("raise HOST_COUNT");
  return `runner-host-${nextHost}`;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

async function calls(host: string): Promise<string[]> {
  const text = await readFile(callsPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${host} `))
    .map((line) => line.slice(host.length + 1));
}

function isAlive(pid: number): boolean {
  // A zombie still answers signal 0, so read its state instead.
  if (process.platform !== "linux") {
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state !== "" && !state.startsWith("Z");
  }
  const stat = Bun.spawnSync(["cat", `/proc/${pid}/stat`]).stdout.toString();
  if (!stat) return false;
  const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  return state !== "Z";
}

// macOS has no `setsid` command.
const SETSID =
  process.platform === "linux" ? "setsid" : `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV'`;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-runner-transport-"));
  remoteHome = path.join(tempDir, "home");
  callsPath = path.join(tempDir, "calls");
  fakeUnameDir = path.join(tempDir, "fake-uname");
  const binDir = path.join(tempDir, "bin");
  await mkdir(remoteHome, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeUnameDir, { recursive: true });
  await writeExecutable(
    path.join(fakeUnameDir, "uname"),
    `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Plan9; else echo x86_64; fi\n`,
  );
  await writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T) shift ;;
    -o) shift 2 ;;
    *) break ;;
  esac
done
host="$1"
shift
printf '%s %s\\n' "$host" "$(printf '%s' "$*" | tr '\\n' ' ')" >> ${JSON.stringify(callsPath)}
export HOME=${JSON.stringify(remoteHome)}/"$host"
mkdir -p "$HOME"
unset XDG_CACHE_HOME
if [ -e ${JSON.stringify(tempDir)}/"$host".plan9 ]; then export PATH=${JSON.stringify(fakeUnameDir)}:"$PATH"; fi
if [ -e ${JSON.stringify(tempDir)}/"$host".holdall ]; then
  # Every command hangs while a process outside the client's group keeps stderr open.
  ${SETSID} sleep 600 </dev/null >/dev/null &
  echo $! > ${JSON.stringify(tempDir)}/"$host".holder
  exec sleep 600
fi
case "$*" in
  *'exec "$0" rpc'*)
    if [ -e ${JSON.stringify(tempDir)}/"$host".wedged ]; then
      # A wedged connection: it ignores stdin EOF, and a process outside its group keeps stderr
      # open, the way an OpenSSH ControlMaster holds a terminated client's descriptors.
      ${SETSID} sleep 600 </dev/null >/dev/null &
      echo $! > ${JSON.stringify(tempDir)}/"$host".holder
      echo started
      exec sleep 600
    fi
    ;;
esac
exec sh -c "$*"
`,
  );
  const sshConfigPath = path.join(tempDir, "ssh-config");
  const hosts = Array.from({ length: HOST_COUNT }, (_, index) => `runner-host-${index + 1}`);
  await writeFile(
    sshConfigPath,
    hosts.map((host) => `Host ${host}\n  HostName 127.0.0.1\n`).join(""),
  );
  previousPath = process.env.PATH;
  previousSshConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
});

afterAll(async () => {
  process.env.PATH = previousPath;
  if (previousSshConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
  else process.env.LILAC_SSH_CONFIG_PATH = previousSshConfigPath;
  await rm(tempDir, { recursive: true, force: true });
});

async function runUntilReady(params: {
  host: string;
  cmd: string;
  abortAfterReady?: boolean;
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const execution = sshExecBash({
    host: params.host,
    cmd: params.cmd,
    timeoutMs: params.timeoutMs ?? 20_000,
    signal: controller.signal,
    maxOutputChars: 10_000,
    onActivity: () => ready.resolve(),
  });
  await Promise.race([ready.promise, execution]);
  if (params.abortAfterReady) controller.abort();
  return await execution;
}

// The second sleep leaves the job's process group, the way a daemonizing command would. macOS has
// no subreaper, so there the runner cannot catch an escaped process and the sleep stays in the group.
const DETACH = process.platform === "linux" ? `${SETSID} ` : "";
const DETACHING_JOB = (pidFile: string) =>
  `sleep 300 & echo $! > ${pidFile}; ${DETACH}sleep 301 & echo $! >> ${pidFile}; trap '' TERM; echo ready; wait`;

describe("remote runner transport", () => {
  it(
    "deploys the runner once per host and runs commands through it",
    async () => {
      const host = freshHost();
      const [first, second] = await Promise.all([
        sshExecBash({ host, cmd: "echo one", maxOutputChars: 1000, timeoutMs: 20_000 }),
        sshExecBash({ host, cmd: "echo two >&2; exit 4", maxOutputChars: 1000, timeoutMs: 20_000 }),
      ]);
      expect(first).toMatchObject({ stdout: "one\n", stderr: "", exitCode: 0 });
      expect(second).toMatchObject({ stdout: "", stderr: "two\n", exitCode: 4 });

      const recorded = await calls(host);
      expect(recorded.filter((call) => call.includes("lilac-probe"))).toHaveLength(1);
      expect(recorded.filter((call) => call.includes("lilac-upload"))).toHaveLength(1);
      expect(recorded.filter((call) => call.includes('exec "$0" rpc'))).toHaveLength(2);
      const installed = await readdir(path.join(remoteHome, host, ".cache/lilac/remote-runner"));
      expect(installed).toHaveLength(1);
      expect(installed[0]).toMatch(/^[0-9a-f]{64}$/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the missing-cwd message and expands the home directory",
    async () => {
      const host = freshHost();
      const missing = await sshExecBash({
        host,
        cmd: "true",
        cwd: "/definitely/missing",
        maxOutputChars: 1000,
        timeoutMs: 20_000,
      });
      expect(missing).toMatchObject({
        exitCode: 1,
        stderr: "Remote cwd does not exist or is not a directory\n",
      });
      const home = await sshExecBash({ host, cmd: "pwd", cwd: "~", maxOutputChars: 1000 });
      expect(home.stdout.trim()).toBe(path.join(remoteHome, host));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancellation stops the remote job and every descendant",
    async () => {
      const host = freshHost();
      const pidFile = path.join(tempDir, `${host}.pids`);
      const started = Date.now();
      const result = await runUntilReady({
        host,
        cmd: DETACHING_JOB(pidFile),
        abortAfterReady: true,
      });
      expect(result.aborted).toBeTrue();
      expect(Date.now() - started).toBeLessThan(8_000);
      const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(isAlive(pid)).toBeFalse();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a timeout stops the remote job",
    async () => {
      const host = freshHost();
      const pidFile = path.join(tempDir, `${host}.pids`);
      const result = await runUntilReady({ host, cmd: DETACHING_JOB(pidFile), timeoutMs: 3_000 });
      expect(result.timedOut).toBeTrue();
      for (const pid of (await readFile(pidFile, "utf8")).trim().split("\n").map(Number)) {
        expect(isAlive(pid)).toBeFalse();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "redeploys once when the cached runner disappears",
    async () => {
      const host = freshHost();
      expect((await sshExecBash({ host, cmd: "echo a", maxOutputChars: 100 })).stdout).toBe("a\n");
      await rm(path.join(remoteHome, host, ".cache/lilac/remote-runner"), {
        recursive: true,
        force: true,
      });
      expect((await sshExecBash({ host, cmd: "echo b", maxOutputChars: 100 })).stdout).toBe("b\n");
      expect((await calls(host)).filter((call) => call.includes("lilac-upload"))).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settles a cancelled call whose connection keeps its output open",
    async () => {
      const host = freshHost();
      await writeFile(path.join(tempDir, `${host}.wedged`), "");
      const started = Date.now();
      try {
        const result = await runUntilReady({ host, cmd: "true", abortAfterReady: true });
        expect(result.aborted).toBeTrue();
        expect(result.stdout).toBe("started\n");
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        const holder = Number(
          (await readFile(path.join(tempDir, `${host}.holder`), "utf8")).trim(),
        );
        if (holder > 0 && isAlive(holder)) process.kill(holder, "SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to a cancellable shell on an unsupported platform",
    async () => {
      const host = freshHost();
      await writeFile(path.join(tempDir, `${host}.plan9`), "");
      const plain = await sshExecBash({ host, cmd: "echo fallback; exit 3", maxOutputChars: 100 });
      expect(plain).toMatchObject({ stdout: "fallback\n", exitCode: 3 });
      expect((await calls(host)).some((call) => call.includes("lilac-upload"))).toBeFalse();

      const pidFile = path.join(tempDir, `${host}.pids`);
      const cancelled = await runUntilReady({
        host,
        cmd: `sleep 300 & echo $! > ${pidFile}; echo ready; wait`,
        abortAfterReady: true,
      });
      expect(cancelled.aborted).toBeTrue();
      for (const pid of (await readFile(pidFile, "utf8")).trim().split("\n").map(Number)) {
        expect(isAlive(pid)).toBeFalse();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the shell when the runner cannot be installed",
    async () => {
      const host = freshHost();
      await mkdir(path.join(remoteHome, host), { recursive: true });
      await writeFile(path.join(remoteHome, host, ".cache"), "not a directory");
      const result = await sshExecBash({ host, cmd: "echo still works", maxOutputChars: 100 });
      expect(result).toMatchObject({ stdout: "still works\n", exitCode: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the shell fallback kills a child that ignores SIGTERM",
    async () => {
      const host = freshHost();
      await writeFile(path.join(tempDir, `${host}.plan9`), "");
      const pidFile = path.join(tempDir, `${host}.pids`);
      const cancelled = await runUntilReady({
        host,
        // The child reports ready only after its trap is in place.
        cmd: `bash -c "trap '' TERM; echo ready; exec sleep 300" & echo $! > ${pidFile}; wait`,
        abortAfterReady: true,
      });
      expect(cancelled.aborted).toBeTrue();
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(isAlive(pid)).toBeFalse();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs a command once even when it prints the missing-runner marker",
    async () => {
      const host = freshHost();
      const counter = path.join(tempDir, `${host}.counter`);
      const result = await sshExecBash({
        host,
        cmd: `echo ran >> ${counter}; echo lilac-remote-runner-missing >&2; exit 127`,
        maxOutputChars: 1000,
      });
      expect(result.exitCode).toBe(127);
      expect(await readFile(counter, "utf8")).toBe("ran\n");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replaces a cached runner that cannot execute",
    async () => {
      const host = freshHost();
      expect((await sshExecBash({ host, cmd: "echo a", maxOutputChars: 100 })).stdout).toBe("a\n");
      const cacheDir = path.join(remoteHome, host, ".cache/lilac/remote-runner");
      const [hash] = await readdir(cacheDir);
      await writeExecutable(path.join(cacheDir, hash!, "lilac-remote"), "#!/bin/sh\nexit 1\n");
      invalidateRemoteRunner(host);
      expect((await sshExecBash({ host, cmd: "echo b", maxOutputChars: 100 })).stdout).toBe("b\n");
      expect((await calls(host)).filter((call) => call.includes("lilac-upload"))).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settles a deployment command whose output a detached process keeps open",
    async () => {
      const host = freshHost();
      await writeFile(path.join(tempDir, `${host}.holdall`), "");
      try {
        const outcome = await runSshCommand({
          host,
          remoteArgs: ["true"],
          stdin: new Blob([]),
          timeoutMs: 200,
        });
        expect(outcome.match({ ok: (value) => value.timedOut, err: () => false })).toBeTrue();
      } finally {
        const holder = Number(
          (await readFile(path.join(tempDir, `${host}.holder`), "utf8")).trim(),
        );
        if (holder > 0 && isAlive(holder)) process.kill(holder, "SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
