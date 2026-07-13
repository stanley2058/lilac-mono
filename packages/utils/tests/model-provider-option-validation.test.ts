import { describe, expect, it } from "bun:test";

import { validateModelProviderOptions } from "../model-provider-option-validation";

describe("validateModelProviderOptions", () => {
  it("accepts generated provider option keys", () => {
    expect(
      validateModelProviderOptions({
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
        openai: { textVerbosity: "low" },
        openaiCompatible: { reasoningEffort: "high" },
      }),
    ).toEqual([]);
  });

  it("warns about stripped options and suggests the nearest key", () => {
    expect(validateModelProviderOptions({ openai: { verbosity: "low" } })).toEqual([
      {
        namespace: "openai",
        option: "verbosity",
        suggestion: "textVerbosity",
      },
    ]);
  });

  it("warns without a suggestion for unrelated keys", () => {
    expect(validateModelProviderOptions({ openai: { temperature: 0.2 } })).toEqual([
      {
        namespace: "openai",
        option: "temperature",
      },
    ]);
  });

  it("validates nested union keys without enforcing the selected branch", () => {
    expect(
      validateModelProviderOptions({
        anthropic: {
          thinking: {
            type: "adaptive",
            budgetToken: 1024,
            budgetTokens: 1024,
          },
        },
      }),
    ).toEqual([
      {
        namespace: "anthropic",
        option: "thinking.budgetToken",
        suggestion: "thinking.budgetTokens",
      },
    ]);
  });

  it("validates objects nested in arrays", () => {
    expect(
      validateModelProviderOptions({
        anthropic: {
          mcpServers: [
            {
              type: "url",
              name: "docs",
              url: "https://example.com",
              toolConfiguration: { allowedTool: ["search"] },
            },
          ],
        },
      }),
    ).toEqual([
      {
        namespace: "anthropic",
        option: "mcpServers[].toolConfiguration.allowedTool",
        suggestion: "mcpServers[].toolConfiguration.allowedTools",
      },
    ]);
  });

  it("does not validate values or keys inside open records", () => {
    expect(
      validateModelProviderOptions({
        anthropic: {
          cacheControl: true,
          fallbacks: [
            {
              model: "claude",
              output_config: { futureOption: true },
            },
          ],
        },
        openai: { metadata: { arbitrary: { nested: true } } },
      }),
    ).toEqual([]);
  });

  it("leaves permissive and custom namespaces alone", () => {
    expect(
      validateModelProviderOptions({
        gateway: { futureServiceOption: true },
        openrouter: { route: "fallback" },
      }),
    ).toEqual([]);
  });
});
