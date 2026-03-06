import { describe, expect, it } from "bun:test";
import type { LanguageModelUsage } from "ai";

import { ModelCapability } from "../model-capability";

function createRegistryFetch(registry: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeUsage(params: {
  inputTokens: number;
  outputTokens: number;
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): LanguageModelUsage {
  const cacheReadTokens = params.cacheReadTokens ?? 0;
  const cacheWriteTokens = params.cacheWriteTokens ?? 0;

  return {
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    totalTokens: params.inputTokens + params.outputTokens,
    reasoningTokens: 0,
    cachedInputTokens: cacheReadTokens,
    inputTokenDetails: {
      noCacheTokens: params.noCacheTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    outputTokenDetails: {
      textTokens: params.outputTokens,
      reasoningTokens: 0,
    },
  };
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

  it("inherits over-200k tier pricing for wrapper models when wrapper cost omits it", async () => {
    const registry = {
      vercel: {
        id: "vercel",
        env: ["AI_GATEWAY_API_KEY"],
        npm: "@ai-sdk/gateway",
        name: "AI Gateway",
        models: {
          "anthropic/claude-opus-4.6": {
            id: "anthropic/claude-opus-4.6",
            name: "Claude Opus 4.6",
            family: "claude-opus",
            modalities: { input: ["text"], output: ["text"] },
            cost: {
              input: 5,
              output: 25,
              cache_read: 0.5,
              cache_write: 6.25,
            },
            limit: { context: 1_000_000, output: 128_000 },
          },
        },
      },
      anthropic: {
        id: "anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            family: "claude-opus",
            modalities: { input: ["text"], output: ["text"] },
            cost: {
              input: 5,
              output: 25,
              cache_read: 0.5,
              cache_write: 6.25,
              context_over_200k: {
                input: 10,
                output: 37.5,
                cache_read: 1,
                cache_write: 12.5,
              },
            },
            limit: { context: 200_000, output: 128_000 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    });

    const info = await mc.resolve("vercel/anthropic/claude-opus-4.6");
    expect(info.limit.context).toBe(1_000_000);
    expect(info.cost?.input).toBe(5);
    expect(info.cost?.output).toBe(25);
    expect(info.cost?.context_over_200k?.input).toBe(10);
    expect(info.cost?.context_over_200k?.output).toBe(37.5);
    expect(info.cost?.context_over_200k?.cache_read).toBe(1);
    expect(info.cost?.context_over_200k?.cache_write).toBe(12.5);
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

  it("supports inherited overrides for newly introduced models", async () => {
    const registry = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o-mini": {
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            family: "gpt-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 16_384 },
            cost: {
              input: 0.15,
              output: 0.6,
            },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
      overrides: {
        "openai-compatible/my-new-model": {
          inherit: "openai/gpt-4o-mini",
          limit: {
            context: 262_144,
          },
        },
      },
    });

    const info = await mc.resolve("openai-compatible/my-new-model");
    expect(info.provider).toBe("openai-compatible");
    expect(info.model).toBe("my-new-model");
    expect(info.limit).toEqual({ context: 262_144, output: 16_384 });
    expect(info.cost).toEqual({ input: 0.15, output: 0.6 });
    expect(info.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  it("preserves tiered cost when an override inherits a base model", async () => {
    const registry = {
      anthropic: {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            family: "claude-opus",
            modalities: { input: ["text"], output: ["text"] },
            cost: {
              input: 5,
              output: 25,
              cache_read: 0.5,
              cache_write: 6.25,
              context_over_200k: {
                input: 10,
                output: 37.5,
                cache_read: 1,
                cache_write: 12.5,
              },
            },
            limit: { context: 200_000, output: 128_000 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
      overrides: {
        "custom/opus": {
          inherit: "anthropic/claude-opus-4-6",
          limit: { context: 1_000_000 },
        },
      },
    });

    const info = await mc.resolve("custom/opus");
    expect(info.cost?.context_over_200k?.input).toBe(10);
    expect(info.cost?.context_over_200k?.output).toBe(37.5);

    const overTierCost = mc.estimateCostUsd(
      info,
      makeUsage({
        inputTokens: 250_000,
        outputTokens: 1_000,
        noCacheTokens: 200_000,
        cacheReadTokens: 50_000,
      }),
    );
    expect(overTierCost).toBeCloseTo(2.0875, 8);
  });

  it("supports inheritance chains across override entries", async () => {
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
      overrides: {
        "custom/base": {
          inherit: "openai/gpt-4o",
          limit: {
            context: 160_000,
          },
        },
        "custom/derived": {
          inherit: "custom/base",
          limit: {
            output: 4096,
          },
        },
      },
    });

    const info = await mc.resolve("custom/derived");
    expect(info.limit).toEqual({ context: 160_000, output: 4096 });
  });

  it("detects override inheritance cycles", async () => {
    const mc = new ModelCapability({
      overrides: {
        "custom/a": { inherit: "custom/b", limit: { context: 1000 } },
        "custom/b": { inherit: "custom/a", limit: { context: 1000 } },
      },
    });

    await expect(mc.resolve("custom/a")).rejects.toThrow("override cycle detected");
  });

  it("resolves explicit overrides even when provider is force-unknown", async () => {
    const mc = new ModelCapability({
      forceUnknownProviders: ["openai-compatible"],
      overrides: {
        "openai-compatible/local-model": {
          inherit: "openai/gpt-4o",
          limit: {
            context: 200_000,
          },
        },
      },
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch({
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
      }),
    });

    const info = await mc.resolve("openai-compatible/local-model");
    expect(info.limit).toEqual({ context: 200_000, output: 16_384 });
  });

  it("uses no-cache tokens for base input pricing when cache pricing is present", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.5,
          cache_write: 3,
        },
      },
      makeUsage({
        inputTokens: 120_000,
        outputTokens: 5_000,
        noCacheTokens: 70_000,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 10_000,
      }),
    );

    expect(costUsd).toBeCloseTo(0.23, 8);
  });

  it("uses over-200k pricing tier when effective input context exceeds 200k", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
          context_over_200k: {
            input: 10,
            output: 37.5,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
      },
      makeUsage({
        inputTokens: 250_000,
        outputTokens: 1_000,
        noCacheTokens: 200_000,
        cacheReadTokens: 50_000,
      }),
    );

    expect(costUsd).toBeCloseTo(2.0875, 8);
  });

  it("keeps base pricing when effective input context is at or below 200k", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
          context_over_200k: {
            input: 10,
            output: 37.5,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
      },
      makeUsage({
        inputTokens: 200_000,
        outputTokens: 1_000,
        noCacheTokens: 180_000,
        cacheReadTokens: 20_000,
      }),
    );

    expect(costUsd).toBeCloseTo(0.935, 8);
  });

  it("falls back to inputTokens threshold when noCacheTokens is unavailable", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
          context_over_200k: {
            input: 10,
            output: 37.5,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
      },
      makeUsage({
        inputTokens: 210_000,
        outputTokens: 0,
        cacheReadTokens: 10_000,
      }),
    );

    expect(costUsd).toBeCloseTo(2.01, 8);
  });

  it("falls back cache tokens to base input pricing when cache-specific pricing is missing", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 2,
          output: 8,
        },
      },
      makeUsage({
        inputTokens: 120_000,
        outputTokens: 5_000,
        noCacheTokens: 70_000,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 10_000,
      }),
    );

    expect(costUsd).toBeCloseTo(0.28, 8);
  });

  it("backs out cache token counts from input tokens when noCacheTokens is unavailable", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.5,
          cache_write: 3,
        },
      },
      makeUsage({
        inputTokens: 120_000,
        outputTokens: 5_000,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 10_000,
      }),
    );

    expect(costUsd).toBeCloseTo(0.23, 8);
  });

  it("ignores invalid negative no-cache token counts and falls back safely", () => {
    const mc = new ModelCapability();
    const costUsd = mc.estimateCostUsd(
      {
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.5,
        },
      },
      makeUsage({
        inputTokens: 15,
        outputTokens: 0,
        noCacheTokens: -1137,
        cacheReadTokens: 1152,
      }),
    );

    expect(costUsd).toBeCloseTo(0.000576, 12);
    expect(costUsd).toBeGreaterThanOrEqual(0);
  });
});
