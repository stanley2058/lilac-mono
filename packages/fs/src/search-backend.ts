import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Dir, Stats } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, matchesGlob, relative, sep } from "node:path";

import type { FileFinderApi } from "@ff-labs/fff-node";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { AsyncFzf } from "fzf";

import { captureFilesystemOperation, type FileSystemOperationFailed } from "./filesystem-operation";
import {
  ripgrep,
  type GrepMatch,
  type GrepOptions,
  type RipgrepError,
  type RipgrepResult,
} from "./ripgrep";

export const FS_BACKENDS = ["fff", "node-rg"] as const;
export type FsBackend = (typeof FS_BACKENDS)[number];
export type EffectiveSearchBackend = FsBackend | "node-fs";
export type EffectiveFuzzySearchBackend = "fff" | "fzf";

export type GlobSearchResult = {
  paths: string[];
  truncated: boolean;
  effectiveBackend: "fff" | "node-rg";
};

export type FuzzyFileSearchResult = {
  results: {
    path: string;
    fileName: string;
    size: number;
    gitStatus: string;
    score?: number;
    matchType?: string;
  }[];
  totalMatched: number;
  totalFiles: number;
  truncated: boolean;
  effectiveBackend: EffectiveFuzzySearchBackend;
};

export type FffPrewarmResult = {
  basePath: string;
  ok: boolean;
  skipped?: "not-directory" | "deny-path" | "unavailable";
};

export type SearchBackend = {
  grep(options: GrepOptions): Promise<ResultType<RipgrepResult, SearchBackendError>>;
  glob(options: {
    cwd: string;
    patterns: readonly string[];
    maxEntries: number;
    denyPaths: readonly string[];
    dangerouslyAllow: boolean;
    cacheDir?: string;
  }): Promise<GlobSearchResult | null>;
};

export type SearchBackendError = SearchBackendUnavailable | RipgrepError;

export class SearchBackendUnavailable extends TaggedError("SearchBackendUnavailable")<{
  readonly backend: FsBackend;
  readonly message: string;
}> {}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E } {
  return result.match<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

async function captureFffOperation<T>(
  effect: () => Promise<T>,
): Promise<ResultType<T, SearchBackendUnavailable>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) =>
      Panic.is(cause)
        ? { kind: "panic" as const, panic: cause }
        : {
            kind: "error" as const,
            error: new SearchBackendUnavailable({
              backend: "fff",
              message: cause instanceof Error ? cause.message : "FFF search backend is unavailable",
            }),
          },
  });
  const outcome = captured.match<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "error"; readonly error: SearchBackendUnavailable }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: (failure) => failure,
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.kind === "value" ? Result.ok(outcome.value) : Result.err(outcome.error);
}

