import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { findWorkspaceRoot } from "../packages/utils/find-root";

const DEFAULT_BUILD_INFO_PATH = path.join("build", "build-info.json");
const DEFAULT_VERSION = "dev";
const DEFAULT_COMMIT = "dev";
const GIT_SHORT_COMMIT_LENGTH = 12;

function readArg(prefix: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : undefined;
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanish(value: string | undefined): boolean | undefined {
  const normalized = readNonEmpty(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function readGitCommit(workspaceRoot: string): string {
  try {
    const commit = execFileSync("git", ["rev-parse", `--short=${GIT_SHORT_COMMIT_LENGTH}`, "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit.length > 0 ? commit : DEFAULT_COMMIT;
  } catch {
    return DEFAULT_COMMIT;
  }
}

function readGitDirty(workspaceRoot: string): boolean | undefined {
  try {
    const dirtyOutput = execFileSync("git", ["status", "--short", "--untracked-files=no"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirtyOutput.length > 0;
  } catch {
    return undefined;
  }
}

async function main() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const outputPath = path.resolve(
    workspaceRoot,
    readArg("--output=") ?? DEFAULT_BUILD_INFO_PATH,
  );

  const version =
    readNonEmpty(readArg("--version=")) ??
    readNonEmpty(process.env.LILAC_BUILD_VERSION) ??
    readNonEmpty(process.env.npm_package_version) ??
    DEFAULT_VERSION;
  const commit =
    readNonEmpty(readArg("--commit=")) ??
    readNonEmpty(process.env.LILAC_BUILD_COMMIT) ??
    readGitCommit(workspaceRoot);
  const dirty =
    parseBooleanish(readArg("--dirty=")) ??
    parseBooleanish(process.env.LILAC_BUILD_DIRTY) ??
    readGitDirty(workspaceRoot);
  const builtAt = readNonEmpty(readArg("--built-at=")) ?? readNonEmpty(process.env.LILAC_BUILD_AT);

  const payload = {
    version,
    commit,
    ...(dirty === undefined ? {} : { dirty }),
    ...(builtAt ? { builtAt } : {}),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const relativeOutputPath = path.relative(workspaceRoot, outputPath) || outputPath;
  console.log(`Wrote ${relativeOutputPath}`);
}

await main();
