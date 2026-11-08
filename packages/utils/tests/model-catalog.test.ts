import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCoreConfigV3ToUniversal } from "../core-config/v3";
import { projectModelCatalog } from "../model-catalog";
import { ModelCatalogCache } from "../model-catalog-cache";
import { modelRuleDefaults } from "../model-rules";
import { claudeAliasTarget } from "../model-catalog-family";
import type { ModelsDevRegistry } from "../model-catalog-schema";

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
  const models = projectModelCatalog(config, registry);
  expect(claudeAliasTarget(registry, "opus")).toBe("claude-opus-5");
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

test("catalog reads share one refresh and keep the snapshot on fetch failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-"));
  let calls = 0;
  const cache = new ModelCatalogCache({
    snapshot: registry,
    cachePath: path.join(dir, "catalog.json"),
    fetch: async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    },
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.read()));
  expect(results.every((value) => value === registry)).toBe(true);
  expect(calls).toBe(1);
  await cache.read();
  expect(calls).toBe(1);
  await rm(dir, { recursive: true, force: true });
});

test("a stale cached catalog is returned while its refresh continues in the background", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-stale-"));
  const cachePath = path.join(dir, "catalog.json");
  await writeFile(cachePath, JSON.stringify(registry));
  const response = Promise.withResolvers<Response>();
  const cache = new ModelCatalogCache({
    snapshot: {},
    cachePath,
    fetch: () => response.promise,
    now: () => Date.now() + 2 * 24 * 60 * 60 * 1000,
  });

  expect(await cache.read()).toEqual(registry);

  const refreshed = Promise.withResolvers<void>();
  cache.subscribe(() => refreshed.resolve());
  const updated = { ...registry, other: { ...registry.anthropic!, id: "other" } };
  response.resolve(Response.json(updated));
  await refreshed.promise;
  expect(cache.current()).toEqual(updated);
});

test("empty refresh cannot erase the catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-catalog-empty-"));
  const cache = new ModelCatalogCache({
    snapshot: registry,
    cachePath: path.join(dir, "catalog.json"),
    fetch: async () => Response.json({}),
  });
  expect(await cache.read()).toBe(registry);
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
  const opus = projectModelCatalog(config, registry).find(
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
  const models = projectModelCatalog(config, {
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
  });
  expect(Object.fromEntries(models.map((entry) => [entry.model, entry.legacy]))).toEqual({
    "gpt-6-sol": false,
    "gpt-6-luna": false,
    "gpt-5-codex-spark": true,
    "gpt-red-latest": true,
  });
});