function captureFffSyncOperation<T>(effect: () => T): ResultType<T, SearchBackendUnavailable> {
  const captured = Result.try({
    try: () => ({ value: effect() }),
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<{ readonly value: T } | { readonly cause: unknown }>({
    ok: ({ value }) => ({ value }),
    err: ({ cause }) => ({ cause }),
  });
  if ("value" in outcome) return Result.ok(outcome.value);
  if (Panic.is(outcome.cause)) throw outcome.cause;
  return Result.err(
    new SearchBackendUnavailable({
      backend: "fff",
      message:
        outcome.cause instanceof Error
          ? outcome.cause.message
          : "FFF search backend is unavailable",
    }),
  );
}

const nodeRgBackend: SearchBackend = {
  grep: ripgrep,
  async glob(options) {
    return await fdGlob(options);
  },
};

type FffFinderEntry = {
  finder: FileFinderApi;
  ready: Promise<boolean>;
};

type FffStoragePaths = {
  frecencyDbPath?: string;
  historyDbPath?: string;
};

const MAX_FFF_FINDER_CACHE_ENTRIES = 8;
const MAX_FFF_GLOB_STAT_CONCURRENCY = 64;
const MAX_FZF_FILES = 10_000;
const FZF_SCAN_BUDGET_MS = 10_000;
const fffFindersByBasePath = new Map<string, FffFinderEntry>();
const FFF_NODE_PACKAGE = ["@ff-labs", "fff-node"].join("/");

function fffFinderCacheKey(basePath: string, cacheDir?: string): string {
  return `${cacheDir ?? ""}\0${basePath}`;
}

function destroyFffFinder(entry: FffFinderEntry): void {
  captureFffSyncOperation(() => entry.finder.destroy());
}

function cacheFffFinder(cacheKey: string, entry: FffFinderEntry): void {
  fffFindersByBasePath.set(cacheKey, entry);

  while (fffFindersByBasePath.size > MAX_FFF_FINDER_CACHE_ENTRIES) {
    const oldest = fffFindersByBasePath.entries().next().value;
    if (!oldest) return;
    const [oldestCacheKey, oldestEntry] = oldest;
    fffFindersByBasePath.delete(oldestCacheKey);
    destroyFffFinder(oldestEntry);
  }
}

function rootStorageKey(basePath: string): string {
  return createHash("sha256").update(basePath).digest("hex").slice(0, 16);
}

async function resolveFffStoragePaths(
  cacheDir: string | undefined,
  basePath: string,
): Promise<FffStoragePaths> {
  if (!cacheDir) return {};

  const rootDir = join(cacheDir, "roots", rootStorageKey(basePath));
  const frecencyDbPath = join(rootDir, "frecency");
  const historyDbPath = join(rootDir, "history");
  const frecencyCreated = await captureFilesystemOperation("create FFF frecency directory", () =>
    fs.mkdir(frecencyDbPath, { recursive: true }),
  );
  if (!resultOutcome(frecencyCreated).ok) return {};
  const historyCreated = await captureFilesystemOperation("create FFF history directory", () =>
    fs.mkdir(historyDbPath, { recursive: true }),
  );
  return resultOutcome(historyCreated).ok ? { frecencyDbPath, historyDbPath } : {};
}

function shouldFallbackForDenyPaths(params: {
  cwd: string;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
}): boolean {
  if (params.dangerouslyAllow) return false;

  for (const denyPath of params.denyPaths) {
    const rel = relative(params.cwd, denyPath);
    if (rel.length === 0) return true;
    if (rel.startsWith("..") || rel.startsWith(sep)) continue;
    return true;
  }

  return false;
}

function isDeniedPath(path: string, denyPaths: readonly string[]): boolean {
  return denyPaths.some((denyPath) => path === denyPath || path.startsWith(`${denyPath}${sep}`));
}

function isSkippableTraversalError(error: FileSystemOperationFailed): boolean {
  return (
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "ENOENT" ||
    error.code === "ENOTDIR"
  );
}

async function getFffFinder(basePath: string, cacheDir?: string): Promise<FileFinderApi | null> {
  const cacheKey = fffFinderCacheKey(basePath, cacheDir);
  const cached = fffFindersByBasePath.get(cacheKey);
  if (cached) {
    fffFindersByBasePath.delete(cacheKey);
    fffFindersByBasePath.set(cacheKey, cached);
    await cached.ready;
    return cached.finder;
  }

  const loaded = await captureFffOperation(async () => {
    const fff = (await import(FFF_NODE_PACKAGE)) as typeof import("@ff-labs/fff-node");
    if (!fff.FileFinder.isAvailable()) return null;

    const storagePaths = await resolveFffStoragePaths(cacheDir, basePath);
    const created = fff.FileFinder.create({
      basePath,
      aiMode: true,
      ...storagePaths,
      // Keep cached indexes fresh after background edits. Eviction destroys
      // the finder, which also stops the native watcher for that base path.
      disableWatch: false,
    });
    if (!created.ok) return null;

    const finder = created.value;
    const ready = captureFffOperation(() => finder.waitForIndexReady(10_000)).then((result) =>
      result.match({ ok: (value) => value.ok && value.value, err: () => false }),
    );
    cacheFffFinder(cacheKey, { finder, ready });

    await ready;
    return finder;
  });
  return loaded.match({ ok: (value) => value, err: () => null });
}

async function isDirectory(path: string): Promise<boolean> {
  const stat = await captureFilesystemOperation("stat FFF search root", () => fs.stat(path));
  return stat.match({ ok: (value) => value.isDirectory(), err: () => false });
}

export async function prewarmFffFinders(params: {
  basePaths: readonly string[];
  denyPaths: readonly string[];
  cacheDir?: string;
}): Promise<FffPrewarmResult[]> {
  const results: FffPrewarmResult[] = [];
  const seen = new Set<string>();
  const canonicalDenyPaths: string[] = [];
  for (const denyPath of params.denyPaths) {
    const canonical = await captureFilesystemOperation("resolve FFF deny path", () =>
      fs.realpath(denyPath),
    );
    canonicalDenyPaths.push(canonical.match({ ok: (value) => value, err: () => denyPath }));
  }

  for (const basePath of params.basePaths) {
    if (seen.has(basePath)) continue;
    seen.add(basePath);
    const canonical = await captureFilesystemOperation("resolve FFF search root", () =>
      fs.realpath(basePath),
    );
    const canonicalBasePath = canonical.match({ ok: (value) => value, err: () => basePath });

    if (!(await isDirectory(canonicalBasePath))) {
      results.push({ basePath, ok: false, skipped: "not-directory" });
      continue;
    }

    if (
      shouldFallbackForDenyPaths({
        cwd: canonicalBasePath,
        denyPaths: canonicalDenyPaths,
        dangerouslyAllow: false,
      })
    ) {
      results.push({ basePath, ok: false, skipped: "deny-path" });
      continue;
    }

    const finder = await getFffFinder(canonicalBasePath, params.cacheDir);
    results.push(finder ? { basePath, ok: true } : { basePath, ok: false, skipped: "unavailable" });
  }

  return results;
}

export async function fuzzyFileSearch(params: {
  cwd: string;
  query: string;
  maxResults: number;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
  cacheDir?: string;
}): Promise<FuzzyFileSearchResult | null> {
  if (
    shouldFallbackForDenyPaths({
      cwd: params.cwd,
      denyPaths: params.denyPaths,
      dangerouslyAllow: params.dangerouslyAllow,
    })
  ) {
    return null;
  }

  const finder = await getFffFinder(params.cwd, params.cacheDir);
  if (!finder) return null;

  const limit = Math.max(1, params.maxResults);
  const searched = captureFffSyncOperation(() =>
    finder.fileSearch(params.query, { pageSize: limit + 1 }),
  );
  const searchedOutcome = resultOutcome(searched);
  if (!searchedOutcome.ok || !searchedOutcome.value.ok) return null;
  const result = searchedOutcome.value.value;
  const items = result.items.slice(0, limit);
  return {
    results: items.map((item, index) => {
      const score = result.scores[index];
      return {
        path: item.relativePath,
        fileName: item.fileName,
        size: item.size,
        gitStatus: item.gitStatus,
        score: score?.total,
        matchType: score?.matchType,
      };
    }),
    totalMatched: result.totalMatched,
    totalFiles: result.totalFiles,
    truncated: result.items.length > limit || result.totalMatched > limit,
    effectiveBackend: "fff",
  };
}

export async function fzfFileSearch(params: {
  cwd: string;
  query: string;
  maxResults: number;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
}): Promise<FuzzyFileSearchResult | null> {
  const files: string[] = [];
  const pendingDirectories = [params.cwd];
  const scanDeadline = Date.now() + FZF_SCAN_BUDGET_MS;
  let scanTruncated = false;

  while (pendingDirectories.length > 0) {
    if (files.length >= MAX_FZF_FILES || Date.now() >= scanDeadline) {
      scanTruncated = true;
      break;
    }
    const directory = pendingDirectories.pop();
    if (!directory) break;
    if (!params.dangerouslyAllow && isDeniedPath(directory, params.denyPaths)) continue;

    const directoryStats = await captureFilesystemOperation("inspect fzf search directory", () =>
      fs.lstat(directory),
    );
    const stats = directoryStats.match<Stats | null | false>({
      ok: (value) => value,
      err: (error) => (isSkippableTraversalError(error) ? null : false),
    });
    if (stats === false) return null;
    if (stats === null || !stats.isDirectory()) continue;

    const opened = await captureFilesystemOperation("open fzf search directory", () =>
      fs.opendir(directory),
    );
    const dir = opened.match<Dir | null | false>({
      ok: (value) => value,
      err: (error) => (isSkippableTraversalError(error) ? null : false),
    });
    if (dir === false) return null;
    if (dir === null) continue;

    const canonicalDirectory = await captureFilesystemOperation(
      "resolve opened fzf search directory",
      () => fs.realpath(directory),
    );
    const canonicalPath = canonicalDirectory.match<string | null | false>({
      ok: (value) => value,
      err: (error) => (isSkippableTraversalError(error) ? null : false),
    });
    if (
      canonicalPath === null ||
      canonicalPath === false ||
      canonicalPath !== directory ||
      (!params.dangerouslyAllow && isDeniedPath(canonicalPath, params.denyPaths))
    ) {
      await captureFilesystemOperation("close skipped fzf search directory", () => dir.close());
      if (canonicalPath === false) return null;
      continue;
    }

    const childDirectories: string[] = [];
    const iterated = await captureFilesystemOperation("iterate fzf search directory", async () => {
      for await (const dirent of dir) {
        if (files.length >= MAX_FZF_FILES || Date.now() >= scanDeadline) {
          scanTruncated = true;
          break;
        }
        const absolutePath = join(directory, dirent.name);
        if (!params.dangerouslyAllow && isDeniedPath(absolutePath, params.denyPaths)) continue;
        if (dirent.isDirectory()) {
          childDirectories.push(absolutePath);
        } else if (dirent.isFile()) {
          files.push(relative(params.cwd, absolutePath).split(sep).join("/"));
        }
      }
    });
    const iterationCompleted = iterated.match({
      ok: () => true,
      err: (error) => (isSkippableTraversalError(error) ? false : null),
    });
    if (iterationCompleted === null) return null;
    if (!iterationCompleted) continue;

    childDirectories.sort().reverse();
    pendingDirectories.push(...childDirectories);
  }

  const limit = Math.max(1, params.maxResults);
  files.sort();
  const matches = await new AsyncFzf(files).find(params.query);
  const results: FuzzyFileSearchResult["results"] = [];

  for (const match of matches) {
    if (results.length >= limit) break;
    const stats = await captureFilesystemOperation("inspect fzf search result", () =>
      fs.lstat(join(params.cwd, match.item)),
    );
    const fileStats = stats.match<Stats | null | false>({
      ok: (value) => value,
      err: (error) => (isSkippableTraversalError(error) ? null : false),
    });
    if (fileStats === false) return null;
    if (fileStats === null || !fileStats.isFile()) continue;

    results.push({
      path: match.item,
      fileName: basename(match.item),
      size: fileStats.size,
      gitStatus: "unknown",
      score: match.score,
      matchType: "fuzzy",
    });
  }

  return {
    results,
    totalMatched: matches.length,
    totalFiles: files.length,
    truncated: scanTruncated || matches.length > results.length,
    effectiveBackend: "fzf",
  };
}

function buildFffGrepQuery(pattern: string, globs: readonly string[] | undefined): string {
  const constraints = globs?.filter((glob) => glob.length > 0 && !glob.startsWith("!")) ?? [];
  if (constraints.length === 0) return pattern;
  return `${constraints.join(" ")} ${pattern}`;
}

function hasMultiplePositiveGlobConstraints(globs: readonly string[] | undefined): boolean {
  const constraints = globs?.filter((glob) => glob.length > 0 && !glob.startsWith("!")) ?? [];
  return constraints.length > 1;
}

function isFileLikeGlobPattern(pattern: string): boolean {
  const lastSegment = pattern.split(/[\\/]/u).pop() ?? pattern;
  return lastSegment.includes(".");
}

function targetsNodeModules(pattern: string): boolean {
  return pattern.split(/[\\/]/u).includes("node_modules");
}

function normalizeNativeGlob(pattern: string): string {
  return pattern
    .replace(/^\.\/+/, "")
    .split(sep)
    .join("/");
}

function supportsFdGlob(pattern: string): boolean {
  return !/[+@?!*]\(/u.test(pattern);
}

function literalGlobSearchRoot(pattern: string): string {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  const prefix: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "..") return "";
    if (/[*?[\]{}()!+@]/u.test(segment)) return prefix.join("/");
    prefix.push(segment);
  }
  return prefix.slice(0, -1).join("/");
}

function escapeFdGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]{}]/gu, "\\$&");
}

