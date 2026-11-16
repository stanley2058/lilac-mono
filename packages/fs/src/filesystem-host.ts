import type { Result as ResultType } from "better-result";

import type { FileSystemOperationFailed } from "./filesystem-operation";
import type { FsBackend, FuzzyFileSearchResult, SearchBackend } from "./search-backend";
import type { TextScan, TextScanRequest } from "./text-scan";

export type HostFileType =
  | "symlink"
  | "file"
  | "directory"
  | "socket"
  | "block_device"
  | "character_device"
  | "fifo"
  | "unknown";

export type HostStats = { readonly type: HostFileType; readonly size: number };

export type HostGlobEntry = { path: string; type: HostFileType; size: number };

export type GlobWalkParams = {
  readonly resolvedBaseDir: string;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly maxEntries: number;
  readonly withStats: boolean;
  readonly denyPaths: readonly string[];
  readonly dangerouslyAllow: boolean;
};

export type GlobWalkResult = {
  readonly paths: string[];
  readonly entries: HostGlobEntry[];
  readonly truncated: boolean;
};

export type FuzzySearchParams = {
  readonly cwd: string;
  readonly query: string;
  readonly maxResults: number;
  readonly denyPaths: readonly string[];
  readonly dangerouslyAllow: boolean;
  readonly cacheDir?: string;
};

type HostResult<T> = Promise<ResultType<T, FileSystemOperationFailed>>;

/**
 * The I/O `FileSystem` performs. The local host uses `node:fs` and local search tools; the remote
 * host forwards each call to the native runner on an SSH host. Paths are absolute host paths.
 */
export interface FileSystemHost {
  /** Home directory on the host, used to expand `~`. */
  readonly homeDir: string;
  /** The deny path itself plus its canonical form when that differs. */
  canonicalizeDenyPath(resolvedPath: string): readonly string[];
  realpath(path: string): HostResult<string>;
  /** Resolves symlinks for the existing prefix of `path` and appends the missing segments. */
  canonicalizeAsFarAsExists(path: string): HostResult<string>;
  stat(path: string): HostResult<HostStats>;
  scanText(canonicalPath: string, request: TextScanRequest): HostResult<TextScan>;
  readBytePrefix(
    canonicalPath: string,
    limit: number,
  ): HostResult<{ readonly bytes: Uint8Array; readonly totalBytes: number }>;
  readBytes(canonicalPath: string): HostResult<Uint8Array>;
  readText(path: string): HostResult<string>;
  /** SHA-256 of each file read as UTF-8 text, keyed by the requested path. */
  hashTextFiles(paths: readonly string[]): HostResult<ReadonlyMap<string, string>>;
  writeText(path: string, content: string, options: { createParents: boolean }): HostResult<void>;
  unlink(path: string): HostResult<void>;
  searchBackend(backend: FsBackend): SearchBackend;
  /** The fallback glob walk, used when the search backend cannot answer. */
  globWalk(params: GlobWalkParams): HostResult<GlobWalkResult>;
  fffSearch(params: FuzzySearchParams): Promise<FuzzyFileSearchResult | null>;
  fzfSearch(params: FuzzySearchParams): Promise<FuzzyFileSearchResult | null>;
}
