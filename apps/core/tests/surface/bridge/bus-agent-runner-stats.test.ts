import { describe, expect, it } from "bun:test";

import { buildNoAssistantTextError } from "../../../src/surface/bridge/bus-agent-runner/stats";

describe("buildNoAssistantTextError", () => {
  it("reports an uncontinuable tool-call turn instead of model unavailability", () => {
    const message = buildNoAssistantTextError({
      provider: "codex",
      modelId: "gpt-5.6-sol",
      finishReason: "tool-calls",
    });

    expect(message).toContain("neither an executable tool call nor a completed tool result");
    expect(message).not.toContain("model_not_found");
  });
});
