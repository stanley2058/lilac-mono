import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { findWorkspaceRoot } from "./find-root";

const DEFAULT_BUILD_VERSION = "dev";
const DEFAULT_BUILD_COMMIT = "dev";
const BUILD_INFO_PATH = path.join("build", "build-info.json");
const GIT_SHORT_COMMIT_LENGTH = 12;

export type BuildInfo = {
  version: string;
  commit: string;
  dirty?: boolean;
  builtAt?: string;
};

type ResolveBuildInfoParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

let cachedBuildInfo: BuildInfo | undefined;
let cachedBuildInfoKey: string | undefined;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findWorkspaceRootSafe(startDir: string): string | undefined {
  try {
    return findWorkspaceRoot(startDir);
  } catch {
    return undefined;
  }
}

function readBuildInfoFile(cwd: string): BuildInfo | null {
  try {
    const workspaceRoot = findWorkspaceRootSafe(cwd);
    if (!workspaceRoot) return null;

    const buildInfoPath = path.join(workspaceRoot, BUILD_INFO_PATH);
    if (!fs.existsSync(buildInfoPath)) return null;

    const raw = fs.readFileSync(buildInfoPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const version = readNonEmpty(typeof parsed.version === "string" ? parsed.version : undefined);
    const commit = readNonEmpty(typeof parsed.commit === "string" ? parsed.commit : undefined);
    if (!version || !commit) return null;

    const dirty =
      typeof parsed.dirty === "boolean"
        ? parsed.dirty
        : parseBooleanish(typeof parsed.dirty === "string" ? parsed.dirty : undefined);
    const builtAt = readNonEmpty(typeof parsed.builtAt === "string" ? parsed.builtAt : undefined);

    return {
      version,
      commit,
      dirty,
      builtAt,
    };
  } catch {
    return null;
  }
}

function getBuildInfoFileCacheKey(cwd: string): string {
  try {
    const workspaceRoot = findWorkspaceRootSafe(cwd);
    if (!workspaceRoot) return "missing-workspace";

    const buildInfoPath = path.join(workspaceRoot, BUILD_INFO_PATH);
    const stats = fs.statSync(buildInfoPath);
    return `${buildInfoPath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "missing-build-info";
  }
}

function readGitBuildInfo(cwd: string): Pick<BuildInfo, "commit" | "dirty"> | null {
  try {
    const workspaceRoot = findWorkspaceRootSafe(cwd);
    if (!workspaceRoot) return null;

    const commit = execFileSync(
      "git",
      ["rev-parse", `--short=${GIT_SHORT_COMMIT_LENGTH}`, "HEAD"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!commit) return null;

    const dirtyOutput = execFileSync("git", ["status", "--short", "--untracked-files=no"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return {
      commit,
      dirty: dirtyOutput.length > 0,
    };
  } catch {
    return null;
  }
}

function resolveBuildInfo(params: ResolveBuildInfoParams): BuildInfo {
  const env = params.env ?? process.env;
  const cwd = params.cwd ?? process.cwd();

  const version =
    readNonEmpty(env.LILAC_BUILD_VERSION) ??
    readNonEmpty(env.npm_package_version) ??
    DEFAULT_BUILD_VERSION;
  const envCommit = readNonEmpty(env.LILAC_BUILD_COMMIT);
  const envDirty = parseBooleanish(env.LILAC_BUILD_DIRTY);
  const builtAt = readNonEmpty(env.LILAC_BUILD_AT);

  if (envCommit) {
    return {
      version,
      commit: envCommit,
      dirty: envDirty,
      builtAt,
    };
  }

  const gitInfo = readGitBuildInfo(cwd);
  if (gitInfo) {
    return {
      version,
      commit: gitInfo.commit,
      dirty: envDirty ?? gitInfo.dirty,
      builtAt,
    };
  }

  const fileInfo = readBuildInfoFile(cwd);
  if (fileInfo) {
    return fileInfo;
  }

  return {
    version,
    commit: DEFAULT_BUILD_COMMIT,
    dirty: envDirty,
    builtAt,
  };
}

export function getBuildInfo(params: ResolveBuildInfoParams = {}): BuildInfo {
  const useCache = params.cwd === undefined && params.env === undefined;
  const cacheKey = useCache
    ? JSON.stringify({
        cwd: process.cwd(),
        buildInfoFile: getBuildInfoFileCacheKey(process.cwd()),
        LILAC_BUILD_VERSION: process.env.LILAC_BUILD_VERSION,
        LILAC_BUILD_COMMIT: process.env.LILAC_BUILD_COMMIT,
        LILAC_BUILD_DIRTY: process.env.LILAC_BUILD_DIRTY,
        LILAC_BUILD_AT: process.env.LILAC_BUILD_AT,
        npm_package_version: process.env.npm_package_version,
      })
    : undefined;

  if (useCache && cachedBuildInfo && cachedBuildInfoKey === cacheKey) return cachedBuildInfo;

  const buildInfo = resolveBuildInfo(params);
  if (useCache) {
    cachedBuildInfo = buildInfo;
    cachedBuildInfoKey = cacheKey;
  }
  return buildInfo;
}
