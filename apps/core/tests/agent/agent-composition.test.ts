import { CodexAgentAdapter } from "@stanley2058/lilac-agent/adapters/codex/adapter";
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { AiSdkAgentAdapter } from "@stanley2058/lilac-agent/adapters/ai-sdk/adapter";
import { OpenAIResponsesAgentAdapter } from "@stanley2058/lilac-agent/adapters/openai-responses/adapter";
import type { AgentExecutionHost } from "@stanley2058/lilac-agent/agent-execution-host";
import { ClaudeCodeAgentAdapter } from "@stanley2058/lilac-claude-code-bridge";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import type { ResolvedModelRef } from "@stanley2058/lilac-utils";

import {
  createCoreAgentAdapter,
  prepareCoreProviderBinding,
} from "../../src/agent/agent-composition";

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
  test("keeps the Anthropic cache default out of shared provider options", async () => {
    const blobStore = (await createMemoryBlobStore()).unwrap();
    try {
      const resolved = resolvedModel("anthropic", "claude-opus-5-5");
      const binding = {
        resolved,
        blobStore,
        reasoningDisplay: "none" as const,
        systemPrompt: "test",
        sessionId: "test",
      };
      expect(prepareCoreProviderBinding(binding).providerOptionsForAgent).toBeUndefined();

      const providerOptions = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
      expect(
        prepareCoreProviderBinding({ ...binding, resolved: { ...resolved, providerOptions } })
          .providerOptionsForAgent,
      ).toEqual(providerOptions);
    } finally {
      await blobStore.close({ deadlineAtMs: Date.now() + 1_000 });
    }
  });

  test("explicit SSE uses the AI SDK adapter", () => {
    const resolved = resolvedModel("openai");
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { ...openai, responsesTransport: "sse" } },
    );

    const execution = adapter.createExecution({
      attemptId: "sse-attempt",
      messages: [],
      host: {} as AgentExecutionHost,
    });
    expect(execution.retryOwner).toBe("adapter");
    expect(execution.capabilities.steering).toBe("boundary");
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

  test.each(["anthropic", "google"])("%s preserves AI SDK execution", (provider) => {
    const resolved = resolvedModel(provider);
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude, openai: { responsesTransport: "websocket" } },
    );

    expect(adapter).toBeInstanceOf(AiSdkAgentAdapter);
  });

  test("Codex selects its own adapter without reading credentials or opening a connection", () => {
    const resolved = resolvedModel("codex");
    const adapter = createCoreAgentAdapter(
      { model: resolved.model, system: "" },
      { resolved, claude },
    );
    expect(adapter).toBeInstanceOf(CodexAgentAdapter);
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
