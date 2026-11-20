import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { recoverAnthropicThinking } from "../../src/agent/anthropic-thinking-recovery";

const error = {
  aiErrorName: "AI_APICallError",
  aiErrorMessage:
    "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
  statusCode: 400,
};
const messages: ModelMessage[] = [
  { role: "user", content: "first" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "signed" } } },
      { type: "text", text: "answer" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "opaque" } } },
      { type: "tool-call", toolCallId: "call", toolName: "read", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "read",
        output: { type: "text", value: "result" },
      },
    ],
  },
  { role: "user", content: "next" },
];

test("retries with assistant text and discards reasoning and tool exchanges", () => {
  const repaired = recoverAnthropicThinking({ provider: "anthropic", error, messages });
  expect(repaired).toEqual([messages[0]!, { role: "assistant", content: "answer" }, messages[4]!]);
  expect(messages[1]).toHaveProperty("content.0.type", "reasoning");
  expect(
    recoverAnthropicThinking({ provider: "anthropic", error, messages: repaired! }),
  ).toBeNull();
});

test("does not repair unrelated errors or providers", () => {
  expect(recoverAnthropicThinking({ provider: "openai", error, messages })).toBeNull();
  expect(
    recoverAnthropicThinking({
      provider: "anthropic",
      error: { ...error, statusCode: 500 },
      messages,
    }),
  ).toBeNull();
  expect(
    recoverAnthropicThinking({
      provider: "anthropic",
      error: { ...error, aiErrorMessage: "Invalid signature" },
      messages,
    }),
  ).toBeNull();
});

test("preserves visible assistant whitespace between text parts", () => {
  const repaired = recoverAnthropicThinking({
    provider: "anthropic",
    error,
    messages: [
      messages[0]!,
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "hidden",
            providerOptions: { anthropic: { signature: "signed" } },
          },
          { type: "text", text: "- one\n" },
          { type: "text", text: "  continuation" },
          { type: "text", text: "Next paragraph" },
        ],
      },
      messages[4]!,
    ],
  });
  expect(repaired?.[1]).toEqual({
    role: "assistant",
    content: "- one\n  continuation\n\nNext paragraph",
  });
});
