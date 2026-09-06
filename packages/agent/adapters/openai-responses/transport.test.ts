import { describe, expect, test } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";
import type {
  ResponseOutputItem,
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import type { OpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import { AgentAdapterFailure } from "../../agent-adapter";
import { createOpenAIResponsesConnectionPool } from "./connection";
import { openAIRequestCodec } from "./input";
import { openAIResponseCodec } from "./output";
import type { OpenAIResponseRequest } from "./protocol";
import type { OpenAIResponsesSocket } from "./socket";
import {
  createResponsesDiagnostics,
  type ResponsesDiagnosticFields,
  type ResponsesDiagnostics,
} from "./diagnostics";
import { createResponsesTransport } from "./transport";
import {
  createCodexWebSocketEventNormalizer,
  normalizeCodexWebSocketRequest,
  readCodexTurnState,
} from "../codex/compatibility";

const settings: OpenAIResponsesConnectionOptions = {
  baseUrl: "https://example.com/v1",
  requestUrl: new URL("https://example.com/v1/responses"),
  websocketUrl: "wss://example.com/v1/responses",
  headers: { Authorization: "Bearer test" },
  mode: "websocket",
};
const user = { role: "user" as const, content: "hello" };
const followUp = { role: "user" as const, content: "continue" };
const request = (): OpenAIResponseRequest => ({
  type: "response.create",
  model: "gpt-6-astra",
  store: true,
  input: [user],
});
const message: ResponseOutputItem = {
  type: "message",
  id: "message-1",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text: "Hello", annotations: [] }],
};
const toolCall: ResponseOutputItem = {
  type: "function_call",
  id: "function-1",
  call_id: "call-1",
  name: "lookup",
  arguments: "{}",
  status: "completed",
};

function event(value: object): ResponsesServerEvent {
  return value as ResponsesServerEvent;
}
function created(id: string) {
  return event({ type: "response.created", response: { id, status: "in_progress", output: [] } });
}
function completed(id: string, output: ResponseOutputItem[] = [message]) {
  return event({ type: "response.completed", response: { id, status: "completed", output } });
}
const stale = () =>
  event({
    type: "error",
    error: {
      code: "previous_response_not_found",
      message: "Previous response was not found",
      param: "previous_response_id",
    },
  });
const delta = () =>
  event({
    type: "response.output_text.delta",
    item_id: "message-2",
    output_index: 0,
    content_index: 0,
    delta: "visible",
    sequence_number: 1,
    logprobs: [],
  });
const metadata = () =>
  event({ type: "response.metadata", headers: { "x-codex-turn-state": "turn-1" } });

type Frame = ResultType<ResponsesServerEvent, AgentAdapterFailure>;
function rawSocket() {
  const frames: Frame[] = [];
  const reads: Array<(value: IteratorResult<Frame>) => void> = [];
  const sent: ResponsesClientEvent[] = [];
  let open = true;
  const socket: OpenAIResponsesSocket = {
    isOpen: () => open,
    send(value) {
      sent.push(structuredClone(value));
      return Result.ok(undefined);
    },
    events: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const value = frames.shift();
            if (value) return Promise.resolve({ done: false as const, value });
            if (!open) return Promise.resolve({ done: true as const, value: undefined });
            return new Promise<IteratorResult<Frame>>((resolve) => reads.push(resolve));
          },
        };
      },
    },
    close() {
      open = false;
      for (const resolve of reads.splice(0)) resolve({ done: true, value: undefined });
    },
  };
  function emit(frame: Frame) {
    const resolve = reads.shift();
    if (resolve) resolve({ done: false, value: frame });
    else frames.push(frame);
  }
  return {
    socket,
    sent,
    emit: (value: ResponsesServerEvent) => emit(Result.ok(value)),
    fail: () =>
      emit(
        Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            replaySafety: "reconcile",
            message: "socket lost",
          }),
        ),
      ),
  };
}

function harness(codex = false, options: Parameters<typeof createResponsesTransport>[0] = {}) {
  const sockets: ReturnType<typeof rawSocket>[] = [];
  const pool = createOpenAIResponsesConnectionPool({
    connect: () => async () => {
      const socket = rawSocket();
      sockets.push(socket);
      return Result.ok(socket.socket);
    },
    scheduleIdleClose: () => () => {},
  });
  const transport = createResponsesTransport({
    ...options,
    pool,
    ...(codex
      ? { normalizeRequest: normalizeCodexWebSocketRequest, readTurnState: readCodexTurnState }
      : {}),
  });
  return {
    sockets,
    transport,
    connect: async (signal = new AbortController().signal, diagnostics?: ResponsesDiagnostics) =>
      (await transport.connect(settings, signal, diagnostics)).unwrap(),
  };
}

