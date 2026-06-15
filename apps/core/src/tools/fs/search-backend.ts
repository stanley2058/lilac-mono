import fs from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { FileFinderApi } from "@ff-labs/fff-node";

import { ripgrep, type GrepMatch, type GrepOptions, type RipgrepResult } from "./ripgrep";

export const FS_BACKENDS = ["fff", "node-rg"] as const;
export type FsBackend = (typeof FS_BACKENDS)[number];

export type GlobSearchResult = {
  paths: string[];
  truncated: boolean;
};

export type SearchBackend = {
  grep(options: GrepOptions): Promise<RipgrepResult>;
  glob(options: {
    cwd: string;
    patterns: readonly string[];
    maxEntries: number;
    denyPaths: readonly string[];
    dangerouslyAllow: boolean;
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

const fffFindersByBasePath = new Map<string, FffFinderEntry>();
const FFF_NODE_PACKAGE = ["@ff-labs", "fff-node"].join("/");

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

async function getFffFinder(basePath: string): Promise<FileFinderApi | null> {
  const cached = fffFindersByBasePath.get(basePath);
  if (cached) {
    await cached.ready;
    return cached.finder;
  }

  try {
    const fff = (await import(FFF_NODE_PACKAGE)) as typeof import("@ff-labs/fff-node");
    if (!fff.FileFinder.isAvailable()) return null;

    const created = fff.FileFinder.create({
      basePath,
      aiMode: true,
    });
    if (!created.ok) return null;

    const finder = created.value;
    const ready = finder.waitForIndexReady(10_000).then((result) => result.ok && result.value);
    fffFindersByBasePath.set(basePath, { finder, ready });

    await ready;
    return finder;
  } catch {
    return null;
  }
}

function buildFffGrepQuery(pattern: string, globs: readonly string[] | undefined): string {
  const constraints = globs?.filter((glob) => glob.length > 0 && !glob.startsWith("!")) ?? [];
  if (constraints.length === 0) return pattern;
  return `${constraints.join(" ")} ${pattern}`;
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

    const finder = await getFffFinder(options.cwd);
    if (!finder) return await nodeRgBackend.grep(options);

    const limit = Math.max(1, options.maxMatches ?? 200);
    const result = finder.grep(buildFffGrepQuery(options.pattern, options.globs), {
      mode: options.regex ? "regex" : "plain",
      smartCase: true,
      pageSize: limit + 1,
      beforeContext: options.contextLines ?? 0,
      afterContext: options.contextLines ?? 0,
    });

    if (!result.ok) return await nodeRgBackend.grep(options);

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

    const finder = await getFffFinder(options.cwd);
    if (!finder) return null;

    const includes = options.patterns.filter((pattern) => pattern.length > 0 && !pattern.startsWith("!"));
    const excludes = options.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1))
      .filter((pattern) => pattern.length > 0);

    if (includes.length === 0) return { paths: [], truncated: false };

    const excluded = new Set<string>();
    for (const pattern of excludes) {
      const result = finder.glob(pattern, { pageSize: 1_000_000 });
      if (!result.ok) return null;
      for (const item of result.value.items) {
        excluded.add(item.relativePath);
      }
    }

    const paths: string[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const pattern of includes) {
      const result = finder.glob(pattern, { pageSize: options.maxEntries + 1 });
      if (!result.ok) return null;

      for (const item of result.value.items) {
        const relPath = item.relativePath;
        if (seen.has(relPath) || excluded.has(relPath)) continue;

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
  },
};

export function getSearchBackend(backend: FsBackend): SearchBackend {
  return backend === "fff" ? fffBackend : nodeRgBackend;
}