function matchesGlobContract(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern) || matchesGlob(`${path}/`, pattern));
}

function isExcludedByGlobContract(path: string, patterns: readonly string[]): boolean {
  let candidate = path;
  while (candidate.length > 0) {
    if (matchesGlobContract(candidate, patterns)) return true;
    const separator = candidate.lastIndexOf("/");
    if (separator === -1) return false;
    candidate = candidate.slice(0, separator);
  }
  return false;
}

function fdPrunedBasename(pattern: string): string | null {
  const match = /^\*\*\/([^*?[\]{}()!+@/]+)\/\*\*\/?$/u.exec(pattern);
  return match?.[1] ?? null;
}

function fdCandidatePatterns(pattern: string): string[] {
  const withoutTrailingSlash = pattern.replace(/\/+$/u, "");
  const withoutTerminalGlobstar = withoutTrailingSlash.endsWith("/**")
    ? withoutTrailingSlash.slice(0, -3)
    : withoutTrailingSlash;
  return [...new Set([withoutTerminalGlobstar, withoutTrailingSlash, pattern])].filter(
    (candidate) => candidate.length > 0,
  );
}

function fdGlobArgs(params: {
  cwd: string;
  candidatePattern: string;
  excludes: readonly string[];
}): string[] {
  const args = [
    "--hidden",
    "--no-ignore",
    "--case-sensitive",
    "--glob",
    "--full-path",
    "--print0",
    "--color",
    "never",
    "--base-directory",
    params.cwd,
  ];
  for (const exclude of params.excludes) {
    const basename = fdPrunedBasename(exclude);
    if (basename) args.push("--exclude", basename);
  }

  const cwdPrefix = escapeFdGlobLiteral(normalizeNativeGlob(params.cwd));
  args.push("--", `${cwdPrefix}/${params.candidatePattern}`);
  return args;
}

