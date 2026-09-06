import { describe, expect, test } from "bun:test";
import { openAIResponseCodec } from "./output";
import type { OpenAIProtocolEvent } from "./protocol";

function decode(value: object): OpenAIProtocolEvent {
  return openAIResponseCodec.decode(JSON.stringify(value)).unwrap();
}

describe("OpenAI Responses output codec", () => {
  test("uses nested steering IDs and separates acceptance from successor creation", () => {
    const steer = { id: "steer-1", previous_response_id: "response-1" };
    expect(decode({ type: "response.steer.accepted", steer })).toEqual({
      type: "steer-accepted",
      steerId: "steer-1",
      previousResponseId: "response-1",
    });
    expect(
      decode({
        type: "response.steer.pending",
        steer,
        required_input: [{ type: "function_call_output", call_id: "call-1" }],
      }),
    ).toEqual({
      type: "steer-pending",
      steerId: "steer-1",
      previousResponseId: "response-1",
      requiredInput: [{ type: "function_call_output", call_id: "call-1" }],
    });
    expect(
      decode({ type: "response.steer.failed", steer, error: { message: "No active response" } }),
    ).toEqual({
      type: "steer-failed",
      steerId: "steer-1",
      previousResponseId: "response-1",
      message: "No active response",
    });
    expect(
      decode({
        type: "response.created",
        response: {
          id: "response-2",
          previous_response_id: "response-1",
          status: "in_progress",
          output: [],
        },
      }),
    ).toMatchObject({
      type: "created",
      response: { id: "response-2", previousResponseId: "response-1" },
    });
  });

  test("rejects malformed relevant events and invalid JSON, tolerates unrelated events", () => {
    for (const event of [
      { type: "response.created", response: {} },
      { type: "response.steer.accepted", steer: { previous_response_id: "r" } },
      { type: "response.output_text.delta", item_id: "m" },
      { type: "response.output_item.done", item: { type: "message", id: "m" } },
    ])
      expect(openAIResponseCodec.decode(JSON.stringify(event)).isErr()).toBe(true);
    expect(openAIResponseCodec.decode("{").isErr()).toBe(true);
    expect(decode({ type: "response.in_progress" })).toEqual({ type: "ignored" });
    expect(decode({ type: "future.telemetry", detail: 42 })).toEqual({ type: "ignored" });
  });

  test("projects complete output with replay metadata, tool inputs, and usage", () => {
    const event = decode({
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs", summary: [], encrypted_content: "encrypted" },
          {
            type: "message",
            id: "m",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Looking up" }],
          },
          {
            type: "function_call",
            id: "fc",
            call_id: "call",
            name: "lookup",
            arguments: '{"q":"hello"}',
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 7 },
        },
      },
    });
    expect(event.type).toBe("finished");
    if (event.type !== "finished") return;
    expect(event.response.usage).toMatchObject({
      inputTokens: 20,
      totalTokens: 30,
      inputTokenDetails: { cacheReadTokens: 5, noCacheTokens: 15 },
      outputTokenDetails: { reasoningTokens: 7, textTokens: 3 },
    });
    const result = openAIResponseCodec.project(event.response).unwrap();
    expect(result.finishReason).toBe("tool-calls");
    expect(result.calls).toEqual([{ callId: "call", name: "lookup", inputJson: '{"q":"hello"}' }]);
    expect(result.assistant.content).toEqual([
      {
        type: "reasoning",
        text: "",
        providerOptions: { openai: { itemId: "rs", reasoningEncryptedContent: "encrypted" } },
      },
      {
        type: "text",
        text: "Looking up",
        providerOptions: { openai: { itemId: "m", phase: "commentary" } },
      },
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "lookup",
        input: { q: "hello" },
        providerOptions: { openai: { itemId: "fc" } },
      },
    ]);
  });

  test("separates streamed blocks and exposes complete items for checkpoints", () => {
    expect(
      decode({
        type: "response.content_part.added",
        item_id: "m",
        content_index: 1,
        part: { type: "output_text", text: "" },
      }),
    ).toMatchObject({ type: "output", output: { phase: "start", id: "m:1", kind: "text" } });
    expect(
      decode({
        type: "response.output_text.delta",
        item_id: "m",
        content_index: 1,
        delta: "hello",
      }),
    ).toMatchObject({ type: "output", output: { phase: "delta", id: "m:1", delta: "hello" } });
    expect(
      decode({ type: "response.output_text.done", item_id: "m", content_index: 1, text: "hello" }),
    ).toMatchObject({ type: "output", output: { phase: "end", id: "m:1" } });
    expect(
      decode({
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs",
          summary: [{ type: "summary_text", text: "Done" }],
          encrypted_content: "x",
        },
      }),
    ).toMatchObject({ type: "item-complete", item: { id: "rs", encrypted_content: "x" } });
    expect(
      decode({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "" },
      }),
    ).toMatchObject({
      type: "item-start",
      item: { type: "function_call", id: "fc", call_id: "call", name: "lookup" },
    });
  });

  test("emits completed text and reasoning blocks before the whole item completes", () => {
    expect(
      decode({
        type: "response.content_part.done",
        item_id: "m",
        content_index: 1,
        part: { type: "output_text", text: "Saved" },
      }),
    ).toEqual({
      type: "block-complete",
      index: 1,
      item: {
        type: "message",
        id: "m",
        role: "assistant",
        content: [{ type: "output_text", text: "Saved" }],
      },
    });
    expect(
      decode({
        type: "response.reasoning_summary_part.done",
        item_id: "rs",
        summary_index: 0,
        part: { type: "summary_text", text: "Reason" },
      }),
    ).toEqual({
      type: "block-complete",
      index: 0,
      item: { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "Reason" }] },
    });
    expect(
      openAIResponseCodec
        .decode(
          JSON.stringify({
            type: "response.steer.pending",
            steer: { id: "s", previous_response_id: "r" },
          }),
        )
        .isErr(),
    ).toBe(true);
    expect(
      openAIResponseCodec
        .decode(
          JSON.stringify({
            type: "response.content_part.done",
            item_id: "m",
            part: { type: "output_text" },
          }),
        )
        .isErr(),
    ).toBe(true);
  });

  test("projects completed checkpoint items and compaction replay data", () => {
    const projected = openAIResponseCodec
      .project({
        id: "r",
        status: "in_progress",
        output: [
          {
            type: "message",
            id: "m",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Complete block" }],
          },
          { type: "compaction", id: "cmp", encrypted_content: "compact" },
        ],
      })
      .unwrap();
    expect(projected.calls).toEqual([]);
    expect(projected.assistant.content).toEqual([
      {
        type: "text",
        text: "Complete block",
        providerOptions: { openai: { itemId: "m", phase: "final_answer" } },
      },
      {
        type: "custom",
        kind: "openai.compaction",
        providerOptions: {
          openai: { type: "compaction", itemId: "cmp", encryptedContent: "compact" },
        },
      },
    ]);
    expect(
      decode({
        type: "response.output_item.added",
        item: { type: "message", id: "m", role: "assistant", phase: "commentary", content: [] },
      }),
    ).toMatchObject({ type: "item-start", item: { id: "m", phase: "commentary" } });
    expect(
      openAIResponseCodec
        .decode(
          JSON.stringify({
            type: "response.output_item.added",
            item: { type: "function_call", id: "x" },
          }),
        )
        .isErr(),
    ).toBe(true);
  });

  test("reports incomplete finish reasons and fails closed on unknown output", () => {
    expect(
      openAIResponseCodec
        .project({
          id: "r",
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          output: [],
        })
        .unwrap().finishReason,
    ).toBe("length");
    expect(
      openAIResponseCodec
        .project({ id: "r", status: "completed", output: [{ type: "unhandled_tool", id: "x" }] })
        .isErr(),
    ).toBe(true);
    expect(
      openAIResponseCodec
        .project({
          id: "r",
          status: "completed",
          output: [
            { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "{" },
          ],
        })
        .isErr(),
    ).toBe(true);
  });
});
