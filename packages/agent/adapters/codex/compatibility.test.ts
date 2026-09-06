import { describe, expect, test } from "bun:test";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import { openAIRequestCodec } from "../openai-responses/input";
import { openAIResponseCodec } from "../openai-responses/output";
import { createResponsesEventNormalizer } from "../openai-responses/events";
import type { OpenAIResponseRequest } from "../openai-responses/protocol";
import {
  createCodexWebSocketEventNormalizer,
  normalizeCodexWebSocketRequest,
  readCodexTurnState,
} from "./compatibility";

function event(value: object): ResponsesServerEvent {
  return value as ResponsesServerEvent;
}

function request(input: Partial<OpenAIResponseRequest> = {}): OpenAIResponseRequest {
  return { type: "response.create", model: "gpt-6-astra", input: [], ...input };
}

describe("Codex WebSocket request policy", () => {
  test("forces stateless requests, strips HTTP flags and unsupported options, and preserves cache metadata", () => {
    const original = request({
      store: true,
      previous_response_id: "resp_old",
      temperature: 0.5,
      prompt_cache_key: "cache-key",
      include: ["message.output_text.logprobs"],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "question", prompt_cache_breakpoint: { mode: "explicit" } },
          ],
        },
        {
          type: "reasoning",
          id: "rs_secret",
          summary: [],
          encrypted_content: "encrypted-reasoning",
        },
        { type: "compaction", id: "cmp_secret", encrypted_content: "encrypted-compaction" },
        {
          type: "message",
          id: "msg_secret",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "working", annotations: [], logprobs: [] }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "find",
          description: "Find",
          parameters: { type: "object" },
          strict: false,
        },
      ],
    });
    const snapshot = structuredClone(original);
    const result = normalizeCodexWebSocketRequest(original).unwrap();
    expect(result).toMatchObject({
      type: "response.create",
      model: "gpt-6-astra",
      store: false,
      parallel_tool_calls: true,
      prompt_cache_key: "cache-key",
    });
    expect(result.include).toEqual(["message.output_text.logprobs", "reasoning.encrypted_content"]);
    expect(result).not.toHaveProperty("stream");
    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("previous_response_id");
    expect<unknown>(result.input).toEqual(
      snapshot.input.map((item) =>
        Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id")),
      ),
    );
    expect(result.tools).toEqual(snapshot.tools);
    expect(original).toEqual(snapshot);
  });

  test("rejects persisted item references instead of enabling the wrong replay feature", () => {
    const result = normalizeCodexWebSocketRequest(
      request({ input: [{ type: "item_reference", id: "stored" }] }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ reason: "protocol", replaySafety: "safe" });
  });

  test("retains encrypted reasoning, phase and compaction through canonical transcript replay while dropping wire-only item IDs", async () => {
    const projected = openAIResponseCodec
      .project({
        id: "resp_final",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-reasoning" },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }],
          },
          { type: "compaction", id: "cmp_1", encrypted_content: "encrypted-compaction" },
        ],
      })
      .unwrap();
    const canonical = structuredClone(projected.messages);
    const encoded = (await openAIRequestCodec.messages(projected.messages)).unwrap();
    const normalized = normalizeCodexWebSocketRequest(request({ input: encoded })).unwrap();
    expect<unknown>(normalized.input).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "encrypted-reasoning" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      { type: "compaction", encrypted_content: "encrypted-compaction" },
    ]);
    expect(projected.messages).toEqual(canonical);
    expect(JSON.stringify(canonical)).toContain('"itemId":"rs_1"');
    expect(JSON.stringify(canonical)).toContain('"itemId":"cmp_1"');
  });
});

describe("Codex event compatibility", () => {
  test("recovers only missing summary deltas and resets state at completion", () => {
    const normalize = createCodexWebSocketEventNormalizer();
    expect(
      normalize(
        event({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: "hello",
        }),
      ),
    ).toMatchObject({ delta: "hello" });
    expect(
      normalize(
        event({
          type: "response.reasoning_summary_text.done",
          item_id: "rs_1",
          summary_index: 0,
          text: "hello world",
        }),
      ),
    ).toMatchObject({ type: "response.reasoning_summary_text.delta", delta: " world" });
    expect(
      normalize(
        event({
          type: "response.reasoning_summary_part.done",
          item_id: "rs_1",
          summary_index: 0,
          part: { type: "summary_text", text: "hello world" },
        }),
      ),
    ).toMatchObject({ delta: "" });
    expect(
      normalize(event({ type: "response.done", response: { id: "resp_final" } })),
    ).toMatchObject({ type: "response.completed" });
    expect(
      normalize(
        event({
          type: "response.reasoning_summary_text.done",
          item_id: "rs_1",
          summary_index: 0,
          text: "hello world",
        }),
      ),
    ).toMatchObject({ delta: "hello world" });
  });

  test("preserves compaction payload and generates stable IDs only when absent", () => {
    const normalize = createCodexWebSocketEventNormalizer();
    const original = event({
      type: "response.output_item.done",
      response_id: "resp_1",
      output_index: 1,
      item: { type: "compaction", encrypted_content: "opaque" },
    });
    const first = normalize(original);
    expect(first).toEqual(normalize(original));
    expect(first).toMatchObject({
      item: { encrypted_content: "opaque", id: expect.stringMatching(/^cmp_lilac_/) },
    });
    expect(original).not.toHaveProperty("item.id");
    const existing = event({
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "opaque", id: "cmp_existing" },
    });
    expect(normalize(existing)).toEqual(existing);
  });

  test("reads turn-state metadata case-insensitively without treating arbitrary metadata as a feature", () => {
    expect(
      readCodexTurnState(
        event({ type: "response.metadata", headers: { "X-Codex-Turn-State": ["opaque-state"] } }),
      ),
    ).toBe("opaque-state");
    expect(
      readCodexTurnState(
        event({ type: "response.metadata", headers: { "x-codex-turn-state": "" } }),
      ),
    ).toBeUndefined();
    expect(
      readCodexTurnState(
        event({ type: "response.created", headers: { "x-codex-turn-state": "wrong-event" } }),
      ),
    ).toBeUndefined();
    expect(
      readCodexTurnState(
        event({ type: "response.metadata", headers: { "x-codex-turn-state": 42 } }),
      ),
    ).toBeUndefined();
  });
});

