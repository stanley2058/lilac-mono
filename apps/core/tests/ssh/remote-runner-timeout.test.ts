import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { runSshCommand } from "../../src/ssh/ssh-command";
import {
  DETACHING_JOB,
  TEST_TIMEOUT_MS,
  isAlive,
  runUntilReady,
  useRemoteRunnerHosts,
} from "./remote-runner-hosts";

const hosts = useRemoteRunnerHosts("timeout");

describe("remote runner timeouts", () => {
  it(
    "a timeout stops the remote job",
    async () => {
      const host = hosts.freshHost();
      const pidFile = path.join(hosts.tempDir, `${host}.pids`);
      const result = await runUntilReady({ host, cmd: DETACHING_JOB(pidFile), timeoutMs: 3_000 });
      expect(result.timedOut).toBeTrue();
      for (const pid of (await readFile(pidFile, "utf8")).trim().split("\n").map(Number)) {
        expect(isAlive(pid)).toBeFalse();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settles a deployment command whose output a detached process keeps open",
    async () => {
      const host = hosts.freshHost();
      await writeFile(path.join(hosts.tempDir, `${host}.holdall`), "");
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
          (await readFile(path.join(hosts.tempDir, `${host}.holder`), "utf8")).trim(),
        );
        if (holder > 0 && isAlive(holder)) process.kill(holder, "SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
