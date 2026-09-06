import { afterEach, describe, expect, it } from "bun:test";
import { Panic } from "better-result";
import {
  connectOpenAIResponsesWebSocket,
  resolveOpenAIResponsesConnectionOptions,
  toOpenAIResponsesWebSocketHeaders,
} from "../openai-responses-connection";

const originalWebSocket = globalThis.WebSocket;
class ControlledWebSocket extends EventTarget {
  static instances: ControlledWebSocket[] = [];
  static failure: Error | undefined;
  static closeFailure: Error | undefined;
  readonly headers: Record<string, string>;
  closed = false;
  constructor(
    readonly url: string,
    options: { headers: Record<string, string> },
  ) {
    super();
    if (ControlledWebSocket.failure) throw ControlledWebSocket.failure;
    this.headers = options.headers;
    ControlledWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
    if (ControlledWebSocket.closeFailure) throw ControlledWebSocket.closeFailure;
  }
}
function installSocket(): void {
  globalThis.WebSocket = ControlledWebSocket as unknown as typeof WebSocket;
}
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  ControlledWebSocket.instances = [];
  ControlledWebSocket.failure = undefined;
  ControlledWebSocket.closeFailure = undefined;
});

describe("OpenAI Responses connection", () => {
  it("resolves default and custom authenticated endpoints without changing transport", () => {
    const defaults = resolveOpenAIResponsesConnectionOptions({
      apiKey: "test",
      responsesTransport: "auto",
    }).unwrap();
    expect(defaults.requestUrl.toString()).toBe("https://api.openai.com/v1/responses");
    expect(defaults.websocketUrl).toBe("wss://api.openai.com/v1/responses");
    expect(defaults.headers).toEqual({ Authorization: "Bearer test" });
    expect(defaults.mode).toBe("auto");
    const custom = resolveOpenAIResponsesConnectionOptions({
      baseUrl: "http://localhost:4000/v1/",
      apiKey: "test",
      responsesTransport: "websocket",
    }).unwrap();
    expect(custom.baseUrl).toBe("http://localhost:4000/v1");
    expect(custom.websocketUrl).toBe("ws://localhost:4000/v1/responses");
    expect(custom.mode).toBe("websocket");
    const proxy = resolveOpenAIResponsesConnectionOptions({
      apiKey: "",
      responsesTransport: "sse",
    }).unwrap();
    expect(proxy.headers).toEqual({ Authorization: "Bearer " });
  });
  it("returns configuration errors without exposing the API key", () => {
    expect(
      resolveOpenAIResponsesConnectionOptions({ responsesTransport: "sse" }).match({
        ok: () => {
          throw new Error("Expected failure");
        },
        err: (error) => error,
      }).reason,
    ).toBe("missing-api-key");
    for (const baseUrl of ["", "invalid", "file:///tmp/key"]) {
      const error = resolveOpenAIResponsesConnectionOptions({
        baseUrl,
        apiKey: "secret-test",
        responsesTransport: "auto",
      }).match({
        ok: () => {
          throw new Error("Expected failure");
        },
        err: (error) => error,
      });
      expect(error.reason).toBe("invalid-base-url");
      expect(JSON.stringify(error)).not.toContain("secret-test");
    }
  });
  it("merges beta headers idempotently without mutating caller headers", () => {
    const headers = { "openai-beta": "another_feature", Authorization: "Bearer test" };
    const shaped = toOpenAIResponsesWebSocketHeaders(headers);
    expect(shaped["OpenAI-Beta"]).toBe("another_feature, responses_websockets=2026-02-06");
    expect(toOpenAIResponsesWebSocketHeaders(shaped)).toEqual(shaped);
    expect(headers["openai-beta"]).toBe("another_feature");
  });
  it("opens a dormant authenticated socket and relinquishes establishment listeners", async () => {
    installSocket();
    const opening = connectOpenAIResponsesWebSocket({
      url: "wss://example.test/responses",
      headers: { Authorization: "Bearer test" },
    });
    const socket = ControlledWebSocket.instances[0]!;
    expect(socket.headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
    socket.dispatchEvent(new Event("open"));
    expect((await opening).unwrap()).toBe(socket as unknown as WebSocket);
    socket.dispatchEvent(new ErrorEvent("error", { message: "after open" }));
    expect(socket.closed).toBe(false);
  });
  it("returns connection failures and closes the unsuccessful socket", async () => {
    installSocket();
    const opening = connectOpenAIResponsesWebSocket({
      url: "wss://example.test/responses",
      headers: {},
    });
    const socket = ControlledWebSocket.instances[0]!;
    socket.dispatchEvent(new ErrorEvent("error", { message: "offline" }));
    const error = (await opening).match({
      ok: () => {
        throw new Error("Expected failure");
      },
      err: (error) => error,
    });
    expect(error.reason).toBe("connection");
    expect(error.error.message).toBe("offline");
    expect(socket.closed).toBe(true);
  });
  it("preserves cancellation before and during establishment", async () => {
    installSocket();
    const before = new AbortController();
    const reason = new Error("cancelled");
    before.abort(reason);
    const failure = (
      await connectOpenAIResponsesWebSocket({
        url: "wss://example.test/responses",
        headers: {},
        signal: before.signal,
      })
    ).match({
      ok: () => {
        throw new Error("Expected failure");
      },
      err: (error) => error,
    });
    expect(failure.reason).toBe("aborted");
    expect(failure.error).toBe(reason);
    expect(ControlledWebSocket.instances).toHaveLength(0);
    const during = new AbortController();
    const opening = connectOpenAIResponsesWebSocket({
      url: "wss://example.test/responses",
      headers: {},
      signal: during.signal,
    });
    during.abort(reason);
    expect(
      (await opening).match({
        ok: () => {
          throw new Error("Expected failure");
        },
        err: (error) => error,
      }).error,
    ).toBe(reason);
    expect(ControlledWebSocket.instances[0]!.closed).toBe(true);
  });
  it("rejects the exact constructor Panic", async () => {
    installSocket();
    const panic = new Panic({ message: "socket invariant" });
    ControlledWebSocket.failure = panic;
    await expect(
      connectOpenAIResponsesWebSocket({ url: "wss://example.test/responses", headers: {} }),
    ).rejects.toBe(panic);
  });
  it("rejects the exact cancellation Panic after closing the connecting socket", async () => {
    installSocket();
    const controller = new AbortController();
    const panic = new Panic({ message: "cancel invariant" });
    const opening = connectOpenAIResponsesWebSocket({
      url: "wss://example.test/responses",
      headers: {},
      signal: controller.signal,
    });
    controller.abort(panic);
    await expect(opening).rejects.toBe(panic);
    expect(ControlledWebSocket.instances[0]!.closed).toBe(true);
  });
  it("rejects a cleanup Panic rather than converting it into a connection error", async () => {
    installSocket();
    const panic = new Panic({ message: "close invariant" });
    ControlledWebSocket.closeFailure = panic;
    const opening = connectOpenAIResponsesWebSocket({
      url: "wss://example.test/responses",
      headers: {},
    });
    ControlledWebSocket.instances[0]!.dispatchEvent(
      new ErrorEvent("error", { message: "offline" }),
    );
    await expect(opening).rejects.toBe(panic);
  });
});
