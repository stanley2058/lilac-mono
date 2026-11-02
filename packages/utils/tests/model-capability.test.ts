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
  it("preserves external fetch rejection identity in the legacy resolver", async () => {
    const failure = new Error("registry unavailable");
    const rejectingFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0]): Promise<Response> => {
        throw failure;
      },
      { preconnect: fetch.preconnect },
    );
    const capability = new ModelCapability({
      fetch: rejectingFetch,
    });

    await expect(capability.resolve("openai/gpt-test")).rejects.toBe(failure);
  });

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

  it("resolves codex/openai when an unrelated model has no family", async () => {
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
      unrelated: {
        id: "unrelated",
        npm: "@ai-sdk/openai-compatible",
        name: "Unrelated Provider",
        models: {
          model: {
            id: "model",
            name: "Family-less model",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    };
    const mc = new ModelCapability({ fetch: createRegistryFetch(registry) });

    const info = await mc.resolve("codex/gpt-4o");

    expect(info.provider).toBe("codex");
    expect(info.family).toBe("gpt-4o");
    expect(info.limit).toEqual({ context: 128_000, output: 16_384 });
  });

  it("tolerates modern unknown models.dev fields", async () => {
    const registry = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt-4o",
            structured_output: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, input: 128_000, output: 16_384 },
          },
        },
      },
    };
    const mc = new ModelCapability({ fetch: createRegistryFetch(registry) });

    const info = await mc.resolve("codex/gpt-4o");

    expect(info.limit).toEqual({ context: 128_000, output: 16_384 });
  });

  it("rejects malformed consumed models.dev limit data", async () => {
    const registry = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: "128000", output: 16_384 },
          },
        },
      },
    };
    const mc = new ModelCapability({ fetch: createRegistryFetch(registry) });

    const result = await mc.resolveResult("codex/gpt-4o");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ModelCapabilityResolutionFailed");
      expect(result.error.message).toBe("models.dev registry JSON has an invalid shape");
    }
  });

  it("maps claude-code/* provider to anthropic/* for models.dev lookup", async () => {
    const registry = {
      anthropic: {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            family: "claude-sonnet",
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

    const info = await mc.resolve("claude-code/claude-sonnet-4-6");
    expect(info.provider).toBe("claude-code");
    expect(info.model).toBe("claude-sonnet-4-6");
    expect(info.limit.context).toBe(200_000);
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
    const result = await mc.resolveResult("openai-compatible/llama-3.1-8b");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ModelCapabilityResolutionFailed");
    }
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

  it("merges partial overrides onto upstream metadata through provider aliases", async () => {
    const registry = {
      openai: {
        id: "openai",
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        models: {
          "gpt-6-astra": {
            id: "gpt-6-astra",
            name: "Astra",
            attachment: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 400_000, output: 128_000 },
            cost: {
              input: 2,
              output: 8,
              cache_read: 0.5,
              context_over_200k: { input: 4, output: 16, cache_read: 1 },
            },
          },
        },
      },
    };
    const options = {
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
    };
    const original = await new ModelCapability(options).resolve("codex/gpt-6-astra");
    const contextOnly = await new ModelCapability({
      ...options,
      overrides: { "codex/gpt-6-astra": { limit: { context: 395_000 } } },
    }).resolve("codex/gpt-6-astra");
    expect(contextOnly).toEqual({ ...original, limit: { context: 395_000, output: 128_000 } });
    expect(contextOnly.attachment).toBe(true);
    expect(contextOnly.modalities?.input).toContain("image");

    const patched = await new ModelCapability({
      ...options,
      overrides: {
        "codex/gpt-6-astra": {
          attachment: false,
          cost: { input: 0, context_over_200k: { input: 3 } },
          limit: { output: 0 },
          modalities: { input: ["text"] },
        },
      },
    }).resolve("codex/gpt-6-astra");
    expect(patched.attachment).toBe(false);
    expect(patched.limit).toEqual({ context: 400_000, output: 0 });
    expect(patched.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(patched.cost).toEqual({
      ...original.cost,
      output: 8,
      input: 0,
      context_over_200k: { input: 3, output: 16, cache_read: 1 },
    });
    expect(await new ModelCapability(options).resolve("codex/gpt-6-astra")).toEqual(original);
  });

  it("retains standalone overrides when upstream metadata is missing or disabled", async () => {
    for (const forceUnknownProviders of [[], ["custom"]]) {
      const mc = new ModelCapability({
        apiUrl: "https://example.invalid/models.dev/api.json",
        fetch: createRegistryFetch({}),
        forceUnknownProviders,
        overrides: {
          "custom/model": {
            limit: { context: 1000 },
            attachment: true,
            modalities: { input: ["text", "image"] },
          },
          "custom/incomplete": { cost: { input: 1 } },
        },
      });
      expect((await mc.resolve("custom/model")).limit).toEqual({ context: 1000, output: 0 });
      await expect(mc.resolve("custom/incomplete")).rejects.toThrow("limit.context is required");
    }
  });

  it("validates incomplete standalone patches after upstream lookup", async () => {
    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch({}),
      overrides: {
        "custom/cost": { limit: { context: 1000 }, cost: { input: 1 } },
        "custom/tier": {
          limit: { context: 1000 },
          cost: { input: 1, output: 2, context_over_200k: { input: 3 } },
        },
        "custom/modalities": { limit: { context: 1000 }, modalities: { output: ["text"] } },
      },
    });
    await expect(mc.resolve("custom/cost")).rejects.toThrow("cost.input and cost.output");
    await expect(mc.resolve("custom/tier")).rejects.toThrow(
      "context_over_200k patch requires input and output",
    );
    await expect(mc.resolve("custom/modalities")).rejects.toThrow("modalities.input is required");
  });

  it("keeps complete standalone overrides usable when catalog fetching fails", async () => {
    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: Object.assign(
        async () => {
          throw new Error("catalog unavailable");
        },
        { preconnect: fetch.preconnect },
      ),
      overrides: {
        "custom/offline": {
          limit: { context: 1000 },
          attachment: true,
          modalities: { input: ["text", "image"] },
        },
      },
    });
    const info = await mc.resolve("custom/offline");
    expect(info.attachment).toBe(true);
    expect(info.limit.context).toBe(1000);
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
            attachment: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
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
    expect(info.attachment).toBe(true);
    expect(info.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
  });

  it("allows overrides to patch inherited attachment support", async () => {
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
            attachment: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 128_000, output: 16_384 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: createRegistryFetch(registry),
      overrides: {
        "custom/no-attachments": {
          inherit: "openai/gpt-4o",
          attachment: false,
        },
      },
    });

    const inherited = await mc.resolve("openai/gpt-4o");
    expect(inherited.attachment).toBe(true);

    const patched = await mc.resolve("custom/no-attachments");
    expect(patched.attachment).toBe(false);
    expect(patched.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
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
                provider_only: true,
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
          cost: { input: 6 },
          limit: { context: 1_000_000 },
        },
      },
    });

    const info = await mc.resolve("custom/opus");
    expect(info.cost?.input).toBe(6);
    expect(info.cost?.context_over_200k).toEqual({
      input: 10,
      output: 37.5,
      cache_read: 1,
      cache_write: 12.5,
    });

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
