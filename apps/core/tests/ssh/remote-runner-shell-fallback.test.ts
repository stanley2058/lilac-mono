import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { sshExecBash } from "../../src/ssh/ssh-exec";
import {
  TEST_TIMEOUT_MS,
  isAlive,
  runUntilReady,
  useRemoteRunnerHosts,
} from "./remote-runner-hosts";

const hosts = useRemoteRunnerHosts("shell-fallback");

describe("remote runner shell fallback", () => {
  it(
    "falls back to a cancellable shell on an unsupported platform",
    async () => {
      const host = hosts.freshHost();
      await writeFile(path.join(hosts.tempDir, `${host}.plan9`), "");
      const plain = await sshExecBash({ host, cmd: "echo fallback; exit 3", maxOutputChars: 100 });
      expect(plain).toMatchObject({ stdout: "fallback\n", exitCode: 3 });
      expect((await hosts.calls(host)).some((call) => call.includes("lilac-upload"))).toBeFalse();

      const pidFile = path.join(hosts.tempDir, `${host}.pids`);
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
    "the shell fallback kills a child that ignores SIGTERM",
    async () => {
      const host = hosts.freshHost();
      await writeFile(path.join(hosts.tempDir, `${host}.plan9`), "");
      const pidFile = path.join(hosts.tempDir, `${host}.pids`);
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
});
