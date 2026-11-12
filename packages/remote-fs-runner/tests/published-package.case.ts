import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  decodeRemoteGlobResponseJson,
  decodeRemoteHealthResponseJson,
} from "@stanley2058/lilac-fs";
import { z } from "zod";

// Packs the runner as `npm publish` would and runs the tarball through bunx and npx outside the
// workspace, the way Core launches it on a remote host. Needs node, npm, and registry access.

const packageDir = path.resolve(import.meta.dir, "..");
const INSTALL_TIMEOUT_MS = 180_000;
const packResultSchema = z.array(
  z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) }),
);
const packedManifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  bin: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

let tempDir = "";
let tarball = "";
let packedFiles: string[] = [];
let packedManifest: z.output<typeof packedManifestSchema>;
const runtimeDirs: string[] = [];

async function run(
  cmd: string[],
  options: { cwd: string; env?: Record<string, string>; stdin?: string },
) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
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

async function runOrThrow(cmd: string[], cwd: string) {
  const result = await run(cmd, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.exitCode}\n${result.stderr}`);
  }
  return result.stdout;
}

// Core launches the runner through bunx with an isolated TMPDIR, or through npx without bunx.
const launchers = {
  bunx: () => ["bunx", "--package", tarball, "lilac-remote-fs"],
  npx: () => ["npx", "--no-workspaces", "-y", "-p", tarball, "lilac-remote-fs"],
};

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "lilac-rfs-package-"));
  await runOrThrow(["bun", "run", "build"], packageDir);
  const packed = packResultSchema.parse(
    JSON.parse(
      await runOrThrow(["npm", "pack", "--json", "--pack-destination", tempDir], packageDir),
    ),
  );
  const [result] = packed;
  if (!result) throw new Error("npm pack produced no tarball");
  tarball = path.join(tempDir, result.filename);
  packedFiles = result.files.map((file) => file.path).sort();

  const extracted = path.join(tempDir, "extracted");
  await mkdir(extracted);
  await runOrThrow(["tar", "xzf", tarball, "-C", extracted], tempDir);
  packedManifest = packedManifestSchema.parse(
    await Bun.file(path.join(extracted, "package/package.json")).json(),
  );
}, INSTALL_TIMEOUT_MS);

afterAll(async () => {
  for (const runtimeDir of runtimeDirs) {
    const health = await run(["node", path.join(packageDir, "dist/cli.js"), "health"], {
      cwd: tempDir,
      env: { LILAC_REMOTE_FS_RUNNER_DIR: runtimeDir },
    });
    const decoded = decodeRemoteHealthResponseJson(health.stdout.trim());
    if (decoded.status === "ok") process.kill(decoded.value.pid, "SIGTERM");
    await rm(runtimeDir, { recursive: true, force: true });
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("published remote fs runner package", () => {
  it("contains only the bundle, its manifest, and its documents", () => {
    expect(packedFiles).toEqual(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
    expect(packedManifest.bin).toEqual({ "lilac-remote-fs": "dist/cli.js" });
  });

  it("declares only registry-resolvable runtime dependencies", () => {
    const declared = {
      ...packedManifest.dependencies,
      ...packedManifest.peerDependencies,
      ...packedManifest.optionalDependencies,
    };
    const unresolvable = Object.entries(declared).filter(([, range]) =>
      /^(catalog|workspace|link|file|portal):/u.test(range),
    );
    expect(unresolvable).toEqual([]);
  });

  for (const [launcher, command] of Object.entries(launchers)) {
    it(
      `installs through ${launcher} outside the workspace and serves a request`,
      async () => {
        const launchDir = await mkdtemp(path.join(tempDir, `${launcher}-`));
        const tree = path.join(launchDir, "tree");
        await mkdir(path.join(tree, "src"), { recursive: true });
        await writeFile(path.join(tree, "src/main.ts"), "export const needle = 1;\n");
        await writeFile(path.join(tree, ".env"), "NEEDLE=1\n");
        // Unix socket paths are limited to about 104 bytes, and the shared test temp root is deep.
        const runtimeDir = await mkdtemp("/tmp/lrfs-");
        runtimeDirs.push(runtimeDir);
        const env = {
          TMPDIR: launchDir,
          LILAC_REMOTE_FS_RUNNER_DIR: runtimeDir,
          LILAC_REMOTE_FS_IDLE_MS: "60000",
          npm_config_update_notifier: "false",
        };

        const version = await run([...command(), "--version"], { cwd: tree, env });
        expect(version.exitCode, version.stderr).toBe(0);
        expect(version.stdout.trim()).toBe(packedManifest.version);

        const request = await run([...command(), "request"], {
          cwd: tree,
          env,
          stdin: JSON.stringify({ op: "fs.glob", input: { patterns: ["**/*"] }, denyPaths: [] }),
        });
        expect(request.exitCode, request.stderr).toBe(0);
        const glob = decodeRemoteGlobResponseJson(request.stdout.trim());
        if (glob.status === "error") throw new Error(glob.error.message);
        expect(glob.value).toMatchObject({ mode: "default", truncated: false });
        if (glob.value.mode !== "default") throw new Error("expected a default glob response");
        expect(glob.value.paths.toSorted()).toEqual([".env", "src", "src/main.ts"]);
      },
      INSTALL_TIMEOUT_MS,
    );
  }
});
