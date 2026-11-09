import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CORE_ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_ENTRY = path.join(CORE_ROOT, "src/runtime/create-core-runtime.ts");

// These cost about 117 MiB of RSS together, so one static import would quietly undo the saving.
const LAZY_PACKAGES = ["jsdom", "playwright", "metascraper", "@tavily/core", "typescript-codegen"];

test("importing the Core runtime does not load heavy on-demand packages", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-lazy-imports-"));
  const script = `
    const packages = ${JSON.stringify(LAZY_PACKAGES)};
    const entries = packages.map((name) => [name, Bun.resolveSync(name, ${JSON.stringify(CORE_ROOT)})]);
    await import(${JSON.stringify(RUNTIME_ENTRY)});
    const loaded = new Set(Object.keys(require.cache));
    console.log(JSON.stringify({
      runtimeLoaded: loaded.has(${JSON.stringify(RUNTIME_ENTRY)}),
      eager: entries.filter(([, entry]) => loaded.has(entry)).map(([name]) => name),
    }));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await rm(dir, { recursive: true, force: true });

  expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
  // The runtime entry must be visible for an empty match below to mean anything.
  expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
    runtimeLoaded: true,
    eager: [],
  });
}, 60_000);
