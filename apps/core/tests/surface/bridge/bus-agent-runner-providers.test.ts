import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RESPONSE_COMMENTARY_INSTRUCTIONS } from "@stanley2058/lilac-utils";
import { isRetryableTransientModelError } from "@stanley2058/lilac-agent";
import {
  formatUnknownErrorForDisplay,
  maybeAppendResponseCommentaryPrompt,
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../../src/surface/bridge/bus-agent-runner";
import {
  buildExperimentalDownloadForAnthropicFallback,
  shouldForceUrlDownloadForAnthropicFallback,
  withStableAnthropicUpstreamOrder,
} from "../../../src/agent/anthropic-fallback-media";
import { TEST_BLOB_STORE } from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("transient model retry", () => {
  it("classifies Codex overload stream errors as retryable", () => {
    expect(
      isRetryableTransientModelError({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe(true);
  });

  it("formats Codex overload stream errors for display", () => {
    expect(
      formatUnknownErrorForDisplay({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe("server_is_overloaded: Our servers are currently overloaded. Please try again later.");
  });

  it("classifies transient errors inside arrays", () => {
    expect(
      isRetryableTransientModelError({
        errors: [{ code: "server_is_overloaded" }],
      }),
    ).toBe(true);
  });

  it("classifies SSE socket closures as retryable", () => {
    const message =
      "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()";

    expect(
      isRetryableTransientModelError(
        Object.assign(new Error(message), { code: "ConnectionClosed" }),
      ),
    ).toBe(true);
    expect(isRetryableTransientModelError(new Error(message))).toBe(true);
    expect(
      isRetryableTransientModelError({
        cause: Object.assign(new Error("connection reset"), {
          code: "ConnectionClosed",
        }),
      }),
    ).toBe(true);
  });
});

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(vercel?.openai?.include).toEqual(["reasoning.encrypted_content"]);
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("does not override explicit reasoningSummary and injects encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  it("preserves existing encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "codex",
      modelId: "gpt-5.5",
      providerOptions: {
        openai: {
          include: ["reasoning.encrypted_content"],
        },
      },
    });

    expect(next?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("withReasoningDisplayDefaultForAnthropicModels", () => {
  it("does not inject summarized thinking when display is none", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "none",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
        },
      },
    });
  });

  it("injects summarized display without changing thinking type", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
          display: "summarized",
        },
      },
    });
  });

  it("injects summarized display for vercel/openrouter anthropic models", () => {
    const vercel = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "anthropic/claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        gateway: {
          order: ["anthropic"],
        },
      },
    });

    const openrouter = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "anthropic/claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        openrouter: {
          route: "fallback",
        },
      },
    });

    expect(vercel).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      gateway: {
        order: ["anthropic"],
      },
    });
    expect(openrouter).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      openrouter: {
        route: "fallback",
      },
    });
  });

  it("does not override explicit anthropic thinking display", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "omitted",
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "omitted",
        },
      },
    });
  });
});

describe("shouldEnableAnthropicPromptCache", () => {
  it("keeps Anthropic prompt caching disabled by default", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
      }),
    ).toBe(false);
  });

  it("enables Anthropic prompt caching only when explicitly opted in", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        anthropicPromptCache: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/openai/gpt-4o",
        anthropicPromptCache: true,
      }),
    ).toBe(false);
  });
});

describe("withStableAnthropicUpstreamOrder", () => {
  it("injects the default order for vercel anthropic when none is configured", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: { type: "enabled" },
      },
      gateway: {
        order: ["anthropic", "vertex", "bedrock"],
      },
    });
  });

  it("preserves an explicit vercel gateway order", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });

    expect(next).toEqual({
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });
  });

  it("preserves an explicit openrouter provider order", () => {
    const next = withStableAnthropicUpstreamOrder("openrouter", {
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });

    expect(next).toEqual({
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });
  });
});

describe("anthropic fallback URL downloads", () => {
  it("detects fallback-capable anthropic gateway models", () => {
    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        providerOptions: {
          openrouter: {
            provider: {
              order: ["anthropic"],
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            only: ["anthropic"],
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(false);
  });

  it("forces downloads for http urls when fallback order includes vertex or bedrock", async () => {
    const downloadCalls: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      downloadUrl: async (url) => {
        downloadCalls.push(url.toString());
        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        };
      },
      cacheDir: dir,
    });

    try {
      expect(download).toBeDefined();

      const result = await download!([
        {
          url: new URL("https://example.com/image.png?test=force-download"),
          isUrlSupportedByModel: true,
        },
        {
          url: new URL("data:image/png;base64,AA=="),
          isUrlSupportedByModel: false,
        },
      ]);

      expect(downloadCalls.toSorted()).toEqual([
        "data:image/png;base64,AA==",
        "https://example.com/image.png?test=force-download",
      ]);
      expect(result).toEqual([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches fallback downloads across repeated requests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array([9, 8, 7, 6]),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/report.pdf?test=cache"),
          isUrlSupportedByModel: true,
        },
      ];

      await download!(request);
      await download!(request);

      expect(calls).toBe(1);
      const files = await readdir(dir);
      expect(files.some((file) => file.endsWith(".bin"))).toBe(false);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o077).toBe(0);

      for (const file of files) {
        const fileStat = await stat(path.join(dir, file));
        expect(fileStat.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads large cached attachments back from blob storage without re-downloading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array(9 * 1024 * 1024),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/large-report.pdf?test=disk-cache"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized images to fit anthropic fallback limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/huge-image.png?test=resize"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
      expect(first).toEqual([
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        },
      ]);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches oversize image failures to avoid repeated downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return null;
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/too-big-image.png?test=oversize"),
          isUrlSupportedByModel: true,
        },
      ];

      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not build a download hook when routing is pinned away from fallback providers", () => {
    const download = buildExperimentalDownloadForAnthropicFallback({
      blobStore: TEST_BLOB_STORE,
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          only: ["anthropic"],
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
    });

    expect(download).toBeUndefined();
  });
});

describe("maybeAppendResponseCommentaryPrompt", () => {
  it("describes commentary and final_answer as response phases", () => {
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("response phases");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("`commentary` phase");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).toContain("`final_answer` phase");
    expect(RESPONSE_COMMENTARY_INSTRUCTIONS).not.toContain("Use two channels");
  });

  it("appends commentary guidance for openai provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("appends commentary guidance for codex provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "codex",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("does not append when disabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: false,
    });

    expect(out).toBe("Base prompt");
  });

  it("does not append for unsupported providers", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openrouter",
      responseCommentary: true,
    });

    expect(out).toBe("Base prompt");
  });
});
