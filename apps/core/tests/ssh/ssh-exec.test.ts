import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";

import { invalidateRemoteRunner } from "../../src/ssh/remote-runner-deploy";
import { readStreamTextCapped, sshExecBash } from "../../src/ssh/ssh-exec";
import { remoteReadTextFile } from "../../src/tools/fs/remote-fs";
import { SSH } from "../../src/tool-server/tools/ssh";
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

# Like sshd, hand the remote command words to a shell.
exec sh -c "$*"
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
    // The deployment cache outlives this file; its runner lives in the temp dir removed below.
    invalidateRemoteRunner("fakehost");
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
      patchText: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch",
    });

    // Depending on what is cached for the host, the failure surfaces before or after path resolution.
    expect(readOutput.resolvedPath).toMatch(/^ssh:\/\/fakehost\/(.*\/)?missing\.ts$/);
    expect(readOutput.error.message).toContain("code 23");
    expect(patchOutput.ok).toBeFalse();
    if (!patchOutput.ok) expect(patchOutput.error).toContain("code 23");
  });
});
