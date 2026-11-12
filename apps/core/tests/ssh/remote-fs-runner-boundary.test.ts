import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bundledRemoteRunnerRequestSchema,
  decodeRemoteHealthResponseJson,
  FileSystem,
  remoteFsRequestSchema,
  remoteHealthRequestSchema,
  type FsBackend,
  type RemoteReadBytesResponse,
} from "@stanley2058/lilac-fs";
import type { Result } from "better-result";
import type { Tool } from "ai";

import { sshExecBash } from "../../src/ssh/ssh-exec";
import { applyHunks, parsePatchResult } from "../../src/tools/apply-patch/apply-patch-core";
import { remoteApplyPatch } from "../../src/tools/apply-patch/remote-apply-patch";
import { fsTool } from "../../src/tools/fs/fs";
import {
  remoteEditFile,
  remoteFuzzySearch,
  remoteGlob,
  remoteGrep,
  remoteReadFileBytes,
  remoteReadTextFile,
} from "../../src/tools/fs/remote-fs";

// Every request operation the remote runners accept. A new protocol operation fails the coverage
// test until this suite exercises it against the built runner.
const COVERED_OPERATIONS = [
  "apply_patch",
  "fs.edit",
  "fs.fuzzy_search",
  "fs.glob",
  "fs.grep",
  "fs.read_bytes",
  "fs.read_text",
  "health",
];

const HOST = "fakehost";
const TEST_TIMEOUT_MS = 30_000;
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const runnerPackageDir = path.join(repoRoot, "packages/remote-fs-runner");

let tempDir = "";
let tree = "";
let cleanTree = "";
let remoteHome = "";
let runtimeDir = "";
let callsPath = "";
let runnerSpec = "";
let previousPath: string | undefined;
let previousSshConfigPath: string | undefined;
let previousRunnerCommand: string | undefined;
let previousRunnerPackage: string | undefined;

type LocalBytesResult = Awaited<ReturnType<FileSystem["readFileBytes"]>>;

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

async function writeTree(root: string, files: Record<string, string | Uint8Array>) {
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
}

function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

async function launchCounts(): Promise<{ runner: number; bundled: number }> {
  const lines = (await readFile(callsPath, "utf8").catch(() => "")).split("\n");
  return {
    runner: lines.filter((line) => line === "runner request").length,
    bundled: lines.filter((line) => line === "bundled").length,
  };
}

// Core falls back to the bundled runner when the package runner fails, so a passing search alone
// does not prove the package runner answered it.
async function expectServedByPackageRunner<T>(operation: () => Promise<T>): Promise<T> {
  const before = await launchCounts();
  const value = await operation();
  const after = await launchCounts();
  expect(after.runner - before.runner).toBe(1);
  expect(after.bundled - before.bundled).toBe(0);
  return value;
}

function bytesOnWire(result: LocalBytesResult): RemoteReadBytesResponse {
  if (!result.success) {
    return {
      ok: false,
      resolvedPath: result.resolvedPath,
      error: result.error.message,
      errorCode: result.error.code,
    };
  }
  return {
    ok: true,
    resolvedPath: result.resolvedPath,
    fileHash: result.fileHash,
    bytesLength: result.bytesLength,
    ...(result.totalBytes === undefined ? {} : { totalBytes: result.totalBytes }),
    base64: Buffer.from(result.bytes).toString("base64"),
  };
}

// ripgrep and fd search in parallel, so result order is not part of the glob or grep contract.
function unordered(value: object): object {
  const sorted: Record<string, unknown> = { ...value };
  for (const key of ["paths", "entries", "results"]) {
    const list = sorted[key];
    if (!Array.isArray(list)) continue;
    sorted[key] = list.toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return sorted;
}

function localFileSystem(root: string, denyPaths: readonly string[], backend?: FsBackend) {
  if (backend !== "fff") return new FileSystem(root, { denyPaths });
  return new FileSystem(root, {
    denyPaths,
    fsBackend: "fff",
    fffCacheDir: path.join(tempDir, `local-fff-${path.basename(root)}`),
    fuzzySearchFallback: "fzf",
  });
}

async function executeTool(toolValue: Tool | undefined, input: unknown): Promise<unknown> {
  if (!toolValue?.execute) throw new Error("tool has no execute function");
  const output = toolValue.execute(input, { toolCallId: "boundary", messages: [], context: {} });
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    let last: unknown;
    for await (const chunk of output as AsyncIterable<unknown>) last = chunk;
    return last;
  }
  return await output;
}

