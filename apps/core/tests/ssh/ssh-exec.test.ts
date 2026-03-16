import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sshExecBash, sshExecScriptJson } from "../../src/ssh/ssh-exec";

describe("ssh exec transport", () => {
  let tempDir = "";
  let previousPath: string | undefined;
  let previousSshConfigPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "lilac-ssh-exec-"));

    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    const sshPath = path.join(binDir, "ssh");
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
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;

    if (previousSshConfigPath === undefined) {
      delete process.env.LILAC_SSH_CONFIG_PATH;
    } else {
      process.env.LILAC_SSH_CONFIG_PATH = previousSshConfigPath;
    }

    await rm(tempDir, { recursive: true, force: true });
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

    const result = await sshExecScriptJson<number>({
      host: "fakehost",
      cwd: "~",
      js,
      input: { op: "noop" },
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result).toEqual({ ok: true, value: 200_000 });
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
});
