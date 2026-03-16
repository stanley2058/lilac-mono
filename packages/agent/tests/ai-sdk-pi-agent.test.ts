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

  it("appends messages while idle", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    agent.appendMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "subagent_result",
            input: { childRequestId: "child-1", status: "resolved" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "subagent_result",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]);

    expect(agent.state.messages).toHaveLength(3);
    expect(agent.state.messages[1]?.role).toBe("assistant");
    expect(agent.state.messages[2]?.role).toBe("tool");
  });
});
