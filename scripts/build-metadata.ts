import { execFileSync } from "node:child_process";

import { findWorkspaceRoot } from "../packages/utils/find-root";

const DEFAULT_VERSION = "dev";
const DEFAULT_COMMIT = "dev";
const GIT_SHORT_COMMIT_LENGTH = 12;

export type BuildMetadata = {
  version: string;
  commit: string;
  dirty?: boolean;
  builtAt?: string;
};

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

export function collectBuildMetadata(workspaceRoot = findWorkspaceRoot(process.cwd())): BuildMetadata {
  const version =
    readNonEmpty(process.env.LILAC_BUILD_VERSION) ??
    readNonEmpty(process.env.npm_package_version) ??
    DEFAULT_VERSION;
  const commit = readNonEmpty(process.env.LILAC_BUILD_COMMIT) ?? readGitCommit(workspaceRoot);
  const dirty = parseBooleanish(process.env.LILAC_BUILD_DIRTY) ?? readGitDirty(workspaceRoot);
  const builtAt = readNonEmpty(process.env.LILAC_BUILD_AT);

  return {
    version,
    commit,
    ...(dirty === undefined ? {} : { dirty }),
    ...(builtAt ? { builtAt } : {}),
  };
}

export function buildMetadataEnv(metadata: BuildMetadata): Record<string, string> {
  return {
    LILAC_BUILD_VERSION: metadata.version,
    LILAC_BUILD_COMMIT: metadata.commit,
    ...(metadata.dirty === undefined ? {} : { LILAC_BUILD_DIRTY: String(metadata.dirty) }),
    ...(metadata.builtAt ? { LILAC_BUILD_AT: metadata.builtAt } : {}),
  };
}
