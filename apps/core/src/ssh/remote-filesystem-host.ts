import {
  FileSystemOperationFailed,
  getGlobSearchRoots,
  HASHLINE_MAX_LINE_CHARS,
  matchesAnyGlob,
  rankFuzzyCandidates,
  RipgrepExecutionFailed,
  type FileSystemHost,
  type GlobWalkParams,
  type GlobWalkResult,
  type HostGlobEntry,
  type RipgrepResult,
  type SearchBackend,
  type SearchBackendError,
} from "@stanley2058/lilac-fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { sshCallRunner } from "./ssh-exec";

/** Cap on one runner response; file contents travel as JSON and base64. */
const MAX_RESPONSE_CHARS = 128 * 1024 * 1024;
/** Matches the local `fzf` fallback's scan bounds in `packages/fs/src/search-backend.ts`. */
const FUZZY_MAX_FILES = 10_000;
const FUZZY_BUDGET_MS = 10_000;
/** Bound for listings that Core matches itself, used only for extended glob patterns. */
const WALK_MAX_ENTRIES = 200_000;

export class RemoteHostUnavailableError extends TaggedError("RemoteHostUnavailableError")<{
  readonly host: string;
  readonly message: string;
}> {}

const fileTypeSchema = z.enum([
  "symlink",
  "file",
  "directory",
  "socket",
  "block_device",
  "character_device",
  "fifo",
  "unknown",
]);
const fsErrorSchema = z.object({ code: z.string(), message: z.string() });
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: fsErrorSchema }),
]);
const envSchema = z.object({ home: z.string(), denyPaths: z.array(z.array(z.string())) });
const statsSchema = z.object({ type: fileTypeSchema, size: z.number() });
const bytesSchema = z.object({ base64: z.string(), totalBytes: z.number() });
const scanSchema = z.object({
  fileHash: z.string(),
  windowLines: z.array(z.string()),
  totalLines: z.number(),
  selectedLineCount: z.number(),
  firstSelectedLineCharacters: z.number(),
  offsetStartLine: z.number().optional(),
  offsetStartColumn: z.number().optional(),
  normalizedStartOffset: z.number().optional(),
  selectedNextLineOffset: z.number().optional(),
  sourceOffset: z.number(),
  hashlineOverflow: z.object({ line: z.number(), length: z.number() }).optional(),
});
const entrySchema = z.object({ path: z.string(), type: fileTypeSchema, size: z.number() });
const globSchema = z
  .object({
    paths: z.array(z.string()),
    entries: z.array(entrySchema).optional(),
    truncated: z.boolean(),
  })
  .nullable();
const walkSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      isDirectory: z.boolean(),
      type: fileTypeSchema.optional(),
      size: z.number().optional(),
    }),
  ),
  truncated: z.boolean(),
});
const grepSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      column: z.number(),
      text: z.string(),
      submatches: z
        .array(z.object({ match: z.string(), start: z.number(), end: z.number() }))
        .optional(),
    }),
  ),
  truncated: z.boolean(),
});
const fuzzySchema = z
  .object({
    files: z.array(z.object({ path: z.string(), size: z.number() })),
    truncated: z.boolean(),
  })
  .nullable();

type RemoteEnv = {
  readonly home: string;
  readonly denyPaths: ReadonlyMap<string, readonly string[]>;
};

type CallContext = {
  readonly host: string;
  readonly deadline: number;
  readonly signal?: AbortSignal;
};

function failure(operation: string, code: string, message: string): FileSystemOperationFailed {
  return new FileSystemOperationFailed({ operation, code, message });
}

