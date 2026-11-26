import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidateRemoteRunner } from "../../src/ssh/remote-runner-deploy";
import { parseSshHostsFromConfigText } from "../../src/ssh/ssh-config";
import { SSH } from "../../src/tool-server/tools/ssh";

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function rejectedStream(reason: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(reason);
    },
  });
}

function rejectedPromise<T>(reason: unknown): Promise<T> {
  const promise = Promise.reject<T>(reason);
  void promise.catch(() => undefined);
  return promise;
}

function mockSshProcess(input: {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited?: Promise<number>;
}): Bun.Subprocess<Blob, "pipe", "pipe"> {
  return {
    stdout: input.stdout ?? textStream(),
    stderr: input.stderr ?? textStream(),
    exited: input.exited ?? Promise.resolve(0),
  } as unknown as Bun.Subprocess<Blob, "pipe", "pipe">;
}

/**
 * Answers Core's runner deployment probe with an unsupported platform, so the call takes the shell
 * path and the mocked `child` stands in for the command's own SSH process.
 */
function spawnCommandAs(child: Bun.Subprocess<Blob, "pipe", "pipe">) {
  return (command: string[] | object) =>
    Array.isArray(command) && command.some((part) => String(part).includes("lilac-probe"))
      ? mockSshProcess({ stdout: textStream("platform Plan9 x86_64\nbase /tmp/lilac\n") })
      : child;
}

// Runner deployments are cached per host for the whole process, and these tests answer the probe
// for "fakehost" with an unsupported platform. Forget it so later test files can deploy there.
afterEach(() => invalidateRemoteRunner("fakehost"));

async function withConfiguredSshHost<T>(run: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-level2-ssh-config-"));
  const configPath = path.join(root, "ssh-config");
  const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
  try {
    await writeFile(configPath, "Host fakehost\n  HostName localhost\n", "utf8");
    process.env.LILAC_SSH_CONFIG_PATH = configPath;
    return await run();
  } finally {
    if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
    else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
    await rm(root, { recursive: true, force: true });
  }
}

describe("parseSshHostsFromConfigText", () => {
  it("parses simple Host aliases", () => {
    const text = `
Host foo
  HostName example.com

Host bar baz
  User ubuntu
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["foo", "bar", "baz"]);
  });

  it("ignores wildcard and negated entries", () => {
    const text = `
Host *
  ForwardAgent no

Host foo*
  HostName example.com

Host !bad good
  HostName example.org
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["good"]);
  });

  it("ignores comments", () => {
    const text = `
# Host commented
Host alpha # trailing comment
  HostName example.com
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["alpha"]);
  });

  it("returns missing configured hosts as a semantic failure", async () => {
    const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    process.env.LILAC_SSH_CONFIG_PATH = path.join(tmpdir(), `missing-ssh-${crypto.randomUUID()}`);
    try {
      expect(await new SSH().call("ssh.run", { host: "missing", cmd: "true" })).toMatchObject({
        status: "error",
        error: { kind: "not_found", code: "ssh_not_found", retryable: false },
      });
    } finally {
      if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
      else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
    }
  });

  it("keeps a remote command nonzero exit as a successful report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-level2-ssh-"));
    const binDir = path.join(root, "bin");
    const configPath = path.join(root, "ssh-config");
    const sshPath = path.join(binDir, "ssh");
    const previousPath = process.env.PATH;
    const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    try {
      await mkdir(binDir);
      await writeFile(configPath, "Host fakehost\n  HostName localhost\n", "utf8");
      await writeFile(sshPath, "#!/usr/bin/env bash\nprintf 'remote failed' >&2\nexit 7\n", "utf8");
      await chmod(sshPath, 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.LILAC_SSH_CONFIG_PATH = configPath;

      expect(await new SSH().call("ssh.run", { host: "fakehost", cmd: "exit 7" })).toMatchObject({
        status: "ok",
        value: { ok: false, exitCode: 7, timedOut: false, stderr: "remote failed" },
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
      else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ordinary stream and exit failures in a successful command report", async () => {
    await withConfiguredSshHost(async () => {
      const child = mockSshProcess({
        stdout: rejectedStream(new Error("stdout unavailable")),
        exited: rejectedPromise(new Error("exit unavailable")),
      });
      const spawn = spyOn(Bun, "spawn").mockImplementation(
        spawnCommandAs(child) as typeof Bun.spawn,
      );
      try {
        expect(await new SSH().call("ssh.run", { host: "fakehost", cmd: "true" })).toMatchObject({
          status: "ok",
          value: {
            ok: false,
            exitCode: -1,
            errors: {
              stdoutRead: "stdout read failed",
              exitRead: "exit status read failed",
            },
          },
        });
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("keeps an ordinary probe stream failure in a successful report", async () => {
    await withConfiguredSshHost(async () => {
      const child = mockSshProcess({ stdout: rejectedStream(new Error("stdout unavailable")) });
      const spawn = spyOn(Bun, "spawn").mockImplementation(
        spawnCommandAs(child) as typeof Bun.spawn,
      );
      try {
        expect(await new SSH().call("ssh.probe", { host: "fakehost" })).toMatchObject({
          status: "ok",
          value: {
            ok: false,
            parseError: undefined,
            errors: { stdoutRead: "Error: stdout unavailable" },
          },
        });
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("keeps an SSH transport failure as a successful report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-level2-ssh-"));
    const binDir = path.join(root, "bin");
    const configPath = path.join(root, "ssh-config");
    const sshPath = path.join(binDir, "ssh");
    const previousPath = process.env.PATH;
    const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    try {
      await mkdir(binDir);
      await writeFile(configPath, "Host fakehost\n  HostName localhost\n", "utf8");
      await writeFile(
        sshPath,
        "#!/usr/bin/env bash\nprintf 'Permission denied' >&2\nexit 255\n",
        "utf8",
      );
      await chmod(sshPath, 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.LILAC_SSH_CONFIG_PATH = configPath;

      expect(await new SSH().call("ssh.run", { host: "fakehost", cmd: "true" })).toMatchObject({
        status: "ok",
        value: {
          ok: false,
          exitCode: 255,
          transportError: { type: "auth", message: "Permission denied" },
        },
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
      else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an explicit timeout as a semantic timeout failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-level2-ssh-"));
    const binDir = path.join(root, "bin");
    const configPath = path.join(root, "ssh-config");
    const sshPath = path.join(binDir, "ssh");
    const previousPath = process.env.PATH;
    const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    try {
      await mkdir(binDir);
      await writeFile(configPath, "Host fakehost\n  HostName localhost\n", "utf8");
      // Like the shell fallback, the fake host stops the command when Core closes stdin.
      await writeFile(
        sshPath,
        `#!/usr/bin/env bash
case "$*" in *lilac-probe*) echo "platform Plan9 x86_64"; echo "base /tmp/lilac"; exit 0 ;; esac
cat >/dev/null
exit 143
`,
        "utf8",
      );
      await chmod(sshPath, 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.LILAC_SSH_CONFIG_PATH = configPath;

      expect(
        await new SSH().call("ssh.run", {
          host: "fakehost",
          cmd: "true",
          timeoutMs: 10,
        }),
      ).toMatchObject({
        status: "error",
        error: { kind: "timeout", code: "ssh_timeout", retryable: true },
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
      else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
