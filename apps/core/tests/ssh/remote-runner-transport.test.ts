import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { invalidateRemoteRunner } from "../../src/ssh/remote-runner-deploy";
import { sshExecBash } from "../../src/ssh/ssh-exec";
import { TEST_TIMEOUT_MS, useRemoteRunnerHosts, writeExecutable } from "./remote-runner-hosts";

const hosts = useRemoteRunnerHosts("runner");

describe("remote runner transport", () => {
  it(
    "deploys the runner once per host and runs commands through it",
    async () => {
      const host = hosts.freshHost();
      const [first, second] = await Promise.all([
        sshExecBash({ host, cmd: "echo one", maxOutputChars: 1000, timeoutMs: 20_000 }),
        sshExecBash({ host, cmd: "echo two >&2; exit 4", maxOutputChars: 1000, timeoutMs: 20_000 }),
      ]);
      expect(first).toMatchObject({ stdout: "one\n", stderr: "", exitCode: 0 });
      expect(second).toMatchObject({ stdout: "", stderr: "two\n", exitCode: 4 });

      const recorded = await hosts.calls(host);
      expect(recorded.filter((call) => call.includes("lilac-probe"))).toHaveLength(1);
      expect(recorded.filter((call) => call.includes("lilac-upload"))).toHaveLength(1);
      expect(recorded.filter((call) => call.includes('exec "$0" rpc'))).toHaveLength(2);
      const installed = await readdir(
        path.join(hosts.remoteHome, host, ".cache/lilac/remote-runner"),
      );
      expect(installed).toHaveLength(1);
      expect(installed[0]).toMatch(/^[0-9a-f]{64}$/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the missing-cwd message and expands the home directory",
    async () => {
      const host = hosts.freshHost();
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
      expect(home.stdout.trim()).toBe(path.join(hosts.remoteHome, host));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "redeploys once when the cached runner disappears",
    async () => {
      const host = hosts.freshHost();
      expect((await sshExecBash({ host, cmd: "echo a", maxOutputChars: 100 })).stdout).toBe("a\n");
      await rm(path.join(hosts.remoteHome, host, ".cache/lilac/remote-runner"), {
        recursive: true,
        force: true,
      });
      expect((await sshExecBash({ host, cmd: "echo b", maxOutputChars: 100 })).stdout).toBe("b\n");
      expect(
        (await hosts.calls(host)).filter((call) => call.includes("lilac-upload")),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the shell when the runner cannot be installed",
    async () => {
      const host = hosts.freshHost();
      await mkdir(path.join(hosts.remoteHome, host), { recursive: true });
      await writeFile(path.join(hosts.remoteHome, host, ".cache"), "not a directory");
      const result = await sshExecBash({ host, cmd: "echo still works", maxOutputChars: 100 });
      expect(result).toMatchObject({ stdout: "still works\n", exitCode: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs a command once even when it prints the missing-runner marker",
    async () => {
      const host = hosts.freshHost();
      const counter = path.join(hosts.tempDir, `${host}.counter`);
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
      const host = hosts.freshHost();
      expect((await sshExecBash({ host, cmd: "echo a", maxOutputChars: 100 })).stdout).toBe("a\n");
      const cacheDir = path.join(hosts.remoteHome, host, ".cache/lilac/remote-runner");
      const [hash] = await readdir(cacheDir);
      await writeExecutable(path.join(cacheDir, hash!, "lilac-remote"), "#!/bin/sh\nexit 1\n");
      invalidateRemoteRunner(host);
      expect((await sshExecBash({ host, cmd: "echo b", maxOutputChars: 100 })).stdout).toBe("b\n");
      expect(
        (await hosts.calls(host)).filter((call) => call.includes("lilac-upload")),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});
