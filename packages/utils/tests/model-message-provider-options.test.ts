import { describe, expect, it } from "bun:test";

import { openAIMessagePhase } from "../model-message-provider-options";

describe("openAIMessagePhase", () => {
  it("reads only supported OpenAI response phases", () => {
    expect(openAIMessagePhase({ openai: { itemId: "msg_1", phase: "commentary" } })).toBe(
      "commentary",
    );
    expect(openAIMessagePhase({ openai: { phase: "final_answer" } })).toBe("final_answer");
    expect(openAIMessagePhase({ openai: { phase: "unknown" } })).toBeUndefined();
    expect(openAIMessagePhase({ anthropic: { phase: "commentary" } })).toBeUndefined();
  });
});
