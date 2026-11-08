import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { findWorkspaceRootResult } from "./find-root";
import { settleSyncResult } from "./runtime-utils";

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

const buildInfoSchema = z.object({
  version: z.string(),
  commit: z.string(),
  dirty: z.union([z.boolean(), z.string()]).optional(),
  builtAt: z.string().optional(),
});

export function decodeBuildInfo(value: unknown): z.output<typeof buildInfoSchema> | undefined {
  const parsed = buildInfoSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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

function findWorkspaceRootSafe(startDir: string): string | undefined {
  return findWorkspaceRootResult(startDir).match({
    ok: (value) => value,
    err: () => undefined,
  });
}

function readBuildInfoFile(cwd: string): BuildInfo | null {
  const outcome = settleSyncResult(() => {
    const workspaceRoot = findWorkspaceRootSafe(cwd);
    if (!workspaceRoot) return null;

    const buildInfoPath = path.join(workspaceRoot, BUILD_INFO_PATH);
    if (!fs.existsSync(buildInfoPath)) return null;

    const raw = fs.readFileSync(buildInfoPath, "utf8");
    const parsed = decodeBuildInfo(JSON.parse(raw));
    if (!parsed) return null;

    const version = readNonEmpty(parsed.version);
    const commit = readNonEmpty(parsed.commit);
    if (!version || !commit) return null;

    const dirty = typeof parsed.dirty === "boolean" ? parsed.dirty : parseBooleanish(parsed.dirty);
    const builtAt = readNonEmpty(parsed.builtAt);

    return {
      version,
      commit,
      dirty,
      builtAt,
    };
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.kind === "value" ? outcome.value : null;
}

function getBuildInfoFileCacheKey(cwd: string): string {
  const outcome = settleSyncResult(() => {
    const workspaceRoot = findWorkspaceRootSafe(cwd);
    if (!workspaceRoot) return "missing-workspace";

    const buildInfoPath = path.join(workspaceRoot, BUILD_INFO_PATH);
    const stats = fs.statSync(buildInfoPath);
    return `${buildInfoPath}:${stats.size}:${stats.mtimeMs}`;
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.kind === "value" ? outcome.value : "missing-build-info";
}

function readGitBuildInfo(cwd: string): Pick<BuildInfo, "commit" | "dirty"> | null {
  const outcome = settleSyncResult(() => {
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

    // Nothing builds from the ref/ submodules, and each one would add a child `git status` per call.
    const dirtyOutput = execFileSync(
      "git",
      ["status", "--short", "--untracked-files=no", "--ignore-submodules=all"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    return {
      commit,
      dirty: dirtyOutput.length > 0,
    };
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.kind === "value" ? outcome.value : null;
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
