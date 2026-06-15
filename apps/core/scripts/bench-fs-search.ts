import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { FileSystem, expandTilde } from "../src/tools/fs/fs-impl";
import type { FsBackend } from "../src/tools/fs/search-backend";

type BackendSelection = FsBackend | "all";

type BenchmarkCase =
  | {
      kind: "glob";
      name: string;
      patterns: string[];
      maxEntries?: number;
    }
  | {
      kind: "grep";
      name: string;
      pattern: string;
      regex?: boolean;
      fileExtensions?: string[];
      maxResults?: number;
    };

type BenchmarkOptions = {
  root: string;
  runs: number;
  warmups: number;
  backend: BackendSelection;
};

const CASES = [
  {
    kind: "glob",
    name: "glob-ts",
    patterns: ["**/*.ts", "!**/node_modules/**"],
    maxEntries: 500,
  },
  {
    kind: "glob",
    name: "glob-core-tests",
    patterns: ["tests/**/*.test.ts"],
    maxEntries: 500,
  },
  {
    kind: "grep",
    name: "grep-file-system",
    pattern: "FileSystem",
    fileExtensions: ["ts"],
    maxResults: 200,
  },
  {
    kind: "grep",
    name: "grep-config-regex",
    pattern: "tools\\.(web|editFile|fsBackend)",
    regex: true,
    fileExtensions: ["ts"],
    maxResults: 200,
  },
] satisfies readonly BenchmarkCase[];

function parsePositiveInt(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBackend(raw: string | undefined): BackendSelection {
  if (raw === undefined || raw === "all") return "all";
  if (raw === "fff" || raw === "node-rg") return raw;
  throw new Error("backend must be one of: all, fff, node-rg");
}

function parseArgs(argv: readonly string[]): BenchmarkOptions {
  let root = process.cwd();
  let runs = 20;
  let warmups = 3;
  let backend: BackendSelection = "all";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i] ?? "";
      continue;
    }
    if (arg === "--runs") {
      runs = parsePositiveInt(argv[++i], "runs");
      continue;
    }
    if (arg === "--warmups") {
      warmups = parsePositiveInt(argv[++i], "warmups");
      continue;
    }
    if (arg === "--backend") {
      backend = parseBackend(argv[++i]);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/bench-fs-search.ts [--root PATH] [--backend all|fff|node-rg] [--warmups N] [--runs N]",
          "",
          "Examples:",
          "  bun run bench:fs-search",
          "  bun run bench:fs-search -- --root ../.. --runs 50",
        ].join("\n") + "\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    root: resolve(expandTilde(root)),
    runs,
    warmups,
    backend,
  };
}

function selectedBackends(selection: BackendSelection): FsBackend[] {
  return selection === "all" ? ["node-rg", "fff"] : [selection];
}

function elapsedMs(startMs: number): number {
  return performance.now() - startMs;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

function countGlobResult(result: Awaited<ReturnType<FileSystem["glob"]>>): number {
  if (result.error) throw new Error(result.error);
  return result.mode === "default" ? result.paths.length : result.entries.length;
}

function countGrepResult(result: Awaited<ReturnType<FileSystem["grep"]>>): number {
  if (result.error) throw new Error(result.error);
  return result.results.length;
}

async function runCase(fsTool: FileSystem, benchmarkCase: BenchmarkCase): Promise<number> {
  if (benchmarkCase.kind === "glob") {
    const result = await fsTool.glob({
      patterns: benchmarkCase.patterns,
      maxEntries: benchmarkCase.maxEntries,
    });
    return countGlobResult(result);
  }

  const result = await fsTool.grep({
    pattern: benchmarkCase.pattern,
    regex: benchmarkCase.regex,
    fileExtensions: benchmarkCase.fileExtensions,
    maxResults: benchmarkCase.maxResults,
  });
  return countGrepResult(result);
}

async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  process.stdout.write(
    `fs-search benchmark root=${options.root} warmups=${options.warmups} runs=${options.runs}\n`,
  );

  for (const backend of selectedBackends(options.backend)) {
    const fsTool = new FileSystem(options.root, { fsBackend: backend });
    process.stdout.write(`\nbackend=${backend}\n`);

    for (const benchmarkCase of CASES) {
      let lastCount = 0;
      const warmupStart = performance.now();
      for (let i = 0; i < options.warmups; i++) {
        lastCount = await runCase(fsTool, benchmarkCase);
      }
      const warmupMs = elapsedMs(warmupStart);

      const samples: number[] = [];
      for (let i = 0; i < options.runs; i++) {
        const start = performance.now();
        lastCount = await runCase(fsTool, benchmarkCase);
        samples.push(elapsedMs(start));
      }

      process.stdout.write(
        [
          `case=${benchmarkCase.name}`,
          `kind=${benchmarkCase.kind}`,
          `count=${lastCount}`,
          `warmup_ms=${formatMs(warmupMs)}`,
          `median_ms=${formatMs(median(samples))}`,
          `mean_ms=${formatMs(mean(samples))}`,
          `min_ms=${formatMs(Math.min(...samples))}`,
          `max_ms=${formatMs(Math.max(...samples))}`,
        ].join(" ") + "\n",
      );
    }
  }
}

try {
  await runBenchmark(parseArgs(process.argv.slice(2)));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
