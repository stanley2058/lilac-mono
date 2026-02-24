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

describe("createOpenAIResponsesWebSocketFetch", () => {
  it("routes streaming /responses calls through websocket", async () => {
    const fallbackCalls: unknown[] = [];
    globals.fetch = (async (...args: Parameters<typeof fetch>) => {
      fallbackCalls.push(args);
      return new Response("fallback");
    }) as unknown as typeof globalThis.fetch;

    const wsFetch = createOpenAIResponsesWebSocketFetch({ mode: "websocket" });

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
    wsFetch.close();
  });

  it("falls back to HTTP when mode=auto and websocket transport is unavailable", async () => {
    const fallbackCalls: unknown[] = [];
    let fallbackDetails:
      | {
          reason: "websocket_busy" | "websocket_connect_failed";
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
});
