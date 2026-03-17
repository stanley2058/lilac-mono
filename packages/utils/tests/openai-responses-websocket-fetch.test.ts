import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createOpenAIResponsesWebSocketFetch } from "../openai-responses-websocket-fetch";

type WebSocketInit = {
  headers?: Record<string, string>;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly init?: WebSocketInit;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];

  private readonly listeners: Record<string, Set<(event: Event) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(url: string | URL, init?: WebSocketInit) {
    this.url = String(url);
    this.init = init;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emitOpen());
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners[type];
    if (!set) return;
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners[type];
    if (!set) return;
    set.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", new CloseEvent("close", { code: 1000, reason: "closed" }));
  }

  emitMessage(data: string): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  private emitOpen(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  private emit(type: string, event: Event): void {
    const set = this.listeners[type];
    if (!set) return;
    for (const listener of set) {
      listener(event);
    }
  }
}

const globals = globalThis as unknown as {
  fetch: typeof globalThis.fetch;
  WebSocket: typeof WebSocket;
};

let originalFetch: typeof globalThis.fetch;
let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  originalFetch = globals.fetch;
  originalWebSocket = globals.WebSocket;
  FakeWebSocket.reset();
  globals.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globals.fetch = originalFetch;
  globals.WebSocket = originalWebSocket;
  FakeWebSocket.reset();
});

function sentBody(socket: FakeWebSocket | undefined, index = 0): Record<string, unknown> {
  return JSON.parse(socket?.sent[index] ?? "{}") as Record<string, unknown>;
}

function eventStreamResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

function chunkedEventStreamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

