import { describe, expect, it } from "bun:test";

import type { ProviderConfig } from "../src/providers";
import { createWebSearchProviderResolver, createWebsearchTool } from "../src/web-search";

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
  it("resolves OpenAI and Anthropic providers and hides unsupported providers", () => {
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

  it.each([
    {
      provider: "openai" as const,
      hostedToolId: "openai.web_search",
      args: { externalWebAccess: true, searchContextSize: "medium" },
    },
    {
      provider: "anthropic" as const,
      hostedToolId: "anthropic.web_search_20250305",
      args: { maxUses: 3 },
    },
    {
      provider: "codex" as const,
      hostedToolId: "openai.web_search",
      args: { externalWebAccess: true, searchContextSize: "medium" },
    },
  ])("exposes the native $provider hosted tool directly", (testCase) => {
    const websearch = createWebsearchTool(testCase.provider).websearch;

    expect(websearch).toMatchObject({
      type: "provider",
      isProviderExecuted: true,
      id: testCase.hostedToolId,
      args: testCase.args,
    });
    expect(websearch?.execute).toBeUndefined();
  });
});
