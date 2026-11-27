import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CORE_ROOT = path.join(REPO_ROOT, "apps/core");
const UTILS_ROOT = path.join(REPO_ROOT, "packages/utils");
const CLIENT_PROTOCOL_ROOT = path.join(REPO_ROOT, "packages/client-protocol");

const transpiler = new Bun.Transpiler({ loader: "ts" });

type ImportEdge = {
  from: string;
  specifier: string;
  kind: string;
};

function isTranspilableSource(filePath: string): boolean {
  return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/u.test(filePath);
}

function resolveLocalFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "src/index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveWorkspaceImport(specifier: string): string | null {
  if (specifier === "@stanley2058/lilac-utils") return path.join(UTILS_ROOT, "index.ts");
  if (specifier.startsWith("@stanley2058/lilac-utils/")) {
    return resolveLocalFile(
      path.join(UTILS_ROOT, specifier.slice("@stanley2058/lilac-utils/".length)),
    );
  }
  if (specifier === "@stanley2058/lilac-client-protocol") {
    return path.join(CLIENT_PROTOCOL_ROOT, "src/index.ts");
  }
  if (specifier.startsWith("@stanley2058/lilac-client-protocol/")) {
    return resolveLocalFile(
      path.join(
        CLIENT_PROTOCOL_ROOT,
        "src",
        specifier.slice("@stanley2058/lilac-client-protocol/".length),
      ),
    );
  }
  return null;
}

/** Walks value imports (`import`, `require`, `import()`) from `entryPath`, recording the shortest chain. */
function scanImportGraph(entryPath: string): {
  files: Set<string>;
  externalSpecifiers: Map<string, ImportEdge[]>;
  fileChains: Map<string, ImportEdge[]>;
} {
  const entry = path.resolve(entryPath);
  const files = new Set<string>([entry]);
  const externalSpecifiers = new Map<string, ImportEdge[]>();
  const fileChains = new Map<string, ImportEdge[]>([[entry, []]]);
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentChain = fileChains.get(current)!;
    const source = fs.readFileSync(current, "utf8");
    for (const imp of transpiler.scanImports(source)) {
      if (
        imp.kind !== "import-statement" &&
        imp.kind !== "require-call" &&
        imp.kind !== "dynamic-import"
      ) {
        continue;
      }
      const edge: ImportEdge = {
        from: path.relative(REPO_ROOT, current),
        specifier: imp.path,
        kind: imp.kind,
      };
      const nextChain = [...currentChain, edge];

      if (imp.path.startsWith(".")) {
        const resolved = resolveLocalFile(path.resolve(path.dirname(current), imp.path));
        if (resolved && !files.has(resolved)) {
          files.add(resolved);
          fileChains.set(resolved, nextChain);
          if (isTranspilableSource(resolved)) queue.push(resolved);
        }
        continue;
      }

      if (!externalSpecifiers.has(imp.path)) {
        externalSpecifiers.set(imp.path, nextChain);
      }

      const workspaceTarget = resolveWorkspaceImport(imp.path);
      if (workspaceTarget && !files.has(workspaceTarget)) {
        files.add(workspaceTarget);
        fileChains.set(workspaceTarget, nextChain);
        queue.push(workspaceTarget);
      }
    }
  }

  return { files, externalSpecifiers, fileChains };
}

function formatChain(chain: readonly ImportEdge[]): string {
  return chain.map((edge) => `${edge.from} --(${edge.kind})--> ${edge.specifier}`).join("\n  ");
}

