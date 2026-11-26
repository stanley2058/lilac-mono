import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import {
  DETACHING_JOB,
  TEST_TIMEOUT_MS,
  isAlive,
  runUntilReady,
  useRemoteRunnerHosts,
} from "./remote-runner-hosts";

const hosts = useRemoteRunnerHosts("cancel");

describe("remote runner cancellation", () => {
  it(
    "cancellation stops the remote job and every descendant",
    async () => {
      const host = hosts.freshHost();
      const pidFile = path.join(hosts.tempDir, `${host}.pids`);
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
    "settles a cancelled call whose connection keeps its output open",
    async () => {
      const host = hosts.freshHost();
      await writeFile(path.join(hosts.tempDir, `${host}.wedged`), "");
      const started = Date.now();
      try {
        const result = await runUntilReady({ host, cmd: "true", abortAfterReady: true });
        expect(result.aborted).toBeTrue();
        expect(result.stdout).toBe("started\n");
        expect(Date.now() - started).toBeLessThan(15_000);
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
