import { expect, test } from "bun:test";
import type { AgentPreparedContext } from "../../agent-adapter";
import { CodexAgentAdapter, codexRequestCodec } from "./adapter";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentExecutionHost } from "../../agent-execution-host";
import { normalizeCodexWebSocketRequest } from "./compatibility";

test("Codex encodes complete stateless replay before request normalization and preserves canonical metadata", async () => {
  const context: AgentPreparedContext = {
    scopeId: "scope",
    step: 0,
    system: "system",
    tools: [
      {
        name: "optional",
        description: "Optional property",
        inputSchemaJson: '{"type":"object","properties":{"name":{"type":"string"}}}',
      },
    ],
    canonicalMessages: [],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" },
              anthropic: { signature: "foreign-signature" },
            },
          },
          {
            type: "text",
            text: "reply",
            providerOptions: { openai: { itemId: "msg_1", phase: "commentary" } },
          },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "optional",
            input: {},
            providerOptions: { openai: { itemId: "fc_1" } },
          },
        ],
      },
    ],
  };
  const before = structuredClone(context);
  const encoded = (
    await codexRequestCodec.request({
      model: "gpt-6-astra",
      context,
      providerOptions: {
        openai: {
          store: true,
          conversation: "stored-conversation",
          previousResponseId: "resp_stored",
          promptCacheKey: "cache-key",
        },
      },
    })
  ).unwrap();
  const request = normalizeCodexWebSocketRequest(encoded).unwrap();
  expect(request.store).toBe(false);
  expect(request.prompt_cache_key).toBe("cache-key");
  expect<unknown[]>(request.input).toContainEqual({
    type: "reasoning",
    encrypted_content: "encrypted",
    summary: [],
  });
  expect(request.input.some((item) => item.type === "message" && item.role === "assistant")).toBe(
    true,
  );
  expect<unknown[]>(request.input).toContainEqual({
    type: "function_call",
    call_id: "call_1",
    name: "optional",
    arguments: "{}",
  });
  expect(request.tools?.[0]).toMatchObject({ strict: false });
  expect(JSON.stringify(request)).not.toContain("stored-conversation");
  expect(JSON.stringify(request)).not.toContain("resp_stored");
  expect(JSON.stringify(request)).not.toContain("foreign-signature");
  expect(context).toEqual(before);
});

test("Codex never exposes native steering even for gpt-6-astra", () => {
  const adapter = new CodexAgentAdapter(
    { model: new MockLanguageModelV4(), system: "system" },
    { model: "gpt-6-astra", transport: "websocket" },
  );
  const execution = adapter.createExecution({
    attemptId: "attempt",
    messages: [],
    host: {} as AgentExecutionHost,
  });
  expect(execution.capabilities.steering).toBe("boundary");
});
