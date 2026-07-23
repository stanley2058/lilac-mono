import { describe, expect, it } from "bun:test";

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
        fetch: async () => {
          if (abortNext) throw new DOMException("cancelled", "AbortError");
          return Response.json({ data: [{ id: "cached-model" }] });
        },
      },
    );
    const cached = await catalog.get();
    abortNext = true;

    await expect(
      catalog.get({ forceRefresh: true, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await catalog.get()).toBe(cached);
  });

  it("isolates a signalled refresh from a shared refresh", async () => {
    let releaseShared = () => {};
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
          if (init?.signal) {
            await new Promise<void>((_resolve, reject) => {
              init.signal?.addEventListener(
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
