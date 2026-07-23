import { describe, expect, it } from "bun:test";

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import type { ProviderConfig } from "../src/providers";
import {
  createWebSearchProviderResolver,
  executeWebsearch,
  type WebSearchGenerate,
} from "../src/web-search";

const providerConfig: ProviderConfig = {
  configVersion: 1,
  providers: {
    primary: { type: "openai", catalog: "models-dev" },
    claude: { type: "anthropic", catalog: "models-dev" },
    compatible: {
      type: "openai-compatible",
      baseUrl: "https://models.example.com/v1",
      catalog: "v1",
    },
  },
};

describe("Mini Lilac websearch", () => {
  it("resolves arbitrary OpenAI and Anthropic IDs and distinguishes Codex OAuth", () => {
    const resolve = createWebSearchProviderResolver({
      config: providerConfig,
      supersededProviderIds: ["primary"],
    });
    expect(resolve("primary/gpt-5")).toBe("codex");
    expect(resolve("claude/claude-sonnet-4-6")).toBe("anthropic");
    expect(resolve("compatible/model")).toBeUndefined();
    expect(resolve("missing/model")).toBeUndefined();

    const apiKeyResolve = createWebSearchProviderResolver({
      config: providerConfig,
      supersededProviderIds: [],
    });
    expect(apiKeyResolve("primary/gpt-5")).toBe("openai");
  });

  it("normalizes, deduplicates, and bounds provider search results", async () => {
    const seen: Parameters<WebSearchGenerate>[0][] = [];
    const generate: WebSearchGenerate = async (input) => {
      seen.push(input);
      return {
        text: " Current answer ",
        sources: [
          { sourceType: "url", url: "https://one.example.com", title: "One" },
          { sourceType: "url", url: "https://one.example.com", title: "Duplicate" },
          { sourceType: "document" },
          { sourceType: "url", url: "https://two.example.com" },
        ],
        toolCalls: [{ toolName: "web_search" }],
        finishReason: "stop",
      };
    };
    const abortController = new AbortController();
    const result = await executeWebsearch({
      query: " current release ",
      model: new MockLanguageModelV4(),
      modelSpecifier: "primary/gpt-5",
      provider: "openai",
      abortSignal: abortController.signal,
      generate,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.query).toBe("current release");
    expect(seen[0]?.abortSignal).toBe(abortController.signal);
    expect(result.answer).toBe("Current answer");
    expect(result.sources).toEqual([
      { title: "One", url: "https://one.example.com" },
      { title: "https://two.example.com", url: "https://two.example.com" },
    ]);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("primary/gpt-5");
    expect(result.truncated).toBe(false);
  });

  it.each([
    { provider: "openai" as const, hostedToolId: "openai.web_search", toolChoiceType: "required" },
    {
      provider: "anthropic" as const,
      hostedToolId: "anthropic.web_search_20250305",
      toolChoiceType: "required",
    },
    { provider: "codex" as const, hostedToolId: "openai.web_search", toolChoiceType: "auto" },
  ])("uses the native $provider hosted search tool", async (testCase) => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "search-1",
              toolName: "web_search",
              input: "{}",
              providerExecuted: true,
            },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Native search answer" },
            { type: "text-end", id: "answer" },
            {
              type: "source",
              sourceType: "url",
              id: "source-1",
              url: "https://source.example.com",
              title: "Source",
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });

    const result = await executeWebsearch({
      query: "latest native search result",
      model,
      modelSpecifier: `provider/${testCase.provider}`,
      provider: testCase.provider,
    });

    expect(result.answer).toBe("Native search answer");
    expect(JSON.stringify(model.doStreamCalls[0]?.tools)).toContain(testCase.hostedToolId);
    expect(model.doStreamCalls[0]?.toolChoice?.type).toBe(testCase.toolChoiceType);
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(
      testCase.provider === "codex" ? undefined : 2_000,
    );
    expect(model.doStreamCalls[0]?.providerOptions).toEqual(
      testCase.provider === "anthropic"
        ? undefined
        : testCase.provider === "codex"
          ? { openai: { store: false } }
          : { openai: { store: false, maxToolCalls: 3 } },
    );
  });

  it("requires an actual hosted search call and a non-empty answer", async () => {
    const base = {
      query: "latest information",
      model: new MockLanguageModelV4(),
      modelSpecifier: "primary/gpt-5",
      provider: "codex" as const,
    };
    await expect(
      executeWebsearch({
        ...base,
        generate: async () => ({
          text: "answer without search",
          sources: [],
          toolCalls: [],
          finishReason: "stop",
        }),
      }),
    ).rejects.toThrow("did not execute");
    await expect(
      executeWebsearch({
        ...base,
        generate: async () => ({
          text: "  ",
          sources: [],
          toolCalls: [{ toolName: "web_search" }],
          finishReason: "stop",
        }),
      }),
    ).rejects.toThrow("no answer");

    let generated = false;
    await expect(
      executeWebsearch({
        ...base,
        modelSpecifier: "m".repeat(2_049),
        generate: async () => {
          generated = true;
          return {
            text: "unused",
            sources: [],
            toolCalls: [{ toolName: "web_search" }],
            finishReason: "stop",
          };
        },
      }),
    ).rejects.toThrow();
    expect(generated).toBe(false);
  });

  it("caps answers, titles, and source counts", async () => {
    const result = await executeWebsearch({
      query: "bounded result",
      model: new MockLanguageModelV4(),
      modelSpecifier: "claude/model",
      provider: "anthropic",
      generate: async () => ({
        text: "a".repeat(13_000),
        sources: Array.from({ length: 12 }, (_, index) => ({
          sourceType: "url" as const,
          url: `https://source-${index}.example.com`,
          title: "t".repeat(300),
        })),
        toolCalls: [{ toolName: "web_search" }],
        finishReason: "length",
      }),
    });
    expect(result.answer).toHaveLength(12_000);
    expect(result.sources).toHaveLength(10);
    expect(result.sources[0]?.title).toHaveLength(256);
    expect(result.truncated).toBe(true);
  });
});
