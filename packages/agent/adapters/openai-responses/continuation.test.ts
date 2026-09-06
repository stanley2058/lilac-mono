import { describe, expect, test } from "bun:test";

import type { ResponseInputItem } from "openai/resources/responses/responses";
import { isPreviousResponseNotFoundError, OpenAIResponsesContinuation } from "./continuation";
import type { OpenAIResponseRequest } from "./protocol";

const user: ResponseInputItem = { role: "user", content: "hello" };
const assistant: ResponseInputItem = { type: "item_reference", id: "message-1" };
const followUp: ResponseInputItem = { role: "user", content: "continue" };

function request(input: ResponseInputItem[] = [user]): OpenAIResponseRequest {
  return { type: "response.create", model: "gpt-6-astra", store: true, input };
}

function completed(
  cache: OpenAIResponsesContinuation,
  options: {
    request?: OpenAIResponseRequest;
    replayInput?: ResponseInputItem[];
    needsClientFollowUp?: boolean;
    turnState?: string | null;
  } = {},
): void {
  cache.store({
    request: options.request ?? request(),
    replayInput: options.replayInput ?? [assistant],
    responseId: "response-1",
    needsClientFollowUp: options.needsClientFollowUp ?? false,
    turnState: options.turnState ?? null,
  });
}

