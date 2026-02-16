import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";

import { AiSdkPiAgent } from "../ai-sdk-pi-agent";

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

describe("AiSdkPiAgent model spec tracking", () => {
  it("stores initial modelSpecifier and updates on setModel", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "anthropic/claude-sonnet-4-5",
    });

    expect(agent.state.modelSpecifier).toBe("anthropic/claude-sonnet-4-5");

    agent.setModel(fakeModel(), undefined, "openai/gpt-4.1-mini");
    expect(agent.state.modelSpecifier).toBe("openai/gpt-4.1-mini");

    agent.setModel(fakeModel());
    expect(agent.state.modelSpecifier).toBeUndefined();
  });
});