async function collectFdGlobPattern(params: {
  cwd: string;
  pattern: string;
  candidatePattern: string;
  excludes: readonly string[];
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
  limit: number;
  paths: string[];
  seen: Set<string>;
}): Promise<boolean | null> {
  const child = spawn("fd", fdGlobArgs(params), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdout = child.stdout;
  if (!stdout) {
    child.kill("SIGTERM");
    return null;
  }

  return await new Promise<boolean | null>((resolve) => {
    let remainder = "";
    let terminatedAtLimit = false;
    let settled = false;

    const settle = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const consumePath = (path: string) => {
      if (path.length === 0 || terminatedAtLimit) return;
      const withoutPrefix = path.startsWith("./") ? path.slice(2) : path;
      const normalized = withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
      if (normalized.length === 0 || params.seen.has(normalized)) return;
      if (!matchesGlobContract(normalized, [params.pattern])) return;
      if (isExcludedByGlobContract(normalized, params.excludes)) return;
      const absolute = join(params.cwd, normalized);
      if (!params.dangerouslyAllow && isDeniedPath(absolute, params.denyPaths)) return;
      params.seen.add(normalized);
      params.paths.push(normalized);
      if (params.paths.length <= params.limit) return;

      terminatedAtLimit = true;
      child.kill("SIGTERM");
      stdout.destroy();
    };

    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (terminatedAtLimit) return;
      remainder += chunk;
      while (!terminatedAtLimit) {
        const separator = remainder.indexOf("\0");
        if (separator === -1) break;
        consumePath(remainder.slice(0, separator));
        remainder = remainder.slice(separator + 1);
      }
    });

    child.on("error", () => settle(null));
    child.on("close", (code) => {
      if (!terminatedAtLimit && remainder.length > 0) consumePath(remainder);
      const exitedNormally = code === 0;
      const exitedAtLimit = terminatedAtLimit;
      settle(exitedNormally || exitedAtLimit ? terminatedAtLimit : null);
    });
  });
}

