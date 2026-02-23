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

  it("best-effort matches version delimiters when wrapper uses dots and models.dev uses dashes", async () => {
    const registry = {
      vercel: {
        id: "vercel",
        env: ["AI_GATEWAY_API_KEY"],
        npm: "@ai-sdk/gateway",
        name: "AI Gateway",
        models: {},
      },
      anthropic: {
        id: "anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            family: "claude-sonnet-4",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 64_000 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("vercel/anthropic/claude-sonnet-4.6");
    expect(info.provider).toBe("vercel");
    expect(info.model).toBe("anthropic/claude-sonnet-4.6");
    expect(info.limit.context).toBe(200_000);
    expect(info.npm).toBe("@ai-sdk/gateway");
    expect(info.env).toEqual(["AI_GATEWAY_API_KEY"]);
  });

  it("best-effort matches version delimiters for direct provider lookups", async () => {
    const registry = {
      anthropic: {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            family: "claude-sonnet-4",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 64_000 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("anthropic/claude-sonnet-4.6");
    expect(info.provider).toBe("anthropic");
    expect(info.model).toBe("claude-sonnet-4.6");
    expect(info.limit.context).toBe(200_000);
  });

  it("treats force-unknown providers as unresolved", async () => {
    const registry = {
      "openai-compatible": {
        id: "openai-compatible",
        npm: "@ai-sdk/openai-compatible",
        name: "OpenAI Compatible",
        models: {
          "llama-3.1-8b": {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            family: "llama-3.1",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
      forceUnknownProviders: ["openai-compatible"],
    });

    await expect(mc.resolve("openai-compatible/llama-3.1-8b")).rejects.toThrow(
      "Model capability lookup intentionally disabled",
    );
  });

  it("treats aliased force-unknown providers as unresolved", async () => {
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
      forceUnknownProviders: ["codex"],
    });

    await expect(mc.resolve("codex/gpt-4o")).rejects.toThrow(
      "Model capability lookup intentionally disabled",
    );
  });
});
