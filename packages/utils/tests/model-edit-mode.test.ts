import { describe, expect, it } from "bun:test";

import { isOpenAiLikeModel, resolveEditingToolMode } from "../model-edit-mode";

describe("model edit mode", () => {
  it("treats openai/* as openai-like", () => {
    expect(
      isOpenAiLikeModel({
        provider: "openai",
        modelId: "gpt-5",
      }),
    ).toBe(true);
    expect(
      resolveEditingToolMode({
        provider: "openai",
        modelId: "gpt-5",
      }),
    ).toBe("apply_patch");
  });

  it("treats codex/* as openai-like", () => {
    expect(
      isOpenAiLikeModel({
        provider: "codex",
        modelId: "gpt-5-codex",
      }),
    ).toBe(true);
  });

  it("treats openrouter/openai/* as openai-like", () => {
    expect(
      isOpenAiLikeModel({
        provider: "openrouter",
        modelId: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it("treats vercel/openai/* as openai-like", () => {
    expect(
      isOpenAiLikeModel({
        provider: "vercel",
        modelId: "openai/gpt-4o-mini",
      }),
    ).toBe(true);
  });

  it("treats non-openai families as edit_file mode", () => {
    expect(
      resolveEditingToolMode({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
      }),
    ).toBe("edit_file");

    expect(
      resolveEditingToolMode({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.5",
      }),
    ).toBe("edit_file");

    expect(
      resolveEditingToolMode({
        provider: "vercel",
        modelId: "anthropic/claude-sonnet-4.5",
      }),
    ).toBe("edit_file");
  });
});
