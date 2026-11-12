import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RUNNER_PACKAGE_DIR, runnerBuildOptions } from "../packages/remote-fs-runner/build";

// Core runs `<name>@<version>` from npm on remote hosts, so a runner change that keeps the version
// ships nothing. The record pairs the version last published with a fingerprint of everything the
// bundle and its install depend on; the published-fingerprint test fails when they disagree.

export const FINGERPRINT_RECORD_PATH = path.join(RUNNER_PACKAGE_DIR, "published-fingerprint.json");
const REPO_ROOT = path.resolve(import.meta.dir, "..");

// package.json fields that change what a remote install resolves or runs.
const PUBLISHED_MANIFEST_FIELDS = [
  "name",
  "type",
  "main",
  "bin",
  "files",
  "engines",
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type FingerprintRecord = { version: string; fingerprint: string };
type PackageManifest = { name: string; version: string; fields: Record<string, unknown> };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filePath} does not contain a JSON object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(object: Record<string, unknown>, field: string, source: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new Error(`${source} has no string "${field}"`);
  return value;
}

async function readManifest(packageRoot: string): Promise<PackageManifest> {
  const manifestPath = path.join(packageRoot, "package.json");
  const fields = await readJsonObject(manifestPath);
  return {
    name: stringField(fields, "name", manifestPath),
    version: stringField(fields, "version", manifestPath),
    fields,
  };
}

export async function readPackageManifest(): Promise<PackageManifest> {
  return await readManifest(RUNNER_PACKAGE_DIR);
}

export async function readFingerprintRecord(): Promise<FingerprintRecord | undefined> {
  const exists = await Bun.file(FINGERPRINT_RECORD_PATH).exists();
  if (!exists) return undefined;
  const record = await readJsonObject(FINGERPRINT_RECORD_PATH);
  return {
    version: stringField(record, "version", FINGERPRINT_RECORD_PATH),
    fingerprint: stringField(record, "fingerprint", FINGERPRINT_RECORD_PATH),
  };
}

// Dependency files are keyed by package name and version, so the fingerprint does not depend on
// the install layout under node_modules.
async function inputKey(absolutePath: string): Promise<string> {
  const segments = absolutePath.split(path.sep);
  const nodeModules = segments.lastIndexOf("node_modules");
  if (nodeModules === -1) return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");

  const nameLength = segments[nodeModules + 1]?.startsWith("@") ? 2 : 1;
  const packageRoot = segments.slice(0, nodeModules + 1 + nameLength).join(path.sep);
  const dependency = await readManifest(packageRoot);
  const inside = path.relative(packageRoot, absolutePath).split(path.sep).join("/");
  return `${dependency.name}@${dependency.version}/${inside}`;
}

export async function computeRunnerFingerprint(): Promise<string> {
  const build = await Bun.build({
    ...runnerBuildOptions,
    entrypoints: [...runnerBuildOptions.entrypoints],
    external: [...runnerBuildOptions.external],
    define: { PACKAGE_VERSION: '"fingerprint"' },
    metafile: true,
  });
  if (!build.success || !build.metafile) {
    throw new Error(`remote fs runner fingerprint build failed: ${build.logs.join("\n")}`);
  }

  const inputs = await Promise.all(
    Object.keys(build.metafile.inputs).map(async (input) => {
      const absolutePath = path.resolve(input);
      return `${await inputKey(absolutePath)}\0${sha256(await readFile(absolutePath))}`;
    }),
  );
  const { fields } = await readPackageManifest();
  const publishedManifest = Object.fromEntries(
    PUBLISHED_MANIFEST_FIELDS.map((field) => [field, fields[field] ?? null]),
  );
  const buildOptions = {
    ...runnerBuildOptions,
    entrypoints: runnerBuildOptions.entrypoints.map((entry) => path.relative(REPO_ROOT, entry)),
  };

  return `sha256-${sha256(
    JSON.stringify({ inputs: inputs.sort(), manifest: publishedManifest, build: buildOptions }),
  )}`;
}

async function isPublished(spec: string): Promise<boolean> {
  const child = Bun.spawn(["npm", "view", spec, "version", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode === 0) return stdout.trim().length > 0;
  if (stderr.includes("E404")) return false;
  throw new Error(`could not check npm for ${spec}: ${stderr.trim()}`);
}

async function refresh(): Promise<void> {
  const manifest = await readPackageManifest();
  const recorded = await readFingerprintRecord();
  const fingerprint = await computeRunnerFingerprint();
  const spec = `${manifest.name}@${manifest.version}`;

  if (recorded?.version === manifest.version && recorded.fingerprint === fingerprint) {
    console.log(`${spec} fingerprint is already recorded.`);
    return;
  }
  const published = await isPublished(spec);
  if (recorded?.version === manifest.version && published) {
    console.error(
      `${spec} is already on npm, so remote hosts would keep running the published code. ` +
        "Bump the version in packages/remote-fs-runner/package.json, then run this again.",
    );
    process.exitCode = 1;
    return;
  }

  const record: FingerprintRecord = { version: manifest.version, fingerprint };
  await writeFile(FINGERPRINT_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Recorded the ${spec} fingerprint.`);
  if (!published) {
    console.log(`${spec} is not on npm yet. Publish it before Core releases depend on it.`);
  }
}

if (import.meta.main) await refresh();
