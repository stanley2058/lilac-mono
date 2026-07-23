import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelCapability } from "@stanley2058/lilac-utils";

import {
  ModelCatalog,
  modelCapabilityOverrides,
  parseModelRef,
  resolveLanguageModel,
  type CatalogFetch,
} from "../src/model-catalog";
import { createAiProviderRegistry, type ProviderAuth, type ProviderConfig } from "../src/providers";

const config: ProviderConfig = {
  configVersion: 1,
  providers: {
    primary: { type: "openai", catalog: "models-dev" },
    local: {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      catalog: "v1",
    },
  },
};
const auth: ProviderAuth = {
  primary: { type: "api-key", key: "openai-key" },
  local: { type: "api-key", key: "local-key" },
};

function modelsDevResponse(modelId: string) {
  return {
    openai: {
      id: "openai",
      models: { [modelId]: { id: modelId } },
    },
  };
}

describe("model catalog", () => {
  it("normalizes configured models.dev and /v1/models providers", async () => {
    const requests: Parameters<CatalogFetch>[0][] = [];
    const catalog = new ModelCatalog(config, auth, {
      modelsDevUrl: "https://models.test/api.json",
      fetch: async (input, init) => {
        requests.push(input);
        const url = String(input);
        if (url.includes("models.test")) {
          return Response.json({
            openai: {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-test": {
                  id: "gpt-test",
                  name: "GPT Test",
                  family: "gpt",
                  reasoning: true,
                  tool_call: true,
                  modalities: { input: ["text"], output: ["text"] },
                  limit: { context: 1000, output: 100 },
                },
              },
            },
            unconfigured: {
              id: "unconfigured",
              models: { hidden: { id: "hidden" } },
            },
          });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-key");
        return Response.json({ data: [{ id: "llama/test", owned_by: "local" }] });
      },
    });

    const snapshot = await catalog.get();

    expect(requests.map(String)).toEqual([
      "https://models.test/api.json",
      "http://localhost:11434/v1/models",
    ]);
    expect(snapshot.providers).toEqual([
      { id: "primary", type: "openai" },
      { id: "local", type: "openai-compatible" },
    ]);
    expect(snapshot.models.map((model) => model.ref.value)).toEqual([
      "local/llama/test",
      "primary/gpt-test",
    ]);
    expect(snapshot.models.find((model) => model.ref.value === "primary/gpt-test")?.reasoning).toBe(
      true,
    );
    expect(snapshot.models.some((model) => model.ref.providerId === "unconfigured")).toBe(false);
    expect(snapshot.warnings).toEqual([]);
  });

  it("applies partial provider model overrides after catalog discovery", async () => {
    const overriddenConfig: ProviderConfig = {
      configVersion: 1,
      providers: {
        primary: {
          type: "openai",
          catalog: "models-dev",
          models: {
            "gpt-test": {
              name: "Configured GPT",
              reasoning: false,
              limit: { context: 262_144 },
            },
          },
        },
        local: {
          type: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          catalog: "v1",
          models: { "llama/test": { limit: { context: 131_072 } } },
        },
      },
    };
    const catalog = new ModelCatalog(overriddenConfig, auth, {
      fetch: async (input) =>
        String(input).includes("models.dev")
          ? Response.json({
              openai: {
                id: "openai",
                models: {
                  "gpt-test": {
                    id: "gpt-test",
                    name: "Fetched GPT",
                    family: "gpt",
                    reasoning: true,
                    limit: { context: 128_000, output: 16_000 },
                  },
                },
              },
            })
          : Response.json({ data: [{ id: "llama/test" }] }),
    });

    const snapshot = await catalog.get();
    expect(snapshot.models.find((model) => model.ref.value === "primary/gpt-test")).toMatchObject({
      name: "Configured GPT",
      family: "gpt",
      reasoning: false,
      limits: { context: 262_144, output: 16_000 },
    });
    expect(snapshot.models.find((model) => model.ref.value === "local/llama/test")?.limits).toEqual(
      {
        context: 131_072,
        output: 0,
      },
    );

    const capability = new ModelCapability({ overrides: modelCapabilityOverrides(snapshot) });
    await expect(capability.resolve("primary/gpt-test")).resolves.toMatchObject({
      limit: { context: 262_144, output: 16_000 },
    });
    await expect(capability.resolve("local/llama/test")).resolves.toMatchObject({
      limit: { context: 131_072, output: 0 },
    });
  });

  it("ignores invalid unrelated providers and accepts zero modality limits", async () => {
    const catalog = new ModelCatalog(
      {
        configVersion: 1,
        providers: { openai: { type: "openai", catalog: "models-dev" } },
      },
      { openai: { type: "api-key", key: "openai-key" } },
      {
        fetch: async () =>
          Response.json({
            openai: {
              id: "openai",
              models: {
                "gpt-5.6-sol": {
                  id: "gpt-5.6-sol",
                  reasoning: true,
                  tool_call: true,
                  modalities: { input: ["text"], output: ["text"] },
                  limit: { context: 0, output: 0 },
                },
              },
            },
            unrelated: { invalid: true },
          }),
      },
    );

    const snapshot = await catalog.get();

    expect(snapshot.models.map((model) => model.ref.value)).toEqual(["openai/gpt-5.6-sol"]);
    expect(snapshot.models[0]?.limits).toEqual({ context: 0, output: 0 });
    expect(snapshot.warnings).toEqual([]);
  });

  it("filters Codex OAuth providers without filtering ordinary OpenAI API-key providers", async () => {
    const coding = {
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
    };
    const models = {
      "gpt-5.6-sol": { id: "gpt-5.6-sol", ...coding },
      "gpt-5.6-terra": { id: "gpt-5.6-terra", ...coding },
      "gpt-5.5": { id: "gpt-5.5", ...coding },
      "gpt-5.4-mini": { id: "gpt-5.4-mini", ...coding },
      "gpt-5.3-codex": { id: "gpt-5.3-codex", ...coding },
      "gpt-5.2": { id: "gpt-5.2", ...coding },
      "gpt-4.1": { id: "gpt-4.1", ...coding },
      "o4-mini": { id: "o4-mini", ...coding },
      "gpt-5.6-image": {
        id: "gpt-5.6-image",
        ...coding,
        modalities: { input: ["text", "image"], output: ["text", "image"] },
      },
      "gpt-5.6-realtime": {
        id: "gpt-5.6-realtime",
        ...coding,
        modalities: { input: ["text", "audio"], output: ["audio"] },
      },
      "gpt-5.6-no-tools": { id: "gpt-5.6-no-tools", ...coding, tool_call: false },
      "text-embedding-3-large": { id: "text-embedding-3-large" },
    };
    const catalog = new ModelCatalog(
      {
        configVersion: 1,
        providers: {
          oauth: { type: "openai", catalog: "models-dev" },
          api: { type: "openai", catalog: "models-dev" },
        },
      },
      { api: { type: "api-key", key: "openai-key" } },
      {
        codexOAuthProviderIds: ["oauth"],
        fetch: async () => Response.json({ openai: { id: "openai", models } }),
      },
    );

    const snapshot = await catalog.get();
    const oauthModels = snapshot.models
      .filter((model) => model.ref.providerId === "oauth")
      .map((model) => model.ref.modelId);
    const apiModels = snapshot.models.filter((model) => model.ref.providerId === "api");

    expect(oauthModels).toEqual([
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(apiModels).toHaveLength(Object.keys(models).length);
    expect(apiModels.some((model) => model.ref.modelId === "text-embedding-3-large")).toBe(true);
    expect(apiModels.some((model) => model.ref.modelId === "gpt-5.2")).toBe(true);
  });

  it("serves stale provider entries with explicit warnings after refresh failure", async () => {
    let fail = false;
    let now = 1;
    const v1Only: ProviderConfig = {
      configVersion: 1,
      providers: { local: config.providers.local! },
    };
    const catalog = new ModelCatalog(
      v1Only,
      { local: auth.local! },
      {
        cacheTtlMs: 1,
        now: () => now,
        fetch: async () => {
          if (fail) throw new Error("offline");
          return Response.json({ data: [{ id: "stable-model" }] });
        },
      },
    );

    expect((await catalog.get()).stale).toBe(false);
    fail = true;
    now = 3;
    const stale = await catalog.get();

    expect(stale.stale).toBe(true);
    expect(stale.models[0]?.ref.value).toBe("local/stable-model");
    expect(stale.warnings.map((warning) => warning.code)).toEqual([
      "source-fetch-failed",
      "stale-cache",
    ]);
  });

  it("times out a stalled request and surfaces a warning", async () => {
    const catalog = new ModelCatalog(
      {
        configVersion: 1,
        providers: { local: config.providers.local! },
      },
      { local: auth.local! },
      {
        requestTimeoutMs: 20,
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          }),
      },
    );

    const snapshot = await catalog.get();

    expect(snapshot.models).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatchObject({
      code: "source-fetch-failed",
      providerId: "local",
    });
    expect(snapshot.warnings[0]?.message).toContain("timed out after 20ms");
  });

  it("bounds models.dev and /v1/models response bytes", async () => {
    const catalog = new ModelCatalog(config, auth, {
      maxResponseBytes: 32,
      fetch: async () => new Response("x".repeat(33)),
    });

    const snapshot = await catalog.get();

    expect(snapshot.models).toEqual([]);
    expect(snapshot.warnings).toHaveLength(2);
    expect(snapshot.warnings.map((warning) => warning.providerId).sort()).toEqual([
      "local",
      "primary",
    ]);
    expect(
      snapshot.warnings.every((warning) => warning.message.includes("exceeded 32 bytes")),
    ).toBe(true);
  });

  it("returns a valid disk cache while refreshing in the background", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-model-cache-"));
    const cacheFile = path.join(directory, "models-dev.json");
    const cacheSource = `${JSON.stringify({
      version: 1,
      fetchedAt: 100,
      registry: modelsDevResponse("cached-model"),
    })}\n`;
    await writeFile(cacheFile, cacheSource);
    let rejectRefresh = (_error: Error) => {};
    const refreshGate = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const warnings: string[] = [];

    try {
      const catalog = new ModelCatalog(
        {
          configVersion: 1,
          providers: { primary: config.providers.primary! },
        },
        { primary: auth.primary! },
        {
          cacheFilePath: cacheFile,
          cacheTtlMs: 1_000,
          now: () => 100,
          onWarning: (warning) => warnings.push(warning.code),
          fetch: async () => refreshGate,
        },
      );

      const cached = await catalog.get({ backgroundRefresh: true });
      expect(cached.models.map((model) => model.ref.value)).toEqual(["primary/cached-model"]);
      expect(cached.stale).toBe(false);

      rejectRefresh(new Error("offline"));
      const stale = await catalog.get({ forceRefresh: true });
      expect(stale.models.map((model) => model.ref.value)).toEqual(["primary/cached-model"]);
      expect(stale.stale).toBe(true);
      expect(warnings).toEqual(["source-fetch-failed", "stale-cache"]);
      expect(await readFile(cacheFile, "utf8")).toBe(cacheSource);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores an invalid disk cache and surfaces its warning", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-model-cache-"));
    const cacheFile = path.join(directory, "models-dev.json");
    await writeFile(cacheFile, '{"version":1,"fetchedAt":"invalid","registry":{}}\n');
    const observedWarnings: string[] = [];

    try {
      const catalog = new ModelCatalog(
        {
          configVersion: 1,
          providers: { primary: config.providers.primary! },
        },
        { primary: auth.primary! },
        {
          cacheFilePath: cacheFile,
          onWarning: (warning) => observedWarnings.push(warning.code),
          fetch: async () => Response.json(modelsDevResponse("network-model")),
        },
      );

      const initial = await catalog.get({ backgroundRefresh: true });
      expect(initial.models).toEqual([]);
      expect(initial.stale).toBe(true);
      expect(initial.warnings.map((warning) => warning.code)).toEqual(["cache-invalid"]);

      const snapshot = await catalog.get({ forceRefresh: true });
      expect(snapshot.models.map((model) => model.ref.value)).toEqual(["primary/network-model"]);
      expect(snapshot.warnings.map((warning) => warning.code)).toEqual(["cache-invalid"]);
      expect(observedWarnings).toEqual(["cache-invalid"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a disk cache larger than the response limit before reading it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-model-cache-"));
    const cacheFile = path.join(directory, "models-dev.json");
    await writeFile(cacheFile, "x".repeat(257));

    try {
      const catalog = new ModelCatalog(
        { configVersion: 1, providers: { primary: config.providers.primary! } },
        { primary: auth.primary! },
        {
          cacheFilePath: cacheFile,
          maxResponseBytes: 256,
          fetch: async () => Response.json(modelsDevResponse("network-model")),
        },
      );

      const initial = await catalog.get({ backgroundRefresh: true });
      expect(initial.models).toEqual([]);
      expect(initial.warnings.map((warning) => warning.code)).toEqual(["cache-read-failed"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically replaces the cache with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-model-cache-"));
    const cacheFile = path.join(directory, "models-dev.json");
    await chmod(directory, 0o750);
    await writeFile(cacheFile, "old cache", { mode: 0o644 });

    try {
      const catalog = new ModelCatalog(
        {
          configVersion: 1,
          providers: { primary: config.providers.primary! },
        },
        { primary: auth.primary! },
        {
          cacheFilePath: cacheFile,
          now: () => 123,
          fetch: async () => Response.json(modelsDevResponse("fresh-model")),
        },
      );

      const snapshot = await catalog.get();
      const written: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
      expect(snapshot.models.map((model) => model.ref.value)).toEqual(["primary/fresh-model"]);
      expect(written).toEqual({
        version: 1,
        fetchedAt: 123,
        registry: modelsDevResponse("fresh-model"),
      });
      expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o750);
      expect(await readdir(directory)).toEqual(["models-dev.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates AbortError without replacing the cached snapshot", async () => {
    let abortNext = false;
    const v1Only: ProviderConfig = {
      configVersion: 1,
      providers: { local: config.providers.local! },
    };
    const catalog = new ModelCatalog(
      v1Only,
      { local: auth.local! },
      {
        fetch: async (_input, init) => {
          if (abortNext) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            });
          }
          return Response.json({ data: [{ id: "cached-model" }] });
        },
      },
    );
    const cached = await catalog.get();
    abortNext = true;
    const controller = new AbortController();
    const aborted = catalog.get({ forceRefresh: true, signal: controller.signal });
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(await catalog.get()).toBe(cached);
  });

  it("isolates a signalled refresh from a shared refresh", async () => {
    let releaseShared = () => {};
    let requests = 0;
    const sharedGate = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const v1Only: ProviderConfig = {
      configVersion: 1,
      providers: { local: config.providers.local! },
    };
    const catalog = new ModelCatalog(
      v1Only,
      { local: auth.local! },
      {
        fetch: async (_input, init) => {
          requests += 1;
          if (requests === 2) {
            await new Promise<void>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            });
          }
          await sharedGate;
          return Response.json({ data: [{ id: "shared-model" }] });
        },
      },
    );

    const shared = catalog.get({ forceRefresh: true });
    const controller = new AbortController();
    const isolated = catalog.get({ forceRefresh: true, signal: controller.signal });
    controller.abort();
    await expect(isolated).rejects.toMatchObject({ name: "AbortError" });
    releaseShared();
    expect((await shared).models[0]?.ref.value).toBe("local/shared-model");
  });

  it("caches a successful signal-bearing refresh", async () => {
    let requests = 0;
    const catalog = new ModelCatalog(
      {
        configVersion: 1,
        providers: { local: config.providers.local! },
      },
      { local: auth.local! },
      {
        fetch: async () => {
          requests += 1;
          return Response.json({ data: [{ id: `model-${requests}` }] });
        },
      },
    );

    const refreshed = await catalog.get({
      forceRefresh: true,
      signal: new AbortController().signal,
    });
    expect((await catalog.get()).models).toEqual(refreshed.models);
    expect(requests).toBe(1);
  });

  it("resolves only concrete references for configured providers", () => {
    const loaded = {
      config,
      auth,
      registry: createAiProviderRegistry(config, auth),
      supersededProviderIds: [],
    };
    expect(parseModelRef("primary/openai/gpt-test")).toEqual({
      providerId: "primary",
      modelId: "openai/gpt-test",
      value: "primary/openai/gpt-test",
    });
    expect(resolveLanguageModel("primary/gpt-test", loaded).ref.modelId).toBe("gpt-test");
    expect(() => resolveLanguageModel("missing/gpt-test", loaded)).toThrow("not configured");
    expect(() => parseModelRef("alias")).toThrow("provider/model");
  });
});