describe("createOpenAIResponsesWebSocketFetch", () => {
  it("routes streaming /responses calls through websocket", async () => {
    const selections: Array<Record<string, unknown>> = [];
    const fallbackCalls: unknown[] = [];
    globals.fetch = (async (...args: Parameters<typeof fetch>) => {
      fallbackCalls.push(args);
      return new Response("fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      onTransportSelected: (details) => {
        selections.push(details as unknown as Record<string, unknown>);
      },
    });

    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        stream: true,
        input: "hi",
      }),
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(fallbackCalls.length).toBe(0);

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket?.init?.headers?.["OpenAI-Beta"]).toContain("responses_websockets");

    const sent = JSON.parse(socket?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect("stream" in sent).toBe(false);

    const textPromise = response.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created" }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    const text = await textPromise;

    expect(text).toContain('"type":"response.created"');
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain("[DONE]");
    expect(selections).toEqual([
      {
        mode: "websocket",
        requestUrl: "https://api.openai.com/v1/responses",
        transport: "websocket",
        optimizationEnabled: false,
        optimizationReason: "no_continuation_state",
      },
    ]);
    wsFetch.close();
  });

  it("falls back to HTTP when mode=auto and websocket transport is unavailable", async () => {
    const fallbackCalls: unknown[] = [];
    let fallbackDetails:
      | {
          reason: "websocket_connect_failed";
          requestUrl: string;
          errorMessage?: string;
        }
      | undefined;
    globals.fetch = (async (...args: Parameters<typeof fetch>) => {
      fallbackCalls.push(args);
      return new Response("fallback");
    }) as unknown as typeof globalThis.fetch;

    globals.WebSocket = undefined as unknown as typeof WebSocket;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "auto",
      onAutoFallback: (details) => {
        fallbackDetails = details;
      },
    });

    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    expect(await response.text()).toBe("fallback");
    expect(fallbackCalls.length).toBe(1);
    expect(fallbackDetails?.reason).toBe("websocket_connect_failed");
    expect(fallbackDetails?.requestUrl).toBe("https://api.openai.com/v1/responses");
  });

  it("throws when mode=websocket and websocket transport is unavailable", async () => {
    globals.fetch = (async () => new Response("fallback")) as unknown as typeof globalThis.fetch;
    globals.WebSocket = undefined as unknown as typeof WebSocket;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    await expect(
      wsFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true, input: "hi" }),
      }),
    ).rejects.toThrow();
  });

  it("supports codex-style response.done normalization", async () => {
    globals.fetch = (async () => new Response("fallback")) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      completionEventTypes: ["response.completed", "response.done"],
      normalizeEvent: (event) => {
        if (event.type !== "response.done") return event;
        return {
          ...event,
          type: "response.completed",
        };
      },
    });

    const response = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const textPromise = response.text();
    socket?.emitMessage(JSON.stringify({ type: "response.done" }));
    const text = await textPromise;

    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain('"type":"response.done"');
  });

  it("normalizes websocket response.failed into error events", async () => {
    globals.fetch = (async () => new Response("fallback")) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
    });

    const response = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const textPromise = response.text();
    socket?.emitMessage(
      JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            type: "invalid_request_error",
            code: "model_not_found",
            message: "model not found",
          },
        },
      }),
    );

    const text = await textPromise;
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"code":"model_not_found"');
    expect(text).not.toContain('"type":"response.failed"');
    expect(text).toContain("[DONE]");
  });

  it("normalizes SSE response.done events", async () => {
    const selections: Array<Record<string, unknown>> = [];
    globals.fetch = (async () =>
      eventStreamResponse(
        `data: ${JSON.stringify({ type: "response.done" })}\n\ndata: [DONE]\n\n`,
      )) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "sse",
      onTransportSelected: (details) => {
        selections.push(details as unknown as Record<string, unknown>);
      },
      normalizeEvent: (event) => {
        if (event.type !== "response.done") return event;
        return {
          ...event,
          type: "response.completed",
        };
      },
    });

    const response = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const text = await response.text();
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain('"type":"response.done"');
    expect(selections).toEqual([
      {
        mode: "sse",
        requestUrl: "https://chatgpt.com/backend-api/codex/responses",
        transport: "sse",
        optimizationEnabled: false,
        optimizationReason: "transport_not_websocket",
      },
    ]);
  });

  it("normalizes SSE response.failed into error events", async () => {
    globals.fetch = (async () =>
      eventStreamResponse(
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              type: "invalid_request_error",
              code: "model_not_found",
              message: "model not found",
            },
          },
        })}\n\ndata: [DONE]\n\n`,
      )) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "sse",
    });

    const response = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const text = await response.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"code":"model_not_found"');
    expect(text).not.toContain('"type":"response.failed"');
  });

  it("normalizes SSE response.failed when CRLF delimiters are split across chunks", async () => {
    globals.fetch = (async () =>
      chunkedEventStreamResponse([
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              type: "invalid_request_error",
              code: "model_not_found",
              message: "model not found",
            },
          },
        })}\r`,
        "\n\r",
        "\ndata: [DONE]\r\n\r\n",
      ])) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "sse",
    });

    const response = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const text = await response.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"code":"model_not_found"');
    expect(text).not.toContain('"type":"response.failed"');
    expect(text).toContain("data: [DONE]");
  });

  it("supports concurrent websocket requests via dedicated connection", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const response1 = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "turn-1" }),
    });

    const response2 = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "turn-2" }),
    });

    expect(FakeWebSocket.instances.length).toBe(2);
    const socket1 = FakeWebSocket.instances[0];
    const socket2 = FakeWebSocket.instances[1];
    expect(socket1).toBeDefined();
    expect(socket2).toBeDefined();

    const text1Promise = response1.text();
    const text2Promise = response2.text();

    socket2?.emitMessage(JSON.stringify({ type: "response.completed" }));
    socket1?.emitMessage(JSON.stringify({ type: "response.completed" }));

    const [text1, text2] = await Promise.all([text1Promise, text2Promise]);
    expect(text1).toContain("[DONE]");
    expect(text2).toContain("[DONE]");
    wsFetch.close();
  });

  it("reuses previous response id and only sends delta input for default OpenAI requests", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const firstResponse = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const firstTextPromise = firstResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Let me check.", annotations: [] }],
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        },
      }),
    );
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await firstTextPromise;

    const secondResponse = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { type: "item_reference", id: "msg_1" },
          { type: "item_reference", id: "fc_1" },
          { type: "function_call_output", call_id: "call_1", output: "# Lilac" },
        ],
      }),
    });

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "# Lilac" }],
    });

    const secondTextPromise = secondResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;
    wsFetch.close();
  });

  it("reuses previous response id for codex store=false requests", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const firstResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const firstTextPromise = firstResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Checking the file.", annotations: [] }],
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
          status: "completed",
        },
      }),
    );
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await firstTextPromise;

    const secondResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { role: "assistant", content: [{ type: "output_text", text: "Checking the file." }] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "# Lilac" },
        ],
      }),
    });

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      store: false,
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "# Lilac" }],
    });

    const secondTextPromise = secondResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;
    wsFetch.close();
  });

  it("builds codex delta state from websocket deltas when done items are skeletal", async () => {
    const selections: Array<Record<string, unknown>> = [];
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      onTransportSelected: (details) => {
        selections.push(details as unknown as Record<string, unknown>);
      },
    });

    const firstResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const firstTextPromise = firstResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        content_index: 0,
        delta: "Checking the file.",
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: { id: "msg_1", type: "message", role: "assistant", status: "completed" },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          status: "in_progress",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"path":"README.md"}',
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          status: "completed",
        },
      }),
    );
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await firstTextPromise;

    const secondResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { role: "assistant", content: [{ type: "output_text", text: "Checking the file." }] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "# Lilac" },
        ],
      }),
    });

    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      store: false,
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "# Lilac" }],
    });
    expect(selections).toEqual([
      {
        mode: "websocket",
        requestUrl: "https://chatgpt.com/backend-api/codex/responses",
        transport: "websocket",
        optimizationEnabled: false,
        optimizationReason: "no_continuation_state",
      },
      {
        mode: "websocket",
        requestUrl: "https://chatgpt.com/backend-api/codex/responses",
        transport: "websocket",
        optimizationEnabled: true,
        optimizationReason: "incremental_replay",
      },
    ]);

    const secondTextPromise = secondResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;
    wsFetch.close();
  });

  it("clears continuation state after terminal websocket errors", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const firstResponse = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const firstTextPromise = firstResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Let me check.", annotations: [] }],
        },
      }),
    );
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await firstTextPromise;

    const secondResponse = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { type: "item_reference", id: "msg_1" },
          { role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      }),
    });

    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      previous_response_id: "resp_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "continue" }] }],
    });

    const secondTextPromise = secondResponse.text();
    socket?.emitMessage(
      JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            type: "invalid_request_error",
            code: "invalid_prompt",
            message: "bad prompt",
          },
        },
      }),
    );
    await secondTextPromise;

    const thirdResponse = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { type: "item_reference", id: "msg_1" },
          { role: "user", content: [{ type: "input_text", text: "continue" }] },
          { role: "user", content: [{ type: "input_text", text: "retry" }] },
        ],
      }),
    });

    expect(sentBody(socket, 2)).toEqual({
      type: "response.create",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "item_reference", id: "msg_1" },
        { role: "user", content: [{ type: "input_text", text: "continue" }] },
        { role: "user", content: [{ type: "input_text", text: "retry" }] },
      ],
    });

    const thirdTextPromise = thirdResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_3" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await thirdTextPromise;
    wsFetch.close();
  });

  it("closes reusable websocket after idle timeout", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      idleTimeoutMs: 10,
    });

    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hello" }),
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const textPromise = response.text();
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    const text = await textPromise;
    expect(text).toContain("[DONE]");

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    wsFetch.close();
  });
});
