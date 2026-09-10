import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER_ENTRY = path.join(import.meta.dir, "launcher.ts");
const NATIVE_LAUNCHER_SOURCE = path.join(import.meta.dir, "native-launcher.go");
let nativeFixtureRoot = "";
let nativeLauncherPath = "";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type LauncherResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type WorkerHealth = {
  readonly buildId: string;
  readonly pid: number;
};

async function runLauncher(params: {
  readonly args: readonly string[];
  readonly backendUrl: string;
  readonly workerDir: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}): Promise<LauncherResult> {
  const process = Bun.spawn([nativeLauncherPath, ...params.args], {
    cwd: params.cwd ?? import.meta.dir,
    env: {
      ...globalThis.process.env,
      ...params.env,
      TOOL_SERVER_BACKEND_URL: params.backendUrl,
      LILAC_TOOL_WORKER_DIR: params.workerDir,
      NO_COLOR: "1",
    },
    stdin: params.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (params.stdin !== undefined && process.stdin) {
    process.stdin.write(params.stdin);
    process.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function workerSocketName(directory: string, id: string): string {
  const identity = createHash("sha256")
    .update(`${path.join(directory, "tools-worker")}\0${id}`)
    .digest("hex")
    .slice(0, 8);
  return `${identity}.sock`;
}

async function readWorkerHealth(workerDir: string): Promise<WorkerHealth> {
  const uid = process.getuid?.() ?? 0;
  const response = await fetch("http://localhost/health", {
    unix: path.join(workerDir, String(uid), workerSocketName(nativeFixtureRoot, "dev")),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as WorkerHealth;
}

function stopWorker(worker: WorkerHealth | undefined): void {
  if (worker) process.kill(worker.pid, "SIGTERM");
}

describe("resident tools worker", () => {
  // Cold Go builds on CI compile the standard library and can exceed Bun's default hook timeout.
  beforeAll(async () => {
    nativeFixtureRoot = await fs.mkdtemp(path.join(tmpdir(), "lilac-native-tools-test-"));
    nativeLauncherPath = path.join(nativeFixtureRoot, "tools");
    const compiler = Bun.which("go");
    expect(compiler).toBeTruthy();
    const compiled = Bun.spawnSync(
      [
        compiler ?? "go",
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-buildmode=pie",
        "-ldflags",
        "-s -w",
        "-o",
        nativeLauncherPath,
        NATIVE_LAUNCHER_SOURCE,
      ],
      { env: { ...process.env, CGO_ENABLED: "0" } },
    );
    expect(compiled.stderr.toString()).toBe("");
    expect(compiled.exitCode).toBe(0);
    await fs.writeFile(path.join(nativeFixtureRoot, "tools-build-id"), "dev\n");
    await fs.writeFile(
      path.join(nativeFixtureRoot, "tools-worker"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(LAUNCHER_ENTRY)} "$@"\n`,
      { mode: 0o755 },
    );
  }, 120_000);

  afterAll(async () => {
    await fs.rm(nativeFixtureRoot, { recursive: true, force: true });
  });

  it("builds the launcher without cgo or unsafe Go", async () => {
    const source = await fs.readFile(NATIVE_LAUNCHER_SOURCE, "utf8");
    const buildInfo = Bun.spawnSync(["go", "version", "-m", nativeLauncherPath]);

    expect(source).not.toContain('"unsafe"');
    expect(source).not.toContain('import "C"');
    expect(buildInfo.exitCode).toBe(0);
    expect(buildInfo.stdout.toString()).toContain("CGO_ENABLED=0");
  });

  it("reads installed metadata on demand and switches workers when the shared ID changes", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ltbi-"));
    const executable = path.join(root, "tools");
    const workerExecutable = path.join(root, "tools-worker");
    const workerDir = path.join(root, "run");
    const metadataPath = path.join(root, "tools-build-info.json");
    const idPath = path.join(root, "tools-build-id");
    const workers = new Set<number>();
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ ok: true, version: "dev", commit: "backend" });
      },
    });
    async function invoke(launcher = executable): Promise<LauncherResult> {
      const child = Bun.spawn([launcher, "--version"], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          LILAC_TOOL_WORKER_DIR: workerDir,
          TOOL_SERVER_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
          TOOL_SERVER_BACKEND_SOCKET: "",
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    }
    async function health(id: string, installation = root): Promise<WorkerHealth> {
      const response = await fetch("http://localhost/health", {
        unix: path.join(
          workerDir,
          String(process.getuid?.() ?? 0),
          workerSocketName(installation, id),
        ),
      });
      const value = (await response.json()) as WorkerHealth;
      workers.add(value.pid);
      return value;
    }
    try {
      await fs.copyFile(nativeLauncherPath, executable);
      const built = await Bun.build({
        entrypoints: [LAUNCHER_ENTRY],
        target: "bun",
        minify: true,
        bytecode: true,
        compile: {
          outfile: workerExecutable,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadPackageJson: false,
        },
        define: { __LILAC_TOOL_COMPILED__: "true", __LILAC_TOOL_AUTOSTART__: "false" },
      });
      expect(built.success).toBe(true);
      await fs.writeFile(idPath, "deadbeef\n");
      await fs.writeFile(metadataPath, JSON.stringify({ version: "v1", commit: "first" }));
      const first = await invoke();
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toBe("");
      expect(first.stdout).toContain("[commit: first] [build: deadbeef]");
      const original = await health("deadbeef");

      await fs.writeFile(
        metadataPath,
        JSON.stringify({ version: "v2", commit: "second", dirty: true }),
      );
      const second = await invoke();
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("[commit: second] [build: deadbeef] [dirty]");
      expect((await health("deadbeef")).pid).toBe(original.pid);

      const otherRoot = path.join(root, "other");
      await fs.mkdir(otherRoot);
      await fs.copyFile(executable, path.join(otherRoot, "tools"));
      await fs.copyFile(workerExecutable, path.join(otherRoot, "tools-worker"));
      await fs.copyFile(idPath, path.join(otherRoot, "tools-build-id"));
      await fs.writeFile(
        path.join(otherRoot, "tools-build-info.json"),
        JSON.stringify({ version: "v3", commit: "other-installation" }),
      );
      const other = await invoke(path.join(otherRoot, "tools"));
      expect(other.exitCode).toBe(0);
      expect(other.stdout).toContain("[commit: other-installation] [build: deadbeef]");
      const otherWorker = await health("deadbeef", otherRoot);
      expect(otherWorker.pid).not.toBe(original.pid);
      expect((await invoke()).stdout).toContain("[commit: second] [build: deadbeef]");

      await fs.writeFile(idPath, "cafefeed\n");
      const changed = await invoke();
      expect(changed.exitCode).toBe(0);
      expect(changed.stdout).toContain("[commit: second] [build: cafefeed]");
      const replacement = await health("cafefeed");
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.buildId).toBe("cafefeed");

      const mismatch = await fetch("http://localhost/invoke", {
        unix: path.join(
          workerDir,
          String(process.getuid?.() ?? 0),
          workerSocketName(root, "cafefeed"),
        ),
        method: "POST",
        body: JSON.stringify({ buildId: "deadbeef" }),
      });
      expect(mismatch.status).toBe(400);

      for (const id of ["", "../wrong", "ABCDEFGH", "123456789"]) {
        await fs.writeFile(idPath, id);
        const invalid = await invoke();
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr).toContain("bridge_launcher_defect");
        const worker = Bun.spawn([workerExecutable, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await worker.exited).toBe(1);
        expect(await new Response(worker.stderr).text()).toContain("bridge_launcher_defect");
      }
      await fs.rm(idPath);
      expect((await invoke()).exitCode).toBe(1);
    } finally {
      for (const pid of workers) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      backend.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps operator credentials scoped to one invocation", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ltwo-"));
    const workerDir = root;
    const tokenPath = path.join(root, "operator-token");
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        return Response.json({
          status: "ok",
          value: {
            operatorToken: request.headers.get("x-lilac-operator-token"),
          },
        });
      },
    });
    let worker: WorkerHealth | undefined;

    try {
      const backendUrl = `http://127.0.0.1:${server.port}`;
      const operator = await runLauncher({
        args: ["--operator", "test.echo", "--value=operator"],
        backendUrl,
        workerDir,
        cwd: root,
        env: {
          LILAC_OPERATOR_TOKEN_FILE: path.basename(tokenPath),
          TOOL_SERVER_BACKEND_SOCKET: path.join(root, "unavailable.sock"),
        },
      });
      const normal = await runLauncher({
        args: ["test.echo", "--value=normal"],
        backendUrl,
        workerDir,
      });
      expect(operator.stderr).toBe("");
      expect(operator.exitCode).toBe(0);
      expect(normal.exitCode).toBe(0);
      worker = await readWorkerHealth(workerDir);

      expect(JSON.parse(operator.stdout)).toEqual({ operatorToken: token });
      expect(JSON.parse(normal.stdout)).toEqual({ operatorToken: null });
    } finally {
      stopWorker(worker);
      server.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses one worker while isolating concurrent invocation context", async () => {
    const workerDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-test-"));
    const cwdA = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-a-"));
    const cwdB = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-b-"));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as {
          callableId: string;
          input: unknown;
        };
        if (body.callableId === "test.failure") {
          return Response.json({
            status: "error",
            error: {
              kind: "denied",
              code: "test_denied",
              message: "test denial",
              retryable: false,
            },
          });
        }
        return Response.json({
          status: "ok",
          value: {
            cwd: request.headers.get("x-lilac-cwd"),
            requestId: request.headers.get("x-lilac-request-id"),
            input: body.input,
          },
        });
      },
    });
    let worker: WorkerHealth | undefined;

    try {
      const backendUrl = `http://127.0.0.1:${server.port}`;
      const [resultA, resultB] = await Promise.all([
        runLauncher({
          args: ["test.echo", "--value=a", "--file-path=~/a"],
          backendUrl,
          workerDir,
          cwd: cwdA,
          env: { HOME: cwdA, LILAC_REQUEST_ID: "request-a" },
        }),
        runLauncher({
          args: ["test.echo", "--value=b", "--file-path=~/b"],
          backendUrl,
          workerDir,
          cwd: cwdB,
          env: { HOME: cwdB, LILAC_REQUEST_ID: "request-b" },
        }),
      ]);
      const stdinResult = await runLauncher({
        args: ["test.echo", "--stdin"],
        backendUrl,
        workerDir,
        stdin: '{"value":"quote\\\" and newline\\n"}',
      });
      const failure = await runLauncher({
        args: ["test.failure"],
        backendUrl,
        workerDir,
      });
      worker = await readWorkerHealth(workerDir);

      expect(resultA).toEqual({
        stdout: `${JSON.stringify({ cwd: cwdA, requestId: "request-a", input: { value: "a", filePath: `${cwdA}/a` } })}\n`,
        stderr: "",
        exitCode: 0,
      });
      expect(resultB).toEqual({
        stdout: `${JSON.stringify({ cwd: cwdB, requestId: "request-b", input: { value: "b", filePath: `${cwdB}/b` } })}\n`,
        stderr: "",
        exitCode: 0,
      });
      expect(stdinResult).toEqual({
        stdout: `${JSON.stringify({ cwd: import.meta.dir, requestId: null, input: { value: 'quote" and newline\n' } })}\n`,
        stderr: "",
        exitCode: 0,
      });
      expect(failure.stdout).toBe("");
      expect(JSON.parse(failure.stderr)).toEqual({
        status: "error",
        error: {
          kind: "denied",
          code: "test_denied",
          message: "test denial",
          retryable: false,
        },
      });
      expect(failure.exitCode).not.toBe(0);
      expect((await readWorkerHealth(workerDir)).pid).toBe(worker.pid);
    } finally {
      stopWorker(worker);
      server.stop(true);
      await Promise.all([
        fs.rm(workerDir, { recursive: true, force: true }),
        fs.rm(cwdA, { recursive: true, force: true }),
        fs.rm(cwdB, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not consume an open stdin pipe for commands that ignore stdin", async () => {
    const workerDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-help-"));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/versionz") {
          return Response.json({ ok: true, version: "dev", commit: "dev" });
        }
        if (pathname === "/list") return Response.json({ tools: [] });
        return new Response("Not found", { status: 404 });
      },
    });
    const cases = [
      { args: ["--help"], exitCode: 0 },
      { args: ["--version", "--stdin"], exitCode: 0 },
      { args: ["--list", "--stdin"], exitCode: 0 },
      { args: ["--unknown", "--stdin"], exitCode: 2 },
      { args: ["onboard", "--stdin"], exitCode: 2 },
    ] as const;

    try {
      for (const testCase of cases) {
        const process = Bun.spawn([nativeLauncherPath, ...testCase.args], {
          env: {
            ...globalThis.process.env,
            LILAC_TOOL_WORKER_DIR: workerDir,
            TOOL_SERVER_BACKEND_URL: `http://127.0.0.1:${server.port}`,
            NO_COLOR: "1",
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const guard = setTimeout(() => process.kill("SIGKILL"), 5_000);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        clearTimeout(guard);
        if (process.stdin) process.stdin.end();

        expect(exitCode).toBe(testCase.exitCode);
        if (testCase.exitCode === 0) expect(stderr).toBe("");
        if (testCase.args[0] === "--help") {
          expect(stdout).toContain("tools - All-in-one tool proxy [commit: dev] [build: dev]");
        }
      }
    } finally {
      const runtimeDir = path.join(workerDir, String(process.getuid?.() ?? 0));
      const socketName = (await fs.readdir(runtimeDir)).find((name) => name.endsWith(".sock"));
      if (socketName) {
        const response = await fetch("http://localhost/health", {
          unix: path.join(runtimeDir, socketName),
        });
        const health = (await response.json()) as WorkerHealth;
        stopWorker(health);
      }
      server.stop(true);
      await fs.rm(workerDir, { recursive: true, force: true });
    }
  });

  it("does not change permissions on an existing worker directory", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-mode-"));
    const workerDir = path.join(root, "shared");
    const runtimeDir = path.join(workerDir, String(process.getuid?.() ?? 0));
    await fs.mkdir(workerDir, { mode: 0o755 });
    await fs.chmod(workerDir, 0o755);
    await fs.mkdir(runtimeDir, { mode: 0o755 });
    await fs.chmod(runtimeDir, 0o755);

    try {
      const result = Bun.spawnSync([nativeLauncherPath, "--help"], {
        env: {
          ...process.env,
          LILAC_TOOL_WORKER_DIR: workerDir,
          NO_COLOR: "1",
        },
      });
      expect(result.exitCode).toBe(1);
      expect((await fs.stat(workerDir)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(runtimeDir)).mode & 0o777).toBe(0o755);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves piped stdin when worker startup fails", async () => {
    const workerDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-fallback-"));
    const uid = process.getuid?.() ?? 0;
    const runtimeDir = path.join(workerDir, String(uid));
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const lockPath = path.join(runtimeDir, `${workerSocketName(nativeFixtureRoot, "dev")}.lock`);
    await fs.mkdir(lockPath);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { input: unknown };
        return Response.json({ status: "ok", value: body.input });
      },
    });

    try {
      const result = await runLauncher({
        args: ["test.echo", "--stdin"],
        backendUrl: `http://127.0.0.1:${server.port}`,
        workerDir,
        stdin: '{"value":"fallback"}',
      });
      expect(result).toEqual({
        stdout: '{"value":"fallback"}\n',
        stderr: "",
        exitCode: 0,
      });
    } finally {
      server.stop(true);
      await fs.rm(workerDir, { recursive: true, force: true });
    }
  });

  it("shuts down an obsolete worker from the same installation", async () => {
    const workerDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-rebuild-"));
    const uid = process.getuid?.() ?? 0;
    const runtimeDir = path.join(workerDir, String(uid));
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const oldSocketPath = path.join(runtimeDir, "old.sock");
    const oldWorkerRequests: string[] = [];
    const oldWorker = Bun.serve({
      unix: oldSocketPath,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        oldWorkerRequests.push(pathname);
        if (pathname === "/health") {
          return Response.json({
            buildId: "old",
            pid: process.pid,
            executable: path.join(nativeFixtureRoot, "tools-worker"),
          });
        }
        if (pathname === "/shutdown" && request.method === "POST") {
          return Response.json({ ok: true });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ status: "ok", value: { ok: true } });
      },
    });
    let currentWorker: WorkerHealth | undefined;

    try {
      const result = await runLauncher({
        args: ["test.echo", "--value=rebuild"],
        backendUrl: `http://127.0.0.1:${backend.port}`,
        workerDir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(oldWorkerRequests).toContain("/health");
      expect(oldWorkerRequests).toContain("/shutdown");
      currentWorker = await readWorkerHealth(workerDir);
    } finally {
      stopWorker(currentWorker);
      oldWorker.stop(true);
      backend.stop(true);
      await fs.rm(workerDir, { recursive: true, force: true });
    }
  });

  it("cancels the worker's backend request when the launcher is terminated", async () => {
    const workerDir = await fs.mkdtemp(path.join(tmpdir(), "lilac-tools-worker-signal-"));
    const requestStarted = Promise.withResolvers<void>();
    const requestAborted = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { callableId: string };
        if (body.callableId !== "test.slow") {
          return Response.json({ status: "ok", value: { ok: true } });
        }
        request.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true });
        requestStarted.resolve();
        await requestAborted.promise;
        return Response.json({ status: "error", error: { kind: "cancelled" } });
      },
    });
    let worker: WorkerHealth | undefined;

    try {
      const backendUrl = `http://127.0.0.1:${server.port}`;
      const warmed = await runLauncher({
        args: ["test.echo", "--value=warm"],
        backendUrl,
        workerDir,
      });
      expect(warmed.exitCode).toBe(0);
      worker = await readWorkerHealth(workerDir);

      const launcher = Bun.spawn([nativeLauncherPath, "test.slow", "--value=wait"], {
        env: {
          ...process.env,
          TOOL_SERVER_BACKEND_URL: backendUrl,
          LILAC_TOOL_WORKER_DIR: workerDir,
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await requestStarted.promise;
      launcher.kill("SIGTERM");
      await launcher.exited;
      await requestAborted.promise;
    } finally {
      requestAborted.resolve();
      stopWorker(worker);
      server.stop(true);
      await fs.rm(workerDir, { recursive: true, force: true });
    }
  });
});
