import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll } from "bun:test";

import { sshExecBash } from "../../src/ssh/ssh-exec";

// The shim stands in for a remote host: it drops the OpenSSH options and hands the remote command
// words to `sh -c`, joined by spaces, the way sshd hands them to the login shell.
const HOST_COUNT = 8;
export const TEST_TIMEOUT_MS = 30_000;

export type RemoteRunnerHosts = {
  tempDir: string;
  remoteHome: string;
  freshHost(): string;
  calls(host: string): Promise<string[]>;
};

/**
 * Installs the fake `ssh` for the calling test file. Each file passes its own host prefix, because
 * the runner caches deployments by host name and test files can share a process.
 */
export function useRemoteRunnerHosts(prefix: string): RemoteRunnerHosts {
  let callsPath = "";
  let previousPath: string | undefined;
  let previousSshConfigPath: string | undefined;
  let nextHost = 0;
  const hosts: RemoteRunnerHosts = {
    tempDir: "",
    remoteHome: "",
    freshHost() {
      nextHost += 1;
      if (nextHost > HOST_COUNT) throw new Error("raise HOST_COUNT");
      return `${prefix}-host-${nextHost}`;
    },
    async calls(host) {
      const text = await readFile(callsPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line.startsWith(`${host} `))
        .map((line) => line.slice(host.length + 1));
    },
  };

  beforeAll(async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lilac-remote-runner-transport-"));
    const remoteHome = path.join(tempDir, "home");
    hosts.tempDir = tempDir;
    hosts.remoteHome = remoteHome;
    callsPath = path.join(tempDir, "calls");
    const fakeUnameDir = path.join(tempDir, "fake-uname");
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
    const names = Array.from({ length: HOST_COUNT }, (_, index) => `${prefix}-host-${index + 1}`);
    await writeFile(
      sshConfigPath,
      names.map((host) => `Host ${host}\n  HostName 127.0.0.1\n`).join(""),
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
    await rm(hosts.tempDir, { recursive: true, force: true });
  });

  return hosts;
}

export async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

export function isAlive(pid: number): boolean {
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

export async function runUntilReady(params: {
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
export const DETACHING_JOB = (pidFile: string) =>
  `sleep 300 & echo $! > ${pidFile}; ${DETACH}sleep 301 & echo $! >> ${pidFile}; trap '' TERM; echo ready; wait`;
