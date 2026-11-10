import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("bare utils import leaves the bundled catalog unloaded", () => {
  const entry = new URL("../index.ts", import.meta.url).pathname;
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    await import(${JSON.stringify(entry)});
    console.log(Object.keys(require.cache).some(path => path.endsWith("model-catalog-snapshot.json.txt")));
  `,
  ]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("false");
});

test("Bun bundles retain a usable lazy catalog snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-bundle-"));
  try {
    const build = await Bun.build({
      entrypoints: [new URL("../model-catalog-cache.ts", import.meta.url).pathname],
      target: "bun",
      outdir: directory,
    });
    expect(build.success).toBe(true);
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `
      const { ModelCatalogCache } = await import(${JSON.stringify(path.join(directory, "model-catalog-cache.js"))});
      const cache = new ModelCatalogCache({ cachePath: ":memory:" });
      console.log((await cache.read()).providerIds().length > 0);
    `,
    ]);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("true");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
