import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { AiSdkAgentAdapter } from "@stanley2058/lilac-agent/adapters/ai-sdk/adapter";
import { OpenAIResponsesAgentAdapter } from "@stanley2058/lilac-agent/adapters/openai-responses/adapter";
import { ClaudeCodeAgentAdapter } from "@stanley2058/lilac-claude-code-bridge";
import type { ResolvedModelRef } from "@stanley2058/lilac-utils";

import { createCoreAgentAdapter } from "../../src/agent/agent-composition";

function resolvedModel(provider: string, modelId = "gpt-6-astra"): ResolvedModelRef {
  return {
    provider,
    modelId,
    spec: `${provider}/${modelId}`,
    model: new MockLanguageModelV4({ modelId }),
  };
}

const claude = { run: null, namedRuntime: null, primaryRuntime: null };
const openai = {
  apiKey: "test",
  baseUrl: "https://openai.invalid/v1",
};

describe("Core agent adapter selection", () => {
  test("explicit SSE uses the AI SDK adapter", () => {
    const resolved = resolvedModel("openai");
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { ...openai, responsesTransport: "sse" } },
    );

    expect(adapter).toBeInstanceOf(AiSdkAgentAdapter);
  });

  test.each(["auto", "websocket"] as const)(
    "%s selects native OpenAI execution without opening a connection",
    (responsesTransport) => {
      const resolved = resolvedModel("openai");
      const adapter = createCoreAgentAdapter(
        { model: resolved.model, system: "" },
        { resolved, claude, openai: { ...openai, responsesTransport } },
      );

      expect(adapter).toBeInstanceOf(OpenAIResponsesAgentAdapter);
    },
  );

  test("a model without native steering still selects native OpenAI execution", () => {
    const resolved = resolvedModel("openai", "gpt-5.4");
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { ...openai, responsesTransport: "websocket" } },
    );

    expect(adapter).toBeInstanceOf(OpenAIResponsesAgentAdapter);
  });

  test.each(["codex", "anthropic", "google"])("%s preserves AI SDK execution", (provider) => {
    const resolved = resolvedModel(provider);
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { responsesTransport: "websocket" } },
    );

    expect(adapter).toBeInstanceOf(AiSdkAgentAdapter);
  });

  test("a constructor model override selects AI SDK execution", () => {
    const resolved = resolvedModel("openai");
    const overrideModel = new MockLanguageModelV4({ modelId: "test-override" });
    const adapter = createCoreAgentAdapter(
      { model: overrideModel, system: "" },
      { resolved, claude, openai: { responsesTransport: "websocket" } },
    );

    expect(adapter).toBeInstanceOf(AiSdkAgentAdapter);
  });

  test("Claude selects the bridge adapter without requiring a running process", () => {
    const resolved = resolvedModel("claude-code", "sonnet");
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { responsesTransport: "websocket" } },
    );

    expect(adapter).toBeInstanceOf(ClaudeCodeAgentAdapter);
  });
});
