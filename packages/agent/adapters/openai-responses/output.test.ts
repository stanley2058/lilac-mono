import { describe, expect, test } from "bun:test";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import { openAIRequestCodec } from "./input";
import { openAIResponseCodec } from "./output";
import type { OpenAIProtocolEvent } from "./protocol";

function decode(value: object): OpenAIProtocolEvent {
  return openAIResponseCodec.decode(value as ResponsesServerEvent).unwrap();
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
        required_input: [{ type: "function_call_output", call_id: "call-1", name: "lookup" }],
      }),
    ).toEqual({
      type: "steer-pending",
      steerId: "steer-1",
      previousResponseId: "response-1",
      requiredInput: [{ type: "function_call_output", call_id: "call-1", name: "lookup" }],
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

  test("ignores unrelated SDK events", () => {
    expect(decode({ type: "response.in_progress" })).toEqual({ type: "ignored" });
  });

  test("preserves SDK protocol and streaming error details", () => {
    expect(
      decode({
        type: "error",
        status: 429,
        error: { code: "rate_limit", type: "rate_limit_error", param: null, message: "Slow down" },
      }),
    ).toEqual({
      type: "error",
      message: "Slow down",
      details: { code: "rate_limit", type: "rate_limit_error", param: null, statusCode: 429 },
    });
    expect(
      decode({
        type: "error",
        sequence_number: 1,
        code: "stream_error",
        param: "input",
        message: "Interrupted",
      }),
    ).toEqual({
      type: "error",
      message: "Interrupted",
      details: { code: "stream_error", type: "error", param: "input", statusCode: undefined },
    });
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
            status: "completed",
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
        part: { type: "output_text", text: "Saved", annotations: [] },
      }),
    ).toEqual({
      type: "block-complete",
      index: 1,
      item: {
        type: "message",
        id: "m",
        role: "assistant",
        status: "in_progress",
        content: [{ type: "output_text", text: "Saved", annotations: [] }],
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
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Complete block", annotations: [] }],
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
        .project({
          id: "r",
          status: "completed",
          output: [{ type: "image_generation_call", id: "x", result: null, status: "completed" }],
        })
        .isErr(),
    ).toBe(true);
    const projected = openAIResponseCodec
      .project({
        id: "r",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc",
            call_id: "call",
            name: "lookup",
            arguments: "not-json",
          },
        ],
      })
      .unwrap();
    expect(projected.calls).toEqual([{ callId: "call", name: "lookup", inputJson: "not-json" }]);
    expect(projected.assistant.content).toMatchObject([{ type: "tool-call", input: "not-json" }]);
  });
  test("round trips provider replay metadata without inventing optional features", async () => {
    const output = [
      { type: "reasoning" as const, id: "rs-encrypted", summary: [], encrypted_content: "sealed" },
      {
        type: "reasoning" as const,
        id: "rs-plain",
        summary: [{ type: "summary_text" as const, text: "Plan" }],
      },
      { type: "reasoning" as const, id: "rs-null", summary: [], encrypted_content: null },
      {
        type: "message" as const,
        id: "msg-comment",
        role: "assistant" as const,
        status: "completed" as const,
        phase: "commentary" as const,
        content: [{ type: "output_text" as const, text: "Checking", annotations: [] }],
      },
      {
        type: "message" as const,
        id: "msg-final",
        role: "assistant" as const,
        status: "completed" as const,
        phase: "final_answer" as const,
        content: [{ type: "output_text" as const, text: "Done", annotations: [] }],
      },
      {
        type: "message" as const,
        id: "msg-plain",
        role: "assistant" as const,
        status: "completed" as const,
        content: [{ type: "refusal" as const, refusal: "No" }],
      },
      {
        type: "function_call" as const,
        id: "fc",
        call_id: "call",
        name: "lookup",
        arguments: '{"q":"hello"}',
      },
      { type: "compaction" as const, id: "cmp", encrypted_content: "compacted" },
    ];
    const original = structuredClone(output);
    const projected = openAIResponseCodec
      .project({ id: "r", status: "completed", output })
      .unwrap();
    expect(projected.assistant.content).toMatchObject([
      {
        providerOptions: {
          openai: { itemId: "rs-encrypted", reasoningEncryptedContent: "sealed" },
        },
      },
      { providerOptions: { openai: { itemId: "rs-plain", reasoningEncryptedContent: null } } },
      { providerOptions: { openai: { itemId: "rs-null", reasoningEncryptedContent: null } } },
      {},
      {},
      { providerOptions: { openai: { itemId: "msg-plain" } } },
      {},
      {},
    ]);
    const replay = (await openAIRequestCodec.messages(projected.messages)).unwrap();
    expect(replay).toEqual([
      { type: "reasoning", id: "rs-encrypted", summary: [], encrypted_content: "sealed" },
      {
        type: "message",
        id: "msg-comment",
        role: "assistant",
        status: "completed",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking", annotations: [] }],
      },
      {
        type: "message",
        id: "msg-final",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      },
      {
        type: "message",
        id: "msg-plain",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "No", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc",
        call_id: "call",
        name: "lookup",
        arguments: '{"q":"hello"}',
      },
      { type: "compaction", id: "cmp", encrypted_content: "compacted" },
    ]);
    expect(output).toEqual(original);
  });
});