async function fdGlob(options: {
  cwd: string;
  patterns: readonly string[];
  maxEntries: number;
  denyPaths: readonly string[];
  dangerouslyAllow: boolean;
}): Promise<GlobSearchResult | null> {
  if (shouldFallbackForDenyPaths(options)) return null;

  const includes = options.patterns
    .filter((pattern) => pattern.length > 0 && !pattern.startsWith("!"))
    .map(normalizeNativeGlob);
  const excludes = options.patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => normalizeNativeGlob(pattern.slice(1)))
    .filter((pattern) => pattern.length > 0);
  if (![...includes, ...excludes].every(supportsFdGlob)) return null;

  const limit = Math.max(0, Math.floor(options.maxEntries));
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const pattern of new Set(includes)) {
    const literalRoot = literalGlobSearchRoot(pattern);
    if (
      literalRoot.length > 0 &&
      !seen.has(literalRoot) &&
      matchesGlobContract(literalRoot, [pattern]) &&
      !isExcludedByGlobContract(literalRoot, excludes)
    ) {
      const stats = resultOutcome(
        await captureFilesystemOperation("inspect fd glob search root", () =>
          fs.lstat(join(options.cwd, literalRoot)),
        ),
      );
      if (!stats.ok && !isSkippableTraversalError(stats.error)) return null;
      if (stats.ok && stats.value.isSymbolicLink()) return null;
      if (stats.ok) {
        seen.add(literalRoot);
        paths.push(literalRoot);
        if (paths.length > limit) break;
      }
    }

    for (const candidatePattern of fdCandidatePatterns(pattern)) {
      const truncated = await collectFdGlobPattern({
        ...options,
        pattern,
        candidatePattern,
        excludes,
        limit,
        paths,
        seen,
      });
      if (truncated === null) return null;
      if (truncated) break;
    }
    if (paths.length > limit) break;
  }

  return {
    paths: paths.slice(0, limit),
    truncated: paths.length > limit,
    effectiveBackend: "node-rg",
  };
}