function probeRuntimeLoadedModules(entryPath: string): string[] {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      if (typeof globalThis.postMessage !== "function") {
        globalThis.postMessage = () => {};
      }
      await import(${JSON.stringify(entryPath)});
      console.log(JSON.stringify(Object.keys(require.cache)));
      process.exit(0);
    `,
    ],
    { cwd: CORE_ROOT },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const loaded = JSON.parse(child.stdout.toString().trim()) as string[];
  expect(loaded, `Expected ${entryPath} to be loaded into require.cache`).toContain(entryPath);
  return loaded;
}

const FORBIDDEN_HEAVY_SDK_PATTERNS = [
  /^ai$/,
  /^@ai-sdk\//,
  /^@anthropic-ai\/claude-agent-sdk$/,
  /^@openrouter\/ai-sdk-provider$/,
  /^@orpc\/contract$/,
  /^discord\.js$/,
  /^playwright$/,
  /^jsdom$/,
];

const FORBIDDEN_SQLITE_WORKER_CACHE_FRAGMENTS = [
  "/@ai-sdk/",
  "/ai/dist/",
  "/@anthropic-ai/claude-agent-sdk/",
  "/@openrouter/ai-sdk-provider/",
  "/@orpc/contract/",
  "/packages/utils/model-provider.ts",
  "/model-catalog-snapshot.json.txt",
];

const FORBIDDEN_PROVIDER_SDK_CACHE_FRAGMENTS = [
  "/@ai-sdk/openai/",
  "/@ai-sdk/openai-compatible/",
  "/@ai-sdk/anthropic/",
  "/@ai-sdk/google/",
  "/@ai-sdk/xai/",
  "/@ai-sdk/groq/",
  "/@ai-sdk/cerebras/",
  "/@anthropic-ai/claude-agent-sdk/",
  "/@openrouter/ai-sdk-provider/",
  "/@orpc/contract/",
  "/model-catalog-snapshot.json.txt",
];

const FORBIDDEN_UTILS_BARREL_CACHE_FRAGMENTS = [
  ...FORBIDDEN_PROVIDER_SDK_CACHE_FRAGMENTS,
  "/ai/dist/",
  "/@ai-sdk/gateway/",
];

describe("worker import budget", () => {
  it("keeps thread-search-worker free of heavy barrels, config parsers, and AI SDKs", () => {
    const graph = scanImportGraph(path.join(CORE_ROOT, "src/conversation/thread-search-worker.ts"));

    for (const forbiddenSpecifier of [
      "@stanley2058/lilac-utils",
      "@stanley2058/lilac-client-protocol",
      "@stanley2058/lilac-utils/core-config",
      "@stanley2058/lilac-utils/model-provider",
      "@stanley2058/lilac-utils/model-catalog",
    ]) {
      const chain = graph.externalSpecifiers.get(forbiddenSpecifier);
      expect(
        chain,
        chain ? `Forbidden import ${forbiddenSpecifier}:\n  ${formatChain(chain)}` : undefined,
      ).toBeUndefined();
    }

    for (const [specifier, chain] of graph.externalSpecifiers) {
      const forbidden = FORBIDDEN_HEAVY_SDK_PATTERNS.some((pattern) => pattern.test(specifier));
      expect(
        forbidden,
        forbidden ? `Forbidden heavy dependency ${specifier}:\n  ${formatChain(chain)}` : undefined,
      ).toBe(false);
    }

    for (const forbiddenFile of [
      path.join(UTILS_ROOT, "model-provider.ts"),
      path.join(UTILS_ROOT, "core-config.ts"),
      path.join(UTILS_ROOT, "model-catalog.ts"),
    ]) {
      const chain = graph.fileChains.get(forbiddenFile);
      expect(
        chain,
        chain
          ? `Forbidden transitive file ${path.relative(REPO_ROOT, forbiddenFile)}:\n  ${formatChain(chain)}`
          : undefined,
      ).toBeUndefined();
    }
  });

  it("keeps thread-materializer-worker-isolate free of heavy barrels and AI SDKs", () => {
    const graph = scanImportGraph(
      path.join(CORE_ROOT, "src/conversation/thread-materializer-worker-isolate.ts"),
    );

    for (const forbiddenSpecifier of [
      "@stanley2058/lilac-utils",
      "@stanley2058/lilac-client-protocol",
      "@stanley2058/lilac-utils/model-provider",
      "@stanley2058/lilac-utils/model-catalog",
    ]) {
      const chain = graph.externalSpecifiers.get(forbiddenSpecifier);
      expect(
        chain,
        chain ? `Forbidden import ${forbiddenSpecifier}:\n  ${formatChain(chain)}` : undefined,
      ).toBeUndefined();
    }

    for (const [specifier, chain] of graph.externalSpecifiers) {
      const forbidden = FORBIDDEN_HEAVY_SDK_PATTERNS.some((pattern) => pattern.test(specifier));
      expect(
        forbidden,
        forbidden ? `Forbidden heavy dependency ${specifier}:\n  ${formatChain(chain)}` : undefined,
      ).toBe(false);
    }

    const modelProviderChain = graph.fileChains.get(path.join(UTILS_ROOT, "model-provider.ts"));
    expect(
      modelProviderChain,
      modelProviderChain
        ? `Materializer transitively imported model-provider.ts:\n  ${formatChain(modelProviderChain)}`
        : undefined,
    ).toBeUndefined();
  });

  it("keeps AI provider SDKs lazy inside packages/utils/model-provider.ts", () => {
    const source = fs.readFileSync(path.join(UTILS_ROOT, "model-provider.ts"), "utf8");
    const staticImports = transpiler
      .scanImports(source)
      .filter((imp) => imp.kind === "import-statement")
      .map((imp) => imp.path);

    for (const specifier of staticImports) {
      const forbidden =
        specifier === "./claude-sdk" ||
        FORBIDDEN_HEAVY_SDK_PATTERNS.some((pattern) => pattern.test(specifier));
      expect(forbidden, `model-provider.ts eagerly static-imports ${specifier}`).toBe(false);
    }
  });

  it("leaves AI SDKs, oRPC contracts, and the model catalog unloaded at runtime in SQLite worker entrypoints", () => {
    for (const entryPath of [
      path.join(CORE_ROOT, "src/conversation/thread-search-worker.ts"),
      path.join(CORE_ROOT, "src/conversation/thread-materializer-worker-isolate.ts"),
    ]) {
      const loaded = probeRuntimeLoadedModules(entryPath);
      const violations = loaded.filter((modPath) =>
        FORBIDDEN_SQLITE_WORKER_CACHE_FRAGMENTS.some((fragment) => modPath.includes(fragment)),
      );
      expect(violations, `Unexpected heavy modules loaded by ${entryPath}`).toEqual([]);
    }
  });

  it("leaves provider SDKs and the model catalog unloaded at runtime in summarization worker", () => {
    const entryPath = path.join(CORE_ROOT, "src/conversation/thread-summarization-worker.ts");
    const loaded = probeRuntimeLoadedModules(entryPath);
    const violations = loaded.filter((modPath) =>
      FORBIDDEN_PROVIDER_SDK_CACHE_FRAGMENTS.some((fragment) => modPath.includes(fragment)),
    );
    expect(violations, `Unexpected provider SDKs loaded by ${entryPath}`).toEqual([]);
  });

  it("leaves ai, provider SDKs, gateway, and the model catalog unloaded at runtime in utils barrel", () => {
    const entryPath = path.join(UTILS_ROOT, "index.ts");
    const loaded = probeRuntimeLoadedModules(entryPath);
    const violations = loaded.filter((modPath) =>
      FORBIDDEN_UTILS_BARREL_CACHE_FRAGMENTS.some((fragment) => modPath.includes(fragment)),
    );
    expect(violations, `Unexpected AI/SDK modules loaded by ${entryPath}`).toEqual([]);
  });
});
