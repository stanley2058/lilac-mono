import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCoreConfigV3ToUniversal } from "../core-config/v3";
import { projectModelCatalog } from "../model-catalog";
import { ModelCatalogCache } from "../model-catalog-cache";
import { modelRuleDefaults } from "../model-rules";
import { claudeAliasTarget, newestModels } from "../model-catalog-family";
import {
  decodeModelsDevRegistry,
  registryModelCatalog,
  type ModelsDevRegistry,
} from "../model-catalog-schema";
import bundledSnapshot from "../model-catalog-snapshot.generated";

const registry: ModelsDevRegistry = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "test",
    models: {
      "claude-opus-4": {
        id: "claude-opus-4",
        name: "Opus 4",
        family: "claude-opus",
        release_date: "2025-01-01",
        limit: { context: 100, output: 10 },
        modalities: { input: ["text"], output: ["text"] },
      },
      "claude-opus-5": {
        id: "claude-opus-5",
        name: "Opus 5",
        family: "claude-opus",
        release_date: "2026-01-01",
        limit: { context: 200, output: 20 },
        modalities: { input: ["text"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
};

test("catalog maps harness aliases and classifies legacy per provider", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    models: { catalog: { providers: { anthropic: "enabled", "claude-code": "enabled" } } },
  });
  const models = projectModelCatalog(config, registryModelCatalog(registry));
  expect(claudeAliasTarget(registryModelCatalog(registry), "opus")).toBe("claude-opus-5");
  expect(models.find((model) => model.id === "claude-code/opus")).toMatchObject({
    model: "opus",
    legacy: false,
    reasoning: ["provider-default", "low", "high"],
  });
  expect(models.find((model) => model.id === "anthropic/claude-opus-4")?.legacy).toBe(true);
});

test("rules merge in order, replace arrays, preserve null, and unset inherited keys", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    models: {
      rules: [
        {
          match: "vercel/*",
          options: { gateway: { order: ["a", "b"], extra: true }, nullable: true },
          reasoning: "low",
        },
        {
          match: "vercel/anthropic/*",
          options: { gateway: { order: ["c"] }, nullable: null },
          unset: ["gateway.extra"],
          reasoning: "high",
        },
      ],
    },
  });
  expect(modelRuleDefaults(config, "vercel/anthropic/opus")).toEqual({
    options: { gateway: { order: ["c"] }, nullable: null },
    reasoning: "high",
    legacy: undefined,
  });
});

const DAY = 24 * 60 * 60 * 1000;

function supervised(cache: ModelCatalogCache): ModelCatalogCache {
  cache.supervise((error) => {
    throw error;
  });
  return cache;
}

test("catalog reads share one refresh and keep the seed on fetch failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-"));
  let calls = 0;
  const cache = supervised(
    new ModelCatalogCache({
      snapshot: registry,
      cachePath: path.join(dir, "catalog.sqlite"),
      fetch: async () => {
        calls++;
        return new Response("unavailable", { status: 503 });
      },
    }),
  );
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.read()));
  expect(results.every((catalog) => catalog.provider("anthropic")?.id === "anthropic")).toBe(true);
  expect(calls).toBe(1);
  await cache.read();
  expect(calls).toBe(1);
  await rm(dir, { recursive: true, force: true });
});

test("unsupervised isolates read the store without fetching", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-reader-"));
  let calls = 0;
  const cache = new ModelCatalogCache({
    snapshot: registry,
    cachePath: path.join(dir, "catalog.sqlite"),
    fetch: async () => {
      calls++;
      return Response.json(registry);
    },
  });
  const catalog = await cache.read();
  expect(catalog.model("anthropic", "claude-opus-5")?.id).toBe("claude-opus-5");
  expect(calls).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("a stale store is returned while its refresh continues, and readers share the update", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-stale-"));
  const cachePath = path.join(dir, "catalog.sqlite");
  const response = Promise.withResolvers<Response>();
  const reader = new ModelCatalogCache({ snapshot: registry, cachePath });
  expect(reader.current().providerIds()).toEqual(["anthropic"]);
  const cache = supervised(
    new ModelCatalogCache({
      snapshot: {},
      cachePath,
      fetch: () => response.promise,
      now: () => Date.now() + 2 * DAY,
    }),
  );

  const stale = await cache.read();
  expect(stale.providerIds()).toEqual(["anthropic"]);

  const refreshed = Promise.withResolvers<void>();
  cache.subscribe(() => refreshed.resolve());
  const updated = { ...registry, other: { ...registry.anthropic!, id: "other" } };
  response.resolve(Response.json(updated));
  await refreshed.promise;
  expect(cache.current().providerIds()).toEqual(["anthropic", "other"]);
  expect(reader.current().provider("other")?.id).toBe("other");
  expect(reader.current().modelIds("other")).toEqual(cache.current().modelIds("anthropic"));
  await rm(dir, { recursive: true, force: true });
});

