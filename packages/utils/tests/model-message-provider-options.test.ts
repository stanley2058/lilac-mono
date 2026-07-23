import { describe, expect, it } from "bun:test";

import type { ModelMessage } from "ai";

import { withoutOpenAIItemIds } from "../model-message-provider-options";

describe("withoutOpenAIItemIds", () => {
  it("strips item IDs from stored assistant parts while preserving all other metadata", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Answer",
            providerOptions: {
              openai: { itemId: "msg_123", phase: "final_answer" },
              other: { traceId: "trace-1" },
            },
          },
          {
            type: "reasoning",
            text: "Reasoning summary",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted-reasoning",
              },
            },
          },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "read_file",
            input: { path: "README.md" },
            providerOptions: {
              openai: { itemId: "fc_123", namespace: "functions" },
            },
          },
          {
            type: "custom",
            kind: "openai.compaction",
            providerOptions: {
              openai: { itemId: "cmp_123", encryptedContent: "encrypted-compaction" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "read_file",
            output: { type: "text", value: "contents" },
            providerOptions: { openai: { itemId: "out_123", phase: "commentary" } },
          },
        ],
      },
    ];
    const original = structuredClone(messages);

    const transformed = withoutOpenAIItemIds(messages);

    expect(messages).toEqual(original);
    expect(transformed).not.toBe(messages);
    expect(transformed.every((message, index) => message !== messages[index])).toBe(true);
    expect(transformed).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Answer",
            providerOptions: {
              openai: { phase: "final_answer" },
              other: { traceId: "trace-1" },
            },
          },
          {
            type: "reasoning",
            text: "Reasoning summary",
            providerOptions: {
              openai: { reasoningEncryptedContent: "encrypted-reasoning" },
            },
          },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "read_file",
            input: { path: "README.md" },
            providerOptions: { openai: { namespace: "functions" } },
          },
          {
            type: "custom",
            kind: "openai.compaction",
            providerOptions: { openai: { encryptedContent: "encrypted-compaction" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "read_file",
            output: { type: "text", value: "contents" },
            providerOptions: { openai: { phase: "commentary" } },
          },
        ],
      },
    ]);
  });

  it("does not remove itemId from other provider namespaces or message metadata", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        providerOptions: { openai: { itemId: "message-level" } },
        content: [
          {
            type: "text",
            text: "Answer",
            providerOptions: { custom: { itemId: "custom-item" } },
          },
        ],
      },
    ];

    expect(withoutOpenAIItemIds(messages)).toEqual(messages);
  });
});
