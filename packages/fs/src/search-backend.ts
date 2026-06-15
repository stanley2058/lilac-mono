import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

import type { FileFinderApi } from "@ff-labs/fff-node";

import { ripgrep, type GrepMatch, type GrepOptions, type RipgrepResult } from "./ripgrep";

export const FS_BACKENDS = ["fff", "node-rg"] as const;
export type FsBackend = (typeof FS_BACKENDS)[number];

export type GlobSearchResult = {
  paths: string[];
  truncated: boolean;
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
};

export type FffPrewarmResult = {
  basePath: string;
  ok: boolean;
  skipped?: "not-directory" | "deny-path" | "unavailable";
};

export type SearchBackend = {
  grep(options: GrepOptions): Promise<RipgrepResult>;
  glob(options: {
    cwd: string;
    patterns: readonly string[];
    maxEntries: number;
    denyPaths: readonly string[];
    dangerouslyAllow: boolean;
    cacheDir?: string;
  }): Promise<GlobSearchResult | null>;
};

const nodeRgBackend: SearchBackend = {
  grep: ripgrep,
  async glob() {
    throw new Error("node-rg backend does not implement glob");
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
const fffFindersByBasePath = new Map<string, FffFinderEntry>();
const FFF_NODE_PACKAGE = ["@ff-labs", "fff-node"].join("/");

function fffFinderCacheKey(basePath: string, cacheDir?: string): string {
  return `${cacheDir ?? ""}\0${basePath}`;
}

function destroyFffFinder(entry: FffFinderEntry): void {
  try {
    entry.finder.destroy();
  } catch {
    // Best effort: eviction should not break the caller's fallback path.
  }
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
  await fs.mkdir(frecencyDbPath, { recursive: true });
  await fs.mkdir(historyDbPath, { recursive: true });
  return { frecencyDbPath, historyDbPath };
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

async function getFffFinder(basePath: string, cacheDir?: string): Promise<FileFinderApi | null> {
  const cacheKey = fffFinderCacheKey(basePath, cacheDir);
  const cached = fffFindersByBasePath.get(cacheKey);
  if (cached) {
    fffFindersByBasePath.delete(cacheKey);
    fffFindersByBasePath.set(cacheKey, cached);
    await cached.ready.catch(() => false);
    return cached.finder;
  }

  try {
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
    const ready = finder
      .waitForIndexReady(10_000)
      .then((result) => result.ok && result.value)
      .catch(() => false);
    cacheFffFinder(cacheKey, { finder, ready });

    await ready;
    return finder;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isDirectory() === true;
}

export async function prewarmFffFinders(params: {
  basePaths: readonly string[];
  denyPaths: readonly string[];
  cacheDir?: string;
}): Promise<FffPrewarmResult[]> {
  const results: FffPrewarmResult[] = [];
  const seen = new Set<string>();

  for (const basePath of params.basePaths) {
    if (seen.has(basePath)) continue;
    seen.add(basePath);

    if (!(await isDirectory(basePath))) {
      results.push({ basePath, ok: false, skipped: "not-directory" });
      continue;
    }

    if (
      shouldFallbackForDenyPaths({
        cwd: basePath,
        denyPaths: params.denyPaths,
        dangerouslyAllow: false,
      })
    ) {
      results.push({ basePath, ok: false, skipped: "deny-path" });
      continue;
    }

    const finder = await getFffFinder(basePath, params.cacheDir);
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
  const result = finder.fileSearch(params.query, { pageSize: limit + 1 });
  if (!result.ok) return null;

  const items = result.value.items.slice(0, limit);
  return {
    results: items.map((item, index) => {
      const score = result.value.scores[index];
      return {
        path: item.relativePath,
        fileName: item.fileName,
        size: item.size,
        gitStatus: item.gitStatus,
        score: score?.total,
        matchType: score?.matchType,
      };
    }),
    totalMatched: result.value.totalMatched,
    totalFiles: result.value.totalFiles,
    truncated: result.value.items.length > limit || result.value.totalMatched > limit,
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
    const result = finder.grep(buildFffGrepQuery(options.pattern, options.globs), {
      mode: options.regex ? "regex" : "plain",
      smartCase: false,
      pageSize: limit + 1,
      beforeContext: options.contextLines ?? 0,
      afterContext: options.contextLines ?? 0,
    });

    if (!result.ok) return await nodeRgBackend.grep(options);
    if (options.regex && result.value.regexFallbackError) return await nodeRgBackend.grep(options);

    const matches = result.value.items.map(mapFffGrepMatch);
    const truncated = matches.length > limit;
    return {
      matches: truncated ? matches.slice(0, limit) : matches,
      truncated,
    };
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

    if (includes.length === 0) return { paths: [], truncated: false };
    if (excludes.length > 0) return null;
    if (!includes.every(isFileLikeGlobPattern)) return null;
    if (includes.some(targetsNodeModules)) return null;

    try {
      const finder = await getFffFinder(options.cwd, options.cacheDir);
      if (!finder) return null;

      const paths: string[] = [];
      const seen = new Set<string>();
      let truncated = false;

      for (const pattern of includes) {
        const result = finder.glob(pattern, { pageSize: options.maxEntries + 1 });
        if (!result.ok) return null;

        for (const item of result.value.items) {
          const relPath = item.relativePath;
          if (seen.has(relPath)) continue;

          const abs = join(options.cwd, relPath);
          const stat = await fs.stat(abs).catch(() => null);
          if (!stat?.isFile()) continue;

          seen.add(relPath);
          if (paths.length >= options.maxEntries) {
            truncated = true;
            break;
          }
          paths.push(relPath);
        }

        if (truncated) break;
      }

      return { paths, truncated };
    } catch {
      return null;
    }
  },
};

export function getSearchBackend(backend: FsBackend): SearchBackend {
  return backend === "fff" ? fffBackend : nodeRgBackend;
}