test("isolates opening a new store together all share it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-isolates-"));
  const cachePath = path.join(dir, "catalog.sqlite");
  const workers = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const worker = new Worker(
        new URL("./fixtures/model-catalog-reader-worker.ts", import.meta.url).href,
      );
      await new Promise<void>((resolve) => {
        worker.onmessage = () => resolve();
      });
      return worker;
    }),
  );
  const request = (worker: Worker, message: unknown) =>
    new Promise<string[]>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<string[]>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(message);
    });

  const opened = await Promise.all(
    workers.map((worker) => request(worker, { type: "open", cachePath, snapshot: registry })),
  );
  expect(opened).toEqual(workers.map(() => ["anthropic"]));

  const cache = supervised(
    new ModelCatalogCache({
      snapshot: registry,
      cachePath,
      fetch: async () =>
        Response.json({ ...registry, other: { ...registry.anthropic!, id: "other" } }),
    }),
  );
  const refreshed = Promise.withResolvers<void>();
  cache.subscribe(() => refreshed.resolve());
  await cache.read();
  await refreshed.promise;

  // An isolate that fell back to a private in-memory copy would still report only the seed.
  const reads = await Promise.all(workers.map((worker) => request(worker, { type: "read" })));
  expect(reads).toEqual(workers.map(() => ["anthropic", "other"]));
  for (const worker of workers) worker.terminate();
  await rm(dir, { recursive: true, force: true });
});

test("the store keeps the rollback journal so concurrent opens wait instead of failing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-journal-"));
  const cachePath = path.join(dir, "catalog.sqlite");
  new ModelCatalogCache({ snapshot: registry, cachePath }).current();
  const db = new Database(cachePath);
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("a restarted fetcher waits a day after the last fetch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-restart-"));
  const cachePath = path.join(dir, "catalog.sqlite");
  const start = Date.now();
  let calls = 0;
  const open = (now: number) =>
    supervised(
      new ModelCatalogCache({
        snapshot: registry,
        cachePath,
        now: () => now,
        fetch: async () => {
          calls++;
          return Response.json(registry);
        },
      }),
    );

  const first = open(start);
  const refreshed = Promise.withResolvers<void>();
  first.subscribe(() => refreshed.resolve());
  await first.read();
  await refreshed.promise;
  expect(calls).toBe(1);

  await open(start + DAY - 1).read();
  expect(calls).toBe(1);
  await open(start + DAY).read();
  expect(calls).toBe(2);
  await rm(dir, { recursive: true, force: true });
});

test("empty refresh cannot erase the catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-empty-"));
  const cache = supervised(
    new ModelCatalogCache({
      snapshot: registry,
      cachePath: path.join(dir, "catalog.sqlite"),
      fetch: async () => Response.json({}),
    }),
  );
  const catalog = await cache.read();
  expect(catalog.providerIds()).toEqual(["anthropic"]);
  await rm(dir, { recursive: true, force: true });
});

test("the store preserves payload order and matches the registry it was seeded from", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-order-"));
  const modelEntry = (id: string, release_date: string) => ({
    id,
    name: id,
    family: "same-family",
    release_date,
    limit: { context: 100, output: 10 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  });
  const ordered: ModelsDevRegistry = {
    zeta: {
      id: "zeta",
      name: "Zeta",
      npm: "test",
      models: {
        "z-model": modelEntry("z-model", "2026-01-01"),
        "a-model": modelEntry("a-model", "2026-01-01"),
      },
    },
    alpha: { id: "alpha", name: "Alpha", npm: "test", env: ["ALPHA_KEY"], models: {} },
  };
  const expected = registryModelCatalog(ordered);
  const catalog = new ModelCatalogCache({
    snapshot: ordered,
    cachePath: path.join(dir, "catalog.sqlite"),
  }).current();

  expect(catalog.providerIds()).toEqual(["zeta", "alpha"]);
  expect(catalog.modelIds("zeta")).toEqual(["z-model", "a-model"]);
  expect(catalog.models("zeta")).toEqual(expected.models("zeta"));
  expect(catalog.model("zeta", "a-model")).toEqual(expected.model("zeta", "a-model"));
  expect(catalog.model("zeta", "missing")).toBeUndefined();
  expect(catalog.provider("alpha")).toEqual({
    id: "alpha",
    name: "Alpha",
    npm: "test",
    env: ["ALPHA_KEY"],
  });
  expect(catalog.provider("missing")).toBeUndefined();
  // Release-date ties resolve to the first model, so row order decides this result.
  expect(newestModels(catalog.models("zeta")).get("same-family")?.id).toBe("z-model");
  await rm(dir, { recursive: true, force: true });
});

