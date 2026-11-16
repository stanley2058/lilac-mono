import {
  FileSystem,
  type EditFileResult,
  type FileEdit,
  type FuzzySearchResult,
  type GlobResult,
  type GrepResult,
  type HashlineEdit,
  type ReadFileResult,
  type ReadFileStart,
} from "@stanley2058/lilac-fs";
import { Result, type Result as ResultType } from "better-result";

import {
  createRemoteFileSystemHost,
  type RemoteHostUnavailableError,
} from "../../ssh/remote-filesystem-host";

export type RemoteReadTextInput = {
  path: string;
  start?: ReadFileStart;
  maxLines?: number;
  maxCharacters?: number;
  maxBytes?: number;
  format?: "raw" | "numbered" | "hashline";
};

export type RemoteReadTextOutput = ReadFileResult;
export type RemoteReadBytesResult =
  | {
      ok: true;
      resolvedPath: string;
      fileHash: string;
      bytesLength: number;
      totalBytes?: number;
      base64: string;
    }
  | {
      ok: false;
      resolvedPath?: string;
      error: string;
      errorCode?: "NOT_FOUND" | "PERMISSION" | "MEDIA_TOO_LARGE" | "UNKNOWN";
    };
export type RemoteGlobOutput = GlobResult;
export type RemoteGlobEntry = Extract<GlobResult, { mode: "detailed" }>["entries"][number];
export type RemoteGrepOutput = GrepResult;
export type RemoteGrepMatch = Extract<GrepResult, { mode: "detailed" }>["results"][number];
export type RemoteFuzzySearchOutput = FuzzySearchResult;

export type RemoteEditInput =
  | {
      path: string;
      edits: FileEdit[];
      expectedHash?: string;
      mode?: "legacy";
    }
  | {
      path: string;
      edits: readonly HashlineEdit[];
      mode: "hashline";
      expectedHash?: string;
    };

export type RemoteEditOutput = EditFileResult;

export type RemoteFsExecutionError = RemoteHostUnavailableError;

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
/** Byte reads without an explicit limit keep the bundled runner's former cap. */
const DEFAULT_MAX_READ_BYTES = 10_000_000;