/** One runner call, decoded at the boundary; every failure becomes a filesystem failure. */
async function call<T>(
  context: CallContext,
  operation: string,
  request: Readonly<Record<string, unknown>>,
  schema: z.ZodType<T>,
): Promise<ResultType<T, FileSystemOperationFailed>> {
  if (context.signal?.aborted) return Result.err(failure(operation, "ECANCELED", "aborted"));
  const remainingMs = context.deadline - Date.now();
  if (remainingMs <= 0) {
    return Result.err(failure(operation, "ETIMEDOUT", `remote ${operation} timed out`));
  }
  const outcome = await sshCallRunner({
    host: context.host,
    request,
    timeoutMs: remainingMs,
    signal: context.signal,
    maxOutputChars: MAX_RESPONSE_CHARS,
  });
  if (outcome.kind === "rejected") {
    return Result.err(failure(operation, "ENOHOST", outcome.message));
  }
  if (outcome.kind === "unsupported") {
    return Result.err(failure(operation, "ENOTSUP", `remote host unsupported: ${outcome.reason}`));
  }
  const result = outcome.result;
  if (result.aborted) return Result.err(failure(operation, "ECANCELED", "aborted"));
  if (result.timedOut) {
    return Result.err(failure(operation, "ETIMEDOUT", `remote ${operation} timed out`));
  }
  if (result.capped.stdout) {
    return Result.err(failure(operation, "E2BIG", `remote ${operation} response too large`));
  }
  if (result.transportError) {
    return Result.err(failure(operation, "EREMOTE", result.transportError.message));
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return Result.err(
      failure(
        operation,
        "EREMOTE",
        `remote runner exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
      ),
    );
  }
  return decodeRemoteRunnerEnvelope(operation, result.stdout, schema);
}

/** Decodes the runner's `{ ok, value }` or `{ ok, error }` envelope and its payload. */
export function decodeRemoteRunnerEnvelope<T>(
  operation: string,
  text: string,
  schema: z.ZodType<T>,
): ResultType<T, FileSystemOperationFailed> {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(text),
    catch: () => failure(operation, "EREMOTE", `remote ${operation} returned malformed JSON`),
  });
  const outcome = parsed.match<
    | { readonly kind: "json"; readonly value: unknown }
    | { readonly kind: "failure"; readonly error: FileSystemOperationFailed }
  >({
    ok: (value) => ({ kind: "json", value }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (outcome.kind === "failure") return Result.err(outcome.error);
  const envelope = envelopeSchema.safeParse(outcome.value);
  if (!envelope.success) {
    return Result.err(failure(operation, "EREMOTE", `remote ${operation} returned a bad envelope`));
  }
  if (!envelope.data.ok) {
    return Result.err(failure(operation, envelope.data.error.code, envelope.data.error.message));
  }
  const decoded = schema.safeParse(envelope.data.value);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(failure(operation, "EREMOTE", `remote ${operation} returned a bad payload`));
}

async function loadEnv(
  context: CallContext,
  denyPaths: readonly string[],
): Promise<ResultType<RemoteEnv, FileSystemOperationFailed>> {
  // Deny paths are canonicalized on every call: a cached form would miss a retargeted symlink.
  const loaded = await call(context, "env", { op: "env", denyPaths: [...denyPaths] }, envSchema);
  return loaded.map((value) => {
    const resolvedDenyPaths = new Map<string, readonly string[]>();
    for (const forms of value.denyPaths) {
      const [resolved] = forms;
      if (resolved) resolvedDenyPaths.set(resolved, forms);
    }
    return { home: value.home, denyPaths: resolvedDenyPaths };
  });
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function remoteSearchBackend(context: CallContext): SearchBackend {
  return {
    async glob(options) {
      const globbed = await call(
        context,
        "glob",
        {
          op: "glob",
          cwd: options.cwd,
          patterns: [...options.patterns],
          maxEntries: options.maxEntries,
          denyPaths: [...options.denyPaths],
          dangerouslyAllow: options.dangerouslyAllow,
          withStats: true,
        },
        globSchema,
      );
      const value = globbed.match({ ok: (output) => output, err: () => null });
      if (!value) return null;
      // globset and Node's matcher can disagree, so keep only what Node's matcher accepts.
      const includes = options.patterns.filter((pattern) => pattern && !pattern.startsWith("!"));
      const excludes = options.patterns
        .filter((pattern) => pattern.startsWith("!"))
        .map((pattern) => pattern.slice(1));
      const accepts = (entryPath: string) =>
        matchesAnyGlob(entryPath, includes) && !isExcludedPath(entryPath, excludes);
      const entries: HostGlobEntry[] | undefined = value.entries?.filter((entry) =>
        accepts(entry.path),
      );
      return {
        paths: entries ? entries.map((entry) => entry.path) : value.paths.filter(accepts),
        entries,
        truncated: value.truncated,
        effectiveBackend: "native",
      };
    },
    async grep(options) {
      const grepped = await call(
        context,
        "grep",
        {
          op: "grep",
          cwd: options.cwd,
          searchPath: options.searchPath ?? null,
          pattern: options.pattern,
          regex: options.regex ?? false,
          globs: [...(options.globs ?? [])],
          maxMatches: options.maxMatches ?? 200,
        },
        grepSchema,
      );
      return grepped.match<ResultType<RipgrepResult, SearchBackendError>>({
        ok: (value) => Result.ok({ ...value, effectiveBackend: "native" }),
        err: (error) =>
          Result.err(
            new RipgrepExecutionFailed({ code: null, signal: null, message: error.message }),
          ),
      });
    },
  };
}

function isExcludedPath(entryPath: string, excludes: readonly string[]): boolean {
  let candidate = entryPath;
  while (candidate.length > 0) {
    if (matchesAnyGlob(candidate, excludes)) return true;
    const separator = candidate.lastIndexOf("/");
    if (separator === -1) return false;
    candidate = candidate.slice(0, separator);
  }
  return false;
}

/** Matches a remote listing the way `collectLocalGlobMatches` matches a local walk. */
async function remoteGlobWalk(
  context: CallContext,
  params: GlobWalkParams,
  roots: readonly string[],
): Promise<ResultType<GlobWalkResult, FileSystemOperationFailed>> {
  const listed = await call(
    context,
    "walk",
    {
      op: "walk",
      base: params.resolvedBaseDir,
      roots: [...roots],
      denyPaths: [...params.denyPaths],
      dangerouslyAllow: params.dangerouslyAllow,
      maxEntries: WALK_MAX_ENTRIES,
    },
    walkSchema,
  );
  return listed.map((listing) => {
    const paths: string[] = [];
    const entries: HostGlobEntry[] = [];
    const pruned = new Set<string>();
    let truncated = false;
    const underPruned = (entryPath: string) => {
      let parent = entryPath;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        if (pruned.has(parent)) return true;
      }
      return false;
    };
    for (const entry of listing.entries) {
      if (truncated) break;
      if (underPruned(entry.path)) {
        if (entry.isDirectory) pruned.add(entry.path);
        continue;
      }
      if (matchesAnyGlob(entry.path, params.excludes)) {
        if (entry.isDirectory) pruned.add(entry.path);
        continue;
      }
      if (!matchesAnyGlob(entry.path, params.includes)) continue;
      const count = params.withStats ? entries.length : paths.length;
      if (count >= params.maxEntries) {
        truncated = true;
        break;
      }
      if (!params.withStats) {
        paths.push(entry.path);
      } else if (entry.type !== undefined && entry.size !== undefined) {
        entries.push({ path: entry.path, type: entry.type, size: entry.size });
      }
    }
    return { paths, entries, truncated: truncated || listing.truncated };
  });
}

/**
 * Builds a `FileSystemHost` for one tool call on an SSH host. It loads the remote home directory
 * and canonical deny paths first, because `FileSystem` needs both synchronously.
 */
export async function createRemoteFileSystemHost(params: {
  readonly host: string;
  readonly denyPaths: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ResultType<FileSystemHost, RemoteHostUnavailableError>> {
  const context: CallContext = {
    host: params.host,
    deadline: Date.now() + params.timeoutMs,
    signal: params.signal,
  };
  const loaded = await loadEnv(context, params.denyPaths);
  return loaded.match<ResultType<FileSystemHost, RemoteHostUnavailableError>>({
    err: (error) =>
      Result.err(new RemoteHostUnavailableError({ host: params.host, message: error.message })),
    ok: (env) => Result.ok(remoteHost(context, env)),
  });
}

function remoteHost(context: CallContext, env: RemoteEnv): FileSystemHost {
  const searchBackend = remoteSearchBackend(context);
  return {
    homeDir: env.home,
    canonicalizeDenyPath: (resolvedPath) => env.denyPaths.get(resolvedPath) ?? [resolvedPath],
    realpath: (target) => call(context, "realpath", { op: "realpath", path: target }, z.string()),
    canonicalizeAsFarAsExists: (target) =>
      call(
        context,
        "canonicalize",
        { op: "canonicalize_as_far_as_exists", path: target },
        z.string(),
      ),
    stat: (target) => call(context, "stat", { op: "stat", path: target }, statsSchema),
    scanText: (canonicalPath, request) =>
      call(
        context,
        "read",
        {
          op: "scan_text",
          path: canonicalPath,
          start: request.start,
          maxLines: request.maxLines,
          maxCharacters: request.maxCharacters,
          hashlineMaxLineChars: HASHLINE_MAX_LINE_CHARS,
        },
        scanSchema,
      ),
    readBytePrefix: async (canonicalPath, limit) =>
      (
        await call(
          context,
          "read byte prefix",
          { op: "read_prefix", path: canonicalPath, limit },
          bytesSchema,
        )
      ).map((value) => ({ bytes: decodeBase64(value.base64), totalBytes: value.totalBytes })),
    readBytes: async (canonicalPath) =>
      (
        await call(
          context,
          "read byte file",
          { op: "read_bytes", path: canonicalPath },
          bytesSchema,
        )
      ).map((value) => decodeBase64(value.base64)),
    readText: (target) => call(context, "read", { op: "read_text", path: target }, z.string()),
    hashTextFiles: async (paths) =>
      (
        await call(
          context,
          "hash",
          { op: "hash_text_files", paths: [...paths] },
          z.record(z.string(), z.string()),
        )
      ).map((value) => new Map(Object.entries(value))),
    writeText: (target, content, options) =>
      call(
        context,
        "write",
        { op: "write_text", path: target, content, createParents: options.createParents },
        z.null(),
      ).then((result) => result.map(() => undefined)),
    unlink: (target) =>
      call(context, "delete", { op: "unlink", path: target }, z.null()).then((result) =>
        result.map(() => undefined),
      ),
    searchBackend: () => searchBackend,
    globWalk: (params) => remoteGlobWalk(context, params, getGlobSearchRoots(params.includes)),
    fffSearch: async () => null,
    fzfSearch: async (params) => {
      const walked = await call(
        context,
        "fuzzy search",
        {
          op: "fuzzy_candidates",
          cwd: params.cwd,
          denyPaths: [...params.denyPaths],
          dangerouslyAllow: params.dangerouslyAllow,
          maxFiles: FUZZY_MAX_FILES,
          budgetMs: FUZZY_BUDGET_MS,
        },
        fuzzySchema,
      );
      const candidates = walked.match({ ok: (value) => value, err: () => null });
      if (!candidates) return null;
      const sizes = new Map(candidates.files.map((file) => [file.path, file.size]));
      return await rankFuzzyCandidates({
        files: candidates.files.map((file) => file.path),
        query: params.query,
        maxResults: params.maxResults,
        scanTruncated: candidates.truncated,
        sizeOf: async (candidate) => sizes.get(candidate) ?? null,
      });
    },
  };
}
