import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { Result, type Result as ResultType } from "better-result";

import { captureFilesystemOperation, type FileSystemOperationFailed } from "./filesystem-operation";
import type {
  GlobWalkParams,
  GlobWalkResult,
  HostFileType,
  HostGlobEntry,
} from "./filesystem-host";
import { matchesGlobWithDotfiles } from "./glob-match";

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export function isSkippableTraversalError(error: FileSystemOperationFailed): boolean {
  const code = error.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ENOTDIR";
}

export function isDeniedPathIn(path: string, denyPaths: readonly string[]): boolean {
  const normalized = resolve(path);
  for (const deny of denyPaths) {
    if (normalized === deny) return true;
    if (normalized.startsWith(`${deny}${sep}`)) return true;
  }
  return false;
}

export function matchesAnyGlob(entryPath: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      matchesGlobWithDotfiles(entryPath, pattern) ||
      matchesGlobWithDotfiles(`${entryPath}/`, pattern),
  );
}

function hasGlobMeta(segment: string): boolean {
  return /[*?[\]{}()!+@]/.test(segment);
}

function getLiteralSearchRoot(pattern: string): string {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  const prefix: string[] = [];

  for (const segment of segments) {
    if (segment === "." || segment === "..") return "";
    if (hasGlobMeta(segment)) return prefix.join("/");
    prefix.push(segment);
  }

  return prefix.slice(0, -1).join("/");
}

function isSameOrChildPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/** The shortest literal directory prefixes that contain every match of the patterns. */
export function getGlobSearchRoots(patterns: readonly string[]): string[] {
  const roots = patterns.map(getLiteralSearchRoot).sort((a, b) => a.length - b.length);
  const deduped: string[] = [];

  for (const root of roots) {
    if (root.length === 0) return [""];
    if (deduped.some((existing) => isSameOrChildPath(root, existing))) continue;
    deduped.push(root);
  }

  return deduped.length > 0 ? deduped : [""];
}

export function fileTypeFromStats(stats: Stats): HostFileType {
  switch (true) {
    case stats.isSymbolicLink(): {
      return "symlink";
    }
    case stats.isFile(): {
      return "file";
    }
    case stats.isDirectory(): {
      return "directory";
    }
    case stats.isSocket(): {
      return "socket";
    }
    case stats.isBlockDevice(): {
      return "block_device";
    }
    case stats.isCharacterDevice(): {
      return "character_device";
    }
    case stats.isFIFO(): {
      return "fifo";
    }
    default: {
      return "unknown";
    }
  }
}

/** Walks the tree with `opendir`, matching each entry against the glob contract. */
export async function collectLocalGlobMatches(
  params: GlobWalkParams,
): Promise<ResultType<GlobWalkResult, FileSystemOperationFailed>> {
  const paths: string[] = [];
  const entries: HostGlobEntry[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const addMatch = async (
    entry: string,
    abs: string,
  ): Promise<ResultType<void, FileSystemOperationFailed>> => {
    if (seen.has(entry)) return Result.ok(undefined);
    seen.add(entry);

    const count = params.withStats ? entries.length : paths.length;
    if (count >= params.maxEntries) {
      truncated = true;
      return Result.ok(undefined);
    }

    if (!params.withStats) {
      paths.push(entry);
      return Result.ok(undefined);
    }

    const stats = resultOutcome(
      await captureFilesystemOperation("stat glob match", () => fs.stat(abs)),
    );
    if (!stats.ok) {
      return isSkippableTraversalError(stats.error)
        ? Result.ok(undefined)
        : Result.err(stats.error);
    }
    entries.push({
      path: entry,
      type: fileTypeFromStats(stats.value),
      size: stats.value.size,
    });
    return Result.ok(undefined);
  };

  const walk = async (relDir: string): Promise<ResultType<void, FileSystemOperationFailed>> => {
    if (truncated) return Result.ok(undefined);

    const absDir = relDir ? join(params.resolvedBaseDir, relDir) : params.resolvedBaseDir;
    if (!params.dangerouslyAllow && isDeniedPathIn(absDir, params.denyPaths)) {
      return Result.ok(undefined);
    }
    if (relDir && matchesAnyGlob(relDir, params.excludes)) return Result.ok(undefined);
    if (relDir && matchesAnyGlob(relDir, params.includes)) {
      const added = resultOutcome(await addMatch(relDir, absDir));
      if (!added.ok) return Result.err(added.error);
      if (truncated) return Result.ok(undefined);
    }

    const opened = resultOutcome(
      await captureFilesystemOperation("open glob directory", () => fs.opendir(absDir)),
    );
    if (!opened.ok) {
      return isSkippableTraversalError(opened.error)
        ? Result.ok(undefined)
        : Result.err(opened.error);
    }

    let iterationError: FileSystemOperationFailed | undefined;
    const iterated = resultOutcome(
      await captureFilesystemOperation("iterate glob directory", async () => {
        for await (const dirent of opened.value) {
          if (truncated) break;

          const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
          const abs = join(params.resolvedBaseDir, relPath);

          if (!params.dangerouslyAllow && isDeniedPathIn(abs, params.denyPaths)) continue;
          if (matchesAnyGlob(relPath, params.excludes)) continue;

          if (matchesAnyGlob(relPath, params.includes)) {
            const added = resultOutcome(await addMatch(relPath, abs));
            if (!added.ok) {
              iterationError = added.error;
              break;
            }
          }

          if (dirent.isDirectory()) {
            const walked = resultOutcome(await walk(relPath));
            if (!walked.ok) {
              iterationError = walked.error;
              break;
            }
          }
        }
      }),
    );
    if (!iterated.ok) {
      return isSkippableTraversalError(iterated.error)
        ? Result.ok(undefined)
        : Result.err(iterated.error);
    }
    if (iterationError) return Result.err(iterationError);
    return Result.ok(undefined);
  };

  for (const root of getGlobSearchRoots(params.includes)) {
    const walked = resultOutcome(await walk(root));
    if (!walked.ok) return Result.err(walked.error);
  }

  return Result.ok({ paths, entries, truncated });
}
