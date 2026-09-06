import { afterEach, expect, test } from "bun:test";
import { createOpenAIResponsesConnect } from "./socket";

const original = globalThis.WebSocket;
class ControlledSocket extends EventTarget {
  static instance: ControlledSocket;
  static OPEN = 1;
  readyState = 1;
  closeCount = 0;
  constructor(
    readonly url: string,
    readonly options: { headers: Record<string, string> },
  ) {
    super();
    ControlledSocket.instance = this;
  }
  close() {
    this.closeCount++;
  }
  send() {}
}
afterEach(() => {
  globalThis.WebSocket = original;
});

for (const failure of ["error", "nontext"] as const)
  test(`disposal closes the underlying socket after ${failure} and retains compaction negotiation`, async () => {
    globalThis.WebSocket = ControlledSocket as unknown as typeof WebSocket;
    const connect = createOpenAIResponsesConnect({
      baseUrl: "https://example.test/v1",
      requestUrl: new URL("https://example.test/v1/responses"),
      websocketUrl: "wss://example.test/v1/responses",
      headers: { Authorization: "Bearer test", "x-codex-beta-features": "existing" },
      mode: "websocket",
    });
    const opening = connect(new AbortController().signal);
    const raw = ControlledSocket.instance;
    raw.dispatchEvent(new Event("open"));
    const socket = (await opening).unwrap();
    expect(raw.options.headers["x-codex-beta-features"]).toBe("existing,remote_compaction_v2");
    expect(raw.options.headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
    raw.dispatchEvent(
      failure === "error"
        ? new Event("error")
        : new MessageEvent("message", { data: new Uint8Array([1]) }),
    );
    const events = socket.events[Symbol.asyncIterator]();
    expect((await events.next()).value?.isErr()).toBe(true);
    socket.close();
    socket.close();
    expect(raw.closeCount).toBe(1);
    raw.dispatchEvent(new MessageEvent("message", { data: "late" }));
    expect((await events.next()).done).toBe(true);
  });