test("Codex terminal error aliases preserve error details and response usage", () => {
  const normalize = createCodexWebSocketEventNormalizer();
  const normalized = normalize(
    event({
      type: "response.done",
      error: {
        code: "invalid_request",
        type: "invalid_request_error",
        message: "backend failed",
        param: "input",
      },
      response: {
        id: "resp_failed",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    }),
  );
  const terminal = createResponsesEventNormalizer()(normalized).unwrap();
  expect(terminal).toHaveLength(1);
  const decoded = openAIResponseCodec.decode(terminal[0]!).unwrap();
  expect(decoded).toMatchObject({
    type: "error",
    message: "backend failed",
    details: { code: "invalid_request", type: "invalid_request_error", param: "input" },
    response: {
      id: "resp_failed",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokenDetails: { reasoningTokens: 2 },
      },
    },
  });
});

test("combined Codex and shared normalization completes a bare response.done after streamed output", () => {
  const codex = createCodexWebSocketEventNormalizer();
  const shared = createResponsesEventNormalizer();
  const normalize = (value: object) => shared(codex(event(value))).unwrap();
  normalize({
    type: "response.created",
    response: { id: "resp_bare", status: "in_progress", output: [] },
  });
  normalize({
    type: "response.output_text.delta",
    item_id: "msg_bare",
    output_index: 0,
    content_index: 0,
    delta: "complete reply",
  });
  const terminal = normalize({ type: "response.done" });
  const decoded = terminal.map((value) => openAIResponseCodec.decode(value).unwrap());
  expect(decoded).toContainEqual({
    type: "finished",
    response: {
      id: "resp_bare",
      previousResponseId: undefined,
      status: "completed",
      incompleteReason: undefined,
      usage: undefined,
      output: [
        {
          type: "message",
          id: "msg_bare",
          role: "assistant",
          status: "in_progress",
          content: [{ type: "output_text", text: "complete reply", annotations: [] }],
        },
      ],
    },
  });
});

test("combined Codex and shared normalization retains a bare terminal error and known response usage", () => {
  const codex = createCodexWebSocketEventNormalizer();
  const shared = createResponsesEventNormalizer();
  const normalize = (value: object) => shared(codex(event(value))).unwrap();
  normalize({
    type: "response.created",
    response: {
      id: "resp_bare_error",
      status: "in_progress",
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  });
  const original = {
    type: "response.done",
    error: {
      code: "invalid_request",
      message: "backend failed",
      type: "invalid_request_error",
      param: "input",
    },
  };
  expect(codex(event(original))).toMatchObject({
    type: "response.completed",
    error: original.error,
  });
  const terminal = normalize(original);
  const decoded = terminal.map((value) => openAIResponseCodec.decode(value).unwrap());
  expect(decoded).toHaveLength(1);
  expect(decoded[0]).toMatchObject({
    type: "error",
    message: "backend failed",
    details: { code: "invalid_request", type: "invalid_request_error", param: "input" },
    response: {
      id: "resp_bare_error",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokenDetails: { reasoningTokens: 2 },
      },
    },
  });
});

test("turn-state extraction ignores unrelated header value shapes", () => {
  expect(
    readCodexTurnState({
      type: "response.metadata",
      headers: { "X-Codex-Turn-State": "opaque", unrelated: 123, detail: { enabled: false } },
    } as never),
  ).toBe("opaque");
  expect(
    readCodexTurnState({
      type: "response.metadata",
      headers: { "x-codex-turn-state": 123 },
    } as never),
  ).toBeUndefined();
});

test("turn-state arrays use the first string entry", () => {
  expect(
    readCodexTurnState({
      type: "response.metadata",
      headers: { "x-codex-turn-state": [null, "opaque"] },
    } as never),
  ).toBe("opaque");
});

test("combined Codex and shared normalization completes a partial terminal response using its created identity", () => {
  const codex = createCodexWebSocketEventNormalizer();
  const shared = createResponsesEventNormalizer();
  const normalize = (value: object) => shared(codex(event(value))).unwrap();
  normalize({
    type: "response.created",
    response: {
      id: "resp_partial",
      status: "in_progress",
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  });
  const terminal = normalize({
    type: "response.done",
    response: { status: "completed", output: [] },
  });
  expect(terminal).toHaveLength(1);
  const decoded = openAIResponseCodec.decode(terminal[0]!).unwrap();
  expect(decoded).toMatchObject({
    type: "finished",
    response: {
      id: "resp_partial",
      status: "completed",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokenDetails: { reasoningTokens: 2 },
      },
    },
  });
});
