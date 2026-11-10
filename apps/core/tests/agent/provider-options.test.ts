import { describe, expect, it } from "bun:test";

import {
  withOpenAIPromptCacheKey,
  withOpenAIServerCompaction,
} from "../../src/agent/provider-options";

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
