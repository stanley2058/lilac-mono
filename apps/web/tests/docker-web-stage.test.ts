import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The Docker `web` stage copies only the sources the web build needs, some of them file by file.
 * This walks the web app's imports and fails when a file it reaches is missing from those copies,
 * so a new shared module breaks this test instead of the image build.
 */
const ROOT = path.resolve(import.meta.dir, "../../..");
const CODE = /\.(?:ts|tsx|js|mjs)$/u;
const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?(?:[^;"'`]*?\sfrom\s+)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;

/** Context paths the `web` stage copies. Each lands at the same path under `/app`. */
function webStageSources(): string[] {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8").replace(/\\\n/gu, " ");
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((line) => /^FROM\s+\S+\s+AS\s+web\s*$/iu.test(line));
  const end = lines.findIndex((line, index) => index > start && /^FROM\s/iu.test(line));
  return lines
    .slice(start + 1, end)
    .filter((line) => /^COPY\s/iu.test(line) && !/--from=/u.test(line))
    .flatMap((line) => {
      const args = line
        .trim()
        .split(/\s+/u)
        .slice(1)
        .filter((arg) => !arg.startsWith("--"));
      return args.slice(0, -1).map((source) => path.normalize(source).replace(/\/$/u, ""));
    });
}

function workspacePackages(): Map<string, { dir: string; entry: string }> {
  const packages = new Map<string, { dir: string; entry: string }>();
  for (const name of readdirSync(path.join(ROOT, "packages"))) {
    const manifestPath = path.join(ROOT, "packages", name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      main?: string;
      module?: string;
      exports?: unknown;
    };
    const dot =
      typeof manifest.exports === "object" && manifest.exports !== null
        ? Reflect.get(manifest.exports, ".")
        : manifest.exports;
    const exported = typeof dot === "string" ? dot : undefined;
    const entry = exported ?? manifest.module ?? manifest.main ?? "index.ts";
    packages.set(manifest.name, { dir: path.join("packages", name), entry });
  }
  return packages;
}

function resolveFile(base: string): string | undefined {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

function webSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => CODE.test(file))
    .map((file) => path.join(dir, file));
}

/** Repository-relative files the web build reaches through runtime imports. */
function reachableFiles(): Set<string> {
  const packages = workspacePackages();
  const seen = new Set<string>();
  const queue = webSources(path.join(ROOT, "apps/web/src"));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...[...source.matchAll(STATIC_IMPORT)].filter((match) => !match[1]).map((match) => match[2]),
      ...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (!specifier) continue;
      const target = resolveSpecifier(file, specifier, packages);
      if (target) queue.push(target);
    }
  }
  return new Set([...seen].map((file) => path.relative(ROOT, file)));
}

function resolveSpecifier(
  from: string,
  specifier: string,
  packages: Map<string, { dir: string; entry: string }>,
): string | undefined {
  if (specifier.startsWith(".")) return resolveFile(path.resolve(path.dirname(from), specifier));
  const [scope = "", name = "", ...rest] = specifier.split("/");
  const workspace = packages.get(`${scope}/${name}`);
  if (!workspace) return undefined;
  const target = rest.length > 0 ? rest.join("/") : workspace.entry;
  return resolveFile(path.join(ROOT, workspace.dir, target));
}

test("the Docker web stage copies every source file the web build imports", () => {
  const sources = webStageSources();
  expect(sources).toContain("apps/web");
  const missing = [...reachableFiles()].filter(
    (file) => !sources.some((source) => file === source || file.startsWith(`${source}/`)),
  );
  expect(missing).toEqual([]);
});