async function untilTerminal(socket: OpenAIResponsesSocket) {
  const events: ResponsesServerEvent[] = [];
  for await (const frame of socket.events) {
    if (frame.isErr()) return { events, error: frame.error };
    events.push(frame.value);
    if (
      ["response.completed", "response.incomplete", "response.failed", "error"].includes(
        frame.value.type,
      )
    )
      return { events, error: undefined };
  }
  return { events, error: undefined };
}

async function prefix(output: ResponseOutputItem[], store = true) {
  const projected = openAIResponseCodec
    .project({ id: "response-1", status: "completed", output })
    .unwrap();
  return (await openAIRequestCodec.messages(projected.messages, { store })).unwrap();
}

async function warm(
  h: ReturnType<typeof harness>,
  original = request(),
  output: ResponseOutputItem[] = [message],
) {
  const socket = await h.connect();
  socket.send(original).unwrap();
  h.sockets[0]!.emit(completed("response-1", output));
  await untilTerminal(socket);
  socket.close();
  return {
    ...original,
    input: [...original.input, ...(await prefix(output, original.store !== false)), followUp],
  };
}

describe("Responses transport behavior parity", () => {
  test("reuses one socket and a canonical transcript prefix across executions", async () => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.sent[1]).toEqual({
      ...next,
      previous_response_id: "response-1",
      input: [followUp],
    });
    h.sockets[0]!.emit(completed("response-2"));
    await untilTerminal(socket);
    socket.close();
    h.transport.close();
  });

  test("retries stale response ids once before output and discards buffered created events", async () => {
    const h = harness();
    const next = await warm(h);
    const logs: Array<{ event: string; fields: ResponsesDiagnosticFields; level: string }> = [];
    const diagnostics = createResponsesDiagnostics(
      {
        provider: "openai",
        model: "gpt-6-astra",
        requestId: "request-test",
        sessionId: "session-test",
      },
      (level, event, fields) => logs.push({ level, event, fields }),
    ).withContext({ attemptId: "attempt-test" });
    const socket = await h.connect(undefined, diagnostics);
    socket.send(next).unwrap();
    h.sockets[0]!.emit(created("rejected"));
    h.sockets[0]!.emit(stale());
    h.sockets[0]!.emit(created("accepted"));
    h.sockets[0]!.emit(completed("accepted"));
    const result = await untilTerminal(socket);
    expect(h.sockets[0]!.sent).toHaveLength(3);
    expect(h.sockets[0]!.sent[2]).toEqual(next);
    expect(logs.find((log) => log.event === "response.continuation")).toMatchObject({
      fields: {
        requestId: "request-test",
        sessionId: "session-test",
        attemptId: "attempt-test",
        connectionId: expect.any(Number),
        optimizationEnabled: true,
        optimizationReason: "incremental_replay",
        inputItemsBefore: next.input.length,
        inputItemsAfter: 1,
        previousResponseId: "response-1",
        turnStatePresent: false,
      },
    });
    expect(logs.filter((log) => log.event === "response.retry_full_input")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          requestId: "request-test",
          attemptId: "attempt-test",
          connectionId: expect.any(Number),
          reason: "previous_response_not_found",
          previousResponseId: "response-1",
          inputItems: next.input.length,
        }),
      }),
    ]);
    expect(logs.find((log) => log.event === "response.finished")?.fields.responseId).toBe(
      "accepted",
    );
    expect(JSON.stringify(logs)).not.toContain("Hello");
    expect(
      result.events
        .filter((value) => value.type === "response.created")
        .map((value) => value.response.id),
    ).toEqual(["accepted"]);
    socket.close();
    h.transport.close();
  });

  test("logs Codex normalization and repair without exposing turn state or response content", async () => {
    const h = harness(true, { createEventNormalizer: createCodexWebSocketEventNormalizer });
    const logs: Array<{ event: string; fields: ResponsesDiagnosticFields }> = [];
    const diagnostics = createResponsesDiagnostics(
      { provider: "codex", model: "gpt-6-astra", requestId: "request-test" },
      (_level, event, fields) => logs.push({ event, fields }),
    );
    const socket = await h.connect(undefined, diagnostics);
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.emit(created("codex-response"));
    h.sockets[0]!.emit(
      event({ type: "response.done", response: { status: "completed", output: [message] } }),
    );
    const result = await untilTerminal(socket);
    expect(result.error).toBeUndefined();
    expect(logs.find((log) => log.event === "response.request_normalized")).toMatchObject({
      fields: { provider: "codex", inputItemsBefore: 1, inputItemsAfter: 1, store: false },
    });
    expect(
      logs.find(
        (log) =>
          log.event === "response.event_normalized" &&
          log.fields.incomingEventType === "response.done",
      ),
    ).toBeDefined();
    expect(logs.find((log) => log.event === "response.finished")).toMatchObject({
      fields: { responseId: "codex-response", status: "completed", turnStatePresent: true },
    });
    expect(JSON.stringify(logs)).not.toContain("turn-1");
    expect(JSON.stringify(logs)).not.toContain("Hello");
    socket.close();
    h.transport.close();
  });

  test("a second stale-id rejection is exposed without another retry", async () => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    h.sockets[0]!.emit(stale());
    h.sockets[0]!.emit(stale());
    const result = await untilTerminal(socket);
    expect(result.events.at(-1)?.type).toBe("error");
    expect(h.sockets[0]!.sent).toHaveLength(3);
    socket.close();
    h.transport.close();
  });

  test.each([
    { type: "error", error: { code: "previous_response_not_found" } },
    { type: "error", code: "previous_response_not_found" },
    { type: "error", error: {}, param: "previous_response_id" },
  ])("retries sparse stale-id errors exactly once without crashing: %j", async (failure) => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    h.sockets[0]!.emit(created("rejected"));
    h.sockets[0]!.emit(event(failure));
    h.sockets[0]!.emit(event(failure));
    const result = await untilTerminal(socket);
    expect(result.error).toBeUndefined();
    expect(result.events.map((value) => value.type)).toEqual(["error"]);
    expect(h.sockets[0]!.sent).toHaveLength(3);
    expect(h.sockets[0]!.sent[2]).toEqual(next);
    socket.close();
    h.transport.close();
  });

  test("identity-less failed responses retain stale-id rejection details and retry once", async () => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    const failure = event({
      type: "response.failed",
      error: { code: "previous_response_not_found" },
    });
    h.sockets[0]!.emit(failure);
    h.sockets[0]!.emit(failure);
    const result = await untilTerminal(socket);
    expect(result.error).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(openAIResponseCodec.decode(result.events[0]!).unwrap()).toMatchObject({
      type: "error",
      details: { code: "previous_response_not_found" },
    });
    expect(h.sockets[0]!.sent).toHaveLength(3);
    expect(h.sockets[0]!.sent[2]).toEqual(next);
    socket.close();
    h.transport.close();
  });

  test("does not retry after visible output", async () => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    h.sockets[0]!.emit(created("accepted"));
    h.sockets[0]!.emit(delta());
    h.sockets[0]!.emit(stale());
    const result = await untilTerminal(socket);
    expect(result.events.map((value) => value.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "error",
    ]);
    expect(h.sockets[0]!.sent).toHaveLength(2);
    socket.close();
    h.transport.close();
  });

  test("does not retry an explicit previous response id", async () => {
    const h = harness();
    const socket = await h.connect();
    const explicit = { ...request(), previous_response_id: "owned-by-caller" };
    socket.send(explicit).unwrap();
    h.sockets[0]!.emit(stale());
    expect((await untilTerminal(socket)).events.at(-1)?.type).toBe("error");
    expect(h.sockets[0]!.sent).toEqual([explicit]);
    socket.close();
    h.transport.close();
  });

  test("changed provider features send full history even on a reused socket", async () => {
    const h = harness();
    const next = {
      ...(await warm(h)),
      parallel_tool_calls: false,
      prompt_cache_key: "new-cache-key",
    };
    const socket = await h.connect();
    socket.send(next).unwrap();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.sent[1]).toEqual(next);
    socket.close();
    h.transport.close();
  });

  test("terminal errors clear cached response ownership and retire the failed socket", async () => {
    const h = harness();
    const next = await warm(h);
    const socket = await h.connect();
    socket.send(next).unwrap();
    h.sockets[0]!.emit(
      event({ type: "error", error: { code: "server_error", message: "failed" } }),
    );
    await untilTerminal(socket);
    socket.close();
    const retry = await h.connect();
    retry.send(next).unwrap();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.sent[0]).toEqual(next);
    retry.close();
    h.transport.close();
  });

  test("top-level terminal errors override completed status and never cache the response", async () => {
    const h = harness();
    const socket = await h.connect();
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(
      event({
        type: "response.completed",
        error: { code: "server_error", message: "completion failed" },
        response: { id: "failed-response", status: "completed", output: [message] },
      }),
    );
    const result = await untilTerminal(socket);
    expect(result.error).toBeUndefined();
    expect(result.events).toHaveLength(1);
    const terminal = result.events[0];
    expect(terminal).toBeDefined();
    expect(openAIResponseCodec.decode(terminal!).unwrap()).toMatchObject({
      type: "error",
      message: "completion failed",
    });
    socket.close();
    const nextRequest = { ...request(), input: [user, ...(await prefix([message])), followUp] };
    const next = await h.connect();
    next.send(nextRequest).unwrap();
    expect(h.sockets.at(-1)!.sent.at(-1)).toEqual(nextRequest);
    next.close();
    h.transport.close();
  });

  test("canonical metadata remains in the full-input retry and streamed terminal response", async () => {
    const h = harness();
    const output: ResponseOutputItem[] = [
      { type: "reasoning", id: "reasoning-1", encrypted_content: "encrypted", summary: [] },
      { ...message, phase: "commentary" },
      toolCall,
    ];
    const original = {
      ...request(),
      store: false,
      prompt_cache_key: "cache-key",
      reasoning: { effort: "high" as const },
    };
    const next = await warm(h, original, output);
    next.input[next.input.length - 1] = {
      type: "function_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "tool result", prompt_cache_breakpoint: { mode: "explicit" } },
      ],
    };
    const before = structuredClone(next);
    const socket = await h.connect();
    socket.send(next).unwrap();
    h.sockets[0]!.emit(stale());
    h.sockets[0]!.emit(completed("response-2", output));
    const result = await untilTerminal(socket);
    expect(h.sockets[0]!.sent[1]).toMatchObject({
      previous_response_id: "response-1",
      input: [next.input.at(-1)],
    });
    expect(h.sockets[0]!.sent[2]).toEqual(before);
    expect(next).toEqual(before);
    expect(next.input).toContainEqual({
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted",
      summary: [],
    });
    expect(next.input).toContainEqual({ ...message, phase: "commentary" });
    const terminal = result.events.at(-1);
    expect(terminal?.type).toBe("response.completed");
    if (terminal?.type === "response.completed") expect(terminal.response.output).toEqual(output);
    socket.close();
    h.transport.close();
  });

  test("Codex tool continuation preserves request metadata and replay feature metadata", async () => {
    const h = harness(true);
    const output: ResponseOutputItem[] = [
      { type: "reasoning", id: "reasoning-1", encrypted_content: "encrypted", summary: [] },
      { ...message, phase: "commentary" },
      toolCall,
    ];
    const original = { ...request(), client_metadata: { trace: "trace-1" } };
    const socket = await h.connect();
    socket.send(original).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.emit(completed("response-1", output));
    await untilTerminal(socket);
    socket.close();
    const resultItem = {
      type: "function_call_output" as const,
      call_id: "call-1",
      output: [
        {
          type: "input_text" as const,
          text: "tool result",
          prompt_cache_breakpoint: { mode: "explicit" as const },
        },
      ],
    };
    const next = {
      ...original,
      input: [...original.input, ...(await prefix(output, false)), resultItem],
    };
    const resumed = await h.connect();
    resumed.send(next).unwrap();
    expect(h.sockets[0]!.sent[1]).toMatchObject({
      previous_response_id: "response-1",
      store: false,
      input: [resultItem],
      client_metadata: { trace: "trace-1", "x-codex-turn-state": "turn-1" },
    });
    h.sockets[0]!.emit(stale());
    h.sockets[0]!.emit(completed("response-2"));
    await untilTerminal(resumed);
    const replayed = h.sockets[0]!.sent[2];
    expect(replayed).toMatchObject({
      client_metadata: { trace: "trace-1", "x-codex-turn-state": "turn-1" },
    });
    if (replayed?.type === "response.create" && Array.isArray(replayed.input)) {
      expect(replayed.input.find((item) => item.type === "reasoning")).not.toHaveProperty("id");
      expect(replayed.input.find((item) => item.type === "message")).not.toHaveProperty("id");
      expect(replayed.input.find((item) => item.type === "reasoning")).toMatchObject({
        type: "reasoning",
        encrypted_content: "encrypted",
        summary: [],
      });
      expect(replayed.input.find((item) => item.type === "message")).toMatchObject({
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "commentary",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      });
    }
    resumed.close();
    h.transport.close();
  });

  test("Codex replays a pending tool turn after socket replacement without a stale response id", async () => {
    const h = harness(true);
    const socket = await h.connect();
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.emit(completed("response-1", [toolCall]));
    await untilTerminal(socket);
    socket.close();
    h.sockets[0]!.socket.close();
    const nextRequest = {
      ...request(),
      input: [
        user,
        ...(await prefix([toolCall], false)),
        { type: "function_call_output" as const, call_id: "call-1", output: "done" },
      ],
    };
    const resumed = await h.connect();
    resumed.send(nextRequest).unwrap();
    expect(h.sockets).toHaveLength(2);
    const sent = h.sockets[1]!.sent[0];
    expect(sent).not.toHaveProperty("previous_response_id");
    expect(sent).toMatchObject({
      input: [
        user,
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "done" },
      ],
      client_metadata: { "x-codex-turn-state": "turn-1" },
    });
    resumed.close();
    h.transport.close();
  });

  test("Codex retains turn state for an exact failed request retry after reconnect", async () => {
    const h = harness(true);
    const original = request();
    const socket = await h.connect();
    socket.send(original).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.fail();
    expect((await untilTerminal(socket)).error?.message).toBe("socket lost");
    socket.close();
    const retry = await h.connect();
    retry.send(original).unwrap();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.sent[0]).toMatchObject({
      store: false,
      client_metadata: { "x-codex-turn-state": "turn-1" },
    });
    expect(h.sockets[1]!.sent[0]).not.toHaveProperty("previous_response_id");
    retry.close();
    h.transport.close();
  });

  test("Codex preserves exact retry turn state when a socket ends without an error frame", async () => {
    const h = harness(true);
    const socket = await h.connect();
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.socket.close();
    await untilTerminal(socket);
    socket.close();
    const retry = await h.connect();
    retry.send(request()).unwrap();
    expect(h.sockets[1]!.sent[0]).toMatchObject({
      client_metadata: { "x-codex-turn-state": "turn-1" },
    });
    retry.close();
    h.transport.close();
  });

  test("Codex does not attach a failed turn's state to new input", async () => {
    const h = harness(true);
    const socket = await h.connect();
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.fail();
    await untilTerminal(socket);
    socket.close();
    const next = await h.connect();
    next.send({ ...request(), input: [user, followUp] }).unwrap();
    expect(h.sockets[1]!.sent[0]).not.toHaveProperty("client_metadata");
    next.close();
    h.transport.close();
  });

  test("cancellation clears Codex turn state instead of retaining it for retry", async () => {
    const h = harness(true);
    const controller = new AbortController();
    const socket = await h.connect(controller.signal);
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.emit(delta());
    const iterator = socket.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.unwrap().type).toBe("response.output_text.delta");
    controller.abort();
    socket.close();
    await iterator.return?.();
    const retry = await h.connect();
    retry.send(request()).unwrap();
    expect(h.sockets[1]!.sent[0]).not.toHaveProperty("client_metadata");
    retry.close();
    h.transport.close();
  });

  test.each(["create", "steer"] as const)(
    "an acquired socket never submits %s after cancellation",
    async (kind) => {
      const h = harness();
      const controller = new AbortController();
      const socket = await h.connect(controller.signal);
      controller.abort(new Error("cancelled"));
      const payload: ResponsesClientEvent =
        kind === "create"
          ? request()
          : {
              type: "response.steer",
              previous_response_id: "active-response",
              input: [{ type: "message", role: "user", content: "new direction" }],
            };
      const result = socket.send(payload);
      expect(result.match({ ok: () => undefined, err: (error) => error })).toMatchObject({
        reason: "cancelled",
        replaySafety: "safe",
      });
      expect(h.sockets[0]!.sent).toHaveLength(0);
      socket.close();
      h.transport.close();
    },
  );

  test.each(["create", "steer"] as const)(
    "an acquired socket preserves Panic cancellation identity for %s",
    async (kind) => {
      const h = harness();
      const controller = new AbortController();
      const socket = await h.connect(controller.signal);
      const panic = new Panic({ message: "abort defect", cause: new Error("defect") });
      controller.abort(panic);
      const payload: ResponsesClientEvent =
        kind === "create"
          ? request()
          : {
              type: "response.steer",
              previous_response_id: "active-response",
              input: [{ type: "message", role: "user", content: "new direction" }],
            };
      await expect(Promise.resolve().then(() => socket.send(payload))).rejects.toBe(panic);
      expect(h.sockets[0]!.sent).toHaveLength(0);
      socket.close();
      h.transport.close();
    },
  );

  test("a stale-id error queued before cancellation cannot trigger a retry after cancellation", async () => {
    const h = harness();
    const nextRequest = await warm(h);
    const controller = new AbortController();
    const socket = await h.connect(controller.signal);
    socket.send(nextRequest).unwrap();
    h.sockets[0]!.emit(stale());
    controller.abort();
    const result = await untilTerminal(socket);
    expect(result.events).toHaveLength(0);
    expect(h.sockets[0]!.sent).toHaveLength(2);
    socket.close();
    h.transport.close();
  });

  test.each([
    { kind: "error", retry: "exact" },
    { kind: "panic", retry: "exact" },
    { kind: "error", retry: "new-input" },
    { kind: "panic", retry: "new-input" },
    { kind: "error", retry: "cancelled" },
    { kind: "panic", retry: "cancelled" },
  ] as const)("normalizer failure preserves Codex retry ownership: %j", async ({ kind, retry }) => {
    const controller = new AbortController();
    const failure =
      kind === "panic"
        ? new Panic({ message: "normalizer defect", cause: new Error("defect") })
        : new Error("normalizer failed");
    const h = harness(true, {
      createEventNormalizer: () => (value) => {
        if (value.type !== "response.output_text.delta") return value;
        if (retry === "cancelled") controller.abort();
        throw failure;
      },
    });
    const socket = await h.connect(controller.signal);
    socket.send(request()).unwrap();
    h.sockets[0]!.emit(metadata());
    h.sockets[0]!.emit(delta());
    const received = untilTerminal(socket);
    if (kind === "panic") await expect(received).rejects.toBe(failure);
    else
      expect((await received).error).toMatchObject({
        reason: "protocol",
        replaySafety: "reconcile",
        cause: failure,
      });
    socket.close();
    const resumed = await h.connect();
    resumed
      .send(retry === "new-input" ? { ...request(), input: [user, followUp] } : request())
      .unwrap();
    expect(h.sockets).toHaveLength(2);
    if (retry === "exact")
      expect(h.sockets[1]!.sent[0]).toMatchObject({
        client_metadata: { "x-codex-turn-state": "turn-1" },
      });
    else expect(h.sockets[1]!.sent[0]).not.toHaveProperty("client_metadata");
    expect(h.sockets[1]!.sent[0]).not.toHaveProperty("previous_response_id");
    resumed.close();
    h.transport.close();
  });

  test("concurrent dedicated sockets cannot consume or replace reusable continuation state", async () => {
    const h = harness();
    const pooled = await h.connect();
    const dedicated = await h.connect();
    pooled.send(request()).unwrap();
    dedicated.send({ ...request(), input: [{ role: "user", content: "unrelated" }] }).unwrap();
    h.sockets[0]!.emit(completed("response-1"));
    await untilTerminal(pooled);
    pooled.close();
    h.sockets[1]!.emit(completed("unrelated-response"));
    await untilTerminal(dedicated);
    dedicated.close();
    const next = await h.connect();
    next.send({ ...request(), input: [user, ...(await prefix([message])), followUp] }).unwrap();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0]!.sent[1]).toMatchObject({
      previous_response_id: "response-1",
      input: [followUp],
    });
    expect(h.sockets[1]!.sent[0]).not.toHaveProperty("previous_response_id");
    next.close();
    h.transport.close();
  });
});
