import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  buildSyntheticToolCallId,
  normalizeModelMessagesToolCallIds,
  resolveToolCallIdNormalizationPolicy,
} from "../tool-call-id-normalization";

describe("tool call ID normalization", () => {
  it("enables strict normalization for Anthropic-family specs", () => {
    expect(resolveToolCallIdNormalizationPolicy("vercel/anthropic/claude-opus-4.6")).toEqual({
      mode: "strict",
      maxLength: 64,
    });

    expect(
      resolveToolCallIdNormalizationPolicy("bedrock/global.anthropic.claude-opus-4-6-v1"),
    ).toEqual({
      mode: "strict",
      maxLength: 64,
    });
  });

  it("enables strict9 normalization for Mistral-family specs", () => {
    expect(
      resolveToolCallIdNormalizationPolicy("openrouter/mistralai/devstral-small-2507"),
    ).toEqual({
      mode: "strict9",
      maxLength: 9,
    });
  });

  it("leaves OpenAI-family specs unchanged", () => {
    expect(resolveToolCallIdNormalizationPolicy("openrouter/openai/gpt-4o")).toBeUndefined();
  });

  it("rewrites assistant tool calls and tool results consistently", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagent_result:sub:discord:680343695673131032:1484530145162432552",
            toolName: "subagent_result",
            input: { ok: true },
          },
          {
            type: "tool-call",
            toolCallId: "subagent_result|sub|discord|680343695673131032|1484530145162432552",
            toolName: "subagent_result",
            input: { ok: false },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "subagent_result:sub:discord:680343695673131032:1484530145162432552",
            toolName: "subagent_result",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "subagent_result|sub|discord|680343695673131032|1484530145162432552",
            toolName: "subagent_result",
            output: { type: "json", value: { ok: false } },
          },
        ],
      },
    ];

    const normalized = normalizeModelMessagesToolCallIds({
      messages,
      modelSpecifier: "openrouter/anthropic/claude-sonnet-4.5",
    });

    const assistant = normalized[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant tool-call message");
    }

    const firstId =
      assistant.content[0]?.type === "tool-call" ? assistant.content[0].toolCallId : null;
    const secondId =
      assistant.content[1]?.type === "tool-call" ? assistant.content[1].toolCallId : null;

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(secondId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(firstId).not.toBe(secondId);

    const firstResult = normalized[2];
    const secondResult = normalized[3];
    expect(firstResult?.role).toBe("tool");
    expect(secondResult?.role).toBe("tool");
    if (
      !firstResult ||
      firstResult.role !== "tool" ||
      !secondResult ||
      secondResult.role !== "tool"
    ) {
      throw new Error("expected tool result messages");
    }

    const firstResultId =
      firstResult.content[0]?.type === "tool-result" ? firstResult.content[0].toolCallId : null;
    const secondResultId =
      secondResult.content[0]?.type === "tool-result" ? secondResult.content[0].toolCallId : null;

    expect(firstResultId).toBe(firstId);
    expect(secondResultId).toBe(secondId);
  });

  it("keeps OpenAI-family tool call IDs unchanged", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagent_result:sub:discord:1",
            toolName: "subagent_result",
            input: { ok: true },
          },
        ],
      },
    ];

    const normalized = normalizeModelMessagesToolCallIds({
      messages,
      modelSpecifier: "openrouter/openai/gpt-4o",
    });

    const assistant = normalized[0];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool call part");
    }

    expect(part.toolCallId).toBe("subagent_result:sub:discord:1");
  });

  it("builds stable synthetic tool call IDs with safe characters", () => {
    const one = buildSyntheticToolCallId({
      prefix: "subagent_result",
      seed: "sub:discord:680343695673131032:1484530145162432552",
    });
    const two = buildSyntheticToolCallId({
      prefix: "subagent_result",
      seed: "sub:discord:680343695673131032:1484530145162432553",
    });

    expect(one).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(two).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(one).not.toBe(two);
    expect(
      buildSyntheticToolCallId({
        prefix: "subagent_result",
        seed: "sub:discord:680343695673131032:1484530145162432552",
      }),
    ).toBe(one);
  });
});
