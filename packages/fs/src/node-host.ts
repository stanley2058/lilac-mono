import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { Result, type Result as ResultType } from "better-result";

import {
  captureFilesystemOperation,
  captureFilesystemOperationSync,
  type FileSystemOperationFailed,
} from "./filesystem-operation";
import type { FileSystemHost, HostStats } from "./filesystem-host";
import { collectLocalGlobMatches, fileTypeFromStats } from "./glob-walk";
import { fuzzyFileSearch, fzfFileSearch, getSearchBackend } from "./search-backend";
import { scanLocalTextFile } from "./text-scan";

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export async function canonicalizeLocalPathAsFarAsExists(
  inputPath: string,
): Promise<ResultType<string, FileSystemOperationFailed>> {
  let current = resolve(inputPath);
  const missingSegments: string[] = [];

  while (true) {
    const canonical = resultOutcome(
      await captureFilesystemOperation("canonicalize path", () => fs.realpath(current)),
    );
    if (canonical.ok) return Result.ok(resolve(canonical.value, ...missingSegments));
    if (canonical.error.code !== "ENOENT" && canonical.error.code !== "ENOTDIR") {
      return Result.err(canonical.error);
    }

    const stats = resultOutcome(
      await captureFilesystemOperation("inspect canonical path segment", () => fs.lstat(current)),
    );
    if (!stats.ok && stats.error.code !== "ENOENT" && stats.error.code !== "ENOTDIR") {
      return Result.err(stats.error);
    }
    if (stats.ok && stats.value.isSymbolicLink()) {
      const target = resultOutcome(
        await captureFilesystemOperation("read canonical path symlink", () => fs.readlink(current)),
      );
      if (!target.ok) return Result.err(target.error);
      current = isAbsolute(target.value)
        ? resolve(target.value)
        : resolve(dirname(current), target.value);
      continue;
    }

    const parent = dirname(current);
    if (parent === current) return Result.ok(resolve(current, ...missingSegments));
    missingSegments.unshift(basename(current));
    current = parent;
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export const nodeFileSystemHost: FileSystemHost = {
  get homeDir() {
    return homedir();
  },

  canonicalizeDenyPath(resolvedPath) {
    const canonical = captureFilesystemOperationSync("canonicalize deny path", () =>
      realpathSync(resolvedPath),
    );
    return canonical.match({
      ok: (canonicalPath) =>
        canonicalPath === resolvedPath ? [resolvedPath] : [resolvedPath, canonicalPath],
      err: () => [resolvedPath],
    });
  },

  realpath(path) {
    return captureFilesystemOperation("resolve path", () => fs.realpath(path));
  },

  canonicalizeAsFarAsExists(path) {
    return canonicalizeLocalPathAsFarAsExists(path);
  },

  async stat(path) {
    const stats = await captureFilesystemOperation("stat path", () => fs.stat(path));
    return stats.map((value): HostStats => ({ type: fileTypeFromStats(value), size: value.size }));
  },

  scanText(canonicalPath, request) {
    return scanLocalTextFile(canonicalPath, request);
  },

  readBytePrefix(canonicalPath, limit) {
    return captureFilesystemOperation("read byte prefix", async () => {
      await using handle = await fs.open(canonicalPath, "r");
      const stats = await handle.stat();
      const buffer = Buffer.alloc(Math.min(limit, stats.size));
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      return { bytes: buffer.subarray(0, size), totalBytes: stats.size };
    });
  },

  readBytes(canonicalPath) {
    return captureFilesystemOperation("read byte file", () => fs.readFile(canonicalPath));
  },

  readText(path) {
    return captureFilesystemOperation("read text file", () => fs.readFile(path, "utf-8"));
  },

  async hashTextFiles(paths) {
    const hashes = new Map<string, string>();
    for (const path of paths) {
      if (hashes.has(path)) continue;
      const read = resultOutcome(
        await captureFilesystemOperation("read hashline grep result", () =>
          fs.readFile(path, "utf-8"),
        ),
      );
      if (!read.ok) return Result.err(read.error);
      hashes.set(path, sha256(read.value));
    }
    return Result.ok(hashes);
  },

  async writeText(path, content, options) {
    if (options.createParents) {
      const created = resultOutcome(
        await captureFilesystemOperation("create parent directories", () =>
          fs.mkdir(dirname(path), { recursive: true }),
        ),
      );
      if (!created.ok) return Result.err(created.error);
    }
    return captureFilesystemOperation("write file", () => fs.writeFile(path, content));
  },

  unlink(path) {
    return captureFilesystemOperation("delete file", () => fs.unlink(path));
  },

  searchBackend(backend) {
    return getSearchBackend(backend);
  },

  globWalk(params) {
    return collectLocalGlobMatches(params);
  },

  fffSearch(params) {
    return fuzzyFileSearch(params);
  },

  fzfSearch(params) {
    return fzfFileSearch(params);
  },
};