test("a store from another version is rebuilt from the snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-version-"));
  const cachePath = path.join(dir, "catalog.sqlite");
  const previous = new Database(cachePath);
  previous.run("CREATE TABLE providers (id TEXT, incompatible TEXT)");
  previous.run("PRAGMA user_version = 999");
  previous.close();

  const catalog = new ModelCatalogCache({ snapshot: registry, cachePath }).current();
  expect(catalog.providerIds()).toEqual(["anthropic"]);
  await rm(dir, { recursive: true, force: true });
});

test("an unusable store path falls back to an in-memory catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-fallback-"));
  const blocker = path.join(dir, "not-a-directory");
  await writeFile(blocker, "");
  const catalog = new ModelCatalogCache({
    snapshot: registry,
    cachePath: path.join(blocker, "catalog.sqlite"),
  }).current();
  expect(catalog.providerIds()).toEqual(["anthropic"]);
  await rm(dir, { recursive: true, force: true });
});

test("the bundled snapshot seeds a store that projects like the registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-snapshot-"));
  const snapshot = decodeModelsDevRegistry(bundledSnapshot)!;
  const catalog = new ModelCatalogCache({ cachePath: path.join(dir, "catalog.sqlite") }).current();
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    models: { catalog: { providers: { anthropic: "enabled", openai: "enabled" } } },
  });
  expect(projectModelCatalog(config, catalog)).toEqual(
    projectModelCatalog(config, registryModelCatalog(snapshot)),
  );
  await rm(dir, { recursive: true, force: true });
});

test("explicit harness metadata and legacy overrides work without enabling the upstream provider", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    models: {
      catalog: { providers: { anthropic: "disabled", "claude-code": "enabled" } },
      capability: { overrides: { "claude-code/opus": { inherit: "anthropic/claude-opus-4" } } },
      rules: [{ match: "claude-code/opus", legacy: true }],
    },
  });
  const opus = projectModelCatalog(config, registryModelCatalog(registry)).find(
    (entry) => entry.id === "claude-code/opus",
  );
  expect(opus).toMatchObject({ legacy: true, reasoning: ["provider-default"] });
});

test("catalog lists text models and marks families from an earlier generation as legacy", () => {
  const model = (id: string, family: string, release_date: string, output = ["text"] as const) => ({
    id,
    name: id,
    family,
    release_date,
    limit: { context: 100, output: 10 },
    modalities: { input: ["text" as const], output: [...output] },
  });
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    models: { catalog: { providers: { codex: "enabled" } } },
  });
  const models = projectModelCatalog(
    config,
    registryModelCatalog({
      openai: {
        id: "openai",
        name: "OpenAI",
        npm: "test",
        models: {
          "gpt-6-sol": model("gpt-6-sol", "gpt-sol", "2026-09-01"),
          "gpt-6-luna": model("gpt-6-luna", "gpt-luna", "2026-07-01"),
          "gpt-5-codex-spark": model("gpt-5-codex-spark", "gpt-codex-spark", "2026-02-01"),
          "gpt-realtime": {
            ...model("gpt-realtime", "gpt", "2026-09-01"),
            modalities: { input: ["text", "audio"], output: ["text", "audio"] },
          },
          "gpt-red-latest": model("gpt-red-latest", "gpt", "2026-08-01"),
        },
      },
    }),
  );
  expect(Object.fromEntries(models.map((entry) => [entry.model, entry.legacy]))).toEqual({
    "gpt-6-sol": false,
    "gpt-6-luna": false,
    "gpt-5-codex-spark": true,
    "gpt-red-latest": true,
  });
});