async function remoteHealth(runnerDir = runtimeDir) {
  const res = await sshExecBash({
    host: HOST,
    cmd: `LILAC_REMOTE_FS_RUNNER_DIR='${runnerDir}' bunx --no-install '${runnerSpec}' health`,
    cwd: tree,
    timeoutMs: 10_000,
    maxOutputChars: 10_000,
  });
  if (res.exitCode !== 0) throw new Error(`remote health exited ${res.exitCode}: ${res.stderr}`);
  return decodeRemoteHealthResponseJson(res.stdout.trim());
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "lilac-rfs-"));
  // Unix socket paths are limited to about 104 bytes, and the shared test temp root is deep.
  runtimeDir = await mkdtemp("/tmp/lrfs-");
  const binDir = path.join(tempDir, "bin");
  const runnerDir = path.join(tempDir, "runner");
  remoteHome = path.join(tempDir, "home");
  tree = path.join(tempDir, "tree");
  cleanTree = path.join(tempDir, "clean");
  callsPath = path.join(tempDir, "launches.log");
  await mkdir(binDir, { recursive: true });

  const built = await run(["bun", "build.ts", "--outdir", runnerDir], runnerPackageDir);
  if (built.exitCode !== 0) throw new Error(`remote fs runner build failed: ${built.stderr}`);
  // The bundle keeps fff-node external, as the published package does.
  await mkdir(path.join(runnerDir, "node_modules/@ff-labs"), { recursive: true });
  await symlink(
    path.join(runnerPackageDir, "node_modules/@ff-labs/fff-node"),
    path.join(runnerDir, "node_modules/@ff-labs/fff-node"),
  );
  const runnerPackage = await Bun.file(path.join(runnerPackageDir, "package.json")).json();
  runnerSpec = `${runnerPackage.name}@${runnerPackage.version}`;

  // The ssh shim runs the command locally with a separate HOME, standing in for the remote host.
  await writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-T" ]; then shift; continue; fi
  if [ "$1" = "-o" ]; then shift 2; continue; fi
  shift
  break
