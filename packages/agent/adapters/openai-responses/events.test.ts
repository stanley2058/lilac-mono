import { describe, expect, test } from "bun:test";
import type {
  ResponseOutputItem,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import { createResponsesEventNormalizer } from "./events";
import { openAIResponseCodec } from "./output";

function event(value: object): ResponsesServerEvent {
  return value as ResponsesServerEvent;
}

function created(id = "response-1"): ResponsesServerEvent {
  return event({ type: "response.created", response: { id, status: "in_progress", output: [] } });
}

describe("Responses event reconstruction", () => {
  test("handles terminal errors before response creation while preserving structured details", () => {
    for (const value of [
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "model_not_found", message: "model not found" },
        },
      },
      { type: "response.failed", error: { code: "model_not_found", message: "model not found" } },
    ]) {
      const normalized = createResponsesEventNormalizer()(event(value)).unwrap();
      expect(normalized).toHaveLength(1);
      expect(normalized[0]?.type).toBe("error");
      expect(openAIResponseCodec.decode(normalized[0]!).unwrap()).toMatchObject({
        type: "error",
        message: "model not found",
        details: { code: "model_not_found" },
      });
    }
    const sparse = createResponsesEventNormalizer()(
      event({
        type: "response.failed",
        response: { status: "failed", error: { code: "previous_response_not_found" } },
      }),
    ).unwrap();
    expect(openAIResponseCodec.decode(sparse[0]!).unwrap()).toMatchObject({
      type: "error",
      message: "Responses request failed (status=failed)",
      details: { code: "previous_response_not_found" },
    });
  });

  test("top-level terminal errors suppress successful checkpoints and retain known response usage", () => {
    for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
      const normalize = createResponsesEventNormalizer();
      normalize(created()).unwrap();
      normalize(
        event({
          type: "response.output_text.delta",
          item_id: "msg",
          output_index: 0,
          content_index: 0,
          delta: "Partial",
        }),
      ).unwrap();
      const normalized = normalize(
        event({
          type,
          error: { code: "invalid_prompt", message: "Rejected", param: "input" },
          response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
        }),
      ).unwrap();
      expect(normalized).toHaveLength(1);
      expect(normalized[0]?.type).toBe("response.failed");
      expect(openAIResponseCodec.decode(normalized[0]!).unwrap()).toMatchObject({
        type: "error",
        message: "Rejected",
        details: { code: "invalid_prompt", param: "input" },
        response: { id: "response-1", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      });
    }
  });

  test("keeps parent and steering successor items separate when their events overlap", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created("parent")).unwrap();
    normalize(
      event({
        type: "response.output_text.delta",
        item_id: "parent-msg",
        output_index: 0,
        content_index: 0,
        delta: "Before",
      }),
    ).unwrap();
    normalize(created("successor")).unwrap();
    normalize(
      event({
        type: "response.output_text.delta",
        item_id: "successor-msg",
        output_index: 0,
        content_index: 0,
        delta: "After",
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_text.done",
        item_id: "parent-msg",
        output_index: 0,
        content_index: 0,
        text: "Before steering",
      }),
    ).unwrap();
    expect(
      normalize(
        event({
          type: "response.completed",
          response: { id: "parent", status: "completed", output: [] },
        }),
      )
        .unwrap()
        .at(-1),
    ).toMatchObject({
      response: { output: [{ id: "parent-msg", content: [{ text: "Before steering" }] }] },
    });
    expect(
      normalize(
        event({
          type: "response.completed",
          response: { id: "successor", status: "completed", output: [] },
        }),
      )
        .unwrap()
        .at(-1),
    ).toMatchObject({
      response: { output: [{ id: "successor-msg", content: [{ text: "After" }] }] },
    });
  });

  test("retains streamed annotations when a completed item has an empty annotations array", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created()).unwrap();
    normalize(
      event({
        type: "response.content_part.done",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "Cited",
          annotations: [{ type: "file_citation", file_id: "file", filename: "ref", index: 0 }],
        },
      }),
    ).unwrap();
    const normalized = normalize(
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Cited", annotations: [] }],
        },
      }),
    ).unwrap();
    expect(normalized).toMatchObject([
      { item: { content: [{ annotations: [{ file_id: "file", filename: "ref" }] }] } },
    ]);
  });

  test("repairs skeletal items and terminal output without losing provider metadata", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created()).unwrap();
    const added = event({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg",
        role: "assistant",
        status: "in_progress",
        phase: "commentary",
        content: [],
      },
    });
    const original = structuredClone(added);
    normalize(added).unwrap();
    normalize(
      event({
        type: "response.output_text.delta",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        delta: "Checking",
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.content_part.done",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "Checking",
          annotations: [{ type: "file_citation", file_id: "file", filename: "ref.txt", index: 0 }],
        },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg", role: "assistant", status: "completed" },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "rs", encrypted_content: "partial", summary: [] },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs",
        output_index: 1,
        summary_index: 0,
        delta: "Reason",
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.reasoning_summary_part.done",
        item_id: "rs",
        output_index: 1,
        summary_index: 0,
        part: { type: "summary_text", text: "Reasoning" },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "reasoning", id: "rs", encrypted_content: "sealed", summary: [] },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc",
          call_id: "call",
          name: "lookup",
          namespace: "tools",
          caller: { type: "direct" },
        },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.function_call_arguments.delta",
        item_id: "fc",
        output_index: 2,
        delta: '{"q":',
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.function_call_arguments.delta",
        item_id: "fc",
        output_index: 2,
        delta: '"test"}',
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "function_call", id: "fc", status: "completed" },
      }),
    ).unwrap();
    const normalized = normalize(
      event({
        type: "response.completed",
        response: { id: "response-1", status: "completed", output: [] },
        sequence_number: 10,
      }),
    ).unwrap();
    expect(normalized).toHaveLength(1);
    const terminal = normalized[0]!;
    expect(terminal).toMatchObject({
      response: {
        output: [
          {
            id: "msg",
            phase: "commentary",
            content: [{ text: "Checking", annotations: [{ file_id: "file" }] }],
          },
          { id: "rs", encrypted_content: "sealed", summary: [{ text: "Reasoning" }] },
          {
            id: "fc",
            call_id: "call",
            name: "lookup",
            arguments: '{"q":"test"}',
            namespace: "tools",
            caller: { type: "direct" },
          },
        ],
      },
    });
    const projected = openAIResponseCodec.decode(terminal).unwrap();
    expect(projected.type).toBe("finished");
    if (projected.type !== "finished") return;
    expect(openAIResponseCodec.project(projected.response).unwrap().assistant.content).toEqual([
      {
        type: "text",
        text: "Checking",
        providerOptions: { openai: { itemId: "msg", phase: "commentary" } },
      },
      {
        type: "reasoning",
        text: "Reasoning",
        providerOptions: { openai: { itemId: "rs", reasoningEncryptedContent: "sealed" } },
      },
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "lookup",
        input: { q: "test" },
        providerOptions: { openai: { itemId: "fc" } },
      },
    ]);
    expect(added).toEqual(original);
  });

  test("emits completed items before terminal-only output and preserves compaction and empty reasoning", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created()).unwrap();
    const items: ResponseOutputItem[] = [
      { type: "reasoning", id: "empty", summary: [], encrypted_content: "opaque" },
      { type: "compaction", id: "cmp", encrypted_content: "compact" },
      {
        type: "message",
        id: "final",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      },
    ];
    const normalized = normalize(
      event({
        type: "response.completed",
        response: { id: "response-1", status: "completed", output: items },
        sequence_number: 2,
      }),
    ).unwrap();
    expect(normalized.map((entry) => entry.type)).toEqual([
      "response.output_item.done",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(normalized.slice(0, 3).map((entry) => ("item" in entry ? entry.item : null))).toEqual(
      items,
    );
    const projected = openAIResponseCodec.decode(normalized[3]!).unwrap();
    if (projected.type !== "finished") throw new Error("Expected completion");
    expect(
      openAIResponseCodec.project(projected.response).unwrap().assistant.content,
    ).toMatchObject([
      {
        type: "reasoning",
        text: "",
        providerOptions: { openai: { itemId: "empty", reasoningEncryptedContent: "opaque" } },
      },
      {
        type: "custom",
        kind: "openai.compaction",
        providerOptions: {
          openai: { type: "compaction", itemId: "cmp", encryptedContent: "compact" },
        },
      },
      { providerOptions: { openai: { itemId: "final", phase: "final_answer" } } },
    ]);
  });

  test("keeps explicit null reasoning encryption and absent message phase", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created()).unwrap();
    normalize(
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs", encrypted_content: "partial", summary: [] },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs", encrypted_content: null, summary: [] },
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_text.delta",
        output_index: 1,
        item_id: "msg",
        content_index: 0,
        delta: "Text",
      }),
    ).unwrap();
    const terminal = normalize(
      event({ type: "response.completed", response: { id: "response-1", status: "completed" } }),
    )
      .unwrap()
      .at(-1)!;
    expect(terminal).toMatchObject({
      response: { output: [{ encrypted_content: null }, { content: [{ text: "Text" }] }] },
    });
    if (!("response" in terminal)) throw new Error("Expected response");
    expect(terminal.response.output[1]).not.toHaveProperty("phase");
  });

  test("uses completed text and arguments without duplicating streamed content", () => {
    const normalize = createResponsesEventNormalizer();
    normalize(created()).unwrap();
    normalize(
      event({
        type: "response.output_text.delta",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.output_text.done",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        text: "Hello world",
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.function_call_arguments.delta",
        item_id: "fc",
        output_index: 1,
        delta: '{"a":',
      }),
    ).unwrap();
    normalize(
      event({
        type: "response.function_call_arguments.done",
        item_id: "fc",
        output_index: 1,
        arguments: '{"a":1}',
      }),
    ).unwrap();
    const terminal = normalize(
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          output: [{ type: "function_call", id: "fc", name: "lookup", call_id: "call" }],
        },
      }),
    )
      .unwrap()
      .at(-1)!;
    expect(terminal).toMatchObject({
      response: { output: [{ content: [{ text: "Hello world" }] }, { arguments: '{"a":1}' }] },
    });
  });

  test("normalizes failed terminal status without emitting successful item checkpoints", () => {
    for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
      const normalize = createResponsesEventNormalizer();
      normalize(created()).unwrap();
      normalize(
        event({
          type: "response.output_text.delta",
          item_id: "msg",
          output_index: 0,
          content_index: 0,
          delta: "Partial",
        }),
      ).unwrap();
      const normalized = normalize(
        event({
          type,
          response: {
            id: "response-1",
            status: "failed",
            error: {
              code: "rate_limit_exceeded",
              message: "Slow down",
              type: "rate_limit_error",
              param: "model",
            },
          },
        }),
      ).unwrap();
      expect(normalized).toHaveLength(1);
      expect(openAIResponseCodec.decode(normalized[0]!).unwrap()).toMatchObject({
        type: "error",
        message: "Slow down",
        details: { code: "rate_limit_exceeded", type: "rate_limit_error", param: "model" },
      });
    }
  });

  test.each([undefined, { status: "completed", output: [] }])(
    "repairs terminal response identity from created and clears drafts between requests (%j)",
    (response) => {
      const normalize = createResponsesEventNormalizer();
      normalize(created()).unwrap();
      normalize(
        event({
          type: "response.output_text.delta",
          item_id: "msg",
          output_index: 0,
          content_index: 0,
          delta: "First",
        }),
      ).unwrap();
      expect(
        normalize(event({ type: "response.completed", response }))
          .unwrap()
          .at(-1),
      ).toMatchObject({ response: { id: "response-1", output: [{ id: "msg" }] } });
      normalize(created("response-2")).unwrap();
      expect(normalize(event({ type: "response.completed", response })).unwrap()).toMatchObject([
        { response: { id: "response-2", output: [] } },
      ]);
      expect(
        createResponsesEventNormalizer()(event({ type: "response.completed", response })).isErr(),
      ).toBe(true);
    },
  );
});
