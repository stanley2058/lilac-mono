import { describe, expect, it } from "bun:test";

import {
  withDefaultAnthropicAutomaticPromptCache,
  withOpenAIPromptCacheKey,
  withOpenAIServerCompaction,
} from "../../src/agent/provider-options";

describe("Anthropic automatic prompt caching defaults", () => {
  it.each([
    undefined,
    "https://api.anthropic.com",
    "https://api.anthropic.com/v1/",
    "https://API.ANTHROPIC.COM/v1",
    "https://api.anthropic.com:443/v1",
  ])("adds a five-minute request-level marker for the first-party endpoint %s", (baseUrl) => {
    expect(
      withDefaultAnthropicAutomaticPromptCache({
        provider: "anthropic",
        baseUrl,
        providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
      }),
    ).toEqual({
      anthropic: {
        thinking: { type: "adaptive" },
        cacheControl: { type: "ephemeral", ttl: "5m" },
      },
    });
  });

  it.each([
    { provider: "anthropic", anthropicPromptCache: false },
    { provider: "anthropic", anthropicPromptCache: true },
    { provider: "anthropic", baseUrl: "https://proxy.example/v1" },
    { provider: "anthropic", baseUrl: "https://api.anthropic.com/proxy/v1" },
    { provider: "openrouter" },
    { provider: "vercel" },
    { provider: "claude-code" },
  ])("leaves the request options alone for %j", (selection) => {
    expect(withDefaultAnthropicAutomaticPromptCache(selection)).toBeUndefined();
  });

  it("preserves an explicit request-level cache setting", () => {
    const providerOptions = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
    expect(
      withDefaultAnthropicAutomaticPromptCache({ provider: "anthropic", providerOptions }),
    ).toBe(providerOptions);
  });

  it("defers to an explicit marker on the final user content block", () => {
    expect(
      withDefaultAnthropicAutomaticPromptCache({
        provider: "anthropic",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reuse this prefix for an hour.",
                providerOptions: {
                  anthropic: { cache_control: { type: "ephemeral", ttl: "1h" } },
                },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("OpenAI provider option projections", () => {
  it("preserves existing options while adding the prompt cache key", () => {
    expect(
      withOpenAIPromptCacheKey(
        {
          openai: { reasoningSummary: "detailed" },
          gateway: { routing: "stable" },
        },
        "session-1",
      ),
    ).toEqual({
      openai: { reasoningSummary: "detailed", promptCacheKey: "session-1" },
      gateway: { routing: "stable" },
    });
  });

  it("normalizes server compaction include values to the closed string projection", () => {
    expect(
      withOpenAIServerCompaction({
        openai: {
          include: ["output.logprobs", 42, null, "reasoning.encrypted_content"],
          store: true,
        },
      }),
    ).toEqual({
      openai: {
        include: ["output.logprobs", "reasoning.encrypted_content"],
        store: false,
      },
    });
  });
});