describe("Responses continuation parity", () => {
  test("uses the response id only for a strict extension and consumes the cached entry", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache);
    const next = request([user, assistant, followUp]);
    expect(cache.prepare(next)).toEqual({
      payload: { ...next, previous_response_id: "response-1", input: [followUp] },
      optimizationEnabled: true,
      optimizationReason: "incremental_replay",
      turnState: null,
    });
    expect(cache.prepare(next).optimizationReason).toBe("no_continuation_state");
  });

  test.each([
    ["same input", [user, assistant]],
    ["shorter input", [user]],
    ["different branch", [user, { role: "assistant", content: "other" }, followUp]],
  ] satisfies [string, ResponseInputItem[]][])("rejects %s", (_name, input) => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
    const next = request(input);
    expect(cache.prepare(next)).toEqual({
      payload: next,
      optimizationEnabled: false,
      optimizationReason: "not_prefix_extension",
      turnState: null,
    });
  });

  test("settings comparison ignores key order and omitted undefined wire fields", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, {
      request: { ...request(), reasoning: { effort: "high", summary: "auto" } },
    });
    const next = {
      ...request([user, assistant, followUp]),
      reasoning: { summary: "auto", effort: "high" },
      temperature: undefined,
    } satisfies OpenAIResponseRequest;
    expect(cache.prepare(next).optimizationEnabled).toBe(true);
  });

  test("a changed provider feature prevents response-id reuse but preserves a pending turn", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
    const next = { ...request([user, assistant, followUp]), parallel_tool_calls: false };
    expect(cache.prepare(next)).toEqual({
      payload: next,
      optimizationEnabled: false,
      optimizationReason: "request_shape_changed",
      turnState: "turn-1",
    });
  });

  test.each([{ previous_response_id: "explicit-response" }, { conversation: "conversation-1" }])(
    "leaves explicit server conversation ownership intact: %j",
    (ownership) => {
      const cache = new OpenAIResponsesContinuation();
      completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
      const next = { ...request([user, assistant, followUp]), ...ownership };
      const result = cache.prepare(next);
      expect(result.payload).toEqual(next);
      expect(result.optimizationEnabled).toBe(false);
      expect(result.turnState).toBeNull();
    },
  );

  test("response ids remain valid at 30 minutes and expire immediately after", () => {
    let now = 0;
    const cache = new OpenAIResponsesContinuation(() => now);
    completed(cache);
    now = 30 * 60 * 1000;
    expect(cache.prepare(request([user, assistant, followUp])).optimizationEnabled).toBe(true);
    now = 0;
    completed(cache);
    now = 30 * 60 * 1000 + 1;
    expect(cache.prepare(request([user, assistant, followUp])).optimizationReason).toBe(
      "no_continuation_state",
    );
  });

  test("expired response ids retain Codex turn state for a client tool continuation", () => {
    let now = 0;
    const cache = new OpenAIResponsesContinuation(() => now);
    completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
    now = 30 * 60 * 1000 + 1;
    const next = request([user, assistant, followUp]);
    const result = cache.prepare(next);
    expect(result.payload).toEqual(next);
    expect(result.optimizationEnabled).toBe(false);
    expect(result.turnState).toBe("turn-1");
  });

  test("socket replacement invalidates response ids while retaining tool turn state", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
    cache.invalidateResponseIds();
    const result = cache.prepare(request([user, assistant, followUp]));
    expect(result.optimizationEnabled).toBe(false);
    expect(result.turnState).toBe("turn-1");
    expect(result.payload.previous_response_id).toBeUndefined();
  });

  test("a completed answer does not carry turn state into the next user turn", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, { turnState: "turn-1" });
    const result = cache.prepare(request([user, assistant, followUp]));
    expect(result.optimizationEnabled).toBe(true);
    expect(result.turnState).toBeNull();
  });

  test("failed requests retain turn state only for an exact-input retry, even after expiry", () => {
    let now = 0;
    const cache = new OpenAIResponsesContinuation(() => now);
    cache.retainTurnStateRetry(request(), "turn-1");
    now = 60 * 60 * 1000;
    const result = cache.prepare(request());
    expect(result.turnState).toBe("turn-1");
    expect(result.optimizationEnabled).toBe(false);
    cache.retainTurnStateRetry(request(), "turn-1");
    expect(cache.prepare(request([user, followUp])).turnState).toBeNull();
  });

  test("provider metadata participates in prefix matching and survives suffix conversion", () => {
    const cache = new OpenAIResponsesContinuation();
    const encrypted: ResponseInputItem = {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted-private-reasoning",
      summary: [],
    };
    const message: ResponseInputItem = {
      type: "message",
      id: "message-1",
      status: "completed",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "working", annotations: [] }],
    };
    const toolResult: ResponseInputItem = {
      type: "function_call_output",
      call_id: "call-1",
      output: [{ type: "input_text", text: "done", prompt_cache_breakpoint: { mode: "explicit" } }],
    };
    completed(cache, { replayInput: [encrypted, message] });
    const next = request([user, encrypted, message, toolResult]);
    const result = cache.prepare(next);
    expect(result.payload.input).toEqual([toolResult]);
    expect(result.payload.input[0]).not.toBe(toolResult);
    completed(cache, { replayInput: [encrypted, message] });
    expect(
      cache.prepare(request([user, { ...encrypted, encrypted_content: null }, message, toolResult]))
        .optimizationEnabled,
    ).toBe(false);
    completed(cache, { replayInput: [encrypted, message] });
    expect(
      cache.prepare(request([user, encrypted, { ...message, phase: "final_answer" }, toolResult]))
        .optimizationEnabled,
    ).toBe(false);
  });

  test("snapshots stored and returned inputs without mutating requests", () => {
    const cache = new OpenAIResponsesContinuation();
    const initial = request([{ role: "user", content: "initial" }]);
    completed(cache, { request: initial });
    initial.input.length = 0;
    const next = request([{ role: "user", content: "initial" }, assistant, followUp]);
    const before = structuredClone(next);
    const result = cache.prepare(next);
    expect(result.optimizationEnabled).toBe(true);
    result.payload.input.length = 0;
    expect(next).toEqual(before);
  });

  test("clearing state removes both continuation and turn state", () => {
    const cache = new OpenAIResponsesContinuation();
    completed(cache, { needsClientFollowUp: true, turnState: "turn-1" });
    cache.clear();
    const result = cache.prepare(request([user, assistant, followUp]));
    expect(result.optimizationReason).toBe("no_continuation_state");
    expect(result.turnState).toBeNull();
  });
});

describe("previous response rejection detection", () => {
  test.each([
    { message: "bad id", details: { code: "previous_response_not_found" } },
    { message: "invalid parameter", details: { param: "previous_response_id" } },
    { message: "Previous response abc was not found" },
  ])("accepts the legacy bridge's explicit rejection shapes: %j", (event) => {
    expect(isPreviousResponseNotFoundError({ type: "error", ...event })).toBe(true);
  });

  test.each([
    { message: "connection lost" },
    { message: "model not found", details: { param: "model", code: "model_not_found" } },
    { message: "previous response could not be continued", details: { code: "server_error" } },
  ])("does not treat an uncertain failure as a stale-id rejection: %j", (event) => {
    expect(isPreviousResponseNotFoundError({ type: "error", ...event })).toBe(false);
  });
});
