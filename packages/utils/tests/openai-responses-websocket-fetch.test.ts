import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { Panic } from "better-result";

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
  static openOnConstruct = true;
  static onConstruct: (() => void) | undefined;
  static onSend: (() => void) | undefined;

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
    FakeWebSocket.onConstruct?.();
    if (FakeWebSocket.openOnConstruct) queueMicrotask(() => this.emitOpen());
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.openOnConstruct = true;
    FakeWebSocket.onConstruct = undefined;
    FakeWebSocket.onSend = undefined;
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
    FakeWebSocket.onSend?.();
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", new CloseEvent("close", { code, reason: "closed" }));
  }

  emitMessage(data: unknown): void {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

describe("createOpenAIResponsesWebSocketFetch", () => {
  it("closes dedicated sockets as well as the reusable socket", async () => {
    const fetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const request = () =>
      fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true, input: "hi" }),
      });
    const responses = await Promise.all([request(), request()]);
    const reads = responses.map((response) => response.text().catch(() => "closed"));
    fetch.close();
    expect(
      FakeWebSocket.instances.every((socket) => socket.readyState === FakeWebSocket.CLOSED),
    ).toBe(true);
    await Promise.all(reads);
  });

  it("fails a response that exceeds the unread stream budget", async () => {
    const fetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(
      JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(17 * 1024 * 1024) }),
    );
    await expect(response.text()).rejects.toThrow("exceeded");
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    fetch.close();
  });

  it("fails after many individually bounded frames fill the unread stream", async () => {
    const fetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const socket = FakeWebSocket.instances[0]!;
    const frame = JSON.stringify({
      type: "response.output_text.delta",
      delta: "x".repeat(1024 * 1024),
    });
    // Decode each frame before sending the next so this exercises the unread stream budget.
    for (let index = 0; index < 20; index++) {
      socket.emitMessage(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (socket.readyState === FakeWebSocket.CLOSED) break;
    }
    await expect(withTimeout(response.text())).rejects.toThrow(
      "Responses WebSocket buffer exceeded 16 MiB",
    );
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    fetch.close();
  });

  it("closes a socket when its response body is cancelled", async () => {
    const fetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    await response.body!.cancel();
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    fetch.close();
  });

  it("decodes asynchronous frames in arrival order", async () => {
    const fetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const decoded = Promise.withResolvers<ArrayBuffer>();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(
      new (class extends Blob {
        override arrayBuffer() {
          return decoded.promise;
        }
      })(["pending"]),
    );
    socket.emitMessage(JSON.stringify({ type: "response.completed", response: { id: "r" } }));
    decoded.resolve(
      new TextEncoder().encode(
        JSON.stringify({ type: "response.output_text.delta", delta: "first" }),
      ).buffer,
    );
    const text = await response.text();
    expect(text).toContain('"delta":"first"');
    expect(text.indexOf('"delta":"first"')).toBeLessThan(text.indexOf("response.completed"));
    fetch.close();
  });

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

  it("ignores null, array, and scalar websocket JSON before normalization", async () => {
    let normalizedEvents = 0;
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      normalizeEvent: (event) => {
        normalizedEvents += 1;
        return event;
      },
    });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const textPromise = response.text();
    const socket = FakeWebSocket.instances[0];
    socket?.emitMessage("null");
    socket?.emitMessage("[]");
    socket?.emitMessage('"scalar"');
    socket?.emitMessage("1");
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));

    const text = await textPromise;
    expect(normalizedEvents).toBe(1);
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain("[DONE]");
    wsFetch.close();
  });

  it("falls back to HTTP when mode=auto and websocket transport is unavailable", async () => {
    const fallbackCalls: unknown[] = [];
    let fallbackDetails:
      | {
          reason: "websocket_connect_failed" | "websocket_message_too_big";
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

  it("times out websocket setup so auto mode can fall back to SSE", async () => {
    jest.useFakeTimers({ now: 0 });
    FakeWebSocket.openOnConstruct = false;
    const constructed = Promise.withResolvers<void>();
    FakeWebSocket.onConstruct = () => constructed.resolve();
    let fallbackCalls = 0;
    globals.fetch = (async () => {
      fallbackCalls += 1;
      return new Response("fallback");
    }) as unknown as typeof globalThis.fetch;
    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "auto" });

    try {
      const responsePromise = wsFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true, input: "hi" }),
      });
      await constructed.promise;
      jest.advanceTimersByTime(30_000);

      const response = await responsePromise;
      expect(await response.text()).toBe("fallback");
      expect(fallbackCalls).toBe(1);
      expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    } finally {
      wsFetch.close();
      jest.useRealTimers();
    }
  });

  it("cancels websocket setup without falling back after caller abort", async () => {
    FakeWebSocket.openOnConstruct = false;
    const constructed = Promise.withResolvers<void>();
    FakeWebSocket.onConstruct = () => constructed.resolve();
    let fallbackCalls = 0;
    globals.fetch = (async () => {
      fallbackCalls += 1;
      return new Response("fallback");
    }) as unknown as typeof globalThis.fetch;
    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "auto" });
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");

    const responsePromise = wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
      signal: controller.signal,
    });
    await constructed.promise;
    controller.abort(reason);

    await expect(responsePromise).rejects.toBe(reason);
    expect(fallbackCalls).toBe(0);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    wsFetch.close();
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
    let normalizerCount = 0;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      completionEventTypes: ["response.completed", "response.done"],
      createEventNormalizer: () => {
        normalizerCount += 1;
        return (event) => {
          if (event.type !== "response.done") return event;
          return {
            ...event,
            type: "response.completed",
          };
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
    expect(normalizerCount).toBe(1);
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

  it("lets AI SDK consumers observe websocket terminal errors without hanging", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const openai = createOpenAI({ apiKey: "test-token", fetch: wsFetch });
    const requestSent = Promise.withResolvers<void>();
    FakeWebSocket.onSend = requestSent.resolve;

    const result = streamText({
      model: openai.responses("gpt-5-mini"),
      prompt: "hi",
      onError: () => {},
    });

    const partsPromise = withTimeout(
      (async () => {
        const parts: Array<{ type: string; error?: unknown }> = [];
        for await (const part of result.stream) {
          parts.push({
            type: part.type,
            ...(part.type === "error" ? { error: part.error } : {}),
          });
        }
        return parts;
      })(),
    );

    await requestSent.promise;

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket?.emitMessage(
      JSON.stringify({
        type: "error",
        sequence_number: 0,
        error: {
          type: "invalid_request_error",
          code: "response_error",
          message: "Instructions are required",
          param: null,
        },
      }),
    );

    const parts = await partsPromise;
    expect(parts.some((part) => part.type === "error")).toBe(true);
    expect(JSON.stringify(parts.find((part) => part.type === "error")?.error)).toContain(
      "Instructions are required",
    );
  });

  it("uses installed OpenAI Responses cache write usage", async () => {
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "sse",
      fetch: (async () =>
        eventStreamResponse(
          [
            {
              type: "response.created",
              response: { id: "resp_cache", created_at: 1_783_620_000, model: "gpt-5.6" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_cache",
                incomplete_details: null,
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 25 },
                  output_tokens: 20,
                  output_tokens_details: { reasoning_tokens: 5 },
                },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        )) as unknown as typeof globalThis.fetch,
    });
    const openai = createOpenAI({ apiKey: "test-token", fetch: wsFetch });
    const result = streamText({ model: openai.responses("gpt-5.6"), prompt: "hi" });

    for await (const _part of result.stream) {
      void _part;
    }

    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: 35,
        cacheReadTokens: 40,
        cacheWriteTokens: 25,
      },
    });
    wsFetch.close();
  });

  it("preserves installed OpenAI-compatible structured stream errors", async () => {
    const provider = createOpenAICompatible({
      name: "test-compatible",
      baseURL: "https://compatible.example/v1",
      apiKey: "test-token",
      fetch: (async () =>
        eventStreamResponse(
          `data: ${JSON.stringify({
            error: {
              message: "Context length exceeded",
              code: "CONTEXT_LENGTH_EXCEEDED",
            },
          })}\n\ndata: [DONE]\n\n`,
        )) as unknown as typeof globalThis.fetch,
    });
    const result = streamText({
      model: provider.chatModel("test-model"),
      prompt: "hi",
      onError: () => {},
    });
    const errors: unknown[] = [];

    for await (const part of result.stream) {
      if (part.type === "error") errors.push(part.error);
    }

    expect(JSON.stringify(errors)).toContain("Context length exceeded");
    expect(JSON.stringify(errors)).toContain("CONTEXT_LENGTH_EXCEEDED");
  });

  it("replays the original request over SSE after a 1009 close before any messages", async () => {
    const sent = Promise.withResolvers<void>();
    FakeWebSocket.onSend = () => sent.resolve();
    const fallbacks: string[] = [];
    const body = JSON.stringify({ stream: true, input: "images", store: false });
    const signal = new AbortController().signal;
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body,
      signal,
    });
    let calls = 0;
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "auto",
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        calls++;
        expect(input).toBe(request);
        expect(await request.text()).toBe(body);
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.signal.aborted).toBe(false);
        return new Response("rate limited", { status: 429, headers: { "retry-after": "12" } });
      }) as unknown as typeof fetch,
      onAutoFallback: ({ reason }) => fallbacks.push(reason),
    });
    const pending = wsFetch(request);
    await sent.promise;
    FakeWebSocket.instances[0]!.close(1009);
    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).toBe("rate limited");
    expect(calls).toBe(1);
    expect(fallbacks).toEqual(["websocket_message_too_big"]);
    wsFetch.close();
  });

  it("normalizes SSE fallback output and forwards fallback fetch failures", async () => {
    for (const fails of [false, true]) {
      const sent = Promise.withResolvers<void>();
      FakeWebSocket.onSend = () => sent.resolve();
      const failure = new Error("SSE unavailable");
      const wsFetch = createOpenAIResponsesWebSocketFetch({
        mode: "auto",
        normalizeEvent: (event) =>
          event.type === "response.done" ? { ...event, type: "response.completed" } : event,
        fetch: (async () => {
          if (fails) throw failure;
          return new Response('data: {"type":"response.done","response":{"id":"resp_sse"}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        }) as unknown as typeof fetch,
      });
      const pending = wsFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true, input: "hi" }),
      });
      await sent.promise;
      FakeWebSocket.instances.at(-1)!.close(1009);
      if (fails) {
        await expect(pending).rejects.toBe(failure);
      } else {
        const text = await (await pending).text();
        expect(text).toContain('"type":"response.completed"');
      }
      wsFetch.close();
    }
  });

  it.each([
    { mode: "websocket" as const, code: 1009, metadata: false },
    { mode: "auto" as const, code: 1006, metadata: false },
    { mode: "auto" as const, code: 1009, metadata: true },
  ])(
    "does not replay unsafe or explicitly websocket requests: %j",
    async ({ mode, code, metadata }) => {
      const sent = Promise.withResolvers<void>();
      FakeWebSocket.onSend = () => sent.resolve();
      let calls = 0;
      const wsFetch = createOpenAIResponsesWebSocketFetch({
        mode,
        fetch: (async () => {
          calls++;
          return new Response("unexpected");
        }) as unknown as typeof fetch,
      });
      const pending = wsFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true, input: "hi" }),
      });
      await sent.promise;
      const socket = FakeWebSocket.instances[0]!;
      if (metadata)
        socket.emitMessage(
          JSON.stringify({ type: "response.created", response: { id: "accepted" } }),
        );
      socket.close(code);
      const response = await pending;
      await expect(response.text()).rejects.toThrow(`code: ${code}`);
      expect(calls).toBe(0);
      wsFetch.close();
    },
  );

  it("opens a fresh websocket after falling back from a rejected request", async () => {
    let calls = 0;
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "auto",
      fetch: (async () => {
        calls++;
        return new Response("fallback");
      }) as unknown as typeof fetch,
    });
    FakeWebSocket.onSend = () => {
      const socket = FakeWebSocket.instances.at(-1)!;
      queueMicrotask(() => {
        if (FakeWebSocket.instances.length === 1) {
          socket.close(1009);
          return;
        }
        socket.emitMessage(
          JSON.stringify({ type: "response.completed", response: { id: "fresh" } }),
        );
      });
    };
    const init = { method: "POST", body: JSON.stringify({ stream: true, input: "hi" }) };
    const first = await wsFetch("https://api.openai.com/v1/responses", init);
    expect(await first.text()).toBe("fallback");
    const second = await wsFetch("https://api.openai.com/v1/responses", init);
    expect(await second.text()).toContain("response.completed");
    expect(calls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toEqual({
      type: "response.create",
      input: "hi",
    });
    wsFetch.close();
  });

  it("does not fall back when aborted immediately after a 1009 close", async () => {
    const sent = Promise.withResolvers<void>();
    FakeWebSocket.onSend = () => sent.resolve();
    const abort = new AbortController();
    let calls = 0;
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "auto",
      fetch: (async () => {
        calls++;
        return new Response("unexpected");
      }) as unknown as typeof fetch,
    });
    const pending = wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
      signal: abort.signal,
    });
    await sent.promise;
    FakeWebSocket.instances[0]!.close(1009);
    const reason = new DOMException("cancelled", "AbortError");
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(0);
    wsFetch.close();
  });

  it("errors when websocket closes before a terminal response event", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const textPromise = response.text();
    FakeWebSocket.instances[0]?.close();

    await expect(textPromise).rejects.toThrow("before a terminal response event");
    wsFetch.close();
  });

  it("errors the stream when websocket event normalization fails", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      normalizeEvent: () => {
        throw new Error("normalization failed");
      },
    });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    const textPromise = response.text();
    FakeWebSocket.instances[0]?.emitMessage(JSON.stringify({ type: "response.created" }));

    await expect(textPromise).rejects.toThrow("normalization failed");
    wsFetch.close();
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

  it("rejects SSE EOF without a terminal response event", async () => {
    globals.fetch = (async () =>
      eventStreamResponse(
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\ndata: [DONE]\n\n`,
      )) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "sse" });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });

    await expect(response.text()).rejects.toThrow(
      "Response stream ended before a terminal response event",
    );
    wsFetch.close();
  });

  it("releases the SSE source reader after an exact Panic", async () => {
    const panic = new Panic({ message: "SSE read invariant" });
    let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
      },
    });
    globals.fetch = (async () =>
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "sse" });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const text = response.text();
    sourceController?.error(panic);

    await expect(text).rejects.toBe(panic);
    expect(source.locked).toBe(false);
    wsFetch.close();
  });

  it("cancels and releases the SSE source reader while preserving the cancel error", async () => {
    const cancelError = new Error("SSE cancellation failed");
    const cancelReason = new Error("consumer stopped");
    let receivedReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        receivedReason = reason;
        throw cancelError;
      },
    });
    globals.fetch = (async () =>
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "sse" });
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "hi" }),
    });
    const reader = response.body?.getReader();

    await expect(reader?.cancel(cancelReason)).rejects.toBe(cancelError);
    expect(receivedReason).toBe(cancelReason);
    expect(source.locked).toBe(false);
    wsFetch.close();
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

  it("uses a dedicated connection for concurrent requests while the reusable socket is still connecting", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const response1Promise = wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "turn-1" }),
    });
    const response2Promise = wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, input: "turn-2" }),
    });

    const [response1, response2] = await Promise.all([response1Promise, response2Promise]);
    expect(FakeWebSocket.instances.length).toBe(2);

    const socket1 = FakeWebSocket.instances[0];
    const socket2 = FakeWebSocket.instances[1];
    expect(sentBody(socket1).input).toBe("turn-1");
    expect(sentBody(socket2).input).toBe("turn-2");

    const text1Promise = response1.text();
    const text2Promise = response2.text();
    socket2?.emitMessage(
      JSON.stringify({ type: "response.completed", response: { id: "resp_2" } }),
    );
    socket1?.emitMessage(
      JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
    );

    const [text1, text2] = await Promise.all([text1Promise, text2Promise]);
    expect(text1).toContain("resp_1");
    expect(text1).not.toContain("resp_2");
    expect(text2).toContain("resp_2");
    expect(text2).not.toContain("resp_1");
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
    socket?.emitMessage(
      JSON.stringify({
        type: "response.metadata",
        headers: { "x-codex-turn-state": "turn-state-1" },
      }),
    );
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
    const firstText = await firstTextPromise;
    expect(firstText).toContain('"type":"response.metadata"');

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

  it("replays codex response metadata turn state after a same-turn reconnect", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      turnStateHeaderName: "x-codex-turn-state",
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
    socket?.emitMessage(
      JSON.stringify({
        type: "response.metadata",
        headers: { "x-codex-turn-state": "turn-state-1" },
      }),
    );
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
    socket?.close();

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

    expect(FakeWebSocket.instances.length).toBe(2);
    const secondSocket = FakeWebSocket.instances[1];
    expect(sentBody(secondSocket)).toEqual({
      type: "response.create",
      store: false,
      client_metadata: { "x-codex-turn-state": "turn-state-1" },
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
    });

    const secondTextPromise = secondResponse.text();
    secondSocket?.emitMessage(
      JSON.stringify({ type: "response.created", response: { id: "resp_2" } }),
    );
    secondSocket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;
    wsFetch.close();
  });

  it("does not replay codex turn state into a new logical turn", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      turnStateHeaderName: "x-codex-turn-state",
    });

    const firstResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });

    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    const firstTextPromise = firstResponse.text();
    firstSocket?.emitMessage(
      JSON.stringify({
        type: "response.metadata",
        headers: { "x-codex-turn-state": "turn-state-1" },
      }),
    );
    firstSocket?.emitMessage(
      JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
    );
    firstSocket?.emitMessage(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "First turn complete." }],
        },
      }),
    );
    firstSocket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await firstTextPromise;

    const secondResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { role: "assistant", content: [{ type: "output_text", text: "First turn complete." }] },
          { role: "user", content: [{ type: "input_text", text: "different" }] },
        ],
      }),
    });

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(sentBody(firstSocket, 1)).toEqual({
      type: "response.create",
      store: false,
      previous_response_id: "resp_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "different" }] }],
    });

    const secondTextPromise = secondResponse.text();
    firstSocket?.emitMessage(
      JSON.stringify({ type: "response.created", response: { id: "resp_2" } }),
    );
    firstSocket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;
    wsFetch.close();
  });

  it("retries codex incremental replay without previous response id when server forgot it", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const selections: unknown[] = [];
    const wsFetch = createOpenAIResponsesWebSocketFetch({
      mode: "websocket",
      turnStateHeaderName: "x-codex-turn-state",
      onTransportSelected: (details) => selections.push(details),
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
    socket?.emitMessage(
      JSON.stringify({
        type: "response.metadata",
        headers: { "x-codex-turn-state": "turn-state-1" },
      }),
    );
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
          name: "continue_work",
          arguments: "{}",
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
          { type: "function_call", call_id: "call_1", name: "continue_work", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "continue" },
        ],
      }),
    });

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      store: false,
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "continue" }],
      client_metadata: { "x-codex-turn-state": "turn-state-1" },
    });

    const secondTextPromise = secondResponse.text();
    const retried = Promise.withResolvers<void>();
    FakeWebSocket.onSend = () => retried.resolve();
    socket?.emitMessage(
      JSON.stringify({
        type: "response.metadata",
        headers: { "x-codex-turn-state": "turn-state-stale" },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({ type: "response.created", response: { id: "resp_stale_attempt" } }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          message: "Previous response with id 'resp_1' not found.",
          param: "previous_response_id",
        },
      }),
    );
    await retried.promise;

    expect(sentBody(socket, 2)).toEqual({
      type: "response.create",
      store: false,
      client_metadata: { "x-codex-turn-state": "turn-state-1" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Checking the file." }] },
        { type: "function_call", call_id: "call_1", name: "continue_work", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "continue" },
      ],
    });

    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));

    const secondText = await secondTextPromise;
    expect(secondText).not.toContain("previous_response_not_found");
    expect(secondText).not.toContain("resp_stale_attempt");
    expect(secondText).not.toContain("turn-state-stale");
    expect(secondText).toContain("resp_2");
    expect(secondText).toContain("[DONE]");
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
      {
        mode: "websocket",
        requestUrl: "https://chatgpt.com/backend-api/codex/responses",
        transport: "websocket",
        optimizationEnabled: false,
        optimizationReason: "stale_previous_response_id_retry",
      },
    ]);
    wsFetch.close();
  });

  it("does not reuse codex previous response id for unrelated input prefixes", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

    const firstResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "thread alpha" }] }],
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
          content: [{ type: "output_text", text: "Alpha summary" }],
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
        input: [{ role: "user", content: [{ type: "input_text", text: "thread beta" }] }],
      }),
    });

    expect(sentBody(socket, 1)).toEqual({
      type: "response.create",
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "thread beta" }] }],
    });

    const secondTextPromise = secondResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await secondTextPromise;

    const thirdResponse = await wsFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        store: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: "thread alpha" }] },
          { role: "assistant", content: [{ type: "output_text", text: "Alpha summary" }] },
          { role: "user", content: [{ type: "input_text", text: "continue alpha" }] },
        ],
      }),
    });

    expect(sentBody(socket, 2)).toEqual({
      type: "response.create",
      store: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "thread alpha" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Alpha summary" }] },
        { role: "user", content: [{ type: "input_text", text: "continue alpha" }] },
      ],
    });

    const thirdTextPromise = thirdResponse.text();
    socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_3" } }));
    socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await thirdTextPromise;
    wsFetch.close();
  });

  it("expires websocket continuation prefixes after thirty minutes", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    try {
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
            content: [{ type: "output_text", text: "Let me check." }],
          },
        }),
      );
      socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
      await firstTextPromise;

      now += 30 * 60 * 1000 + 1;
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
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { type: "item_reference", id: "msg_1" },
          { role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      });

      const secondTextPromise = secondResponse.text();
      socket?.emitMessage(JSON.stringify({ type: "response.created", response: { id: "resp_2" } }));
      socket?.emitMessage(JSON.stringify({ type: "response.completed" }));
      await secondTextPromise;
      wsFetch.close();
    } finally {
      Date.now = originalDateNow;
    }
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

    const thirdSocket = FakeWebSocket.instances[1];
    expect(thirdSocket).toBeDefined();
    expect(sentBody(thirdSocket)).toEqual({
      type: "response.create",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "item_reference", id: "msg_1" },
        { role: "user", content: [{ type: "input_text", text: "continue" }] },
        { role: "user", content: [{ type: "input_text", text: "retry" }] },
      ],
    });

    const thirdTextPromise = thirdResponse.text();
    thirdSocket?.emitMessage(
      JSON.stringify({ type: "response.created", response: { id: "resp_3" } }),
    );
    thirdSocket?.emitMessage(JSON.stringify({ type: "response.completed" }));
    await thirdTextPromise;
    wsFetch.close();
  });

  it("closes reusable websocket after idle timeout", async () => {
    globals.fetch = (async () => {
      throw new Error("should not fallback");
    }) as unknown as typeof globalThis.fetch;

    jest.useFakeTimers({ now: 0 });
    try {
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

      jest.advanceTimersByTime(10);
      expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
      wsFetch.close();
    } finally {
      jest.useRealTimers();
    }
  });
});