function mapFffGrepMatch(item: {
  relativePath: string;
  lineNumber: number;
  col: number;
  lineContent: string;
  matchRanges: readonly (readonly [number, number])[];
}): GrepMatch {
  const submatches = item.matchRanges.map(([start, end]) => ({
    match: item.lineContent.slice(start, end),
    start,
    end,
  }));

  return {
    file: item.relativePath,
    line: item.lineNumber,
    column: item.col + 1,
    text: item.lineContent,
    ...(submatches.length > 0 ? { submatches } : {}),
  };
}

const fffBackend: SearchBackend = {
  async grep(options) {
    // FFF indexes directories; explicit single-file searches must not broaden to siblings.
    if (options.searchPath !== undefined) {
      return await nodeRgBackend.grep(options);
    }

    if (
      shouldFallbackForDenyPaths({
        cwd: options.cwd,
        denyPaths: options.denyPaths ?? [],
        dangerouslyAllow: options.dangerouslyAllow ?? false,
      })
    ) {
      return await nodeRgBackend.grep(options);
    }

    if (hasMultiplePositiveGlobConstraints(options.globs)) {
      return await nodeRgBackend.grep(options);
    }

    const finder = await getFffFinder(options.cwd, options.fffCacheDir);
    if (!finder) return await nodeRgBackend.grep(options);

    const limit = Math.max(1, options.maxMatches ?? 200);
    const captured = captureFffSyncOperation(() =>
      finder.grep(buildFffGrepQuery(options.pattern, options.globs), {
        mode: options.regex ? "regex" : "plain",
        smartCase: false,
        pageSize: limit + 1,
        beforeContext: options.contextLines ?? 0,
        afterContext: options.contextLines ?? 0,
      }),
    );
    const capturedOutcome = resultOutcome(captured);
    if (!capturedOutcome.ok || !capturedOutcome.value.ok) {
      return nodeRgBackend.grep(options);
    }
    if (options.regex && capturedOutcome.value.value.regexFallbackError) {
      return nodeRgBackend.grep(options);
    }

    const matches = capturedOutcome.value.value.items.map(mapFffGrepMatch);
    const truncated = matches.length > limit;
    return Result.ok({
      matches: truncated ? matches.slice(0, limit) : matches,
      truncated,
      effectiveBackend: "fff",
    });
  },

  async glob(options) {
    if (
      shouldFallbackForDenyPaths({
        cwd: options.cwd,
        denyPaths: options.denyPaths,
        dangerouslyAllow: options.dangerouslyAllow,
      })
    ) {
      return null;
    }

    const includes = options.patterns.filter(
      (pattern) => pattern.length > 0 && !pattern.startsWith("!"),
    );
    const excludes = options.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1))
      .filter((pattern) => pattern.length > 0);

    if (includes.length === 0) return { paths: [], truncated: false, effectiveBackend: "fff" };
    if (excludes.length > 0) return null;
    if (!includes.every(isFileLikeGlobPattern)) return null;
    if (includes.some(targetsNodeModules)) return null;

    const finder = await getFffFinder(options.cwd, options.cacheDir);
    if (!finder) return null;

    const paths: string[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const pattern of includes) {
      const captured = captureFffSyncOperation(() =>
        finder.glob(pattern, { pageSize: options.maxEntries + 1 }),
      );
      const capturedOutcome = resultOutcome(captured);
      if (!capturedOutcome.ok || !capturedOutcome.value.ok) return null;
      const result = capturedOutcome.value;
      const inspected: Array<string | null> = [];
      for (
        let offset = 0;
        offset < result.value.items.length;
        offset += MAX_FFF_GLOB_STAT_CONCURRENCY
      ) {
        const batch = result.value.items.slice(offset, offset + MAX_FFF_GLOB_STAT_CONCURRENCY);
        inspected.push(
          ...(await Promise.all(
            batch.map(async (item) => {
              const stat = await captureFilesystemOperation("stat FFF glob match", () =>
                fs.stat(join(options.cwd, item.relativePath)),
              );
              return stat.match({
                ok: (value) => (value.isFile() ? item.relativePath : null),
                err: () => null,
              });
            }),
          )),
        );
      }

      for (const relPath of inspected) {
        if (relPath === null) continue;
        if (seen.has(relPath)) continue;

        seen.add(relPath);
        if (paths.length >= options.maxEntries) {
          truncated = true;
          break;
        }
        paths.push(relPath);
      }

      if (truncated) break;
    }

    return { paths, truncated, effectiveBackend: "fff" };
  },
};

export function getSearchBackend(backend: FsBackend): SearchBackend {
  return backend === "fff" ? fffBackend : nodeRgBackend;
}