/** Runs one filesystem call against an SSH host, through the same `FileSystem` Core uses locally. */
async function withRemoteFileSystem<T>(
  params: {
    host: string;
    cwd: string;
    denyPaths: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  run: (fileSystem: FileSystem) => Promise<T>,
  search?: { readonly fsBackend: "fff"; readonly fuzzySearchFallback: "fzf" },
): Promise<ResultType<T, RemoteFsExecutionError>> {
  const created = await createRemoteFileSystemHost({
    host: params.host,
    denyPaths: params.denyPaths,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
  });
  return await created.match<Promise<ResultType<T, RemoteFsExecutionError>>>({
    err: async (error) => Result.err(error),
    ok: async (host) =>
      Result.ok(
        await run(new FileSystem(params.cwd, { ...search, denyPaths: params.denyPaths, host })),
      ),
  });
}

/** Drops per-edit diagnostics, which the remote edit contract never carried. */
function normalizeEditOutput(result: EditFileResult): EditFileResult {
  if (result.success) {
    return {
      success: true,
      resolvedPath: result.resolvedPath,
      oldHash: result.oldHash,
      newHash: result.newHash,
      changesMade: result.changesMade,
      replacementsMade: result.replacementsMade,
    };
  }
  return {
    success: false,
    resolvedPath: result.resolvedPath,
    currentHash: result.currentHash,
    error: result.error,
  };
}

export async function remoteReadTextFile(params: {
  host: string;
  cwd: string;
  input: RemoteReadTextInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteReadTextOutput, RemoteFsExecutionError>> {
  return await withRemoteFileSystem(params, (fileSystem) =>
    fileSystem.readFile({
      path: params.input.path,
      start: params.input.start,
      maxLines: params.input.maxLines,
      maxCharacters: params.input.maxCharacters,
      maxBytes: params.input.maxBytes,
      format: params.input.format ?? "raw",
    }),
  );
}

export async function remoteReadFileBytes(params: {
  host: string;
  cwd: string;
  filePath: string;
  denyPaths: readonly string[];
  maxBytes: number;
  prefixBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteReadBytesResult, RemoteFsExecutionError>> {
  return await withRemoteFileSystem(params, async (fileSystem) => {
    const result = await fileSystem.readFileBytes({
      path: params.filePath,
      maxBytes: params.maxBytes ?? DEFAULT_MAX_READ_BYTES,
      prefixBytes: params.prefixBytes,
    });
    if (!result.success) {
      return {
        ok: false,
        resolvedPath: result.resolvedPath,
        error: result.error.message,
        errorCode: result.error.code,
      } satisfies RemoteReadBytesResult;
    }
    return {
      ok: true,
      resolvedPath: result.resolvedPath,
      fileHash: result.fileHash,
      bytesLength: result.bytesLength,
      ...(result.totalBytes === undefined ? {} : { totalBytes: result.totalBytes }),
      base64: Buffer.from(result.bytes).toString("base64"),
    } satisfies RemoteReadBytesResult;
  });
}

export async function remoteGlob(params: {
  host: string;
  cwd: string;
  patterns: readonly string[];
  maxEntries?: number;
  mode?: "default" | "detailed";
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteGlobOutput, RemoteFsExecutionError>> {
  return await withRemoteFileSystem(params, (fileSystem) =>
    fileSystem.glob({
      patterns: [...params.patterns],
      maxEntries: params.maxEntries,
      mode: params.mode ?? "default",
    }),
  );
}

export async function remoteGrep(params: {
  host: string;
  cwd: string;
  input: {
    pattern: string;
    regex?: boolean;
    maxResults?: number;
    fileExtensions?: readonly string[];
    includeContextLines?: number;
    mode?: "default" | "detailed" | "hashline";
  };
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteGrepOutput, RemoteFsExecutionError>> {
  return await withRemoteFileSystem(params, (fileSystem) =>
    fileSystem.grep({
      pattern: params.input.pattern,
      baseDir: params.cwd,
      reportedFilePath: params.cwd,
      regex: params.input.regex,
      maxResults: params.input.maxResults,
      fileExtensions: params.input.fileExtensions?.map((extension) => extension.replace(/^\./, "")),
      includeContextLines: params.input.includeContextLines,
      mode: params.input.mode ?? "default",
    }),
  );
}

export async function remoteFuzzySearch(params: {
  host: string;
  cwd: string;
  input: {
    query: string;
    maxResults?: number;
  };
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteFuzzySearchOutput, RemoteFsExecutionError>> {
  // Remote hosts have no fff index, so fuzzy search walks and ranks with fzf.
  return await withRemoteFileSystem(
    params,
    (fileSystem) =>
      fileSystem.fuzzySearchFiles({
        query: params.input.query,
        maxResults: params.input.maxResults,
      }),
    { fsBackend: "fff", fuzzySearchFallback: "fzf" },
  );
}

export async function remoteEditFile(params: {
  host: string;
  cwd: string;
  input: RemoteEditInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteEditOutput, RemoteFsExecutionError>> {
  return await withRemoteFileSystem(params, async (fileSystem) => {
    const input = params.input;
    const expectedHash =
      input.expectedHash && input.expectedHash.length > 0 ? input.expectedHash : undefined;
    if (input.mode === "hashline") {
      return normalizeEditOutput(
        await fileSystem.hashlineEditFile({ path: input.path, edits: input.edits, expectedHash }),
      );
    }
    if (expectedHash) {
      return normalizeEditOutput(
        await fileSystem.editFile({ path: input.path, edits: [...input.edits], expectedHash }),
      );
    }
    // Each call builds a new FileSystem, so it has no read record; read first to get the hash.
    const read = await fileSystem.readFile({
      path: input.path,
      start: { type: "line", line: 1 },
      maxLines: 1,
      maxCharacters: 1,
      format: "raw",
    });
    if (!read.success) return read;
    return normalizeEditOutput(
      await fileSystem.editFile({
        path: input.path,
        edits: [...input.edits],
        expectedHash: read.fileHash,
      }),
    );
  });
}

// For unit tests and future callsites.
export function toRemoteDebugPath(host: string, resolvedPath: string): string {
  if (resolvedPath.startsWith("ssh://")) return resolvedPath;
  const p = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;
  return `ssh://${host}${p}`;
}
