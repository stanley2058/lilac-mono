import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sshExecBash, sshExecScriptJson } from "../../src/ssh/ssh-exec";
import { remoteFuzzySearch } from "../../src/tools/fs/remote-fs";

describe("ssh exec transport", () => {
  let tempDir = "";
  let binDir = "";
  let previousPath: string | undefined;
  let previousSshConfigPath: string | undefined;
  let previousRemoteRunnerCommand: string | undefined;
  let previousRemoteRunnerPackage: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "lilac-ssh-exec-"));

    binDir = path.join(tempDir, "bin");
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

  it("passes JSON stdin to the default remote FFF runner command", async () => {
    const npxPath = path.join(binDir, "npx");
    await writeFile(
      npxPath,
      `#!/usr/bin/env bash
set -euo pipefail
payload=$(cat)
if [[ "$payload" != *'"op":"fs.fuzzy_search"'* ]]; then
  printf '%s' '{"ok":false,"error":"missing fuzzy op"}'
  exit 0
fi
printf '%s' '{"ok":true,"value":{"results":[{"path":"package.json","fileName":"package.json","size":123,"gitStatus":"clean","score":1}],"totalMatched":1,"totalFiles":1,"truncated":false,"effectiveBackend":"fff"}}'
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

    expect(result).toEqual({
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
});
