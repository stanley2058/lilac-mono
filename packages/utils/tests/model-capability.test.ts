import { describe, expect, it } from "bun:test";

import { ModelCapability } from "../model-capability";

function createRegistryFetch(registry: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("ModelCapability", () => {
  it("maps codex/* provider to openai/* for models.dev lookup", async () => {
    const registry = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_384 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("codex/gpt-4o");
    expect(info.model).toBe("gpt-4o");
    expect(info.limit.context).toBe(128_000);
  });

  it("falls back openrouter/provider/model to provider/model in models.dev", async () => {
    const registry = {
      openrouter: {
        id: "openrouter",
        env: ["OPENROUTER_API_KEY"],
        npm: "@openrouter/ai-sdk-provider",
        name: "OpenRouter",
        doc: "https://openrouter.ai/docs",
        models: {},
      },
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_384 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("openrouter/openai/gpt-4o");
    expect(info.provider).toBe("openrouter");
    expect(info.model).toBe("openai/gpt-4o");
    expect(info.limit.context).toBe(128_000);
    expect(info.npm).toBe("@openrouter/ai-sdk-provider");
    expect(info.env).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("falls back vercel/provider/model to provider/model when wrapper provider is missing", async () => {
    const registry = {
      openai: {
        id: "openai",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o-mini": {
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            family: "gpt-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 16_384 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("vercel/openai/gpt-4o-mini");
    expect(info.provider).toBe("vercel");
    expect(info.model).toBe("openai/gpt-4o-mini");
    expect(info.limit.context).toBe(200_000);
    expect(info.npm).toBe("@ai-sdk/openai");
    expect(info.env).toEqual(["OPENAI_API_KEY"]);
  });
});