done
export HOME=${JSON.stringify(remoteHome)}
export LILAC_REMOTE_FS_RUNNER_DIR=${JSON.stringify(runtimeDir)}
export LILAC_REMOTE_FS_IDLE_MS=60000
unset XDG_CACHE_HOME
exec "$@"
`,
  );
  // bunx resolves the pinned package spec to the freshly built runner, so Core's production
  // launch script runs unchanged.
  await writeExecutable(
    path.join(binDir, "bunx"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--no-install" ]; then shift; fi
if [ "\${1:-}" != ${JSON.stringify(runnerSpec)} ]; then
  echo "unexpected remote fs runner package spec: \${1:-}" >&2
  exit 64
fi
shift
if [ "\${1:-}" = "request" ]; then echo "runner request" >> ${JSON.stringify(callsPath)}; fi
exec ${JSON.stringify(path.join(runnerDir, "cli.js"))} "$@"
`,
  );
  await writeExecutable(
    path.join(binDir, "bun"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  */lilac/remote-runners/*) echo "bundled" >> ${JSON.stringify(callsPath)} ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );

  const sshConfigPath = path.join(tempDir, "ssh-config");
  await writeFile(sshConfigPath, `Host ${HOST}\n  HostName 127.0.0.1\n  User tester\n`);
  previousPath = process.env.PATH;
  previousSshConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
  previousRunnerCommand = process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
  previousRunnerPackage = process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
  delete process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
  delete process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;

  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 0, 16]);
  const largeLog = Array.from(
    { length: 50_000 },
    (_, index) => `line ${index} ${index % 1000 === 0 ? "needle" : "hay"}`,
  ).join("\n");
  await writeTree(tree, {
    "src/main.ts": "export const needle = 1;\nconst other = 2;\n",
    "src/util.ts": "export function needleHelper() {}\n",
    "README.md": "# Title\nA needle in the readme.\n",
    ".hidden/config.ts": "export const hiddenNeedle = true;\n",
    ".env": "SECRET_NEEDLE=1\n",
    "secret/keys.txt": "needle in a denied file\n",
    "assets/image.png": binary,
    "large.log": largeLog,
  });
  await writeTree(cleanTree, {
    "src/main.ts": "export const needle = 1;\n",
    "src/util.ts": "export function needleHelper() {}\n",
    "docs/guide.md": "Find the needle here.\n",
    ".env": "NEEDLE=1\n",
  });
  await writeTree(remoteHome, { ".ssh/id_ed25519": "private needle\n" });
}, 60_000);

afterAll(async () => {
  const health = runnerSpec ? await remoteHealth().catch(() => undefined) : undefined;
  if (health?.status === "ok") process.kill(health.value.pid, "SIGTERM");
  process.env.PATH = previousPath;
  for (const [name, value] of [
    ["LILAC_SSH_CONFIG_PATH", previousSshConfigPath],
    ["LILAC_REMOTE_FS_RUNNER_COMMAND", previousRunnerCommand],
    ["LILAC_REMOTE_FS_RUNNER_PACKAGE", previousRunnerPackage],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
  if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
});

describe("remote fs runner boundary", () => {
  it("covers every request operation in the runner protocol", () => {
    const protocolOperations = new Set<string>(
      [
        ...remoteFsRequestSchema.options,
        ...bundledRemoteRunnerRequestSchema.options,
        remoteHealthRequestSchema,
      ].map((schema) => schema.shape.op.value),
    );
    expect([...protocolOperations].sort()).toEqual(COVERED_OPERATIONS);
  });

  it(
    "reads text like the local filesystem, including hidden, binary, large, and denied files",
    async () => {
      const denyPaths = [path.join(tree, "secret")];
      const local = localFileSystem(tree, denyPaths);
      const cases = [
        { path: "src/main.ts" },
        { path: "src/main.ts", format: "numbered" },
        { path: "src/main.ts", format: "hashline" },
        { path: ".env" },
        { path: "assets/image.png" },
        { path: "large.log", start: { type: "line", line: 1000 }, maxLines: 50 },
        { path: "large.log", start: { type: "offset", offset: 5_000 }, maxCharacters: 200 },
        { path: "large.log", maxBytes: 1_000 },
        { path: "secret/keys.txt" },
        { path: "missing.ts" },
      ] as const;

      for (const input of cases) {
        const remote = unwrap(
          await remoteReadTextFile({ host: HOST, cwd: tree, input, denyPaths }),
        );
        const expected = await local.readFile({
          ...input,
          format: "format" in input ? input.format : "raw",
        });
        expect({ input, result: remote }).toEqual({ input, result: expected });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads bytes like the local filesystem, including prefixes and oversized files",
    async () => {
      const denyPaths = [path.join(tree, "secret")];
      const local = localFileSystem(tree, denyPaths);
      const cases: { path: string; maxBytes: number; prefixBytes?: number }[] = [
        { path: "assets/image.png", maxBytes: 1_000 },
        { path: "large.log", maxBytes: 1_000, prefixBytes: 64 },
        { path: "large.log", maxBytes: 1_000 },
        { path: "secret/keys.txt", maxBytes: 1_000 },
        { path: "missing.png", maxBytes: 1_000 },
      ];

      for (const input of cases) {
        const remote = unwrap(
          await remoteReadFileBytes({
            host: HOST,
            cwd: tree,
            filePath: input.path,
            denyPaths,
            maxBytes: input.maxBytes,
            ...(input.prefixBytes === undefined ? {} : { prefixBytes: input.prefixBytes }),
          }),
        );
        expect({ input, result: remote }).toEqual({
          input,
          result: bytesOnWire(await local.readFileBytes(input)),
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  for (const backend of ["fff", undefined] as const) {
    const runnerLabel = backend === "fff" ? "package runner" : "bundled runner";
    const served = <T>(operation: () => Promise<T>) =>
      backend === "fff" ? expectServedByPackageRunner(operation) : operation();

    it(
      `globs like the local filesystem through the ${runnerLabel}`,
      async () => {
        const denyPaths = [path.join(tree, "secret")];
        const local = localFileSystem(tree, denyPaths, backend);
        const cases: { patterns: string[]; mode: "default" | "detailed"; maxEntries?: number }[] = [
          { patterns: ["**/*"], mode: "default" },
          { patterns: ["**/*"], mode: "detailed" },
          { patterns: ["*.md"], mode: "default" },
          { patterns: ["**/*.ts", "!src/**"], mode: "default" },
          { patterns: [".hidden/**"], mode: "detailed" },
          { patterns: ["secret/**"], mode: "default" },
          { patterns: ["**/*"], mode: "default", maxEntries: 3 },
        ];

        for (const input of cases) {
          const remote = unwrap(
            await served(() =>
              remoteGlob({ host: HOST, cwd: tree, ...input, denyPaths, fsBackend: backend }),
            ),
          );
          const expected = await local.glob(input);
          expect({ input, result: unordered(remote) }).toEqual({
            input,
            result: unordered(expected),
          });
          expect(JSON.stringify(remote)).not.toContain("keys.txt");
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      `greps like the local filesystem through the ${runnerLabel}`,
      async () => {
        const denyPaths = [path.join(tree, "secret")];
        const local = localFileSystem(tree, denyPaths, backend);
        const cases: {
          target: string;
          input: {
            pattern: string;
            regex?: boolean;
            maxResults?: number;
            fileExtensions?: string[];
            includeContextLines?: number;
            mode?: "default" | "detailed" | "hashline";
          };
        }[] = [
          { target: tree, input: { pattern: "needle" } },
          { target: tree, input: { pattern: "needle", mode: "detailed" } },
          { target: tree, input: { pattern: "needle", mode: "hashline" } },
          { target: tree, input: { pattern: "need(le|ed)", regex: true } },
          { target: tree, input: { pattern: "needle", fileExtensions: [".ts"] } },
          { target: tree, input: { pattern: "other", includeContextLines: 1, mode: "detailed" } },
          { target: path.join(tree, "large.log"), input: { pattern: "needle", maxResults: 5 } },
          { target: tree, input: { pattern: "no-such-text-anywhere" } },
        ];

        for (const { target, input } of cases) {
          const remote = unwrap(
            await served(() =>
              remoteGrep({ host: HOST, cwd: target, input, denyPaths, fsBackend: backend }),
            ),
          );
          // Core strips the leading dot from extensions before searching locally.
          const expected = await local.grep({
            ...input,
            fileExtensions: input.fileExtensions?.map((extension) => extension.slice(1)),
            baseDir: target,
          });
          expect({ input, result: unordered(remote) }).toEqual({
            input,
            result: unordered(expected),
          });
          expect(JSON.stringify(remote)).not.toContain("keys.txt");
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "fuzzy searches like the local filesystem through the package runner",
    async () => {
      const denyPaths = [path.join(tree, "secret")];
      const local = localFileSystem(tree, denyPaths, "fff");
      for (const input of [
        { query: "main" },
        { query: "env" },
        { query: "keys" },
        { query: "s", maxResults: 2 },
      ]) {
        const remote = unwrap(
          await expectServedByPackageRunner(() =>
            remoteFuzzySearch({ host: HOST, cwd: tree, input, denyPaths }),
          ),
        );
        expect({ input, result: remote }).toEqual({
          input,
          result: await local.fuzzySearchFiles(input),
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "searches with FFF like the local filesystem when no deny path is inside the root",
    async () => {
      const denyPaths = [path.join(remoteHome, ".ssh")];
      const local = localFileSystem(cleanTree, denyPaths, "fff");

      const glob = unwrap(
        await expectServedByPackageRunner(() =>
          remoteGlob({
            host: HOST,
            cwd: cleanTree,
            patterns: ["**/*.ts"],
            denyPaths,
            fsBackend: "fff",
          }),
        ),
      );
      expect(unordered(glob)).toEqual(unordered(await local.glob({ patterns: ["**/*.ts"] })));

      const grep = unwrap(
        await expectServedByPackageRunner(() =>
          remoteGrep({
            host: HOST,
            cwd: cleanTree,
            input: { pattern: "needle", mode: "detailed" },
            denyPaths,
            fsBackend: "fff",
          }),
        ),
      );
      expect(unordered(grep)).toEqual(
        unordered(await local.grep({ pattern: "needle", mode: "detailed", baseDir: cleanTree })),
      );

      const fuzzy = unwrap(
        await expectServedByPackageRunner(() =>
          remoteFuzzySearch({ host: HOST, cwd: cleanTree, input: { query: "guide" }, denyPaths }),
        ),
      );
      expect(fuzzy).toEqual(await local.fuzzySearchFiles({ query: "guide" }));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "edits files like the local filesystem in legacy and hashline modes",
    async () => {
      const filePath = path.join(tree, "edit/target.ts");
      const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      const local = localFileSystem(tree, []);
      await writeTree(tree, { "edit/target.ts": original });
      const hashline = unwrap(
        await remoteReadTextFile({
          host: HOST,
          cwd: tree,
          input: { path: "edit/target.ts", format: "hashline" },
          denyPaths: [],
        }),
      );
      if (!hashline.success || hashline.format !== "hashline") {
        throw new Error("expected a hashline read");
      }
      const secondLine = hashline.hashlineContent.split("\n")[1]?.split(":")[0];
      if (!secondLine) throw new Error("expected a hashline anchor for line 2");

      const legacy = {
        path: "edit/target.ts",
        expectedHash: hashline.fileHash,
        edits: [{ type: "replace_snippet" as const, target: "b = 2", newText: "b = 20" }],
      };
      const anchored = {
        path: "edit/target.ts",
        expectedHash: hashline.fileHash,
        edits: [{ op: "replace" as const, pos: secondLine, lines: ["const b = 200;"] }],
      };

      const results = [];
      for (const mode of ["legacy", "hashline"] as const) {
        await writeFile(filePath, original);
        const remote = unwrap(
          await remoteEditFile({
            host: HOST,
            cwd: tree,
            input: mode === "legacy" ? { ...legacy, mode } : { ...anchored, mode },
            denyPaths: [],
          }),
        );
        const remoteContent = await readFile(filePath, "utf8");

        await writeFile(filePath, original);
        const expected =
          mode === "legacy" ? await local.editFile(legacy) : await local.hashlineEditFile(anchored);
        expect(remote).toEqual(expected);
        expect(remoteContent).toBe(await readFile(filePath, "utf8"));
        results.push({ success: remote.success, content: remoteContent });
      }
      expect(results).toEqual([
        { success: true, content: "const a = 1;\nconst b = 20;\nconst c = 3;\n" },
        { success: true, content: "const a = 1;\nconst b = 200;\nconst c = 3;\n" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "applies patches like the local patch engine",
    async () => {
      const files = { "patch/keep.txt": "alpha\nbeta\n", "patch/drop.txt": "gone\n" };
      const patchText = [
        "*** Begin Patch",
        "*** Add File: patch/new.txt",
        "+created",
        "*** Update File: patch/keep.txt",
        "@@",
        " alpha",
        "-beta",
        "+gamma",
        "*** Delete File: patch/drop.txt",
        "*** End Patch",
      ].join("\n");
      const snapshot = async () => ({
        new: await readFile(path.join(tree, "patch/new.txt"), "utf8").catch(() => null),
        keep: await readFile(path.join(tree, "patch/keep.txt"), "utf8"),
        drop: await readFile(path.join(tree, "patch/drop.txt"), "utf8").catch(() => null),
      });

      await writeTree(tree, files);
      const remote = await remoteApplyPatch({ host: HOST, cwd: tree, patchText });
      const remoteTree = await snapshot();

      await rm(path.join(tree, "patch"), { recursive: true });
      await writeTree(tree, files);
      const hunks = unwrap(parsePatchResult(patchText));
      const localOutput = await applyHunks(tree, hunks, { denyPaths: [] });

      expect(remote).toEqual({ ok: true, output: localOutput });
      expect(remoteTree).toEqual(await snapshot());
      expect(remoteTree).toEqual({ new: "created", keep: "alpha\ngamma\n", drop: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports the daemon pid through the health command",
    async () => {
      // A search first, so the daemon is running.
      unwrap(
        await remoteFuzzySearch({ host: HOST, cwd: tree, input: { query: "main" }, denyPaths: [] }),
      );
      const health = unwrap(await remoteHealth());
      expect(Number.isInteger(health.pid)).toBeTrue();
      expect(() => process.kill(health.pid, 0)).not.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("remote fs runner error shapes Core surfaces", () => {
  const remoteCwd = () => `${HOST}:${tree}`;
  const tools = () =>
    fsTool(tree, {
      includeEditFile: true,
      fsBackend: "fff",
      readFileDirectImageSupported: true,
    });

  it(
    "read_text reports missing and denied files with their error codes",
    async () => {
      expect(await executeTool(tools().read, { path: "missing.ts", cwd: remoteCwd() })).toEqual({
        success: false,
        resolvedPath: `ssh://${HOST}${path.join(tree, "missing.ts")}`,
        error: { code: "NOT_FOUND", message: expect.stringContaining("ENOENT") },
      });
      const denied = path.join(remoteHome, ".ssh/id_ed25519");
      expect(
        await executeTool(tools().read, { path: "~/.ssh/id_ed25519", cwd: remoteCwd() }),
      ).toEqual({
        success: false,
        resolvedPath: `ssh://${HOST}${denied}`,
        error: {
          code: "PERMISSION",
          message: `Access denied: '${denied}' is blocked for readFile`,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "read_bytes reports missing and denied media as read failures",
    async () => {
      expect(await executeTool(tools().read, { path: "missing.png", cwd: remoteCwd() })).toEqual({
        success: false,
        resolvedPath: `ssh://${HOST}/missing.png`,
        error: { code: "UNKNOWN", message: expect.stringContaining("ENOENT") },
      });
      const denied = path.join(remoteHome, ".ssh/key.png");
      expect(await executeTool(tools().read, { path: "~/.ssh/key.png", cwd: remoteCwd() })).toEqual(
        {
          success: false,
          resolvedPath: `ssh://${HOST}/~/.ssh/key.png`,
          error: {
            code: "UNKNOWN",
            message: `Access denied: '${denied}' is blocked for readFile`,
          },
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "edit reports missing, denied, stale, and unmatched edits",
    async () => {
      await writeTree(tree, { "edit/errors.ts": "const value = 1;\n" });
      const edit = (filePath: string, expectedHash?: string, target = "value") =>
        remoteEditFile({
          host: HOST,
          cwd: tree,
          input: {
            path: filePath,
            mode: "legacy",
            ...(expectedHash ? { expectedHash } : {}),
            edits: [{ type: "replace_snippet", target, newText: "next" }],
          },
          denyPaths: ["~/.ssh"],
        });

      expect(unwrap(await edit("missing.ts"))).toMatchObject({
        success: false,
        error: { code: "NOT_FOUND" },
      });
      expect(unwrap(await edit("~/.ssh/id_ed25519"))).toMatchObject({
        success: false,
        error: { code: "PERMISSION", message: expect.stringContaining("Access denied") },
      });
      expect(unwrap(await edit("edit/errors.ts", "0".repeat(64)))).toMatchObject({
        success: false,
        error: { code: "HASH_MISMATCH" },
      });
      expect(unwrap(await edit("edit/errors.ts", undefined, "absent"))).toMatchObject({
        success: false,
        error: { code: "NO_MATCHES" },
      });
      expect(await readFile(path.join(tree, "edit/errors.ts"), "utf8")).toBe("const value = 1;\n");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "apply_patch reports invalid, denied, and inapplicable patches",
    async () => {
      expect(await remoteApplyPatch({ host: HOST, cwd: tree, patchText: "garbage" })).toEqual({
        ok: false,
        error: "Invalid patch format: missing Begin/End markers",
      });
      const denied = path.join(remoteHome, ".ssh/evil");
      expect(
        await remoteApplyPatch({
          host: HOST,
          cwd: tree,
          patchText: `*** Begin Patch\n*** Add File: ${denied}\n+x\n*** End Patch`,
        }),
      ).toEqual({ ok: false, error: `Access denied: '${denied}' is blocked for patch` });
      expect(
        await remoteApplyPatch({
          host: HOST,
          cwd: tree,
          patchText: "*** Begin Patch\n*** Update File: missing.txt\n@@\n-a\n+b\n*** End Patch",
        }),
      ).toEqual({ ok: false, error: expect.stringContaining("missing.txt") });
      expect(await Bun.file(denied).exists()).toBeFalse();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "glob reports denied and missing roots",
    async () => {
      const denied = path.join(remoteHome, ".ssh");
      expect(await executeTool(tools().glob, { patterns: ["*"], cwd: `${HOST}:~/.ssh` })).toEqual({
        mode: "default",
        truncated: false,
        paths: [],
        error: `Access denied: '${denied}' is blocked for glob`,
      });
      expect(
        await executeTool(tools().glob, { patterns: ["*"], cwd: `${remoteCwd()}/missing` }),
      ).toEqual({
        mode: "default",
        truncated: false,
        paths: [],
        error: expect.stringContaining("Remote cwd does not exist or is not a directory"),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "grep reports denied and missing targets",
    async () => {
      const denied = path.join(remoteHome, ".ssh");
      expect(
        await executeTool(tools().grep, { pattern: "needle", path: `${HOST}:~/.ssh` }),
      ).toEqual({
        mode: "default",
        truncated: false,
        results: [],
        error: `Access denied: '${denied}' is blocked for grep`,
      });
      expect(
        await executeTool(tools().grep, { pattern: "needle", path: `${remoteCwd()}/missing` }),
      ).toEqual({
        mode: "default",
        truncated: false,
        results: [],
        error: expect.stringContaining("ENOENT"),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fuzzy_search reports denied and missing roots",
    async () => {
      const denied = path.join(remoteHome, ".ssh");
      const empty = { results: [], totalMatched: 0, totalFiles: 0, truncated: false };
      expect(
        await executeTool(tools().fuzzy_search, { query: "id", cwd: `${HOST}:~/.ssh` }),
      ).toEqual({ ...empty, error: `Access denied: '${denied}' is blocked for fuzzySearch` });
      expect(
        await executeTool(tools().fuzzy_search, { query: "id", cwd: `${remoteCwd()}/missing` }),
      ).toEqual({
        ...empty,
        error: expect.stringContaining("remote fuzzy_search unavailable"),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "health reports a missing daemon as a runner error",
    async () => {
      const emptyRuntime = await mkdtemp("/tmp/lrfs-");
      const health = await remoteHealth(emptyRuntime).finally(() =>
        rm(emptyRuntime, { recursive: true, force: true }),
      );
      expect(health.status).toBe("error");
      if (health.status === "ok") throw new Error("expected health to fail");
      expect(health.error).toMatchObject({
        _tag: "RemoteRunnerReportedError",
        operation: "health",
        message: "remote fs daemon socket transport failed",
      });
    },
    TEST_TIMEOUT_MS,
  );
});
